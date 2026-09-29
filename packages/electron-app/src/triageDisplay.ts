/**
 * How the triage cascade is shown in the AI Radar results list.
 *
 * The cascade already records what it did with every candidate — `TriageOutcomeSummary` rides on the
 * scan result itself — and the results list rendered none of it. A verdict the embedded classifier
 * settled in 0.05ms and one that cost a network round trip looked exactly alike, a candidate that was
 * ambiguous but over budget was indistinguishable from one nobody was unsure about, and `contested` —
 * the one case where the shipped list deliberately outranks the model — read as an ordinary verdict.
 *
 * So this module names the four outcomes as *buckets a reader can act on*, and puts the ambiguity
 * score next to the label that it explains: `CONTESTED 61%` says that a model was asked, that it
 * disagreed, and that the local block was kept anyway — which is the whole point of the cascade.
 *
 * What the record does *not* carry is whether an ordinary escalation agreed with the local verdict,
 * so nothing here claims it did. A chip that read "confirmed" would be asserting a fact the engine
 * never put on the result.
 *
 * Two properties are deliberate and pinned by tests rather than left to the caller:
 *
 *   - **The buckets are mutually exclusive**, resolved in one fixed order. `contested` wins over
 *     `escalated` because both are true (the model *was* consulted) and the disagreement is the
 *     part that matters.
 *   - **Nothing is invented.** A scan whose cascade was off carries no triage at all, and that is
 *     reported as `untracked` — never as "screened locally at 0% ambiguity", which is what a
 *     defaulted number would have claimed.
 *
 * Types only from `@blockingmachine/core`: this module is reachable from the renderer, and importing
 * the package for values would pull its Node-side modules into the renderer bundle.
 */

import type { FalsePositiveGuardResult, TriageOutcomeSummary } from './types';

/**
 * What the cascade did with one verdict, as the results list presents it.
 *
 * `untracked` means the scan carries no cascade record: the cascade was disabled when it ran, the
 * result came from a build that predates it, or the false-positive guard cleared the domain before
 * screening (see `wasClearedByGuard`). It is a real state, not an error.
 */
export type TriageDisplayBucket =
  | 'screened-locally'
  | 'escalated'
  | 'contested'
  | 'deferred'
  | 'untracked';

export interface TriageBucketMeta {
  /** Full name, for a legend or a tooltip. */
  label: string;
  /** Chip text. */
  short: string;
  /** What the bucket means, in one line. */
  description: string;
}

export const TRIAGE_BUCKET_META: Record<TriageDisplayBucket, TriageBucketMeta> = {
  'screened-locally': {
    label: 'Screened locally',
    short: 'SCREENED',
    description: 'The embedded classifier decided this on its own — no model call.',
  },
  escalated: {
    label: 'Escalated',
    short: 'ESCALATED',
    description: 'The local verdict was undecided, so the model was asked.',
  },
  contested: {
    label: 'Contested',
    short: 'CONTESTED',
    description: 'The model recommended clearing this and the local block was kept.',
  },
  deferred: {
    label: 'Deferred',
    short: 'DEFERRED',
    description: 'Undecided but over the escalation budget — the local verdict stands.',
  },
  untracked: {
    label: 'No cascade record',
    short: '',
    description:
      'No cascade record: the false-positive guard cleared this domain before screening, or the cascade was off when it was scanned.',
  },
};

/**
 * The marker core appends to `reasons` on a result the false-positive guard cleared before screening.
 *
 * Kept only as the fallback for records that predate `falsePositiveGuard` — a scan cached in a
 * running session, or a result held in a store across an upgrade. New results are read from the
 * field; see `wasClearedByGuard`.
 */
export const GUARD_REASON_MARKER = 'Protected by False Positive Guard';

