/**
 * The hub's read of the element harvest.
 *
 * The hub accumulates no measurement of its own — the file the browser exported is the
 * measurement — so this is a readout, and the tests are about what it says when the file is
 * not what it hoped. A Settings pane that cannot tell "you never picked a file" from "the
 * file you picked is gone" is a pane that sends people looking in the wrong place, and one
 * that silently summarised half a file would be worse than one that said it read half.
 */

import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearElementHarvest, rememberedElementHarvestPath, summarizeElementHarvest } from '../elementHarvest';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let dir: string;

function record(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    host: 'example.com',
    capturedAt: NOW - DAY,
    verdict: { elementClass: 'Ad', action: 'hide', confidence: 98 },
    snapshot: { tag: 'div', classes: ['adsbygoogle'] },
    ...fields,
  });
}

function write(lines: string[]): string {
  const path = join(dir, 'element-harvest.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bm-harvest-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('summarizeElementHarvest', () => {
  test('reads nothing at all when no file has been chosen, without complaining', () => {
    const summary = summarizeElementHarvest('');
    expect(summary).toMatchObject({ path: null, present: false, records: 0, wouldQueue: 0 });
  });

  test('says a chosen file is gone rather than reporting an empty harvest', () => {
    const summary = summarizeElementHarvest(join(dir, 'moved.jsonl'));
    // The distinction matters: this is a path the user picked that no longer exists, which
    // is a different problem from never having picked one.
    expect(summary.present).toBe(false);
    expect(summary.path).toContain('moved.jsonl');
    expect(summary.records).toBe(0);
  });

  test('counts records, hosts and decisions, and the queue the file would produce', () => {
    const path = write([
      '# exported by the browser',
      record({ human: { action: 'keep', at: NOW } }),
      record({ host: 'other.example', snapshot: { tag: 'div', classes: ['promo'] } }),
      record({ host: 'other.example', snapshot: { tag: 'div', classes: ['promo'] } }),
    ]);
    const summary = summarizeElementHarvest(path);
    expect(summary).toMatchObject({
      present: true,
      records: 3,
      hosts: 2,
      labelled: 1,
      newest: NOW - DAY,
    });
    // Two shapes: the decided ad slot, and the undecided promo the model wants to act on.
    // The repeat promo is one shape with two sightings, not two candidates.
    expect(summary.wouldQueue).toBe(2);
  });

  test('skips a corrupt line and reports it instead of hiding the records around it', () => {
    const path = write([record({ human: { action: 'keep', at: NOW } }), '{ truncated', record()]);
    const summary = summarizeElementHarvest(path);
    expect(summary.records).toBe(2);
    expect(summary.rejected).toBe(1);
  });

  test('counts a record whose text was long enough to be redacted, rather than skipping it', () => {
    const path = write([record({ snapshot: { tag: 'div', text: 'Body copy. '.repeat(200) } })]);
    // Redaction shortens the text, it does not make the capture unusable — a record that
    // was dropped for being long would quietly shrink every queue built from a real page,
    // which is exactly where the long text is.
    expect(summarizeElementHarvest(path)).toMatchObject({ records: 1, rejected: 0 });
  });

  test('measures age from the newest capture, so an old file is not summarised as fresh', () => {
    const path = write([record({ capturedAt: NOW - 400 * DAY })]);
    const summary = summarizeElementHarvest(path);
    expect(summary.newest).toBe(NOW - 400 * DAY);
    expect(summary.records).toBe(1);
  });
});

describe('rememberedElementHarvestPath', () => {
  test('returns only a string the store actually holds', () => {
    expect(rememberedElementHarvestPath({ get: () => '/tmp/harvest.jsonl' })).toBe('/tmp/harvest.jsonl');
    expect(rememberedElementHarvestPath({ get: () => undefined })).toBe('');
    // A store that somehow holds an object must not be handed to fs as a path.
    expect(rememberedElementHarvestPath({ get: () => ({ nope: true }) })).toBe('');
  });
});

describe('clearElementHarvest', () => {
  test('deletes the file, and is a no-op for one that is already gone', () => {
    const path = write([record()]);
    expect(clearElementHarvest(path)).toBe(true);
    expect(summarizeElementHarvest(path).present).toBe(false);
    // Withdrawing what was collected should not report a failure the second time.
    expect(clearElementHarvest(path)).toBe(false);
    expect(clearElementHarvest('')).toBe(false);
  });
});
