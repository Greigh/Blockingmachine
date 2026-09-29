/**
 * Per-tier attribution of the blocks the browser actually reported.
 *
 * The rule-hit ledger answers "which filter lines matter". This answers the coarser question a
 * tier toggle actually turns on: **how much is each shipped tier blocking?**
 *
 * Attribution itself is exact. The browser names the `rulesetId` that won a match, each tier ships
 * exactly one ruleset, and that ruleset's declared id *is* the tier id — so a match either belongs
 * to a named tier or to nothing at all. No heuristics, no hostname guessing, and it works in a
 * packed build too, where the request URL is withheld but the ruleset is still reported.
 *
 * The *conclusion* is the part that needs care. A tier with no matches has either earned having its
 * place questioned, or has simply not been given a chance: it was just switched on, this session
 * was quiet, or blocking is paused. So a silent tier is only ever called idle once the ledger as a
 * whole has seen enough matches for silence to mean something, and a tier that is switched off is
 * never called idle at all — being off is *why* it has no matches. Getting that wrong is the
 * expensive mistake, because acting on it turns off blocking that was working.
 *
 * @beta
 */

import { isTierId, type StaticTierCategory, type StaticTierId } from './rulesetTiers.js';

/** Matches attributed to each tier. An absent tier means zero observed. */
export type TierHitCounts = Partial<Record<StaticTierId, number>>;

/**
 * Matches the ledger must have seen before a silent tier may be called idle.
 *
 * A heuristic, and deliberately stated as one: below it the honest answer is that the ledger does
 * not know yet. Fifty matches is roughly one ad-heavy page — enough to have exercised the tiers
 * that carry real traffic, while a single quiet tab proves nothing.
 */
export const TIER_HIT_MIN_SAMPLE = 50;

export type TierBlockingVerdict =
  /** Blocked something since it was switched on. */
  | 'productive'
  /** Enabled, with a real sample behind it, and it still never matched. */
  | 'idle'
  /** Enabled, but not enough matches yet to judge. */
  | 'unobserved'
  /** Switched off, so having no matches says nothing at all. */
  | 'disabled';

export interface TierAttributionCandidate {
  id: StaticTierId;
  label: string;
  category: StaticTierCategory;
}

export interface TierBlockingInput {
  tiers: readonly TierAttributionCandidate[];
  enabledIds: readonly StaticTierId[];
  hits: TierHitCounts;
  minSample?: number;
}

export interface TierBlockingView {
  id: StaticTierId;
  label: string;
  category: StaticTierCategory;
  enabled: boolean;
  hits: number;
  /** Share of all attributed tier matches, 0–1. */
  share: number;
  verdict: TierBlockingVerdict;
}

export interface TierBlockingSummary {
  tiers: TierBlockingView[];
  /** Every tier's matches summed — the denominator behind `share`. */
  totalHits: number;
  /** Whether the ledger has seen enough traffic for silence to be evidence. */
  observed: boolean;
  minSample: number;
  /** Enabled tiers that have never matched, with a meaningful sample behind that. */
  idle: TierBlockingView[];
  /** One line for a compact status row. */
  summary: string;
}

/** The tier a matched static ruleset belongs to, or null for anything that is not a tier. */
export function tierFromRulesetId(rulesetId: unknown): StaticTierId | null {
  return typeof rulesetId === 'string' && isTierId(rulesetId) ? rulesetId : null;
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * One line describing how much the tiers have actually blocked.
 * @beta
 */
export function formatTierBlocking(
  summary: Pick<TierBlockingSummary, 'tiers' | 'totalHits'>,
): string {
  if (summary.totalHits <= 0) return 'No tier blocks recorded yet';
  const firing = summary.tiers.filter((tier) => tier.hits > 0).length;
  return `${summary.totalHits.toLocaleString()} blocks from ${firing} of ${summary.tiers.length} tiers`;
}

/**
 * Grades each tier by what it has actually blocked, in catalogue order.
 * @beta
 */
export function buildTierBlocking(input: TierBlockingInput): TierBlockingSummary {
  // Annotated rather than inferred: `Array.isArray` narrows to `any[]`, which would take the
  // element type of the catalogue with it and silently allow any tier id to be indexed.
  const tiers: readonly TierAttributionCandidate[] = Array.isArray(input?.tiers) ? input.tiers : [];
  const enabled = new Set<StaticTierId>(input?.enabledIds || []);
  const hits: TierHitCounts = input?.hits || {};
  const requested = readCount(input?.minSample);
  const minSample = requested > 0 ? requested : TIER_HIT_MIN_SAMPLE;

  const counted = tiers.map((tier) => ({ tier, hits: readCount(hits[tier.id]) }));
  const totalHits = counted.reduce((sum, entry) => sum + entry.hits, 0);
  const observed = totalHits >= minSample;

  const views: TierBlockingView[] = counted.map(({ tier, hits: tierHits }) => {
    const isEnabled = enabled.has(tier.id);
    // Order matters: a disabled tier is never idle, a tier that fired is never idle, and only
    // once the ledger has a real sample does silence count against a tier.
    const verdict: TierBlockingVerdict = !isEnabled
      ? 'disabled'
      : tierHits > 0
      ? 'productive'
      : observed
      ? 'idle'
      : 'unobserved';
    return {
      id: tier.id,
      label: tier.label,
      category: tier.category,
      enabled: isEnabled,
      hits: tierHits,
      share: totalHits > 0 ? tierHits / totalHits : 0,
      verdict,
    };
  });

  return {
    tiers: views,
    totalHits,
    observed,
    minSample,
    idle: views.filter((view) => view.verdict === 'idle'),
    summary: formatTierBlocking({ tiers: views, totalHits }),
  };
}
