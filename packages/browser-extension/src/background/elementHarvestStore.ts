/**
 * The browser's buffer of harvested elements.
 *
 * Content scripts cannot be trusted to hold harvest records — a frame can be torn down
 * between a decision and a write, and there is one buffer per frame — so capture sends
 * records up to the service worker and the worker keeps them here. The buffer is what
 * the hub reads when the user exports it, and it is the last place real page data sits
 * before it becomes a file.
 *
 * It is therefore the component that has to be honest about volume and about labels:
 *
 *  - **Bounded, oldest-out.** A user who scans every page all week would otherwise grow
 *    `chrome.storage.local` without limit, and MV3 storage is not free. The cap is a
 *    count of distinct shapes, not a count of records, and eviction prefers shapes with
 *    no decision on them — a decision a person made is the most expensive thing in here to
 *    lose and the cheapest to keep.
 *  - **Redacted on the way in, not on the way out.** Every record is validated and its
 *    text truncated by the core sanitiser before it is stored, so a record that reaches
 *    disk cannot hold more of the page than the classifier reads. A buffer that redacted
 *    at export time would be one bug away from writing whole articles to storage.
 *  - **A decision is never overwritten.** A later undecided sighting of the same shape
 *    updates the count and the latest verdict and leaves the person's decision alone; the
 *    reverse (a decision arriving after undecided sightings) is applied, because that is
 *    new information rather than a contradiction.
 *
 * The merge is pure so the suite can pin it, and the chrome access is three thin wrappers
 * over it — the same split `elementAiFeedback.ts` uses for the learned decisions.
 */

import {
  renderHarvestFile,
  sanitizeHarvestedElement,
  type HarvestedElement,
} from '@blockingmachine/core/element-harvest';
import { STORAGE_KEY_ELEMENT_HARVEST } from '../shared/constants.js';

/** Distinct shapes held at once. Roughly one busy week of scanning. */
export const MAX_HARVEST_SHAPES = 400;

export interface HarvestBuffer {
  records: HarvestedElement[];
}

/** A key that identifies a shape on a host — the same identity the corpus queue uses. */
function shapeKey(record: HarvestedElement): string {
  return `${record.host}/${record.signature}`;
}

export function emptyHarvestBuffer(): HarvestBuffer {
  return { records: [] };
}

/**
 * Validates incoming records and merges them into the buffer.
 *
 * Unusable records are dropped rather than stored: this data comes from content scripts
 * across every frame of every page, and one malformed entry should not be able to poison
 * the export. The signature is derived here rather than trusted, so a record that lost it
 * in transit still merges with the right shape.
 */
export function appendHarvestRecords(
  existing: HarvestBuffer,
  incoming: readonly unknown[],
  maxShapes = MAX_HARVEST_SHAPES,
): HarvestBuffer {
  const byShape = new Map<string, HarvestedElement>();
  for (const entry of existing.records) {
    const record = sanitizeHarvestedElement(entry);
    if (record) byShape.set(shapeKey(record), record);
  }

  for (const entry of incoming) {
    const record = sanitizeHarvestedElement(entry);
    if (!record) continue;
    const key = shapeKey(record);
    const current = byShape.get(key);
    if (!current) {
      byShape.set(key, record);
      continue;
    }
    byShape.set(key, {
      ...current,
      capturedAt: Math.max(current.capturedAt, record.capturedAt),
      // The most assertive verdict wins, so the exported provenance is not the most
      // recent shrug. Confidence breaks a tie in the same direction.
      verdict:
        record.verdict.action === 'hide' || record.verdict.confidence > current.verdict.confidence
          ? record.verdict
          : current.verdict,
      human: record.human ?? current.human,
      snapshot: record.human && !current.human ? record.snapshot : current.snapshot,
    });
  }

  return { records: boundBuffer([...byShape.values()], maxShapes) };
}

/**
 * Caps the buffer and puts it in a deterministic order.
 *
 * Eviction treats "least valuable" as undecided before decided and oldest before newest,
 * so a person who marked something is never the thing thrown away to make room. The
 * export is then sorted oldest-first, which makes the file a chronological account of
 * what was met rather than an artefact of which frame reported first.
 */
function boundBuffer(records: HarvestedElement[], maxShapes: number): HarvestedElement[] {
  const kept =
    maxShapes <= 0
      ? []
      : records.length <= maxShapes
        ? records
        : [...records]
            .sort((a, b) => {
              if (Boolean(a.human) !== Boolean(b.human)) return a.human ? -1 : 1;
              return b.capturedAt - a.capturedAt;
            })
            .slice(0, maxShapes);
  return kept.sort((a, b) => a.capturedAt - b.capturedAt || a.host.localeCompare(b.host));
}