/**
 * Whether the false-positive guard cleared this result before any screening ran.
 *
 * The field is authoritative; the `reasons` sentence is the fallback for records written before it
 * existed. A guard-cleared result and a cascade-off result are both clean with no `triage` entry, so
 * they are indistinguishable from the record alone — and they mean opposite things about a scan that
 * did run: one domain was skipped on purpose, the other was never offered to the cascade.
 *
 * The `verdict === 'clean'` requirement is not redundancy for the field path either. The guard's own
 * record is only ever written on a clean result, so a non-clean result carrying one is a malformed
 * record, and reading it as "cleared without screening" would be inventing a fact. Measured against
 * the real service (`provider: 'mini-ai'`, no network): `localhost`, `telemetry.vendor.example`,
 * `cdn-magiclinks.trackonomics.net` and `mixed-signal.analytics.example` all come back clean with no
 * `triage` and a guard record.
 */
export function wasClearedByGuard(result: ScreeningReadableResult | null | undefined): boolean {
  if (!result || typeof result !== 'object') return false;
  if (readTriage(result as { triage?: TriageOutcomeSummary | null })) return false;
  if (result.verdict !== 'clean') return false;

  const guard = result.falsePositiveGuard;
  if (guard && typeof guard === 'object' && guard.cleared === true) return true;

  const reasons = result.reasons;
  if (!Array.isArray(reasons)) return false;
  return reasons.some(
    (line) => typeof line === 'string' && line.includes(GUARD_REASON_MARKER),
  );
}

/**
 * The ambiguity at which the cascade starts considering a second opinion.
 *
 * Mirrors `DEFAULT_TRIAGE_OPTIONS.minAmbiguity` in core, because the display has to mark the same
 * line the engine acts on — a row shown as "high" ambiguity that the cascade never would have
 * escalated is a lie in the other direction. Restated rather than imported so the renderer bundle
 * stays free of the engine, and pinned by a test that compares the two.
 */
export const TRIAGE_AMBIGUITY_BAR = 0.5;

export type AmbiguityTone = 'low' | 'medium' | 'high' | 'unknown';

/** Reads a triage record off a result defensively; a malformed one is "untracked", never a guess. */
function readTriage(
  result: { triage?: TriageOutcomeSummary | null } | null | undefined,
): TriageOutcomeSummary | null {
  if (!result || typeof result !== 'object') return null;
  const triage = result.triage;
  if (!triage || typeof triage !== 'object') return null;
  return triage;
}

/**
 * Which bucket a result belongs to.
 *
 * Order matters and is the contract: `contested` is checked first because a contested escalation also
 * has `action: 'escalate'`, and the disagreement is the more useful fact. A record whose action is
 * unrecognised is `untracked` — a bucket named after the engine's own vocabulary should not be
 * assigned by elimination.
 */
export function triageBucketOf(
  triage: TriageOutcomeSummary | null | undefined,
): TriageDisplayBucket {
  if (!triage || typeof triage !== 'object') return 'untracked';
  if (triage.source === 'contested') return 'contested';
  if (triage.action === 'deferred') return 'deferred';
  if (triage.action === 'escalate') return 'escalated';
  if (triage.action === 'resolve-locally') return 'screened-locally';
  return 'untracked';
}

/** The bucket for a whole result, rather than for a triage record on its own. */
export function triageBucketOfResult(
  result: { triage?: TriageOutcomeSummary | null } | null | undefined,
): TriageDisplayBucket {
  return triageBucketOf(readTriage(result));
}

/**
 * The ambiguity score as a percentage, or null when it was never recorded.
 *
 * Null rather than `0%` on purpose: an unscored candidate and a candidate the engine scored as
 * perfectly decided are different facts, and a defaulted zero would hide the difference.
 */
export function formatAmbiguity(ambiguity: number | null | undefined): string | null {
  if (typeof ambiguity !== 'number' || !Number.isFinite(ambiguity)) return null;
  const clamped = Math.max(0, Math.min(1, ambiguity));
  return `${Math.round(clamped * 100)}%`;
}

