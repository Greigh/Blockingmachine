/**
 * Turning real elements into corpus candidates.
 *
 * `ELEMENT_EVAL_CORPUS` is 117 shapes someone sat down and wrote, which means it
 * encodes the shapes someone thought of — the finding recorded in
 * `docs/element-classifier-live-scan.md`, where running the shipping scanner over five
 * real pages produced 52 wrong actionable verdicts and not one of them was a shape the
 * corpus had. Growing that corpus from real pages is therefore not a nice-to-have; it
 * is the only source of the cases that are missing.
 *
 * This module is the middle of that pipeline. Real elements arrive as
 * {@link HarvestedElement} records — captured from a live page by the extension,
 * exported, and written beside the hub's other browser data — and leave as a queue of
 * {@link ElementHarvestCandidate}s that a person can review. Four decisions are baked
 * in, and each one exists because the obvious version is wrong:
 *
 * 1. **A model's verdict is provenance, not a label.** Every record carries the class,
 *    action and confidence the shipping model gave the element at capture time. Nothing
 *    here reads it as ground truth, and {@link proposeHarvestEvalCase} returns `null`
 *    for a record that carries nothing else. Labelling a candidate with the model's own
 *    answer would produce a corpus that agrees with the model by construction: every
 *    metric over it would be perfect and none of them would mean anything, and the
 *    weight fit would move nothing while appearing to have been taught something.
 * 2. **A label is a decision, and the only accepted one is a person's.** `hide` on a real
 *    element says the product must remove that shape; `keep` says it is content and must
 *    survive. That is a statement about the page, made by someone who looked at it.
 * 3. **A harvested case cannot enter the graded corpus on its own.** These candidates
 *    are written to their own artifact and imported by nothing that grades, fits or
 *    calibrates. Promotion into `elementEvalCorpus.ts` is a human act, because the
 *    corpus carries the project's safety pins and a harvest queue is not a review.
 * 4. **A harvest record is someone's browsing.** The host is kept and the path is not,
 *    the rendered text is truncated to what the classifier's own vocabulary can use, and
 *    the candidate carries no URL. {@link redactHarvestSnapshot} is applied on the way
 *    in rather than on the way out, so an artifact on disk cannot hold more than the
 *    corpus cases already in the repository do.
 *
 * Selection is a queue, not a sample. A page can hold hundreds of candidates, one site
 * can be seen ten times a day, and a shape nobody has ruled on teaches nothing — so
 * unlabelled `Content` verdicts are dropped, repeats of the same shape on the same host
 * are collapsed into one candidate with a sighting count, per-host and total caps keep
 * one noisy site out of the queue, and anything older than the freshness window is
 * dropped because a page's DOM from last year is not evidence about this year's web.
 * What survives is sorted deterministically (the artifact is diff-checked in CI, so a
 * queue whose order depends on input order would fail that check on a machine that read
 * the records in a different order).
 *
 * This module is pure and holds no I/O, so the extension, the driver script and the
 * suite all go through exactly the same selection and labelling rules.
 */

import {
  ELEMENT_ACTIONS,
  ELEMENT_CLASSES,
  elementSignature,
  isElementSnapshot,
  type ElementAction,
  type ElementClass,
  type ElementSnapshot,
} from './elementClassifier.js';
import type { ElementEvalCase } from './elementEvalCorpus.js';

/** Rendered text kept per harvested element. The classifier reads words, not documents. */
export const HARVEST_TEXT_LIMIT = 120;

/** Default freshness window: a capture older than this is about a page that has moved on. */
export const HARVEST_DEFAULT_MAX_AGE_DAYS = 90;

/** Default per-host cap, so one site cannot fill the whole queue. */
export const HARVEST_DEFAULT_PER_HOST = 3;

/** Default total cap, the size of a review a person will actually sit through. */
export const HARVEST_DEFAULT_TOTAL = 200;

/** The verdict the shipping model gave a real element at capture time. Provenance only. */
export interface HarvestedVerdict {
  elementClass: ElementClass;
  action: ElementAction;
  confidence: number;
}

