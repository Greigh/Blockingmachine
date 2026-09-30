/**
 * The static ruleset tiers: what they are, what they cost, and which of them are worth
 * keeping on when the browser will not grant enough slots for all of them.
 *
 * ## Why this lives in core
 *
 * Three surfaces answer the same question and must not disagree: the extension popup, which plans
 * against the live `getAvailableStaticRuleCount()`; the desktop hub, which plans at package time
 * against the files it is about to ship; and the CLI, which plans against whatever is on disk. The
 * planner and the attribution that feeds it are pure — no `chrome.*`, no clock, no filesystem — so
 * there is no reason for any of that to live inside the extension where the other two cannot reach
 * it. This module is that shared half, and the extension's `shared/rulesetTiers.ts` re-exports it
 * and layers the one thing that genuinely is bundle-specific on top: the rule counts the packaging
 * compiler wrote into the generated file.
 *
 * ## What stayed in the extension, and why
 *
 * `tierRuleCount()` and `tierCompilationSource()` read `tierCounts.generated.js`, which is written
 * at package time and exists only inside a bundle. Everything else — the catalogue, the limits, the
 * validator, the planner, the ledger attribution — is here, and the counts are passed in rather than
 * read, so a caller that has the real files (the hub, the CLI) reports what is actually on disk
 * instead of the curated baseline a fresh checkout holds.
 */


export type StaticTierId =
  | 'tier_core'
  | 'tier_ads'
  | 'tier_privacy'
  | 'tier_annoyances'
  | 'tier_security';

export type StaticTierCategory = 'core' | 'ads' | 'privacy' | 'annoyances' | 'security';

export interface StaticRuleTier {
  id: StaticTierId;
  /** Short name for the toggle row. */
  label: string;
  /** One line explaining what enabling the tier costs and buys. */
  description: string;
  /** Path relative to the extension root, exactly as declared in the manifest. */
  path: string;
  category: StaticTierCategory;
  /** Tiers enabled on a fresh install. Must match the manifest's `enabled` flags. */
  defaultEnabled: boolean;
  /**
   * Rules in the curated baseline file.
   *
   * This is the *curated* figure. When the desktop hub compiles its active blocklist into
   * the tier files at package time the real count changes, so anything that reports or does
   * arithmetic on counts must go through `tierRuleCount()` instead of reading this directly.
   */
  ruleCount: number;
  /**
   * Whether the checked-in file is hand-curated content or only a placeholder.
   *
   * Four tiers are seeded by hand and compiled *additively* on top, so an empty file for one of
   * them is a build defect — someone lost the baseline. `tier_security` is the other shape: it has
   * no curated seed at all, because its contents are the classifier's own verdicts, which exist
   * only where a machine has run the classifier over a real blocklist. An empty file for it is the
   * correct state of a fresh checkout rather than a mistake, and the three places that assert "a
   * tier is non-empty" — the ruleset validator, the compiler's `--check`, and the tier/model
   * agreement suite — read this flag to tell the two apart instead of being loosened for everyone.
   */
  curatedSeed: boolean;
}

/**
 * Chrome's documented bounds for static rulesets. `GUARANTEED_STATIC_RULES` is the floor
 * every extension is granted regardless of how many other extensions are installed.
 */
export const MV3_STATIC_LIMITS = {
  GUARANTEED_STATIC_RULES: 30000,
  MAX_STATIC_RULESETS: 100,
} as const;

/**
 * The single priority every tier rule uses. Static rules are the lowest precedence band
 * (session > dynamic > static on a tie), and the blocklist pipeline uses priorities 1–4 for
 * synced rules and 500/1000 for user decisions, so this can never override a user choice.
 */
export const PRIORITY_STATIC_TIER = 1;