/** Which side of the escalation bar an ambiguity score sits on. */
export function ambiguityTone(ambiguity: number | null | undefined): AmbiguityTone {
  if (typeof ambiguity !== 'number' || !Number.isFinite(ambiguity)) return 'unknown';
  const clamped = Math.max(0, Math.min(1, ambiguity));
  if (clamped >= TRIAGE_AMBIGUITY_BAR) return 'high';
  if (clamped >= TRIAGE_AMBIGUITY_BAR / 2) return 'medium';
  return 'low';
}

/**
 * The chip's text for a result.
 *
 * A failed escalation is spelled out rather than folded into `ESCALATED`: the verdict on screen is
 * the *local* one, and a reader who thinks a model confirmed it would be wrong about the strongest
 * evidence behind the row.
 */
export function triageChipLabel(triage: TriageOutcomeSummary | null | undefined): string {
  const bucket = triageBucketOf(triage);
  if (bucket === 'escalated' && triage?.escalationFailed) return 'ESCALATED (FAILED)';
  return TRIAGE_BUCKET_META[bucket].short;
}

/** The sentence naming where the displayed verdict came from. */
export function triageChipTitle(triage: TriageOutcomeSummary | null | undefined): string {
  const bucket = triageBucketOf(triage);
  if (bucket === 'untracked') return TRIAGE_BUCKET_META.untracked.description;

  const model = typeof triage?.model === 'string' && triage.model.trim() ? triage.model.trim() : null;

  if (bucket === 'contested') {
    return `Contested — ${model ?? 'the model'} recommended clearing this, but the local verdict rests on name-based evidence, so the block was kept.`;
  }
  if (bucket === 'deferred') {
    return 'Deferred — undecided, but this session\u2019s escalation budget was already spent. The local verdict stands.';
  }
  if (bucket === 'escalated') {
    if (triage?.escalationFailed) {
      return 'Escalation attempted and failed — the embedded classifier\u2019s verdict stands in its place.';
    }
    if (triage?.contradicted) {
      return `Escalated to ${model ?? 'the model'}, whose recommendation was not applied — the local verdict stands.`;
    }
    // No claim about agreement: `TriageOutcomeSummary` records the escalation and the model, not
    // whether the two verdicts matched, so a chip that said "confirmed" would be asserting a fact
    // the engine never put on the result.
    return `Escalated to ${model ?? 'the model'} — the local screening was undecided, so the escalation\u2019s verdict was applied.`;
  }
  return 'Screened locally — the embedded classifier decided this without a model call.';
}

/** The engine's own per-signal explanations, in the order it recorded them. */
export function triageExplanationLines(
  triage: TriageOutcomeSummary | null | undefined,
): string[] {
  if (!triage || typeof triage !== 'object' || !Array.isArray(triage.explanations)) return [];
  return triage.explanations.filter(
    (line): line is string => typeof line === 'string' && line.trim().length > 0,
  );
}

/** The cascade's signal codes that fired, as the engine recorded them. */
export function triageSignalCodes(triage: TriageOutcomeSummary | null | undefined): string[] {
  if (!triage || typeof triage !== 'object' || !Array.isArray(triage.signals)) return [];
  return triage.signals.filter(
    (code): code is string => typeof code === 'string' && code.trim().length > 0,
  );
}

/**
 * Everything the display reads off a scan result.
 *
 * Structural rather than `AiScanResult` so a caller can summarize a projection of a result (the
 * crawl list builds its own rows) without fabricating the fields it does not carry — and so a test
 * can hand over exactly the malformed shapes this layer is supposed to refuse.
 */
export interface ScreeningReadableResult {
  verdict?: string;
  reasons?: unknown;
  triage?: TriageOutcomeSummary | null;
  falsePositiveGuard?: FalsePositiveGuardResult | null;
}

export interface TriageBucketTally {
  bucket: TriageDisplayBucket;
  label: string;
  count: number;
}

