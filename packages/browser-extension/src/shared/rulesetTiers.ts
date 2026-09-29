/**
 * Static DeclarativeNetRequest ruleset tiers.
 *
 * Manifest V3 gives an extension two rule budgets that do not compete:
 *
 *   - **Dynamic rules** — written at runtime, capped at `MAX_NUMBER_OF_DYNAMIC_AND_MATCHED_RULES`
 *     (`30,000`), which is the ceiling the sync pipeline already watermarks against.
 *   - **Static rules** — shipped as JSON files declared in the manifest, guaranteed
 *     `30,000` across all rulesets and *individually* enabled or disabled at runtime.
 *
 * Static rules cannot be written at runtime, but they can be *toggled*. Splitting the
 * blocklist into named tiers therefore lets the extension carry far more than the dynamic
 * quota alone: the shipped rules cost nothing until a tier is enabled, and a disabled
 * tier does not consume any rule budget. That is exactly what this module models.
 *
 * A tier file may only ship `block` rules at `PRIORITY_STATIC_TIER`. Static rules lose
 * priority ties to session and dynamic rules, so keeping every tier at the bottom priority
 * guarantees that a user allowance, a site pause, or a synced exception always wins over
 * anything in a tier.
 */

import { GENERATED_TIER_COUNTS, GENERATED_TIER_SOURCE } from './tierCounts.generated.js';

export type StaticTierId = 'tier_core' | 'tier_ads' | 'tier_privacy' | 'tier_annoyances';

export type StaticTierCategory = 'core' | 'ads' | 'privacy' | 'annoyances';

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
}

/**
 * The rule count actually shipped for a tier.
 *
 * Prefers the count written by the packaging compiler, and falls back to the curated
 * catalogue. Without this the popup would report ~118 active rules while a packaged build
 * was shipping tens of thousands.
 */
export function tierRuleCount(tier: StaticRuleTier): number {
  const generated = GENERATED_TIER_COUNTS?.[tier.id];
  return typeof generated === 'number' && generated > 0 ? generated : tier.ruleCount;
}

/**
 * Provenance of the tier files currently in the bundle: null while they are the curated
 * baseline, otherwise where the hub compilation came from and how much it had to omit.
 */
export function tierCompilationSource(): typeof GENERATED_TIER_SOURCE {
  return GENERATED_TIER_SOURCE;
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
  },
  {
    id: 'tier_ads',
    label: 'Ad networks',
    description: 'Programmatic exchanges, mobile ad SDKs, and pop-under networks. Adds depth on ad-heavy pages.',
    path: 'rules/tier_ads.json',
    category: 'ads',
    defaultEnabled: false,
    ruleCount: 36,
  },
  {
    id: 'tier_privacy',
    label: 'Tracking & analytics',
    description: 'Analytics, session replay, fingerprinting, and social pixels. May affect embedded login widgets.',
    path: 'rules/tier_privacy.json',
    category: 'privacy',
    defaultEnabled: false,
    ruleCount: 36,
  },
  {
    id: 'tier_annoyances',
    label: 'Consent & nags',
    description: 'Consent-management platforms, push-notification prompts, and popup builders.',
    path: 'rules/tier_annoyances.json',
    category: 'annoyances',
    defaultEnabled: false,
    ruleCount: 22,
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

export function summarizeTierCapacity(enabledIds: readonly StaticTierId[]): TierCapacitySummary {
  const enabled = new Set(enabledIds);
  let enabledRules = 0;
  let totalRules = 0;
  for (const tier of STATIC_RULE_TIERS) {
    const count = tierRuleCount(tier);
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
): StaticTierStatus {
  const enabled = new Set(enabledIds);
  const summary = summarizeTierCapacity(enabledIds);
  return {
    tiers: STATIC_RULE_TIERS.map((tier) => ({
      id: tier.id,
      label: tier.label,
      description: tier.description,
      category: tier.category,
      enabled: enabled.has(tier.id),
      ruleCount: tierRuleCount(tier),
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
 * Validates a tier ruleset before it is trusted, mirroring what Chrome's DNR engine
 * rejects — plus the one policy rule this project adds: tiers may only ship bottom-priority
 * block rules, so a tier can never outrank a user's own decision.
 */
export function validateTierRuleset(rules: unknown, tierId: string): TierValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(rules)) {
    return { ok: false, ruleCount: 0, errors: [`${tierId}: ruleset is not a JSON array`] };
  }
  if (rules.length === 0) {
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
