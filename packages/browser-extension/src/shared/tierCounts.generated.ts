/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by `scripts/compile-tier-rulesets.mjs`, which compiles the desktop hub's active
 * blocklist into `rules/tier_*.json` at package time. `null` means the files on disk are
 * the curated baseline, so the catalogue's own counts should be trusted.
 *
 * Regenerate with: npm run compile:tiers
 */

/** Real rule counts per tier, or null while the curated baseline is what shipped. */
export const GENERATED_TIER_COUNTS: Record<string, number> | null = {
  'tier_core': 33,
  'tier_ads': 3662,
  'tier_privacy': 8432,
  'tier_annoyances': 435,
  'tier_security': 0,
  'tier_unclassified': 3214,
};

/** Provenance for the last compilation, or null for the checked-in baseline. */
export const GENERATED_TIER_SOURCE: { source: string; generatedAt: string; budget: number; omitted: number; sources?: Array<{ name?: string; url?: string; error?: string }> } | null = {
  "source": "packages/electron-app/filters/output/hosts.txt, packages/electron-app/filters/output/genericBrowserRules.txt, packages/electron-app/filters/output/adguardBrowser.txt, packages/cli/filters/output/genericBrowserRules.txt",
  "generatedAt": "2026-10-04T02:32:06.819Z",
  "budget": 30000,
  "omitted": 107035
};