export interface TriageBucketSummary {
  tallies: TriageBucketTally[];
  /** Verdicts that carry a cascade record. */
  tracked: number;
  /** Verdicts in the list, tracked or not. */
  total: number;
  /**
   * Untracked verdicts the false-positive guard cleared before screening.
   *
   * A subset of the untracked count, named separately because the two read the same on a result and
   * mean opposite things: a guard-cleared domain was deliberately skipped, a cascade-off domain was
   * never offered to the cascade at all.
   */
  clearedByGuard: number;
  /**
   * Model calls per tracked verdict, 0-1.
   *
   * A contested verdict counts: a model call *was* made. That is also how core's
   * `TriageStats.escalationRate` counts it (a contested item's plan action is `escalate`), so the
   * row summary and the engine's own statistics agree on the same input.
   */
  escalationRate: number;
}

/**
 * Counts a result list by bucket.
 *
 * Every result lands in exactly one bucket, including the untracked ones, so the counts always add
 * up to the list length — a summary that silently dropped unscanned results would overstate the
 * cascade's coverage.
 */
export function summarizeTriageBuckets(
  results: ReadonlyArray<ScreeningReadableResult | null | undefined> | null | undefined,
): TriageBucketSummary {
  const list = Array.isArray(results) ? results : [];
  const counts: Record<TriageDisplayBucket, number> = {
    'screened-locally': 0,
    escalated: 0,
    contested: 0,
    deferred: 0,
    untracked: 0,
  };
  let clearedByGuard = 0;
  for (const result of list) {
    counts[triageBucketOfResult(result)] += 1;
    if (wasClearedByGuard(result)) clearedByGuard += 1;
  }

  const tracked = list.length - counts.untracked;
  const tallies = (
    ['screened-locally', 'escalated', 'contested', 'deferred', 'untracked'] as const
  )
    .map((bucket) => ({
      bucket,
      label: TRIAGE_BUCKET_META[bucket].label,
      count: counts[bucket],
    }))
    .filter((tally) => tally.count > 0);

  return {
    tallies,
    tracked,
    total: list.length,
    clearedByGuard,
    escalationRate: tracked === 0 ? 0 : (counts.escalated + counts.contested) / tracked,
  };
}

/**
 * One line for the list header, or null when there is nothing truthful to say.
 *
 * Null when no result carries a cascade record: an empty cascade summary rendered as
 * `0 screened locally` would read as "the cascade decided nothing", when the fact is that it was not
 * running. Zero `contested` and `deferred` are dropped for the opposite reason — they are notable
 * only when they happen — while `untracked` is always named when it is non-zero, so a half-covered
 * list cannot pass for a fully screened one.
 */
export function formatTriageBucketSummary(
  results: ReadonlyArray<ScreeningReadableResult | null | undefined> | null | undefined,
): string | null {
  const { tallies, tracked, total, escalationRate, clearedByGuard } =
    summarizeTriageBuckets(results);
  if (tracked === 0) return null;

  const countOf = (bucket: TriageDisplayBucket): number =>
    tallies.find((tally) => tally.bucket === bucket)?.count ?? 0;
  const rate = `${(escalationRate * 100).toFixed(1)}%`;

  const parts = [`${countOf('screened-locally')} screened locally`];
  const escalated = countOf('escalated');
  const contested = countOf('contested');
  parts.push(`${escalated} escalated`);
  if (contested > 0) parts.push(`${contested} contested`);
  const deferred = countOf('deferred');
  if (deferred > 0) parts.push(`${deferred} deferred`);
  parts.push(`${escalated + contested} model call${escalated + contested === 1 ? '' : 's'} (${rate})`);

  // Split by cause, because the two mean opposite things: a guard-cleared domain was skipped on
  // purpose, an unrecorded one was never offered to the cascade. The counts are exhaustive — the
  // two add back up to the untracked total — so nothing is dropped in the split.
  const guardCleared = Math.min(clearedByGuard, total - tracked);
  if (guardCleared > 0) {
    parts.push(`${guardCleared} cleared before screening`);
  }
  const unrecorded = total - tracked - guardCleared;
  if (unrecorded > 0) parts.push(`${unrecorded} without a cascade record`);

  return parts.join(' \u00b7 ');
}
