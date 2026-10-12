import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendUserLabel,
  effectiveUserLabels,
  readUserLabels,
  userLabelsFilePath,
  USER_LABEL_REPORTER,
} from '../userLabels';

let dir: string | null = null;

function tmp(): string {
  dir = mkdtempSync(join(tmpdir(), 'user-labels-'));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('userLabels — training-corpus bridge', () => {
  it('writes feedback.py-native records with provenance', () => {
    const d = tmp();
    expect(appendUserLabel(d, 'Evil-Tracker.EXAMPLE.com', 'threat', { verdict: 'clean', category: 'Clean' })).toBe(true);
    const recs = readUserLabels(d);
    expect(recs).toHaveLength(1);
    expect(recs[0].domain).toBe('evil-tracker.example.com');
    expect(recs[0].verdict).toBe('threat');
    expect(recs[0].reporter).toBe(USER_LABEL_REPORTER);
    expect(recs[0].correctedVerdict).toBe('clean');
    expect(recs[0].correctedCategory).toBe('Clean');
    expect(recs[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects non-public names — LAN noise must not become training labels', () => {
    const d = tmp();
    for (const bad of [
      'printer.local',
      '_airplay._tcp.local',
      "daniel's macbook pro._airplay._tcp.local",
      'localhost',
      'router.lan',
      'foo.internal',
      'not a domain!',
      '1.2.3.4',
      'justonehost',
      'corp-intranet.invalid',
    ]) {
      expect(appendUserLabel(d, bad, 'threat')).toBe(false);
    }
    expect(readUserLabels(d)).toHaveLength(0);
    // The file is not even created when every write was rejected.
    expect(readUserLabels(d)).toEqual([]);
  });

  it('effective labels are latest-per-domain', () => {
    const d = tmp();
    appendUserLabel(d, 'tracker.example.com', 'threat');
    appendUserLabel(d, 'tracker.example.com', 'safe');
    appendUserLabel(d, 'ads.example.org', 'threat');
    const eff = effectiveUserLabels(d);
    const map = new Map(eff.map((r) => [r.domain, r.verdict]));
    expect(map.get('tracker.example.com')).toBe('safe');
    expect(map.get('ads.example.org')).toBe('threat');
    expect(eff).toHaveLength(2);
  });

  it('reset writes a tombstone the merge honours as a delete', () => {
    const d = tmp();
    appendUserLabel(d, 'tracker.example.com', 'threat');
    appendUserLabel(d, 'tracker.example.com', 'reset');
    const eff = effectiveUserLabels(d);
    expect(eff).toHaveLength(1);
    expect(eff[0].verdict).toBe('reset');
    // feedback.py deletes on verdict:'reset' — the tombstone must survive to disk.
    const raw = readFileSync(userLabelsFilePath(d), 'utf8');
    expect(raw).toContain('"verdict":"reset"');
  });

  it('survives malformed lines without losing valid records', () => {
    const d = tmp();
    appendUserLabel(d, 'good.example.com', 'threat');
    const file = userLabelsFilePath(d);
    const prior = readFileSync(file, 'utf8');
    // splice a corrupt line + a foreign schema line between valid records
    const corrupted = prior + 'not-json\n{"domain":"x.com","verdict":"maybe","reporter":"r"}\n';
    writeFileSync(file, corrupted);
    appendUserLabel(d, 'good2.example.com', 'safe');
    const recs = readUserLabels(d);
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.domain).sort()).toEqual(['good.example.com', 'good2.example.com']);
  });
});
