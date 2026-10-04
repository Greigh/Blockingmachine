/**
 * The measured-benefit fallback ordering for a full export that will not fit the budget.
 *
 * When the sync serves no hot set, a list that overflows used to keep a plain prefix — merge
 * order, a statement about how the file was built rather than about any traffic. The tiers
 * shipped inside this package are the measured evidence that exists anyway: the compiler
 * ranks each tier's hosts by ledger hits, so a host's position in a tier file is the benefit
 * the measurement already assigned it, and the catalogue order across tiers is the authored
 * usefulness order. A deployment that has browsed adds its own measurement on top:
 * `bm_tier_hits` records which tier the browser credited for each static match, and a tier
 * that has blocked more orders its hosts ahead of one that has blocked less.
 *
 * With no local hits at all — a fresh install is exactly that — every tier ties and the
 * compile order stands alone, which is still a measured ranking where a prefix is none.
 * Either way the budget cut spends on what evidence ranks highest and drops the unmeasured
 * tail first, and the answer a trim gives is always "what the tiers can vouch for", never
 * "the part of the file that happened to come first".
 */

import { extractHostFromRule } from '@blockingmachine/core/ruleHost';
import {
  ALL_STATIC_TIER_IDS,
  type StaticTierId,
  type TierHitCounts,
} from '@blockingmachine/core/tiers';
import type { StaticTierSpec } from './staticRuleIndex.js';

/**
 * Room inside a composite rank for one tier file's positions. A rank is
 * `tierOrder * STRIDE + position`, so the stride must exceed any tier file's length; 16.7M
 * is far past every plausible size and keeps 6 tiers × positions far below MAX_SAFE_INTEGER.
 */
const TIER_POSITION_STRIDE = 1 << 24;

/**
 * The tier catalogue ordered by measured benefit: hits descending, the authored catalogue
 * order breaking every tie. A deployment that has measured nothing gets the compile's own
 * order back, which is the point — the fallback never degrades to unordered.
 */
export function tierBenefitOrder(hits: TierHitCounts): StaticTierId[] {
  const authored = new Map(ALL_STATIC_TIER_IDS.map((id, index) => [id, index]));
  return [...ALL_STATIC_TIER_IDS].sort(
    (a, b) =>
      (hits[b] ?? 0) - (hits[a] ?? 0) ||
      (authored.get(a) ?? 0) - (authored.get(b) ?? 0),
  );
}

/**
 * host → benefit rank, built once per worker lifetime from the shipped tier files.
 *
 * The lazy build is the `StaticRuleIndex` doctrine exactly: reading the files is async, the
 * first rule application is when it can happen, and a tier that cannot be read contributes
 * nothing rather than failing the build — its hosts simply rank nowhere, which is the same
 * answer an unshipped tier gives.
 */
export class TierBenefitIndex {
  private readonly ranks = new Map<string, number>();
  private build: Promise<void> | null = null;

  constructor(
    private readonly options: {
      tiers: readonly StaticTierSpec[];
      /** Reads and parses one tier's rule file. Rejecting means that tier ranks nothing. */
      readTier: (path: string) => Promise<unknown>;
      /**
       * The deployment's measured per-tier blocks, consulted once at build time. Omitted —
       * or all zeros — means no local measurement exists and the compile order stands.
       */
      tierHits?: () => TierHitCounts;
    },
  ) {}

  /** Hosts carrying a benefit rank. */
  get size(): number {
    return this.ranks.size;
  }

  /**
   * The benefit rank of a host, or of the nearest ancestor a tier ships: a tier holding
   * `||doubleclick.net^` ranks `ads.doubleclick.net` in the export, because the zone block
   * is the coverage the tier measured. `null` when no shipped tier claims the host — the
   * unmeasured tail, which keeps list order.
   */
  rankFor(host: string): number | null {
    let candidate = host.toLowerCase();
    for (;;) {
      const rank = this.ranks.get(candidate);
      if (rank !== undefined) return rank;
      const dot = candidate.indexOf('.');
      if (dot < 0) return null;
      candidate = candidate.slice(dot + 1);
    }
  }

  /** Builds the index, reusing an in-flight build rather than starting a second one. */
  async ensure(): Promise<void> {
    if (!this.build) this.build = this.load();
    await this.build;
  }

  private async load(): Promise<void> {
    const order = tierBenefitOrder(this.options.tierHits?.() ?? {});
    const weight = new Map(order.map((id, index) => [id, index]));
    for (const tier of this.options.tiers) {
      const tierOrder = weight.get(tier.id as StaticTierId);
      if (tierOrder === undefined) continue;
      try {
        const rules = await this.options.readTier(tier.path);
        if (!Array.isArray(rules)) continue;
        rules.forEach((rule, position) => {
          const urlFilter = (rule as { condition?: { urlFilter?: unknown } })?.condition
            ?.urlFilter;
          const host = extractHostFromRule(urlFilter);
          if (!host) return;
          const rank = tierOrder * TIER_POSITION_STRIDE + position;
          const current = this.ranks.get(host);
          // A host shipped by two tiers keeps its best rank — the measurement it earned.
          if (current === undefined || rank < current) this.ranks.set(host, rank);
        });
      } catch {
        // A tier that cannot be read ranks nothing; the rest still apply.
      }
    }
  }
}