/** Reads the buffer, tolerating a missing or corrupt store. */
export async function readHarvestBuffer(): Promise<HarvestBuffer> {
  try {
    if (!chrome?.storage?.local) return emptyHarvestBuffer();
    const stored = await chrome.storage.local.get(STORAGE_KEY_ELEMENT_HARVEST);
    const raw = stored?.[STORAGE_KEY_ELEMENT_HARVEST] as HarvestBuffer | undefined;
    if (!raw || !Array.isArray(raw.records)) return emptyHarvestBuffer();
    return appendHarvestRecords(emptyHarvestBuffer(), raw.records);
  } catch {
    return emptyHarvestBuffer();
  }
}

/** Appends records from a content script. Returns how many were kept. */
export async function storeHarvestRecords(incoming: readonly unknown[]): Promise<number> {
  try {
    if (!chrome?.storage?.local || !Array.isArray(incoming) || incoming.length === 0) return 0;
    const merged = appendHarvestRecords(await readHarvestBuffer(), incoming);
    await chrome.storage.local.set({ [STORAGE_KEY_ELEMENT_HARVEST]: merged });
    return merged.records.length;
  } catch {
    return 0;
  }
}

/** What the popup needs to offer the export, mirroring the hit ledger's payload. */
export interface ElementHarvestExport {
  filename: string;
  /** The file's contents, in the shared JSONL format. */
  json: string;
  /** One line for the card, so the user knows what they are about to hand over. */
  summary: string;
  records: number;
  labelled: number;
  hosts: number;
}

/** A dated filename, so consecutive exports do not overwrite each other on disk. */
export function elementHarvestFilename(now: Date | number = Date.now()): string {
  const date = new Date(now).toISOString().slice(0, 10);
  return `blockingmachine-element-harvest-${date}.jsonl`;
}

/**
 * Hands the whole buffer to the caller and empties it.
 *
 * Draining rather than reading is what makes an export mean something: the hub has the
 * records, the browser no longer does, and the next export is the next session's browsing
 * rather than a re-send of the last one. The drain happens even when the caller goes away
 * mid-write, so a failed download costs the queue its duplicates rather than its contents
 * — the file format is line-per-record precisely so a half-delivered export is still
 * mostly readable.
 */
export async function drainHarvestBuffer(): Promise<HarvestedElement[]> {
  const buffer = await readHarvestBuffer();
  try {
    if (chrome?.storage?.local) await chrome.storage.local.remove(STORAGE_KEY_ELEMENT_HARVEST);
  } catch {
    // A failed clear means the next export repeats these records; the queue's
    // de-duplication makes that harmless, so it is not worth failing the export over.
  }
  return buffer.records;
}

/** Drains the buffer and formats it as the file the hub and the corpus script read. */
export async function exportElementHarvest(now: Date | number = Date.now()): Promise<ElementHarvestExport> {
  return formatElementHarvest(await drainHarvestBuffer(), now);
}

/**
 * Formats the buffer **without** draining it.
 *
 * The popup's card asks what an export would cover every time it opens, and a preview
 * that emptied the buffer would mean the count on screen was a number the user could
 * never actually export. So reading and taking are separate, the way they are for the hit
 * ledger.
 */
export async function previewElementHarvest(now: Date | number = Date.now()): Promise<ElementHarvestExport> {
  return formatElementHarvest((await readHarvestBuffer()).records, now);
}

function formatElementHarvest(records: HarvestedElement[], now: Date | number): ElementHarvestExport {
  const hosts = new Set(records.map((record) => record.host));
  const labelled = records.filter((record) => record.human).length;
  const stamp = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
  const summary =
    records.length === 0
      ? 'Nothing captured yet. Scanning a page or marking an element captures real elements.'
      : `${records.length} element(s) from ${hosts.size} site(s), ${labelled} with a decision from you.`;
  return {
    filename: elementHarvestFilename(now),
    json: renderHarvestFile(
      records,
      [
        'Blockingmachine element harvest — real elements captured from pages, for the element corpus queue.',
        `Exported ${stamp}.`,
        'One element per line. `verdict` is what the model said at capture time and is provenance, not a label.',
        '`human` is a decision you made about that element, and is the only label the corpus queue accepts.',
        'Build the queue with: npm run harvest:elements -- --in <this file>',
      ].join('\n'),
    ),
    summary,
    records: records.length,
    labelled,
    hosts: hosts.size,
  };
}