/**
 * A decision a person made about a real element: `hide` teaches the shape must be
 * removed, `keep` teaches it is content and must stay visible.
 */
export interface HarvestedHumanDecision {
  action: 'hide' | 'keep';
  /** Epoch ms of the decision. */
  at: number;
}

/** One real element captured from a real page, with where it came from. */
export interface HarvestedElement {
  /** Host of the page, never the URL: a path is personal and a corpus is not. */
  host: string;
  /** Epoch ms of capture. */
  capturedAt: number;
  /**
   * The classifier's signature for the shape. Optional, because it is derived from the
   * snapshot — a hand-written or hand-edited harvest file should not have to restate it.
   */
  signature?: string;
  /** What the model said at capture time. Recorded, never believed. */
  verdict: HarvestedVerdict;
  /** The element as the page had it. Redacted on the way in. */
  snapshot: ElementSnapshot;
  /** A person's decision on this element, when one exists. The only accepted label. */
  human?: HarvestedHumanDecision;
}

/** One shape on one host, collapsed from every sighting of it. */
export interface ElementHarvestCandidate {
  /** Stable id: the host and signature, so a re-run names the same candidate. */
  id: string;
  host: string;
  signature: string;
  /** Epoch ms of the first and most recent sighting. */
  firstSeen: number;
  lastSeen: number;
  /** How many times this shape was captured on this host. */
  sightings: number;
  /** The most assertive verdict seen, as provenance. Never a label. */
  observed: HarvestedVerdict;
  /** The person's decision, or `null` when nobody has ruled on this shape. */
  human: HarvestedHumanDecision | null;
  /** The element itself, redacted. */
  snapshot: ElementSnapshot;
}

export interface ElementHarvestOptions {
  /** Epoch ms to measure age against. Defaults to `Date.now()`. */
  now?: number;
  /** Captures older than this are dropped. */
  maxAgeDays?: number;
  /** Cap per host. */
  perHost?: number;
  /** Cap on the whole queue. */
  total?: number;
  /**
   * Keep unlabelled candidates whose verdict was actionable. Default true: they are
   * where the next defect is, and the report counts them separately from the labelled
   * ones so nobody mistakes the two.
   */
  includeUnlabelled?: boolean;
}

