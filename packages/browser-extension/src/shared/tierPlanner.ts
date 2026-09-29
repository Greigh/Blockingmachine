/**
 * Capacity-aware static tier planner.
 *
 * Manifest V3 gives an extension two rule budgets that never compete: **static** rules
 * (manifest-declared rulesets, toggled at runtime) and **dynamic** rules (written by the sync
 * pipeline, capped by the pipeline's own watermark). "Enable everything" is the right answer
 * only while the static budget can hold everything — and that is not guaranteed.
 *
 * Chrome's 30,000 static rules is a *floor*, not a promise. The figure is drawn from a global
 * pool shared across every installed extension, which is exactly why
 * `chrome.declarativeNetRequest.getAvailableStaticRuleCount()` exists and why the tier files
 * are compiled to a total that fits the floor. When the pool is congested the extension is
 * granted less than the shipped total, and then a choice has to be made: which tiers earn the
 * slots that remain. That choice is this module's whole job.
 *
 * The planner is deliberately pure — no `chrome.*`, no clock. It is arithmetic over numbers a
 * caller has already gathered, so the recommendation and the sentence explaining it can both
 * be asserted in a test.
 *
 * ## What "maximises blocking" means here
 *
 * Benefit defaults to a tier's rule count, because for a blocklist a rule is a host and a host
 * is coverage. A caller holding measured evidence (the rule-hit ledger attributes real blocks
 * to the rules that fired) can supply an explicit `benefit` per tier instead, and the plan
 * says which basis it used. The two never mix: a plan is either entirely evidence-weighted or
 * entirely coverage-weighted, because a blend would silently make an unmeasured tier look
 * worthless.
 *
 * @beta
 */

import { MV3_STATIC_LIMITS, type StaticTierId } from './rulesetTiers.js';

/** One tier as the planner sees it. */
export interface TierPlanCandidate {
  id: StaticTierId;
  label: string;
  /** Rules this tier costs from the static budget. */
  ruleCount: number;
  /** Measured blocking benefit. Omit on every tier to plan by coverage instead. */
  benefit?: number;
}

/** What the dynamic (synced) budget currently looks like. */
export interface DynamicBudgetView {
  used: number;
  /** The browser's hard ceiling. */
  max?: number;
  /** The sync pipeline's own ceiling, held below `max` on purpose. */
  watermark?: number;
}

export interface TierPlanInput {
  tiers: readonly TierPlanCandidate[];
  /** Rules already active from the tiers enabled right now, used to derive live capacity. */
  enabledRuleCount?: number;
  /** From `getAvailableStaticRuleCount()`. Null or absent when the browser will not say. */
  availableStaticRules?: number | null;
  dynamic?: DynamicBudgetView | null;
  /** Blocking is paused everywhere: enabling tiers adds no blocking while it is. */
  suspended?: boolean;
  /** Tiers the user pinned on. They are honoured even if the plan then overshoots. */
  keep?: readonly StaticTierId[];
  /** The current selection, so the plan can say whether applying it would change anything. */
  currentEnabled?: readonly StaticTierId[];
}

export interface TierPlanDisabled {
  id: StaticTierId;
  label: string;
  ruleCount: number;
  reason: string;
  /** How many static slots short of fitting this tier was, when that is why it lost. */
  shortfall?: number;
}

export interface TierPlanDynamic {
  used: number;
  max: number;
  watermark: number;
  /** `max - used`. */
  headroom: number;
  withinMax: boolean;
  withinWatermark: boolean;
}

export interface TierPlan {
  enabled: StaticTierId[];
  disabled: TierPlanDisabled[];
  enabledRules: number;
  totalRules: number;
  staticCapacity: number;
  /** Capacity still unused by the plan. */
  staticHeadroom: number;
  capacitySource: 'browser' | 'guaranteed';
  /** The pinned tiers alone already exceed capacity. */
  overCapacity: boolean;
  /** Which budget actually forced the decision. */
  bindingConstraint: 'static' | 'dynamic' | 'none';
  benefit: number;
  benefitSource: 'evidence' | 'coverage';
  dynamic: TierPlanDynamic | null;
  /** Ordered lines of prose explaining the tradeoff, ready for the popup. */
  explanation: string[];
  suspended: boolean;
  differsFromCurrent: boolean;
}

/** The sync pipeline's watermark, mirrored so a plan can reason about the same ceiling. */
export const DYNAMIC_RULE_LIMITS = {
  DEFAULT_MAX: MV3_STATIC_LIMITS.GUARANTEED_STATIC_RULES,
  SAFE_WATERMARK: 28500,
} as const;

