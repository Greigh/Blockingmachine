/**
 * The filter lines behind the shipped static rulesets, indexed once per worker lifetime.
 *
 * A match names the ruleset and rule id the browser chose; the *filter text* — the thing the ledger
 * is keyed by, and the only form comparable with the compiled list — exists only in the rule file.
 * So the files have to be read, and the first page load is when that happens, while dozens of
 * matches are arriving at once.
 *
 * That timing is the whole reason this is a module rather than a handful of lines in the background:
 * the obvious implementation sets a `loaded` flag before the fetches finish, which looks like
 * memoisation and is not one. Every match arriving during the first build then finds the flag
 * already true, reads a still-empty map, and is recorded with no rule name. Measured on a real page,
 * that was 39 of 40 matches landing as unattributed — a ledger that reported one rule for a whole
 * page load. The build is shared here instead of short-circuited.
 *
 * A tier that cannot be read is skipped rather than failing the build, and is not retried later: the
 * file ships inside the extension, so one that cannot be read now will not read differently on the
 * next match, and re-reading it per match would be the worst of both. Tiers are independent, so a
 * single unreadable file only leaves its own rules unnamed.
 */

/** A shipped ruleset tier: the id the browser reports, and the file holding its rules. */
export interface StaticTierSpec {
  id: string;
  path: string;
}

export interface StaticRuleIndexOptions {
  tiers: readonly StaticTierSpec[];
  /** Reads and parses one tier's rule file. Rejecting means that tier goes unresolved. */
  readTier: (path: string) => Promise<unknown>;
}

interface StoredRuleLike {
  id?: unknown;
  condition?: { urlFilter?: unknown };
}

export class StaticRuleIndex {
  private readonly filters = new Map<string, string>();
  private build: Promise<void> | null = null;

  constructor(private readonly options: StaticRuleIndexOptions) {}

  /** Rules indexed so far. */
  get size(): number {
    return this.filters.size;
  }

  /**
   * The filter line a match came from, or `undefined` when it cannot be named.
   *
   * `undefined` is a real answer, not a failure to look: a dynamic rule, a rule the browser no
   * longer knows about, or a tier file that could not be read all genuinely have no filter text,
   * and the caller records the match as unattributed rather than inventing one.
   */
  filterFor(rulesetId: unknown, ruleId: unknown): string | undefined {
    if (typeof ruleId !== 'number') return undefined;
    const ruleset = typeof rulesetId === 'string' ? rulesetId : '';
    return this.filters.get(`${ruleset}#${ruleId}`);
  }

  /**
   * Builds the index, reusing an in-flight build rather than starting a second one.
   *
   * Concurrent callers await the same promise, which is the point: the first build runs while the
   * matches that triggered it keep arriving.
   */
  async ensure(): Promise<void> {
    if (!this.build) this.build = this.load();
    await this.build;
  }

  private async load(): Promise<void> {
    for (const tier of this.options.tiers) {
      try {
        const rules = await this.options.readTier(tier.path);
        if (!Array.isArray(rules)) continue;
        for (const rule of rules as StoredRuleLike[]) {
          const filter = rule?.condition?.urlFilter;
          if (typeof rule?.id === 'number' && typeof filter === 'string' && filter) {
            this.filters.set(`${tier.id}#${rule.id}`, filter);
          }
        }
      } catch {
        // A tier we cannot read simply goes unresolved; the rest of the ledger still works.
      }
    }
  }
}