export interface ElementHarvestSelection {
  candidates: ElementHarvestCandidate[];
  /** Distinct hosts represented. */
  hosts: number;
  /** Records read. */
  records: number;
  /** Records that were not a usable capture at all. */
  rejected: number;
  /** Records dropped for being older than the freshness window. */
  stale: number;
  /** Repeat sightings of a shape that was already queued. */
  duplicates: number;
  /** Queued candidates carrying a person's decision, i.e. the ones a case can be built from. */
  labelled: number;
  /** Queued candidates nobody has ruled on. */
  unlabelled: number;
  /** Queued candidates dropped because a cap was reached. */
  capped: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isElementClass(value: unknown): value is ElementClass {
  return typeof value === 'string' && (ELEMENT_CLASSES as readonly string[]).includes(value);
}

function isElementAction(value: unknown): value is ElementAction {
  return typeof value === 'string' && (ELEMENT_ACTIONS as readonly string[]).includes(value);
}

/** True for a `hide`/`keep` decision with a usable timestamp. */
export function isHarvestedHumanDecision(value: unknown): value is HarvestedHumanDecision {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as HarvestedHumanDecision;
  if (candidate.action !== 'hide' && candidate.action !== 'keep') return false;
  return Number.isFinite(candidate.at) && candidate.at > 0;
}

/**
 * Trims a captured snapshot to what belongs in a corpus artifact.
 *
 * The rendered text is cut to {@link HARVEST_TEXT_LIMIT} characters — long enough for any
 * phrase the classifier reasons about (`advertising policy`, `sponsored content`), short
 * enough that an article body cannot ride along. Nothing else is touched: dropping
 * attributes or geometry would change what the case teaches, and the corpus already
 * stores exactly these fields.
 */
export function redactHarvestSnapshot(snapshot: ElementSnapshot): ElementSnapshot {
  const text = snapshot.text;
  if (typeof text !== 'string' || text.length <= HARVEST_TEXT_LIMIT) return snapshot;
  return { ...snapshot, text: text.slice(0, HARVEST_TEXT_LIMIT) };
}

/**
 * A validated record. The signature is the only field that changes on the way in: it is
 * derived from the snapshot when the capture did not carry one, so everything downstream
 * can rely on it being a string.
 */
export type SanitizedHarvestedElement = HarvestedElement & { signature: string };

/** The candidate id for a shape on a host. */
export function harvestCandidateId(host: string, signature: string): string {
  return `${host}/${signature}`;
}

/**
 * Validates one record from an untrusted harvest file.
 *
 * A harvest file is written by a browser and read by a script, so it is treated the way
 * any other external input is: field by field, with a usable record required rather than
 * a plausible one. Returns `null` for anything that is not a capture.
 */
export function sanitizeHarvestedElement(value: unknown): SanitizedHarvestedElement | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as HarvestedElement;
  if (!isElementSnapshot(candidate.snapshot)) return null;
  if (typeof candidate.host !== 'string' || candidate.host.length === 0) return null;
  if (!Number.isFinite(candidate.capturedAt) || candidate.capturedAt <= 0) return null;
  const verdict = candidate.verdict;
  if (
    !verdict ||
    typeof verdict !== 'object' ||
    !isElementClass(verdict.elementClass) ||
    !isElementAction(verdict.action) ||
    !Number.isFinite(verdict.confidence)
  ) {
    return null;
  }
  if (candidate.human !== undefined && !isHarvestedHumanDecision(candidate.human)) return null;
  const signature = typeof candidate.signature === 'string' && candidate.signature.length > 0
    ? candidate.signature
    : elementSignature(candidate.snapshot).exact;
  return {
    host: candidate.host.trim().toLowerCase(),
    capturedAt: candidate.capturedAt,
    signature,
    verdict: { ...verdict },
    snapshot: redactHarvestSnapshot(candidate.snapshot),
    ...(candidate.human ? { human: candidate.human } : {}),
  };
}

/** Validates a harvest file's contents, reporting how many records were unusable. */
export function sanitizeHarvestedElements(
  value: unknown,
): { records: SanitizedHarvestedElement[]; rejected: number } {
  if (!Array.isArray(value)) return { records: [], rejected: 0 };
  const records: SanitizedHarvestedElement[] = [];
  let rejected = 0;
  for (const entry of value) {
    const record = sanitizeHarvestedElement(entry);
    if (record) records.push(record);
    else rejected += 1;
  }
  return { records, rejected };
}

/**
 * How consequential an action is, least first.
 *
 * Stated here rather than taken from `ELEMENT_ACTIONS`, whose order is most aggressive
 * first for the display code that consumes it. Reading the array position for a comparison
 * would invert every judgement below, which is exactly the kind of quiet wrongness this
 * module exists to avoid.
 */
const ACTION_RANK: Record<ElementAction, number> = { leave: 0, suggest: 1, hide: 2 };

/** Whether a verdict is more assertive than another — the strongest a shape has been called. */
function moreAssertive(next: HarvestedVerdict, current: HarvestedVerdict): boolean {
  const byAction = ACTION_RANK[next.action] - ACTION_RANK[current.action];
  return byAction > 0 || (byAction === 0 && next.confidence > current.confidence);
}

/**
 * Collapses a harvest file into a reviewable queue.
 *
 * Order is the point of the function, not an afterthought: a queue that changes shape
 * when the same records arrive in a different order cannot be diff-checked, and this
 * artifact is generated and checked in CI like every other generated file here. So
 * labelled candidates come first (a decision already made is worth more than a new
 * sighting), then by how often the shape was met, then most recent, then by id.
 */