export const STATIC_RULE_TIERS: readonly StaticRuleTier[] = [
  {
    id: 'tier_core',
    label: 'Core shield',
    description: 'The highest-confidence ad and tracker hosts. On by default and safe for every site.',
    path: 'rules/tier_core.json',
    category: 'core',
    defaultEnabled: true,
    ruleCount: 24,
    curatedSeed: true,
  },
  {
    id: 'tier_ads',
    label: 'Ad networks',
    description: 'Programmatic exchanges, mobile ad SDKs, and pop-under networks. Adds depth on ad-heavy pages.',
    path: 'rules/tier_ads.json',
    category: 'ads',
    defaultEnabled: false,
    ruleCount: 36,
    curatedSeed: true,
  },
  {
    id: 'tier_privacy',
    label: 'Tracking & analytics',
    description: 'Analytics, session replay, fingerprinting, and social pixels. May affect embedded login widgets.',
    path: 'rules/tier_privacy.json',
    category: 'privacy',
    defaultEnabled: false,
    ruleCount: 36,
    curatedSeed: true,
  },
  {
    id: 'tier_annoyances',
    label: 'Consent & nags',
    description: 'Consent-management platforms, push-notification prompts, and popup builders.',
    path: 'rules/tier_annoyances.json',
    category: 'annoyances',
    defaultEnabled: false,
    ruleCount: 22,
    curatedSeed: true,
  },
  {
    id: 'tier_security',
    label: 'Threat & malware',
    description:
      'Hosts the embedded classifier calls malware or phishing. Opt-in, and the only tier whose contents are a model verdict rather than a publisher list.',
    path: 'rules/tier_security.json',
    category: 'security',
    // Off, and not as a matter of taste. This is the one tier whose contents cannot be audited by
    // reading a filter list — a host is here because a model said so — and it is the one whose
    // contents are, by the publisher's own claim elsewhere, the highest-cost thing to get wrong in
    // either direction. Shipping that enabled would block on the strength of a verdict the user
    // cannot see the reasoning for and cannot narrow.
    defaultEnabled: false,
    ruleCount: 0,
    curatedSeed: false,
  },
] as const;

export const ALL_STATIC_TIER_IDS: readonly StaticTierId[] = STATIC_RULE_TIERS.map((tier) => tier.id);

export const DEFAULT_ENABLED_TIER_IDS: readonly StaticTierId[] = STATIC_RULE_TIERS.filter(
  (tier) => tier.defaultEnabled,
).map((tier) => tier.id);

const TIER_BY_ID = new Map<StaticTierId, StaticRuleTier>(
  STATIC_RULE_TIERS.map((tier) => [tier.id, tier]),
);

export function isTierId(value: unknown): value is StaticTierId {
  return typeof value === 'string' && TIER_BY_ID.has(value as StaticTierId);
}

export function tierById(id: StaticTierId): StaticRuleTier | undefined {
  return TIER_BY_ID.get(id);
}

/**
 * The `rule_resources` array the manifest must declare, derived from the catalogue so the
 * two cannot drift. A test asserts the manifest matches this exactly.
 */
export function manifestRuleResources(): Array<{ id: StaticTierId; enabled: boolean; path: string }> {
  return STATIC_RULE_TIERS.map((tier) => ({
    id: tier.id,
    enabled: tier.defaultEnabled,
    path: tier.path,
  }));
}

/**
 * Normalizes persisted tier state.
 *
 * Asymmetry is deliberate: `undefined` (nothing saved yet) means "fresh install, use the
 * defaults", while `[]` means the user turned every tier off and must stay off. Treating an
 * empty array as "unset" would silently re-enable tiers the user disabled.
 */
export function resolveEnabledTierIds(stored: unknown): StaticTierId[] {
  if (!Array.isArray(stored)) return [...DEFAULT_ENABLED_TIER_IDS];
  const ids = stored.filter(isTierId);
  return [...new Set(ids)];
}

/** The minimal enable/disable call needed to move from `current` to `desired`. */
export function diffRulesets(
  current: readonly string[],
  desired: readonly string[],
): { enableRulesetIds: string[]; disableRulesetIds: string[] } {
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  return {
    enableRulesetIds: [...desiredSet].filter((id) => !currentSet.has(id)),
    disableRulesetIds: [...currentSet].filter((id) => !desiredSet.has(id)),
  };
}

export interface TierCapacitySummary {
  enabledTiers: number;
  totalTiers: number;
  enabledRules: number;
  disabledRules: number;
  totalRules: number;
  /** Static slots still unused inside Chrome's guaranteed budget. */
  headroom: number;
}

/**
 * How a tier's rule count is decided.
 *
 * Defaults to the curated catalogue, which is the honest answer for a checkout that has never been
 * packaged. A caller holding the real files — the hub reading what it is about to ship, the CLI
 * reading what is on disk, the extension reading what the compiler generated — passes its own, so
 * nobody reports 118 rules for a bundle carrying thirty thousand.
 */
export type TierCountSource = (tier: StaticRuleTier) => number;

