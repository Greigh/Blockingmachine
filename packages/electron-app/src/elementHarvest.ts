/**
 * The hub's side of the element harvest.
 *
 * The element corpus is hand-written, and `docs/element-classifier-live-scan.md` is what
 * that costs: five real pages, 52 wrong actionable verdicts, and not one of them a shape
 * the corpus had. Real elements are the only source of the cases that are missing, and the
 * only place real elements exist is the browser — so the extension captures them while the
 * user browses and exports them, and the hub keeps the file the user chose to keep.
 *
 * That division is the tier ledger's, deliberately: the hub accumulates no measurement of
 * its own, so the file is the measurement, and pointing at it is a choice the user makes
 * rather than something the hub starts doing on its own. It also means the corpus queue
 * has exactly one input the user has seen — the same file the popup wrote, in the same
 * JSONL format `scripts/harvest-element-candidates.mjs --in` reads, with no translation
 * step in between to drift.
 *
 * Reading is fail-soft and countable. The file is a log of real pages that has been
 * through a download and a text editor, so a line that does not parse is skipped and
 * reported rather than thrown on: a Settings pane that refused to open because one line of
 * a harvest was malformed would be a worse outcome than a pane that says "read 41 of 42".
 */
import { readFileSync, unlinkSync } from 'fs';
import { parseHarvestFile, selectHarvestCandidates, type HarvestedElement } from '@blockingmachine/core';

/**
 * Records read at once, matching the extension's buffer so a file and a buffer agree.
 *
 * The bound is a read bound, not a truncation: a file larger than this is summarised over
 * its most recent records and says how many it skipped, because a Settings pane that
 * silently described the first 400 of 5,000 records would be a readout nobody could trust.
 */
const MAX_HARVEST_RECORDS = 400;

export interface ElementHarvestSummary {
  /** Where the file is, or `null` when none has been chosen. */
  path: string | null;
  /** Whether the chosen file is still there. A path that has moved is reported as gone. */
  present: boolean;
  records: number;
  /** Records that were on disk but are not usable captures. */
  rejected: number;
  hosts: number;
  /** Records carrying a decision a person made — the only ones a corpus case can come from. */
  labelled: number;
  /** Epoch ms of the most recent capture in the file. */
  newest: number | null;
  /** The queue this file would produce, so the pane can show the shape of it. */
  wouldQueue: number;
}

/** Remembers the file the user picked, the way `tierLedgerPath` remembers the ledger's. */
export function rememberedElementHarvestPath(store: { get(key: string): unknown }): string {
  const stored = store.get('elementHarvestPath');
  return typeof stored === 'string' ? stored : '';
}

/**
 * Summarises a harvest file for the Settings pane.
 *
 * The candidate count is produced by the same core selection the corpus script runs, so
 * the number the user sees before exporting is the number they get. Nothing here labels
 * anything, and nothing here writes: this is a readout of a file, and the queue itself is
 * built by `npm run harvest:elements`.
 */
export function summarizeElementHarvest(path: string): ElementHarvestSummary {
  const empty: ElementHarvestSummary = {
    path: path || null,
    present: false,
    records: 0,
    rejected: 0,
    hosts: 0,
    labelled: 0,
    newest: null,
    wouldQueue: 0,
  };
  if (!path) return empty;
  let text: string;
  try {
    // A plain read, not stat-then-read — the check-then-open window is a TOCTOU race, and
    // readFileSync surfaces the same ENOENT the stat existed to find.
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // ENOENT is the case worth reporting precisely — "the file you picked is gone" and
    // "you have never picked one" call for different actions — so it is a value here
    // rather than a thrown error, and every other failure is logged and read as absent.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[Element Harvest] could not read', path, error);
    }
    return empty;
  }
  const { records, rejected } = parseHarvestFile(text);
  const bounded: HarvestedElement[] = records.slice(-MAX_HARVEST_RECORDS);
  const selection = selectHarvestCandidates(bounded, { now: newestCapture(bounded) ?? Date.now() });
  return {
    path,
    present: true,
    records: bounded.length,
    rejected: rejected + (records.length - bounded.length),
    hosts: new Set(bounded.map((record) => record.host)).size,
    labelled: bounded.filter((record) => record.human).length,
    newest: newestCapture(bounded),
    wouldQueue: selection.candidates.length,
  };
}

function newestCapture(records: readonly HarvestedElement[]): number | null {
  if (records.length === 0) return null;
  return records.reduce((latest, record) => Math.max(latest, record.capturedAt), 0);
}

/**
 * Deletes the harvest file.
 *
 * Offered so withdrawing what was collected is one action rather than a file manager: the
 * capture is on by default for scans and decisions, and a user who decides they would
 * rather not keep it should not have to find the file first.
 */
export function clearElementHarvest(path: string): boolean {
  if (!path) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[Element Harvest] could not clear', path, error);
    }
    return false;
  }
}