export function selectHarvestCandidates(
  records: readonly HarvestedElement[],
  options: ElementHarvestOptions = {},
): ElementHarvestSelection {
  const now = options.now ?? Date.now();
  const maxAge = (options.maxAgeDays ?? HARVEST_DEFAULT_MAX_AGE_DAYS) * DAY_MS;
  const perHost = options.perHost ?? HARVEST_DEFAULT_PER_HOST;
  const total = options.total ?? HARVEST_DEFAULT_TOTAL;
  const includeUnlabelled = options.includeUnlabelled !== false;

  const byShape = new Map<string, ElementHarvestCandidate>();
  let rejected = 0;
  let stale = 0;
  let duplicates = 0;

  for (const raw of records) {
    const record = sanitizeHarvestedElement(raw);
    if (!record) {
      rejected += 1;
      continue;
    }
    if (now - record.capturedAt > maxAge) {
      stale += 1;
      continue;
    }
    const id = harvestCandidateId(record.host, record.signature);
    const existing = byShape.get(id);
    if (!existing) {
      byShape.set(id, {
        id,
        host: record.host,
        signature: record.signature,
        firstSeen: record.capturedAt,
        lastSeen: record.capturedAt,
        sightings: 1,
        observed: { ...record.verdict },
        human: record.human ?? null,
        snapshot: record.snapshot,
      });
      continue;
    }
    duplicates += 1;
    existing.sightings += 1;
    existing.firstSeen = Math.min(existing.firstSeen, record.capturedAt);
    existing.lastSeen = Math.max(existing.lastSeen, record.capturedAt);
    if (moreAssertive(record.verdict, existing.observed)) existing.observed = { ...record.verdict };
    // A decision is never overwritten by a later undecided sighting of the same shape:
    // the person already ruled, and the newer record adds no authority over that.
    if (record.human && !existing.human) existing.human = record.human;
    if (!existing.human && !record.human && record.capturedAt >= existing.lastSeen) {
      existing.snapshot = record.snapshot;
    }
  }

  const interesting = [...byShape.values()].filter((candidate) => {
    if (candidate.human) return true;
    if (!includeUnlabelled) return false;
    // An undecided shape the model wants to leave alone is the overwhelming majority of
    // a real page and says nothing; an undecided shape it wants to act on is a verdict
    // nobody has reviewed, which is precisely the list worth reviewing.
    return candidate.observed.action !== 'leave';
  });

  interesting.sort((a, b) => {
    if (Boolean(a.human) !== Boolean(b.human)) return a.human ? -1 : 1;
    if (a.sightings !== b.sightings) return b.sightings - a.sightings;
    if (a.lastSeen !== b.lastSeen) return b.lastSeen - a.lastSeen;
    return a.id.localeCompare(b.id);
  });

  const kept: ElementHarvestCandidate[] = [];
  const perHostCount = new Map<string, number>();
  let capped = 0;
  for (const candidate of interesting) {
    if (kept.length >= total) {
      capped += 1;
      continue;
    }
    const used = perHostCount.get(candidate.host) ?? 0;
    if (used >= perHost) {
      capped += 1;
      continue;
    }
    perHostCount.set(candidate.host, used + 1);
    kept.push(candidate);
  }

  return {
    candidates: kept,
    hosts: new Set(kept.map((candidate) => candidate.host)).size,
    records: records.length,
    rejected,
    stale,
    duplicates,
    labelled: kept.filter((candidate) => candidate.human).length,
    unlabelled: kept.filter((candidate) => !candidate.human).length,
    capped,
  };
}

/**
 * The one harvest file format: JSONL, with `#` comment lines allowed.
 *
 * Three parties write or read these files — the extension (a drained export), the hub (the
 * file the user kept) and the driver script (the corpus queue's input) — so the format is
 * stated once, here, rather than three times in three places. JSONL rather than a JSON
 * array because the buffer is drained in pieces: an export that lost half its records to a
 * crash should cost those records, not the file. `#` comments because a harvest of real
 * pages is a file someone will want to annotate, and the ledger text format this project
 * already reads treats `#` as a comment for the same reason.
 */
