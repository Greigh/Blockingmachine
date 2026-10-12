/**
 * `shadowReadiness` — the promotion-gate coverage readout. Counting rules are
 * pinned against `shadow.py`'s `coverage()`: scored domains come from summary
 * `evaluated` counters (agreement leaves no per-domain line), a zero-eval sweep
 * is not a day, and `ready` requires BOTH thresholds — never earlier.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userData: string;

jest.unstable_mockModule('electron', () => ({
  app: {
    getPath: (_name: string) => userData,
    getAppPath: () => join(process.cwd(), 'package.json'),
  },
}));

const { shadowReadiness } = await import('../learnedShadow');
const { clearLiveObservations } = await import('../liveObservations');

const disag = (domain: string, at: string) =>
  JSON.stringify({ domain, learnedScore: 0.9, learnedDecision: 'block', referenceDecision: 'allow', allowlisted: false, at });
const sample = (domain: string, at: string) =>
  JSON.stringify({ domain, learnedScore: 0.1, learnedDecision: 'allow', referenceDecision: 'allow', allowlisted: false, sample: true, at });
const summary = (at: string, evaluated: number, disagreements = 0, modelVersion: number | null = null) =>
  JSON.stringify({ type: 'summary', at, evaluated, disagreements, modelVersion });

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'bm-readiness-'));
  clearLiveObservations();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe('shadowReadiness', () => {
  it('reports zero coverage honestly when no shadow log exists', () => {
    const r = shadowReadiness(null, 0);
    expect(r.days).toBe(0);
    expect(r.scoredDomains).toBe(0);
    expect(r.ready).toBe(false);
  });

  it('counts scored domains from summaries and days from distinct dates', () => {
    writeFileSync(
      join(userData, 'learned-shadow.jsonl'),
      [
        disag('a.example.com', '2026-10-01T01:00:00Z'),
        sample('b.example.com', '2026-10-01T02:00:00Z'),
        summary('2026-10-01T02:00:01Z', 40, 1, 2),
        disag('c.example.com', '2026-10-02T01:00:00Z'),
        summary('2026-10-02T01:00:01Z', 60, 1),
      ].join('\n'),
    );
    const r = shadowReadiness(null, 3);
    expect(r.scoredDomains).toBe(100);
    expect(r.days).toBe(2);
    expect(r.disagreementRecords).toBe(2);
    expect(r.sampleRecords).toBe(1);
    expect(r.unversionedScoredDomains).toBe(60); // the null-version sweep
    expect(r.modelVersions).toEqual([2]);
    expect(r.fanoutHosts).toBe(3);
    expect(r.ready).toBe(false); // days and scored both short
  });

  it('a zero-eval sweep is not a day of coverage', () => {
    writeFileSync(
      join(userData, 'learned-shadow.jsonl'),
      summary('2026-10-01T00:00:00Z', 0, 0, null),
    );
    const r = shadowReadiness(null, 0);
    expect(r.days).toBe(0);
    expect(r.scoredDomains).toBe(0);
  });

  it('ready requires both thresholds', () => {
    const lines: string[] = [];
    for (let d = 1; d <= 7; d++) {
      lines.push(summary(`2026-10-0${d}T00:00:00Z`, 200, 0, 3));
    }
    writeFileSync(join(userData, 'learned-shadow.jsonl'), lines.join('\n'));
    const r = shadowReadiness(null, 0);
    expect(r.days).toBe(7);
    expect(r.scoredDomains).toBe(1400);
    expect(r.ready).toBe(true);
  });

  it('counts the observation stream and the live index separately', () => {
    const obsPath = join(userData, 'dns-observations.jsonl');
    writeFileSync(
      obsPath,
      [
        JSON.stringify({ domain: 'a.example.com', verdict: 'BLOCKED' }),
        JSON.stringify({ domain: 'b.example.com', verdict: 'ALLOWED' }),
        '',
      ].join('\n'),
    );
    const r = shadowReadiness(obsPath, 0);
    expect(r.dnsObservationRecords).toBe(2);
    expect(r.liveIndexEntries).toBe(0);
  });
});
