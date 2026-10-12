import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearLiveObservations,
  getLiveObservation,
  indexDnsRecord,
  liveObservationCount,
  observationFromDnsRecord,
  primeLiveObservations,
} from '../liveObservations';

afterEach(() => {
  clearLiveObservations();
});

describe('liveObservations — serving-time index', () => {
  it('maps a daemon record into observation fields', () => {
    const obs = observationFromDnsRecord({
      verdict: 'BLOCKED',
      rcode: 3,
      cname_depth: 2,
      cname_foreign: true,
      ttl_min: 30,
      latency_ms: 12,
    });
    expect(obs.dnsSeen).toBe(true);
    expect(obs.dnsBlocked).toBe(true);
    expect(obs.dnsCnameForeign).toBe(true);
    expect(obs.dnsNxdomainRate).toBe(1);
    expect(obs.dnsTtlMin).toBe(30);
    expect(obs.dnsLatencyMs).toBe(12);
  });

  it('keeps absent fields absent — NOERROR rcode is a 0 rate, not a guess', () => {
    const obs = observationFromDnsRecord({ verdict: 'ALLOWED', rcode: 0 });
    expect(obs.dnsBlocked).toBe(false);
    expect(obs.dnsNxdomainRate).toBe(0);
    expect(obs.dnsCnameForeign).toBeNull();
    expect(obs.dnsTtlMin).toBeNull();
  });

  it('indexes under the normalized key the classifier will look up', () => {
    indexDnsRecord({ domain: 'WWW.Example.COM.', verdict: 'BLOCKED', rcode: null });
    expect(getLiveObservation('www.example.com')?.dnsBlocked).toBe(true);
    expect(getLiveObservation('https://www.example.com/path')?.dnsBlocked).toBe(true);
  });

  it('latest record for a domain wins', () => {
    indexDnsRecord({ domain: 'a.example.com', verdict: 'ALLOWED', rcode: 0 });
    indexDnsRecord({ domain: 'a.example.com', verdict: 'BLOCKED', rcode: 0 });
    expect(getLiveObservation('a.example.com')?.dnsBlocked).toBe(true);
    expect(liveObservationCount()).toBe(1);
  });

  it('returns undefined for unobserved domains', () => {
    expect(getLiveObservation('never-seen.example.org')).toBeUndefined();
  });

  it('ignores records without a usable domain', () => {
    expect(indexDnsRecord({ verdict: 'BLOCKED' })).toBeNull();
    expect(indexDnsRecord({ domain: '' })).toBeNull();
    expect(liveObservationCount()).toBe(0);
  });

  describe('primeLiveObservations', () => {
    it('indexes the file tail and tolerates corrupt lines', () => {
      const dir = mkdtempSync(join(tmpdir(), 'bm-liveobs-'));
      const file = join(dir, 'dns-observations.jsonl');
      try {
        writeFileSync(
          file,
          [
            JSON.stringify({ domain: 'old.example.com', verdict: 'ALLOWED', rcode: 0 }),
            'not json {{{',
            JSON.stringify({ domain: 'new.example.com', verdict: 'BLOCKED', rcode: null }),
            '',
          ].join('\n'),
        );
        expect(primeLiveObservations(file)).toBe(2);
        expect(getLiveObservation('old.example.com')?.dnsBlocked).toBe(false);
        expect(getLiveObservation('new.example.com')?.dnsBlocked).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns 0 when the file does not exist', () => {
      expect(primeLiveObservations(join(tmpdir(), 'bm-no-such-file.jsonl'))).toBe(0);
    });
  });
});