/**
 * Beyond this many tiers an exhaustive search is no longer free, so the planner falls back to
 * a greedy pass. The shipped catalogue has four; this only guards a future with dozens.
 */
const EXHAUSTIVE_TIER_LIMIT = 16;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `used` clamped into `[0, max]`, so a bogus reading cannot produce nonsense sentences. */
function clampUsed(used: number, max: number): number {
  if (!isFiniteNumber(used) || used < 0) return 0;
  return Math.min(used, max);
}

/**
 * Chooses the tier selection that maximises blocking inside the static budget.
 *
 * Exhaustive rather than greedy: with a handful of tiers, enumerating every subset is exact,
 * instant, and removes the ordering bugs a greedy pass invites (the compiler's redistribution
 * had exactly that bug). Ties are broken toward *fewer rules used*, so a plan leaves static
 * headroom for the next compilation instead of sitting flush against the ceiling, and then by
 * catalogue order, so the outcome is deterministic.
 * @beta
 */
export function planTierSelection(input: TierPlanInput): TierPlan {
  const tiers = Array.isArray(input?.tiers) ? input.tiers : [];
  const keep = new Set(input?.keep || []);
  const suspended = input?.suspended === true;

  // ── Static capacity ────────────────────────────────────────────────────────────
  // `getAvailableStaticRuleCount()` reports what can still be *added*, so live capacity is
  // what is already enabled plus what is left. A browser that will not answer leaves the
  // guaranteed floor, which is the figure the tier files were compiled against.
  const liveAvailable = isFiniteNumber(input?.availableStaticRules)
    ? Math.max(0, input.availableStaticRules as number)
    : null;
  const enabledRuleCount = isFiniteNumber(input?.enabledRuleCount)
    ? Math.max(0, input.enabledRuleCount as number)
    : 0;
  const capacitySource: TierPlan['capacitySource'] =
    liveAvailable === null ? 'guaranteed' : 'browser';
  const staticCapacity =
    liveAvailable === null
      ? MV3_STATIC_LIMITS.GUARANTEED_STATIC_RULES
      : enabledRuleCount + liveAvailable;

  // ── Benefit basis ──────────────────────────────────────────────────────────────
  const everyTierMeasured =
    tiers.length > 0 && tiers.every((tier) => isFiniteNumber(tier?.benefit));
  const benefitSource: TierPlan['benefitSource'] = everyTierMeasured ? 'evidence' : 'coverage';
  const benefitOf = (tier: TierPlanCandidate): number =>
    benefitSource === 'evidence' ? Math.max(0, tier.benefit as number) : Math.max(0, tier.ruleCount);

  // ── Selection ──────────────────────────────────────────────────────────────────
  const keepIndexes = tiers
    .map((tier, index) => (keep.has(tier.id) ? index : -1))
    .filter((index) => index >= 0);

  // Tracked as primitives rather than one nullable object: a closure assigning into a union
  // defeats TypeScript's narrowing, and the casts that workaround needs hide real mistakes.
  let bestIndexes: number[] | null = null;
  let bestBenefit = -1;
  let bestRules = 0;

  const keepRules = keepIndexes.reduce((sum, i) => sum + Math.max(0, tiers[i].ruleCount), 0);

  const consider = (indexes: number[]) => {
    const rules = indexes.reduce((sum, i) => sum + Math.max(0, tiers[i].ruleCount), 0);
    const benefit = indexes.reduce((sum, i) => sum + benefitOf(tiers[i]), 0);
    // A pinned tier is a user decision, not a suggestion. When the pins alone exceed the
    // budget the pinned-only selection is still the plan — the caller surfaces `overCapacity`
    // rather than the planner quietly discarding what the user asked for.
    const pinnedOnlyOverBudget =
      keepIndexes.length > 0 && keepRules > staticCapacity && indexes.length === keepIndexes.length;
    if (rules > staticCapacity && !pinnedOnlyOverBudget) return;
    if (
      bestIndexes === null ||
      benefit > bestBenefit ||
      (benefit === bestBenefit && rules < bestRules) ||
      // Final tiebreak: catalogue order, so {core, ads} beats {core, privacy} regardless of
      // how the caller happened to order equal-benefit tiers.
      (benefit === bestBenefit && rules === bestRules && indexes.join(',') < bestIndexes.join(','))
    ) {
      bestIndexes = indexes;
      bestBenefit = benefit;
      bestRules = rules;
    }
  };

  if (tiers.length <= EXHAUSTIVE_TIER_LIMIT) {
    const optional = tiers.map((_, index) => index).filter((index) => !keepIndexes.includes(index));
    const combinations = 1 << optional.length;
    for (let mask = 0; mask < combinations; mask += 1) {
      const indexes = [...keepIndexes];
      for (let bit = 0; bit < optional.length; bit += 1) {
        if (mask & (1 << bit)) indexes.push(optional[bit]);
      }
      consider(indexes.sort((a, b) => a - b));
    }
  } else {
    // Greedy fallback: pinned tiers first, then whatever else fits by benefit per rule.
    const indexes = [...keepIndexes];
    const rest = tiers
      .map((tier, index) => ({ index, tier }))
      .filter(({ index }) => !keepIndexes.includes(index))
      .sort((a, b) => {
        const densityA = benefitOf(a.tier) / Math.max(1, a.tier.ruleCount);
        const densityB = benefitOf(b.tier) / Math.max(1, b.tier.ruleCount);
        if (densityB !== densityA) return densityB - densityA;
        return a.index - b.index;
      });
    for (const { index } of rest) {
      const proposed = [...indexes, index];
      const rules = proposed.reduce((sum, i) => sum + Math.max(0, tiers[i].ruleCount), 0);
      if (rules <= staticCapacity) indexes.push(index);
    }
    consider(indexes.sort((a, b) => a - b));
  }

  const selected = bestIndexes === null ? [] : [...(bestIndexes as number[])];
  const selectedSet = new Set(selected);
  const enabledTiers = selected.map((index) => tiers[index]);
  const enabled = enabledTiers.map((tier) => tier.id);
  const enabledRules = enabledTiers.reduce((sum, tier) => sum + Math.max(0, tier.ruleCount), 0);
  const totalRules = tiers.reduce((sum, tier) => sum + Math.max(0, tier.ruleCount), 0);

  // ── Why each excluded tier lost ────────────────────────────────────────────────
  const disabled: TierPlanDisabled[] = tiers
    .map((tier, index) => ({ tier, index }))
    .filter(({ index }) => !selectedSet.has(index))
    .map(({ tier }) => {
      const ruleCount = Math.max(0, tier.ruleCount);
      const withTier = enabledRules + ruleCount;
      // Two genuinely different failures, and conflating them produces a sentence that reads
      // as nonsense: a tier too big for the budget on its own has not lost to its neighbours,
      // it simply cannot be expressed at all.
      const aloneShortfall = Math.max(0, ruleCount - staticCapacity);
      if (aloneShortfall > 0) {
        return {
          id: tier.id,
          label: tier.label,
          ruleCount,
          shortfall: aloneShortfall,
          reason:
            `Larger than the whole static budget on its own — ${ruleCount.toLocaleString()} rules against ` +
            `${staticCapacity.toLocaleString()} slots — so no combination of the other tiers can make room for it.`,
        };
      }
      const shortfall = Math.max(0, withTier - staticCapacity);
      if (shortfall > 0) {
        return {
          id: tier.id,
          label: tier.label,
          ruleCount,
          shortfall,
          reason:
            `Would need ${shortfall.toLocaleString()} more static slot${shortfall === 1 ? '' : 's'} alongside the ` +
            `tiers kept, so enabling it as well would fail.`,
        };
      }
      return {
        id: tier.id,
        label: tier.label,
        ruleCount,
        reason: 'Left off because the tiers kept deliver more blocking per static slot.',
      };
    });

  // ── Dynamic budget ─────────────────────────────────────────────────────────────
  let dynamic: TierPlanDynamic | null = null;
  if (input?.dynamic) {
    const max = isFiniteNumber(input.dynamic.max)
      ? Math.max(0, input.dynamic.max)
      : DYNAMIC_RULE_LIMITS.DEFAULT_MAX;
    const watermark = isFiniteNumber(input.dynamic.watermark)
      ? Math.max(0, Math.min(input.dynamic.watermark, max))
      : Math.min(DYNAMIC_RULE_LIMITS.SAFE_WATERMARK, max);
    const used = clampUsed(input.dynamic.used, max);
    dynamic = {
      used,
      max,
      watermark,
      headroom: Math.max(0, max - used),
      withinMax: used <= max,
      withinWatermark: used <= watermark,
    };
  }

  // ── Which budget actually forced the decision ──────────────────────────────────
  const allTiersSelected = selected.length === tiers.length;
  let bindingConstraint: TierPlan['bindingConstraint'] = 'none';
  if (tiers.length > 0 && !allTiersSelected) bindingConstraint = 'static';
  else if (dynamic && !dynamic.withinWatermark) bindingConstraint = 'dynamic';

  const staticHeadroom = Math.max(0, staticCapacity - enabledRules);
  const overCapacity = enabledRules > staticCapacity;
  const currentEnabled = Array.isArray(input?.currentEnabled) ? [...input.currentEnabled] : null;
  const differsFromCurrent =
    currentEnabled === null
      ? false
      : currentEnabled.length !== enabled.length ||
        [...currentEnabled].sort().join(',') !== [...enabled].sort().join(',');

  // ── The tradeoff, in prose ────────────────────────────────────────────────────
  const explanation: string[] = [];

  explanation.push(
    capacitySource === 'browser'
      ? `The browser is granting ${staticCapacity.toLocaleString()} static slots right now ` +
          `(${enabledRuleCount.toLocaleString()} already active plus ${(liveAvailable as number).toLocaleString()} available).`
      : `Static rules are capped at Chrome's guaranteed ${staticCapacity.toLocaleString()} slots — ` +
          `the browser did not report a live figure, so this is the floor the tiers were compiled against.`,
  );

  if (tiers.length > 0) {
    explanation.push(
      allTiersSelected
        ? `All ${tiers.length} tiers fit: ${enabledRules.toLocaleString()} of ${totalRules.toLocaleString()} shipped rules can stay on.`
        : `Keeping ${enabled.length} of ${tiers.length} tiers — ${enabledRules.toLocaleString()} rules — because ` +
          `${totalRules.toLocaleString()} shipped rules no longer fit in ${staticCapacity.toLocaleString()} slots.`,
    );
  }

  for (const entry of disabled) {
    explanation.push(`${entry.label}: ${entry.reason}`);
  }

  if (staticHeadroom > 0 && tiers.length > 0) {
    explanation.push(
      `${staticHeadroom.toLocaleString()} static slot${staticHeadroom === 1 ? '' : 's'} stay free, so the next ` +
        `compilation still has room to grow.`,
    );
  }

  if (dynamic) {
    explanation.push(
      `The synced list uses ${dynamic.used.toLocaleString()} of ${dynamic.max.toLocaleString()} dynamic slots. ` +
        `Static tiers never consume that quota, so the two budgets are separate: these tiers block hosts the ` +
        `synced list has no room for.`,
    );
    if (!dynamic.withinWatermark) {
      // Only call the dynamic budget "the tight one" when it actually forced the plan. Saying
      // it while the static budget was binding contradicts the recommendation above it.
      explanation.push(
        bindingConstraint === 'dynamic'
          ? `That makes the dynamic budget the tight one — ${dynamic.used.toLocaleString()} is past the ` +
              `${dynamic.watermark.toLocaleString()} watermark, so hosts that cannot be expressed as a static zone ` +
              `block (path-scoped rules) are the ones losing out.`
          : `The synced list is also over its own ${dynamic.watermark.toLocaleString()} watermark ` +
              `(${dynamic.used.toLocaleString()} used), so the dynamic side is congested too — but the static ` +
              `budget is what forced this plan.`,
      );
    }
  }

  if (suspended) {
    explanation.push(
      'Nothing is blocking right now because blocking is paused everywhere; this is the selection that comes back on resume.',
    );
  }

  if (overCapacity) {
    explanation.push(
      'This selection is kept pinned beyond capacity — the browser will refuse the rulesets until it can grant them.',
    );
  }

  return {
    enabled,
    disabled,
    enabledRules,
    totalRules,
    staticCapacity,
    staticHeadroom,
    capacitySource,
    overCapacity,
    bindingConstraint,
    benefit: bestIndexes === null ? 0 : bestBenefit,
    benefitSource,
    dynamic,
    explanation,
    suspended,
    differsFromCurrent,
  };
}

/**
 * One-line summary of a plan for a compact status row.
 * @beta
 */
export function formatTierPlan(plan: TierPlan): string {
  const slots = plan.staticCapacity.toLocaleString();
  if (plan.bindingConstraint === 'static') {
    return `${plan.enabledRules.toLocaleString()} of ${plan.totalRules.toLocaleString()} rules fit ${slots} static slots`;
  }
  if (plan.bindingConstraint === 'dynamic') {
    return `All tiers fit — the tight budget is the synced list`;
  }
  return `${plan.enabledRules.toLocaleString()} rules inside ${slots} static slots`;
}
