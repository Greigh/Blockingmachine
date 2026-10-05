/**
 * Pins for the daemon hardening findings.
 *
 * The audit found: DnsServer.start() hung forever on a bind failure (the promise never
 * settled — the daemon became an orphan answering nothing), the DoH forwarder had no
 * timeout or in-flight cap, upstream failure answered silence instead of SERVFAIL, and
 * /v1/quarantine spliced unvalidated strings into live DNS rules.
 */

import { describe, expect, test } from '@jest/globals';
import dgram from 'node:dgram';
import dnsPacket from 'dns-packet';
import { DnsServer } from '../server/dnsServer.js';
import { DohForwarder } from '../server/dohForwarder.js';
import { DomainTrie } from '../engine/domainTrie.js';
import { isQuarantinableDomain } from '../index.js';
import type { DaemonConfig } from '../types.js';

const baseConfig: DaemonConfig = {
  bindHost: '127.0.0.1',
  dnsPort: 0,
  controlPort: 0,
  upstreamDoHUrl: 'https://dns.quad9.net/dns-query',
  sinkholeIpv4: '0.0.0.0',
  sinkholeIpv6: '::',
  feedUrl: 'http://127.0.0.1:9/dns.txt',
};

describe('quarantine domain validation', () => {
  test('accepts ordinary dotted hostnames', () => {
    expect(isQuarantinableDomain('evil-tracker.example.com')).toBe(true);
    expect(isQuarantinableDomain('dga-7f3a9c.example.net')).toBe(true);
    expect(isQuarantinableDomain('xn--nxasmq6b.example.org')).toBe(true);
    expect(isQuarantinableDomain('dga-7f3a9c.io')).toBe(true);
  });

  test('rejects rule-syntax smuggling and non-host strings', () => {
    for (const bad of [
      'localhost',
      'foo.localhost',
      'router.local',
      'internal.test',
      'name^$important',
      'a b.com',
      'a_b.com',
      '-lead.com',
      'trail-.com',
      'a..b',
      '.leading.com',
      'trailing.com.',
      'no-dot',
      'x'.repeat(254),
      'a'.repeat(64) + '.com',
    ]) {
      expect(isQuarantinableDomain(bad)).toBe(false);
    }
  });
});

describe('DnsServer startup failure', () => {
  test('start() rejects on bind error instead of hanging', async () => {
    const blocker = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => blocker.bind(0, '127.0.0.1', resolve));
    const takenPort = (blocker.address() as { port: number }).port;
    try {
      const server = new DnsServer(new DomainTrie(), { ...baseConfig, dnsPort: takenPort });
      await expect(server.start()).rejects.toThrow();
    } finally {
      blocker.close();
    }
  });
});

describe('DohForwarder guards', () => {
  test('the in-flight cap drops instead of queueing on a saturated upstream', async () => {
    const forwarder = new DohForwarder('http://127.0.0.1:9/dns-query');
    (forwarder as unknown as { inFlight: number }).inFlight = DohForwarder.MAX_IN_FLIGHT;
    const out = await forwarder.resolvePacket(Buffer.from([0x12]));
    expect(out).toBeNull();
  });
});

describe('DnsServer answers failure honestly', () => {
  function sendQuery(port: number, packet: object): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      const timer = setTimeout(() => { client.close(); reject(new Error('no answer')); }, 3000);
      client.on('message', (msg) => { clearTimeout(timer); client.close(); resolve(msg); });
      client.on('error', (err) => { clearTimeout(timer); client.close(); reject(err); });
      client.send(dnsPacket.encode(packet), port, '127.0.0.1');
    });
  }

  test('a dead upstream answers SERVFAIL rather than silence', async () => {
    const trie = new DomainTrie();
    const server = new DnsServer(trie, { ...baseConfig, dnsPort: 0 });
    // Point the forwarder at a dead loopback port — every query fails fast.
    const deadForwarder = new DohForwarder('http://127.0.0.1:9/dns-query');
    (server as unknown as { forwarder: DohForwarder }).forwarder = deadForwarder;
    await server.start();
    const port = (server as unknown as { socket: dgram.Socket }).socket.address().port as number;
    try {
      const answer = dnsPacket.decode(
        await sendQuery(port, {
          type: 'query',
          id: 1,
          flags: dnsPacket.RECURSION_DESIRED,
          questions: [{ type: 'A', name: 'allowed.example.com' }],
        }),
      );
      expect(answer.rcode).toBe('SERVFAIL');
      expect(answer.id).toBe(1);
    } finally {
      await server.stop();
    }
  }, 15000);

  test('a blocked MX query gets NXDOMAIN, not a type-confused A record', async () => {
    const trie = new DomainTrie();
    trie.addRule('||blocked.example.com^');
    const server = new DnsServer(trie, { ...baseConfig, dnsPort: 0 });
    await server.start();
    const port = (server as unknown as { socket: dgram.Socket }).socket.address().port as number;
    try {
      const answer = dnsPacket.decode(
        await sendQuery(port, {
          type: 'query',
          id: 2,
          flags: dnsPacket.RECURSION_DESIRED,
          questions: [{ type: 'MX', name: 'blocked.example.com' }],
        }),
      );
      expect(answer.rcode).toBe('NXDOMAIN');
      expect(answer.answers).toEqual([]);
    } finally {
      await server.stop();
    }
  }, 15000);

  test('a blocked A query still sinkholes to 0.0.0.0', async () => {
    const trie = new DomainTrie();
    trie.addRule('||blocked.example.com^');
    const server = new DnsServer(trie, { ...baseConfig, dnsPort: 0 });
    await server.start();
    const port = (server as unknown as { socket: dgram.Socket }).socket.address().port as number;
    try {
      const answer = dnsPacket.decode(
        await sendQuery(port, {
          type: 'query',
          id: 3,
          flags: dnsPacket.RECURSION_DESIRED,
          questions: [{ type: 'A', name: 'blocked.example.com' }],
        }),
      );
      expect(answer.answers[0].type).toBe('A');
      expect(answer.answers[0].data).toBe('0.0.0.0');
    } finally {
      await server.stop();
    }
  }, 15000);
});
