import {
  RULE_HIT_FLUSH_EVERY,
  RULE_HIT_MAX_TRACKED,
  STORAGE_KEY_RULE_HITS,
  STORAGE_KEY_TIER_HITS,
} from '../shared/constants.js';
import { isTierId, type StaticTierId } from '../shared/rulesetTiers.js';
import type { TierHitCounts } from '../shared/tierAttribution.js';

export interface RuleHit {
  rule: string;
  count: number;
}

export interface RuleHitSnapshot {
  /** Requests matched by some rule since the last reset. */
  totalHits: number;
  /** Distinct rules that matched at least once. */
  distinctRules: number;
  /** Largest counts first. */
  hits: RuleHit[];
  /**
   * Matches attributed to each shipped static tier.
   *
   * Keyed by tier rather than by filter, because that is what the browser actually reports: a
   * match names the ruleset that won, and a tier's ruleset id is its tier id. It is also **not**
   * derivable from `hits` — the same urlFilter can ship in two tiers and those two entries
   * collapse into one filter entry here. A tier is counted whenever the browser named it, even if
   * its rule file could not be read for the filter lookup, so this is the more complete tally.
   */
  tiers: TierHitCounts;
  /** Ready to feed `blockingmachine coverage --hits`. */
  text: string;
}

/**
 * Counts how often each DNR rule actually matched.
 *
 * This is the high-fidelity counterpart to replaying a request trace: the browser reports the rule
 * that really won, after paths, request types and initiators have all been applied. A hostname
 * replay can only approximate that.
 *
 * Writes are batched. A busy page matches hundreds of requests, and a `chrome.storage` write per
 * match would thrash the service worker for data nobody is reading yet.
 */
export class RuleHitStats {
  private hits = new Map<string, number>();
  private tierHits = new Map<StaticTierId, number>();
  private pending = 0;

  /** Restores prior counts. Never clobbers the store before reading it. */
  async load(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get([
        STORAGE_KEY_RULE_HITS,
        STORAGE_KEY_TIER_HITS,
      ]);
      const raw = stored?.[STORAGE_KEY_RULE_HITS];
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (
            entry &&
            typeof entry.rule === 'string' &&
            entry.rule &&
            Number.isFinite(entry.count) &&
            entry.count > 0
          ) {
            this.hits.set(entry.rule, Math.floor(entry.count));
          }
        }
      }
      const rawTiers = stored?.[STORAGE_KEY_TIER_HITS];
      if (Array.isArray(rawTiers)) {
        for (const entry of rawTiers) {
          if (
            entry &&
            isTierId(entry.tier) &&
            Number.isFinite(entry.count) &&
            entry.count > 0
          ) {
            this.tierHits.set(entry.tier, Math.floor(entry.count));
          }
        }
      }
      this.trim();
    } catch (err) {
      console.warn('[RuleHits] Could not read rule hit counts:', err);
    }
  }

  /** Records one match of `rule`, flushing once enough have accumulated. */
  record(rule: string, count = 1): void {
    if (!rule || !Number.isFinite(count) || count <= 0) return;
    this.hits.set(rule, (this.hits.get(rule) ?? 0) + Math.floor(count));
    this.pending += 1;
    if (this.pending >= RULE_HIT_FLUSH_EVERY) void this.flush();
  }

  /**
   * Records matches the browser attributed to a shipped tier.
   *
   * Deliberately separate from `record`: that keys by filter line so the coverage export can be
   * diffed against a compiled list, this keys by tier so a tier toggle can be judged. Both are fed
   * from the same match, and a filter shipped in two tiers lands in two entries here but only one
   * there. A non-tier id is ignored rather than trusted, since a rule can also come from the
   * dynamic pipeline.
   */
  recordTier(tier: StaticTierId, count = 1): void {
    if (!isTierId(tier) || !Number.isFinite(count) || count <= 0) return;
    this.tierHits.set(tier, (this.tierHits.get(tier) ?? 0) + Math.floor(count));
    this.pending += 1;
    if (this.pending >= RULE_HIT_FLUSH_EVERY) void this.flush();
  }

  /**
   * Forgets one tier's matches.
   *
   * Called when a tier is switched on: matches it did or did not collect while it was off say
   * nothing about the tier, and leaving them in place would let a tier that fired months ago look
   * productive forever — the exact opposite of what the "never fires" verdict is for. A selection
   * re-applied to a tier that is already on changes nothing and keeps its counts.
   */
  clearTier(tier: StaticTierId): void {
    if (!this.tierHits.delete(tier)) return;
    this.pending += 1;
  }

  /** Persists the current counts. Safe to call at any time; a no-op when nothing changed. */
  async flush(): Promise<void> {
    if (this.pending === 0) return;
    this.pending = 0;
    this.trim();
    try {
      const payload: Record<string, unknown> = {
        [STORAGE_KEY_RULE_HITS]: [...this.hits.entries()].map(([rule, count]) => ({ rule, count })),
      };
      // Written only once a tier has actually matched, so a ledger that has never seen a static
      // block keeps its stored shape — and a build without tier attribution reads it unchanged.
      if (this.tierHits.size > 0) {
        payload[STORAGE_KEY_TIER_HITS] = [...this.tierHits.entries()].map(([tier, count]) => ({
          tier,
          count,
        }));
      }
      await chrome.storage.local.set(payload);
    } catch (err) {
      // Keep the counts in memory and try again on the next flush rather than losing them.
      this.pending = 1;
      console.warn('[RuleHits] Could not persist rule hit counts:', err);
    }
  }

  async reset(): Promise<void> {
    this.hits.clear();
    this.tierHits.clear();
    this.pending = 0;
    try {
      await chrome.storage.local.remove([STORAGE_KEY_RULE_HITS, STORAGE_KEY_TIER_HITS]);
    } catch (err) {
      console.warn('[RuleHits] Could not clear rule hit counts:', err);
    }
  }

  snapshot(): RuleHitSnapshot {
    const hits = [...this.hits.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));

    const tiers: TierHitCounts = {};
    for (const [tier, count] of this.tierHits) tiers[tier] = count;

    return {
      totalHits: hits.reduce((sum, entry) => sum + entry.count, 0),
      distinctRules: hits.length,
      hits,
      tiers,
      text: hits.map((entry) => `${entry.count}\t${entry.rule}`).join('\n'),
    };
  }

  /**
   * Caps memory and storage. The long tail of one-off rules is dropped first, which is exactly
   * the part a coverage report does not need — it reports the head of the distribution.
   */
  private trim(): void {
    if (this.hits.size <= RULE_HIT_MAX_TRACKED) return;
    const kept = [...this.hits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, RULE_HIT_MAX_TRACKED);
    this.hits = new Map(kept);
  }
}