export function summarizeTierCapacity(
  enabledIds: readonly StaticTierId[],
  countOf: TierCountSource = (tier) => tier.ruleCount,
): TierCapacitySummary {
  const enabled = new Set(enabledIds);
  let enabledRules = 0;
  let totalRules = 0;
  for (const tier of STATIC_RULE_TIERS) {
    const count = countOf(tier);
    totalRules += count;
    if (enabled.has(tier.id)) enabledRules += count;
  }
  return {
    enabledTiers: STATIC_RULE_TIERS.filter((tier) => enabled.has(tier.id)).length,
    totalTiers: STATIC_RULE_TIERS.length,
    enabledRules,
    disabledRules: totalRules - enabledRules,
    totalRules,
    headroom: Math.max(0, MV3_STATIC_LIMITS.GUARANTEED_STATIC_RULES - enabledRules),
  };
}

export function formatTierCapacity(summary: TierCapacitySummary): string {
  const active = `${summary.enabledRules.toLocaleString()} static rule${summary.enabledRules === 1 ? '' : 's'} active`;
  const headroom = `${summary.headroom.toLocaleString()} slots free`;
  return `${active} · ${headroom}`;
}

/** What one tier toggle row shows, as sent to the popup. */
export interface StaticTierView {
  id: StaticTierId;
  label: string;
  description: string;
  category: StaticTierCategory;
  enabled: boolean;
  ruleCount: number;
}

/** Aggregate static-ruleset state for the popup and diagnostics. */
export interface StaticTierStatus {
  tiers: StaticTierView[];
  enabledRules: number;
  disabledRules: number;
  totalRules: number;
  enabledTiers: number;
  totalTiers: number;
  headroom: number;
  /** From `getAvailableStaticRuleCount()`, when the browser exposes it. */
  availableStaticRules: number | null;
  /**
   * True while blocking is paused everywhere. The selection is unchanged, but every tier is
   * switching off in the browser, so nothing a tier ships is actually blocking right now.
   */
  suspended: boolean;
}

export function buildTierStatus(
  enabledIds: readonly StaticTierId[],
  availableStaticRules: number | null = null,
  suspended = false,
  countOf: TierCountSource = (tier) => tier.ruleCount,
): StaticTierStatus {
  const enabled = new Set(enabledIds);
  const summary = summarizeTierCapacity(enabledIds, countOf);
  return {
    tiers: STATIC_RULE_TIERS.map((tier) => ({
      id: tier.id,
      label: tier.label,
      description: tier.description,
      category: tier.category,
      enabled: enabled.has(tier.id),
      ruleCount: countOf(tier),
    })),
    enabledRules: summary.enabledRules,
    disabledRules: summary.disabledRules,
    totalRules: summary.totalRules,
    enabledTiers: summary.enabledTiers,
    totalTiers: summary.totalTiers,
    headroom: summary.headroom,
    availableStaticRules,
    suspended,
  };
}

export interface TierValidationResult {
  ok: boolean;
  ruleCount: number;
  errors: string[];
}

const MAX_URL_FILTER_LENGTH = 2048;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a tier is allowed to ship an empty file.
 *
 * Only the tiers with no curated seed are, and the reason is in `StaticRuleTier.curatedSeed`: an
 * empty file for a hand-curated tier means someone lost the baseline, while an empty file for the
 * classifier-sourced tier means nobody has run the classifier on this machine yet. Both are
 * "empty", and only one of them is a defect, so the two cannot share a check.
 */
export function tierAllowsEmpty(tierId: string): boolean {
  return TIER_BY_ID.get(tierId as StaticTierId)?.curatedSeed === false;
}

/**
 * Validates a tier ruleset before it is trusted, mirroring what Chrome's DNR engine
 * rejects — plus the one policy rule this project adds: tiers may only ship bottom-priority
 * block rules, so a tier can never outrank a user's own decision.
 */
