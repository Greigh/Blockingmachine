import dnsPacket from 'dns-packet';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cnameChainOf, ObservationRecorder, summarizeAnswer } from '../server/observationRecorder.js';

function answerWith(answers: Array<Record<string, unknown>>, flags = 0x8180) {
  return dnsPacket.encode({
    type: 'response',
    id: 1,
    flags,
    questions: [{ name: 'ad.example.com', type: 'A', class: 'IN' }],
    answers,
  });
}

describe('cnameChainOf', () => {
  test('walks a two-hop chain from the question name', () => {
    const buf = answerWith([
      { name: 'ad.example.com', type: 'CNAME', class: 'IN', ttl: 300, data: 'cdn.tracker.example' },
      { name: 'cdn.tracker.example', type: 'CNAME', class: 'IN', ttl: 300, data: 'edge.akamai.example' },
      { name: 'edge.akamai.example', type: 'A', class: 'IN', ttl: 60, data: '93.184.216.34' },
    ]);
    const decoded = dnsPacket.decode(buf);
    expect(cnameChainOf('ad.example.com', decoded)).toEqual({
      depth: 2,
      hosts: ['cdn.tracker.example', 'edge.akamai.example'],
    });
  });

  test('stops on a chain that loops back on itself', () => {
    const decoded = dnsPacket.decode(
      answerWith([
        { name: 'ad.example.com', type: 'CNAME', class: 'IN', ttl: 300, data: 'loop.example' },
        { name: 'loop.example', type: 'CNAME', class: 'IN', ttl: 300, data: 'ad.example.com' },
      ]),
    );
    const { depth, hosts } = cnameChainOf('ad.example.com', decoded);
    // The loop-back hop to the question name is refused rather than walked forever.
    expect(depth).toBe(1);
    expect(hosts).toEqual(['loop.example']);
  });

  test('a direct A answer has depth zero', () => {
    const decoded = dnsPacket.decode(
      answerWith([{ name: 'ad.example.com', type: 'A', class: 'IN', ttl: 60, data: '1.2.3.4' }]),
    );
    expect(cnameChainOf('ad.example.com', decoded).depth).toBe(0);
  });
});

describe('summarizeAnswer', () => {
  test('reports rcode, depth, chain, min ttl and answer count', () => {
    const buf = answerWith([
      { name: 'ad.example.com', type: 'CNAME', class: 'IN', ttl: 300, data: 'edge.example' },
      { name: 'edge.example', type: 'A', class: 'IN', ttl: 60, data: '1.2.3.4' },
    ]);
    const s = summarizeAnswer('ad.example.com', buf);
    expect(s.rcode).toBe(0);
    expect(s.cname_depth).toBe(1);
    expect(s.cname_hosts).toEqual(['edge.example']);
    expect(s.ttl_min).toBe(60);
    expect(s.answer_count).toBe(2);
  });

  test('a chain crossing registrable domains is flagged foreign — the cloaking signal', () => {
    const buf = answerWith([
      { name: 'ad.example.com', type: 'CNAME', class: 'IN', ttl: 300, data: 'cdn.tracker.example' },
      { name: 'cdn.tracker.example', type: 'A', class: 'IN', ttl: 60, data: '1.2.3.4' },
    ]);
    const s = summarizeAnswer('ad.example.com', buf);
    expect(s.cname_depth).toBe(1);
    expect(s.cname_foreign).toBe(true);
  });

  test('a same-origin chain is not foreign', () => {
    const buf = answerWith([
      { name: 'ad.example.com', type: 'CNAME', class: 'IN', ttl: 300, data: 'edge.example.com' },
      { name: 'edge.example.com', type: 'A', class: 'IN', ttl: 60, data: '1.2.3.4' },
    ]);
    expect(summarizeAnswer('ad.example.com', buf).cname_foreign).toBe(false);
  });

  test('NXDOMAIN rides the flag low-nibble like the sinkhole encoder writes it', () => {
    const buf = answerWith([], 0x8000 | 3);
    const s = summarizeAnswer('ad.example.com', buf);
    expect(s.rcode).toBe(3);
    expect(s.answer_count).toBe(0);
  });
});

describe('ObservationRecorder', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bm-obs-'));
    file = join(dir, 'dns-observations.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const obs = (domain: string) => ({
    domain,
    observed_at: '2026-10-08T00:00:00.000Z',
    qtype: 'A',
    verdict: 'ALLOWED' as const,
    rcode: 0,
    upstream_ok: true,
    cname_depth: 0,
  });

  test('writes one JSONL record per new domain', () => {
    const r = new ObservationRecorder(file);
    r.observe(obs('a.example.com'));
    r.observe(obs('b.example.com'));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).domain).toBe('a.example.com');
  });

  test('dedups a domain inside the window, records again after it', () => {
    let now = 1_000_000;
    const r = new ObservationRecorder(file, { now: () => now, dedupWindowMs: 60_000 });
    r.observe(obs('a.example.com'));
    now += 30_000;
    r.observe(obs('a.example.com')); // inside window — dropped
    now += 60_001;
    r.observe(obs('a.example.com')); // outside window — recorded
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  test('never carries a clientIp', () => {
    const r = new ObservationRecorder(file);
    r.observe(obs('a.example.com'));
    expect(readFileSync(file, 'utf8')).not.toContain('clientIp');
  });

  test('drops non-public names — discovery chatter and private suffixes are not corpus', () => {
    const r = new ObservationRecorder(file);
    for (const name of [
      '_airplay._tcp.local',
      'daniels-macbook._airplay._tcp.local',
      'nas.lan',
      'router.home',
      'dc01.corp',
      '1.2.3.4.in-addr.arpa',
      'a.b.c.ip6.arpa',
      'printer.localdomain',
      'thing.invalid',
      'host.test',
      'host.example',
      'nas', // single label — a machine name, not a domain
      "daniel's macbook pro._airplay._tcp.local", // spaces/apostrophes are not hostnames
      '',
    ]) {
      r.observe(obs(name));
    }
    r.observe(obs('real-tracker.example.com'));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).domain).toBe('real-tracker.example.com');
  });
});
