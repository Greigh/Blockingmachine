/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by `scripts/compile-tier-rulesets.mjs`, which compiles the desktop hub's active
 * blocklist into `rules/tier_*.json` at package time. `null` means the files on disk are the
 * curated baseline, so the catalogue's own counts should be trusted.
 *
 * Regenerate with: npm run compile:tiers
 */

/** Real rule counts per tier, or null while the curated baseline is what shipped. */
export const GENERATED_TIER_COUNTS: Record<string, number> | null = null;

/** Provenance for the last compilation, or null for the checked-in baseline. */
export const GENERATED_TIER_SOURCE: { source: string; generatedAt: string; budget: number; omitted: number } | null =
  null;