export function renderHarvestFile(records: readonly HarvestedElement[], comment?: string): string {
  const lines: string[] = [];
  for (const line of (comment ?? '').split('\n')) {
    if (line.trim().length > 0) lines.push(`# ${line}`);
  }
  for (const record of records) {
    // Redacted on write as well as on read: a file that has just been drained should not
    // be able to hold more of a page than the corpus cases already in the repository.
    lines.push(JSON.stringify({ ...record, snapshot: redactHarvestSnapshot(record.snapshot) }));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Reads a harvest file, skipping what cannot be read.
 *
 * A line that does not parse, or that parses into something that is not a capture, is
 * counted and skipped rather than thrown on: this is a file of real pages that has been
 * through a download, a text editor and a merge, and one bad line must not hide the
 * records around it. The counts come back so a caller can report a short read rather than
 * quietly having one.
 */
export function parseHarvestFile(text: string): {
  records: SanitizedHarvestedElement[];
  rejected: number;
  comments: string[];
} {
  const records: SanitizedHarvestedElement[] = [];
  const comments: string[] = [];
  let rejected = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) {
      comments.push(trimmed.replace(/^#\s?/, ''));
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      rejected += 1;
      continue;
    }
    const record = sanitizeHarvestedElement(parsed);
    if (record) records.push(record);
    else rejected += 1;
  }
  return { records, rejected, comments };
}

/**
 * The corpus case a candidate would become, or `null` when nobody has labelled it.
 *
 * This is a **proposal**. It is written into the candidate artifact and read by nobody
 * that grades, fits or calibrates; promoting one means editing
 * `packages/core/src/ai/elementEvalCorpus.ts` on purpose, with the class checked by eye.
 *
 * The two labels map onto the two ends of the action band, which is the only part of a
 * case a click can honestly state:
 *
 *  - `keep` → `Content`, `leave` on both sides. The element is page content and hiding it
 *    is a defect; the class follows, because "this must stay visible" and "this is
 *    content" are the same statement about a real element.
 *  - `hide` → the three removal classes with `minAction: 'hide'`. A click says the
 *    product must remove this shape and says nothing about whether it is an ad, a
 *    tracker or a nag, so the class stays open — `expected[0]` is the canonical label by
 *    convention, which is why the note says plainly that a reviewer has to name it. The
 *    action, not the class, is what a click has established, and `hide` is the one that
 *    the corpus weighs most.
 */
export function proposeHarvestEvalCase(candidate: ElementHarvestCandidate): ElementEvalCase | null {
  if (!candidate.human) return null;
  const where = `${candidate.host} · ${candidate.signature} · ${candidate.sightings} sighting(s)`;
  if (candidate.human.action === 'keep') {
    return {
      label: `harvest-${candidate.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      family: 'harvest',
      snapshot: candidate.snapshot,
      expected: ['Content'],
      maxAction: 'leave',
      minAction: 'leave',
      notes: `Harvested from ${where}; a person marked this element "keep". Promotion is a review, not a merge.`,
    };
  }
  return {
    label: `harvest-${candidate.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
    family: 'harvest',
    snapshot: candidate.snapshot,
    expected: ['Ad', 'Tracker', 'Annoyance'],
    maxAction: 'hide',
    minAction: 'hide',
    notes:
      `Harvested from ${where}; a person marked this element "hide", which fixes the action and not the class. ` +
      'Name the class before promoting — `expected[0]` is canonical and is currently a placeholder.',
  };
}

/** A human-readable summary of a harvest run, for the driver script and the CLI. */
export function formatHarvestReport(selection: ElementHarvestSelection): string {
  const lines = [
    `   read     ${selection.records} record(s) from ${selection.hosts} host(s) in the queue`,
    `   queued   ${selection.candidates.length} candidate(s): ${selection.labelled} labelled, ${selection.unlabelled} unlabelled`,
  ];
  if (selection.duplicates > 0) lines.push(`   merged   ${selection.duplicates} repeat sighting(s) into an existing candidate`);
  if (selection.stale > 0) lines.push(`   dropped  ${selection.stale} stale capture(s)`);
  if (selection.rejected > 0) lines.push(`   dropped  ${selection.rejected} unusable record(s)`);
  if (selection.capped > 0) lines.push(`   deferred ${selection.capped} candidate(s) past the per-host and total caps`);
  lines.push(
    '   label    a person\'s decision is the only label; the model\'s own verdict is recorded as provenance',
  );
  lines.push('   promote  candidates are not graded — a case enters elementEvalCorpus.ts by hand');
  return lines.join('\n');
}
