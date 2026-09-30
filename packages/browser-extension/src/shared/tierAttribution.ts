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

export interface PlanBenefitView {
  /**
   * Per-tier measured blocks, or null when the ledger cannot judge every tier.
   *
   * Null is the common case and it is a real answer, not a failure: a plan weighted by evidence
   * has to compare measured against measured, and until the ledger has judged every tier that the
   * plan might enable, it has not.
   */
  benefits: TierHitCounts | null;
  source: 'evidence' | 'coverage';
  /** Why the plan is or is not evidence-weighted, in words the popup can put in front of a user. */
  reason: string;
  /** Tiers the ledger cannot speak for, in catalogue order. */
  unmeasured: StaticTierId[];
}

/**
 * Decides whether the ledger has earned the right to weight the tier plan, and with what.
 *
 * ## Why this is a decision rather than a lookup
 *
 * The obvious wiring — hand the planner each tier's hit count and let it optimise — is wrong in a
 * way that only shows up once it is running, because **a disabled tier's zero is not a
 * measurement**. A tier that is switched off cannot block anything, so it accumulates no matches,
 * and a plan that read those zeros as "worthless" would rank every tier the user had ever turned
 * off below every tier they had left on. That is not evidence, it is an artefact of the switch,
 * and it would make the planner systematically argue for re-enabling tiers the user deliberately
 * disabled — the exact opposite of what a measurement is for.
 *
 * So the gate is the verdicts already computed for the blocking card, which already know the
 * difference:
 *
 *   - **`productive`** — fired while on. A real measurement, and still a real measurement for a
 *     tier that has since been switched off, because switching a tier *off* keeps its history and
 *     only switching it *on* clears it. That is what makes this useful rather than permanently
 *     unreachable: a user who tries each tier once has a measurement for all four.
 *   - **`idle`** — on, with a real sample behind it, and never matched. Zero *is* the measurement
 *     here, and it is the verdict that matters most: it is how a tier that has been given a fair
 *     chance earns its way out of a congested plan.
 *   - **`unobserved`** — on, but the ledger has not seen enough traffic to say. Not a zero.
 *   - **`disabled`** — off, so its silence is the switch and not the tier.
 *
 * Only `productive` and `idle` count as measured, plus any tier with a retained history — a tier
 * that fired before it was switched off has a real number, whatever its verdict says. Anything
 * else and the whole plan falls back to rule counts, because a blend would rank a tier with no
 * evidence against a tier with a number, and the no-evidence tier always loses.
 *
 * ## Why the benefit is raw blocks and not a rate
 *
 * The planner maximises a *sum* under a slot constraint, so the benefit has to be denominated in
 * the thing being maximised. A tier that blocked 1,204 requests has earned more than one that
 * blocked three, whatever their rule counts; dividing by rules would throw that away and reward a
 * small tier for being small. The rule counts still do their job — they are the *cost* side of
 * every comparison, which is how a 435-rule tier that earned its slots can outrank a 23,523-rule
 * tier that has not.
 *
 * Ages are comparable because the ledger clears a tier's counts when the tier is switched on, so
 * every measurement starts from the moment that tier was given its chance.
 *
 * @beta
 */
export function planTierBenefits(summary: TierBlockingSummary): PlanBenefitView {
  const views = summary?.tiers ?? [];
  const observed = summary?.observed === true;

  // Asked as a question about *history* rather than read off the verdict, because the two differ
  // in exactly the case that matters: `buildTierBlocking` calls a switched-off tier `disabled`
  // whatever its counts say, because for the blocking card "is it idle" is the wrong question
  // about something that was never on. Here the question is whether a number exists at all, and a
  // tier that fired 12 times before it was turned off does have one — switching a tier off keeps
  // its history and only switching it on clears it. Without this, the ledger's own retention rule
  // would be contradicted by the gate and the evidence basis would be unreachable for anyone who
  // had ever turned a tier off.
  const hasMeasurement = (view: TierBlockingView): boolean =>
    view.hits > 0 || (view.enabled && observed);

  // An empty catalogue satisfies "every tier is measured" vacuously, which would claim evidence
  // for nothing at all. There is no plan to weight, so the honest answer is coverage.
  if (views.length === 0) {
    return { benefits: null, source: 'coverage', unmeasured: [], reason: 'No tiers to plan.' };
  }

  const unmeasured = views.filter((view) => !hasMeasurement(view));

  if (unmeasured.length > 0) {
    const labels = unmeasured.map(
      (view) =>
        `${view.label} (${view.enabled ? 'not enough traffic yet' : 'switched off with no history'})`,
    );
    return {
      benefits: null,
      source: 'coverage',
      unmeasured: unmeasured.map((view) => view.id),
      reason:
        `Planned by rule count: the ledger has not measured ${labels.join(', ')}. A tier that is ` +
        `switched off cannot block, so its silence is the switch rather than the tier — planning by ` +
        `the numbers would rank every tier you had turned off as worthless. Give each tier one session ` +
        `on and this becomes a plan weighted by what actually blocked.`,
    };
  }

  const benefits: TierHitCounts = {};
  for (const view of views) benefits[view.id] = view.hits;
  const idleCount = views.filter((view) => view.hits === 0).length;
  return {
    benefits,
    source: 'evidence',
    unmeasured: [],
    reason:
      `Weighted by what actually blocked: ${summary.totalHits.toLocaleString()} attributed ` +
      `block${summary.totalHits === 1 ? '' : 's'} across ${views.length} tier${views.length === 1 ? '' : 's'}` +
      `${idleCount > 0 ? `, including ${idleCount} that never fired` : ''}.`,
  };
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
