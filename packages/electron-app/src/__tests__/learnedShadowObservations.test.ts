/**
 * The observation-stream tail — flag 43's widened shadow coverage.
 *
 * `shadowScoreWatchdogDomains` only sees domains the AI watchdog's own scan pulled —
 * flagged traffic, a biased slice. The daemon's observation file is every name the
 * resolver answered, already deduped, each carrying the production verdict. These tests
 * pin the tail's mechanics: byte-offset progress, no rescoring without new bytes,
 * torn-line tolerance, and that a daemon `BLOCKED` verdict arrives as reference
 * `block` — the label the disagreement column is read against.
 *
 * Same mock shape as learnedShadowSampling.test.ts: real shipped weights, Electron's
 * `app` swapped for a temp userData.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userData: string;
let appPath: string;
let observationsPath: string;

jest.unstable_mockModule('electron', () => ({
  app: {
    getPath: (_name: string) => userData,
    getAppPath: () => appPath,
  },
}));

const { shadowScoreObservationFile } = await import('../learnedShadow');

const rec = (domain: string, verdict: 'ALLOWED' | 'BLOCKED' | 'EXCEPTION' = 'ALLOWED') =>
  JSON.stringify({ domain, verdict, observed_at: '2026-10-08T00:00:00.000Z', qtype: 'A', rcode: 0 }) + '\n';

function readLog(): Record<string, unknown>[] {
  const p = join(userData, 'learned-shadow.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'bm-obsshadow-'));
  appPath = join(process.cwd(), 'package.json');
  observationsPath = join(userData, 'dns-observations.jsonl');
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('shadowScoreObservationFile', () => {
  it('returns null when the stream does not exist yet', () => {
    expect(shadowScoreObservationFile(observationsPath, 1)).toBeNull();
  });

  it('scores each deduped domain once and writes a summary', () => {
    writeFileSync(observationsPath, rec('www.riversidecom') + rec('blog.northgateorg') + rec('www.riversidecom'));
    const r = shadowScoreObservationFile(observationsPath, 1)!;
    expect(r.evaluated).toBe(2); // third record is the same domain — first wins
    expect(r.recordsRead).toBe(2);
    const summary = readLog().find((l) => l.type === 'summary');
    expect(summary?.evaluated).toBe(2);
  });

  it('advances the byte offset — a second pass with nothing new scores nothing', () => {
    writeFileSync(observationsPath, rec('a.riversidecom'));
    const first = shadowScoreObservationFile(observationsPath, 1)!;
    expect(first.evaluated).toBe(1);
    const second = shadowScoreObservationFile(observationsPath, 1)!;
    expect(second.evaluated).toBe(0);
    expect(second.bytesRead).toBe(0);
    // And the log holds exactly the first pass's summary — no double-scored repeat.
    expect(readLog().filter((l) => l.type === 'summary')).toHaveLength(1);
  });

  it('picks up appended records on the next pass', () => {
    writeFileSync(observationsPath, rec('a.riversidecom'));
    shadowScoreObservationFile(observationsPath, 1);
    appendFileSync(observationsPath, rec('b.northgateorg') + rec('c.willowde'));
    const r = shadowScoreObservationFile(observationsPath, 1)!;
    expect(r.evaluated).toBe(2);
  });

  it('carries the daemon verdict as the reference decision', () => {
    // sampleRate 1 → every scored domain writes a sample record carrying
    // referenceDecision, so the verdict mapping is checkable without depending on
    // what the shipped model happens to say about these names.
    writeFileSync(observationsPath, rec('www.riversidecom', 'BLOCKED') + rec('blog.northgateorg', 'ALLOWED'));
    shadowScoreObservationFile(observationsPath, 1);
    const byDomain = new Map(
      readLog()
        .filter((l) => l.type !== 'summary')
        .map((l) => [l.domain as string, l.referenceDecision as string]),
    );
    expect(byDomain.get('www.riversidecom')).toBe('block');
    expect(byDomain.get('blog.northgateorg')).toBe('allow');
  });

  it('tolerates a torn final line from a mid-write read', () => {
    writeFileSync(observationsPath, rec('a.riversidecom') + '{"domain":"trunc');
    const r = shadowScoreObservationFile(observationsPath, 1)!;
    expect(r.evaluated).toBe(1);
  });
});
