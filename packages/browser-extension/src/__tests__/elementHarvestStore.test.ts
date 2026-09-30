/**
 * The browser's harvest buffer.
 *
 * The buffer is the last place real page data sits before it becomes a file, so what is
 * tested here is what it is allowed to forget and what it is not. Three properties earn
 * their tests: a decision a person made survives everything that happens to the shape
 * afterwards, the cap evicts undecided shapes before decided ones, and a preview of the
 * export does not take it — because the popup shows that count every time it opens.
 *
 * The merge is pure, so none of this needs a browser. The `chrome.storage` wrappers are
 * three lines over the same functions and are exercised through the same rules.
 */

import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import {
  MAX_HARVEST_SHAPES,
  appendHarvestRecords,
  elementHarvestFilename,
  emptyHarvestBuffer,
  exportElementHarvest,
  previewElementHarvest,
  storeHarvestRecords,
  type ElementHarvestExport,
} from '../background/elementHarvestStore.js';
import { STORAGE_KEY_ELEMENT_HARVEST } from '../shared/constants.js';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');

function record(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: 'example.com',
    capturedAt: NOW,
    verdict: { elementClass: 'Ad', action: 'hide', confidence: 98 },
    snapshot: { tag: 'div', classes: ['adsbygoogle'] },
    ...fields,
  };
}

/** The smallest `chrome.storage.local` that behaves like the real one. */
function installStorage() {
  const data = new Map<string, unknown>();
  const api = {
    get: jest.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      const out: Record<string, unknown> = {};
      for (const name of keys) if (data.has(name)) out[name] = data.get(name);
      return out;
    }),
    set: jest.fn(async (entries: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(entries)) data.set(key, value);
    }),
    remove: jest.fn(async (key: string) => {
      data.delete(key);
    }),
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: api } };
  return { data, api };
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('appendHarvestRecords', () => {
  it('keeps a decision when the same shape is seen again with no decision', () => {
    const first = appendHarvestRecords(emptyHarvestBuffer(), [
      record({ human: { action: 'keep', at: NOW } }),
    ]);
    const second = appendHarvestRecords(first, [record({ capturedAt: NOW + 1000 })]);
    expect(second.records).toHaveLength(1);
    expect(second.records[0].human).toEqual({ action: 'keep', at: NOW });
  });

  it('applies a decision that arrives after undecided sightings', () => {
    const first = appendHarvestRecords(emptyHarvestBuffer(), [record()]);
    const second = appendHarvestRecords(first, [record({ human: { action: 'hide', at: NOW } })]);
    expect(second.records[0].human).toEqual({ action: 'hide', at: NOW });
  });

  it('keeps the strongest verdict a shape ever got, because that is the provenance worth having', () => {
    const first = appendHarvestRecords(emptyHarvestBuffer(), [
      record({ verdict: { elementClass: 'Ad', action: 'hide', confidence: 98 } }),
    ]);
    // A later shrug must not overwrite the one time the model was certain.
    const second = appendHarvestRecords(first, [
      record({ capturedAt: NOW + 1, verdict: { elementClass: 'Content', action: 'leave', confidence: 84 } }),
    ]);
    expect(second.records[0].verdict).toEqual({ elementClass: 'Ad', action: 'hide', confidence: 98 });
  });

  it('drops records that are not captures rather than storing them', () => {
    const merged = appendHarvestRecords(emptyHarvestBuffer(), [record(), 'nope', { host: 'x' }, null]);
    expect(merged.records).toHaveLength(1);
  });

  it('evicts undecided shapes before decided ones when it is over the cap', () => {
    const many = Array.from({ length: 5 }, (_unused, index) =>
      record({ host: 'noisy.example', snapshot: { tag: 'div', classes: [`shape${'abcdefghij'[index]}`] } }),
    );
    const decided = record({
      host: 'decided.example',
      snapshot: { tag: 'div', classes: ['keepme'] },
      human: { action: 'keep', at: NOW },
    });
    const merged = appendHarvestRecords(emptyHarvestBuffer(), [...many, decided], 3);
    expect(merged.records).toHaveLength(3);
    // The one thing a person ruled on is never the thing that gets thrown away.
    expect(merged.records.some((entry) => entry.human !== undefined)).toBe(true);
  });

  it('holds a bounded number of shapes by default, and exports oldest first', () => {
    const many = Array.from({ length: MAX_HARVEST_SHAPES + 10 }, (_unused, index) =>
      record({ host: 'noisy.example', capturedAt: NOW + index, snapshot: { tag: 'div', classes: [`s${'abcdefghijklmnopqrstuvwxyz'[index % 26]}${index}`] } }),
    );
    const merged = appendHarvestRecords(emptyHarvestBuffer(), many);
    expect(merged.records).toHaveLength(MAX_HARVEST_SHAPES);
    const times = merged.records.map((entry) => entry.capturedAt);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('redacts long text on the way in, not on the way out', () => {
    const merged = appendHarvestRecords(emptyHarvestBuffer(), [
      record({ snapshot: { tag: 'div', text: 'Body copy. '.repeat(200) } }),
    ]);
    expect(merged.records[0].snapshot.text?.length).toBeLessThanOrEqual(120);
  });
});

describe('reading, storing and exporting', () => {
  it('previews without taking, so the count on screen is still exportable', async () => {
    await storeHarvestRecords([record({ human: { action: 'keep', at: NOW } })]);
    const preview: ElementHarvestExport = await previewElementHarvest(NOW);
    expect(preview.records).toBe(1);
    expect(preview.labelled).toBe(1);
    // Read again: a preview that drained would have emptied the buffer behind the card.
    expect((await previewElementHarvest(NOW)).records).toBe(1);
  });

  it('drains on export, so the next file is new browsing rather than the same records again', async () => {
    await storeHarvestRecords([record({ human: { action: 'hide', at: NOW } })]);
    const exported = await exportElementHarvest(NOW);
    expect(exported.records).toBe(1);
    expect(exported.hosts).toBe(1);
    expect((await exportElementHarvest(NOW)).records).toBe(0);
  });

  it('writes the file the corpus script reads, and explains itself in the header', async () => {
    await storeHarvestRecords([record({ human: { action: 'keep', at: NOW } })]);
    const exported = await exportElementHarvest(NOW);
    expect(exported.filename).toBe(elementHarvestFilename(NOW));
    expect(exported.json).toContain('# Blockingmachine element harvest');
    expect(exported.json).toContain('npm run harvest:elements -- --in');
    const bodyLines = exported.json.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(bodyLines).toHaveLength(1);
    expect(JSON.parse(bodyLines[0]).human).toEqual({ action: 'keep', at: NOW });
  });

  it('says there is nothing to export rather than offering an empty file', async () => {
    const exported = await exportElementHarvest(NOW);
    expect(exported.records).toBe(0);
    expect(exported.summary).toContain('Nothing captured yet');
  });

  it('survives a browser that will not answer', async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {};
    expect(await storeHarvestRecords([record()])).toBe(0);
    expect((await previewElementHarvest(NOW)).records).toBe(0);
  });

  it('survives a corrupt buffer already in storage', async () => {
    const { data } = installStorage();
    data.set(STORAGE_KEY_ELEMENT_HARVEST, { records: 'not an array' });
    expect((await previewElementHarvest(NOW)).records).toBe(0);
  });
});
