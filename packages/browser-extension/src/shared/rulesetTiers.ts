/**
 * The bundle's view of the static ruleset tiers.
 *
 * Everything semantic now lives in `@blockingmachine/core`, because three surfaces have to answer
 * the same question about the same catalogue and must not be able to disagree: this popup, the
 * desktop hub at package time, and the CLI against whatever is on disk. The catalogue, Chrome's
 * limits, the ruleset validator, the capacity planner and the ledger attribution are all pure, so
 * keeping them here would have meant the other two reimplementing them — and three copies of a
 * planner that decides what a user blocks is two too many.
 *
 * What stays is the one thing that is genuinely bundle-specific: the rule counts the packaging
 * compiler writes into `tierCounts.generated.js` at package time. A fresh checkout holds the
 * curated baseline, so without this the popup would report ~118 active rules while a packaged
 * build was shipping tens of thousands.
 *
 * Core takes its counts as a `TierCountSource` argument for exactly this reason — the hub and the
 * CLI pass counts read from the files in front of them, and the same functions serve all three.
 */

import { GENERATED_TIER_COUNTS, GENERATED_TIER_SOURCE } from './tierCounts.generated.js';
import {
  summarizeTierCapacity as summarizeWithCounts,
  buildTierStatus as buildStatusWithCounts,
  type StaticRuleTier,
  type StaticTierId,
  type StaticTierStatus,
  type TierCapacitySummary,
} from '@blockingmachine/core/tiers';

// A star export plus an explicit local export of the same name is legal, and the local one wins:
// `summarizeTierCapacity` and `buildTierStatus` are the same functions as core's with this
// bundle's counts bound in, which is the only difference between them.
export * from '@blockingmachine/core/tiers';

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

/** Core's capacity summary, reading the counts this bundle actually ships. */
export function summarizeTierCapacity(enabledIds: readonly StaticTierId[]): TierCapacitySummary {
  return summarizeWithCounts(enabledIds, tierRuleCount);
}

/** Core's tier status, reading the counts this bundle actually ships. */
export function buildTierStatus(
  enabledIds: readonly StaticTierId[],
  availableStaticRules: number | null = null,
  suspended = false,
): StaticTierStatus {
  return buildStatusWithCounts(enabledIds, availableStaticRules, suspended, tierRuleCount);
}