export function validateTierRuleset(
  rules: unknown,
  tierId: string,
  options: { allowEmpty?: boolean } = {},
): TierValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(rules)) {
    return { ok: false, ruleCount: 0, errors: [`${tierId}: ruleset is not a JSON array`] };
  }
  if (rules.length === 0 && !(options.allowEmpty ?? tierAllowsEmpty(tierId))) {
    errors.push(`${tierId}: ruleset is empty`);
  }

  const seenIds = new Set<number>();

  rules.forEach((rule, index) => {
    const where = `${tierId}[${index}]`;
    if (!isPlainObject(rule)) {
      errors.push(`${where}: rule is not an object`);
      return;
    }

    if (typeof rule.id !== 'number' || !Number.isInteger(rule.id) || rule.id <= 0) {
      errors.push(`${where}: id must be a positive integer`);
    } else if (seenIds.has(rule.id)) {
      errors.push(`${where}: duplicate rule id ${rule.id}`);
    } else {
      seenIds.add(rule.id);
    }

    if (typeof rule.priority !== 'number' || !Number.isInteger(rule.priority) || rule.priority < 1) {
      errors.push(`${where}: priority must be a positive integer`);
    } else if (rule.priority !== PRIORITY_STATIC_TIER) {
      errors.push(
        `${where}: priority must be ${PRIORITY_STATIC_TIER} so dynamic, exception, and user rules keep precedence`,
      );
    }

    if (!isPlainObject(rule.action) || rule.action.type !== 'block') {
      errors.push(`${where}: tiers may only ship block rules`);
    }

    if (!isPlainObject(rule.condition)) {
      errors.push(`${where}: condition is required`);
      return;
    }
    const condition = rule.condition;

    const filter = condition.urlFilter;
    if (typeof filter !== 'string' || filter.length === 0) {
      errors.push(`${where}: condition.urlFilter is required`);
    } else {
      if (filter.length > MAX_URL_FILTER_LENGTH) {
        errors.push(`${where}: urlFilter exceeds ${MAX_URL_FILTER_LENGTH} characters`);
      }
      if (/\s/.test(filter)) {
        errors.push(`${where}: urlFilter must not contain whitespace`);
      }
      if (!/^[\x20-\x7e]+$/.test(filter)) {
        errors.push(`${where}: urlFilter must be printable ASCII`);
      }
    }

    if (condition.resourceTypes !== undefined) {
      const types = condition.resourceTypes;
      const validTypes =
        Array.isArray(types) &&
        types.length > 0 &&
        types.every((type) => typeof type === 'string' && type.length > 0);
      if (!validTypes) {
        errors.push(`${where}: condition.resourceTypes must be a non-empty array of strings when present`);
      }
    }
  });

  return { ok: errors.length === 0, ruleCount: rules.length, errors };
}



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
  // A tier carrying no rules is exempt from the gate for the same reason `planTierBenefits` drops
  // it before asking: it cannot block, so no amount of traffic will ever measure it, and demanding
  // a number for it would pin every plan to rule counts for good. It is no hole in the comparison
  // either — with no rules it costs no slots, so whether the search includes it or not changes
  // nothing it trades against. Strictly zero rather than falsy, so a caller that left the field
  // out is not silently excused from measurement.
  const carriesNoRules = (tier: TierPlanCandidate): boolean =>
    isFiniteNumber(tier?.ruleCount) && tier.ruleCount <= 0;
  // `some` as well as `every`, so a choice between tiers that all carry nothing is not reported as
  // evidence-weighted on the strength of a rule nobody measured.
  const everyTierMeasured =
    tiers.length > 0 &&
    tiers.some((tier) => isFiniteNumber(tier?.benefit)) &&
    tiers.every((tier) => isFiniteNumber(tier?.benefit) || carriesNoRules(tier));
  const benefitSource: TierPlan['benefitSource'] = everyTierMeasured ? 'evidence' : 'coverage';
  const benefitOf = (tier: TierPlanCandidate): number => {
    if (benefitSource !== 'evidence') return Math.max(0, tier.ruleCount);
    // Read rather than cast: the exempt tier above is the one candidate that arrives here without
    // a number, and a `NaN` scored against every other candidate would fail every comparison and
    // take the search with it. Zero is what an empty ruleset has earned.
    return isFiniteNumber(tier.benefit) ? Math.max(0, tier.benefit) : 0;
  };

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

  // What the plan was worth, in the units it was worth. Without this the reader cannot tell a plan
  // that kept three tiers because they earn their slots from one that kept three because they were
  // small, which is the whole difference between the two bases and the reason a plan is chosen.
  if (tiers.length > 0) {
    explanation.push(
      benefitSource === 'evidence'
        ? `Ranked by measured blocking: ${bestBenefit.toLocaleString()} requests actually blocked by the ` +
            `selected tiers, against ${tiers.length} tier${tiers.length === 1 ? '' : 's'} of shipped rules.`
        : `Ranked by rule count — ${bestBenefit.toLocaleString()} shipped rules, because a tier's size is ` +
            `all the planner knows when nothing has measured what it blocks.`,
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
  /**
   * Carries no rules, so it has nothing to block with.
   *
   * The one verdict that is a fact about the ruleset rather than about traffic, and the only silent
   * one that more traffic cannot resolve: a ruleset with no rules never matches anything, so its
   * silence is structural. That is why it is graded here rather than left to look idle — "turn this
   * off" is the wrong advice for a tier that has already proved nothing, and a tier that can never
   * be measured must not be able to hold a plan on the rule-count basis forever. `tier_security`
   * ships empty on a machine that has never run the classifier, which is the ordinary case.
   */
  | 'empty'
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
  /**
   * Rules the tier actually carries, when the caller knows.
   *
   * Optional on purpose, and an absent count is **not** a zero: a caller that never reads the tier
   * files — a diagnostics view listing the catalogue — has not told us its tiers are empty, and
   * grading them `empty` would excuse them from evidence they may well have. Only a caller holding
   * the compiled files, which is every caller that grades real traffic, can say a tier carries
   * nothing.
   */
  ruleCount?: number;
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

  /**
   * Tiers there is something left to measure about, which is every tier that has rules.
   *
   * The gate below refuses the evidence basis while any tier is unmeasured, and that is right for
   * a tier carrying rules with no sample behind them: another session on answers it. It is wrong
   * for a tier carrying nothing, because nothing will ever answer it — so such a tier is taken out
   * of the question instead of being counted as an unanswered one. Without this, the tier that
   * ships empty on every machine that has never run the classifier would hold the plan on rule
   * counts for good, which is the opposite of what the gate is for.
   *
   * Read off the verdict rather than a fresh count so the two cannot disagree about the same tier.
   */
  const graded = views.filter((view) => view.verdict !== 'empty');

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

  // Everything left is empty, so there is likewise nothing to weigh. Distinguished from the case
  // above because the cause is different and only one of the two is worth acting on: a machine
  // whose classifier has not been run yet gets a different answer from one with no tiers at all.
  if (graded.length === 0) {
    return {
      benefits: null,
      source: 'coverage',
      unmeasured: [],
      reason:
        'Planned by rule count: no tier here carries rules yet, so there is nothing for the ledger ' +
        'to measure. This becomes a plan weighted by what actually blocked once the tiers are ' +
        'compiled.',
    };
  }

  const unmeasured = graded.filter((view) => !hasMeasurement(view));

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
  for (const view of graded) benefits[view.id] = view.hits;
  const idleCount = graded.filter((view) => view.hits === 0).length;
  return {
    benefits,
    source: 'evidence',
    unmeasured: [],
    reason:
      `Weighted by what actually blocked: ${summary.totalHits.toLocaleString()} attributed ` +
      `block${summary.totalHits === 1 ? '' : 's'} across ${graded.length} tier${graded.length === 1 ? '' : 's'}` +
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
  // Tiers carrying no rules are left out of the denominator. They cannot block, so including them
  // would present an unwinnable tier as a failure — "2 of 5" reads as three tiers that have been
  // given their chance and wasted it, when one of them was never able to take it. The popup's own
  // list still shows every tier; this sentence only grades the ones that were in the running.
  const inPlay = summary.tiers.filter((tier) => tier.verdict !== 'empty').length;
  const total = Math.max(inPlay, firing);
  return `${summary.totalHits.toLocaleString()} blocks from ${firing} of ${total} tiers`;
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
    // A count of zero is a tier that cannot block, and is deliberately narrower than "no count".
    const noRules =
      typeof tier.ruleCount === 'number' && Number.isFinite(tier.ruleCount) && tier.ruleCount <= 0;
    // A tier carrying no rules is `empty` first, whatever its switch says, because it is the only
    // verdict here that names a fact about the ruleset rather than about traffic or about the
    // switch: an empty ruleset is empty whether it is on or off, and "switch it on" and "give it
    // more traffic" both promise a way forward that it cannot take. The rest of the order is
    // unchanged — a disabled tier is never idle, and only once the ledger has a real sample does
    // silence count against a tier.
    const verdict: TierBlockingVerdict = noRules
      ? 'empty'
      : !isEnabled
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
