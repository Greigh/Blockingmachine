import { isRuleException } from "./utils/ruleSyntax.js";
import type { RuleMetadata, StoredRule } from "./RuleStore.js";

// Reuse RuleMetadata and StoredRule from RuleStore to avoid duplicated/ diverging type definitions.
// Define an internal ExtendedRuleMetadata that makes some commonly-required fields explicitly required
// while still aligning with the canonical `RuleMetadata` shape.
type ExtendedRuleMetadata = RuleMetadata & {
  sources: string[];
  dateAdded: Date;
  lastUpdated: Date;
  enabled: boolean;
  sourceInfo: {
    category: string;
    trusted: boolean;
    url: string;
    priority: number;
  };
  tags: string[];
  // Optional fields that exist on some metadata records
  modifiers?: string[];
  attribution?: string;
};

// --- Interfaces/Types ---
interface DeduplicatorStats {
  total: number;
  duplicates: number;
  merged: number;
  conflicts: number;
  skipped: number;
  uniqueRules?: number; // Added for final stats
  duplicateGroups?: number; // Added for final stats
  duplicatePercent?: string; // Added for final stats
  subdomainsPruned?: number; // Pruned redundant subdomains under parent wildcards
}

// Use our extended RuleMetadata
export interface MergedRuleMetadata extends ExtendedRuleMetadata {
  alternatives?: string[];
}

export class RuleDeduplicator {
  // --- Properties with Types ---
  private filteredRules: Map<string, StoredRule>;
  private stats: DeduplicatorStats;

  constructor() {
    this.filteredRules = new Map();
    this.stats = {
      total: 0,
      duplicates: 0,
      merged: 0,
      conflicts: 0,
      skipped: 0,
    };
  }

  clear(): void {
    this.filteredRules.clear();
    this.stats = {
      total: 0,
      duplicates: 0,
      merged: 0,
      conflicts: 0,
      skipped: 0,
    };
  }

  getStats(): DeduplicatorStats {
    return { ...this.stats };
  }

  /**
   * Normalizes a rule string into a canonical key for deduplication.
   * @param rule The original rule string.
   * @returns A normalized string key, or an empty string if the rule is invalid/empty.
   */
  stripRule(rule: string | null | undefined): string {
    if (typeof rule !== "string" || !rule.trim()) return "";
    const raw = rule.trim();
    const exception = isRuleException(raw);
    const input = raw.replace(/^@@/, "");
    const cosmetic = input.match(/(#@\$\?#|#\$\?#|#@\?#|#@%#|#@\$#|#@#|#\?#|#\$#|#%#|##|\$\$)/);
    if (cosmetic && cosmetic.index !== undefined) {
      const marker = cosmetic[0];
      const scope = input.slice(0, cosmetic.index).toLowerCase();
      const payload = input.slice(cosmetic.index + marker.length);
      const kind = marker === "$$" ? "html"
        : /%|\$/.test(marker) || payload.startsWith("+js(") ? "scriptlet"
        : marker.includes("?") ? "extsel" : "sel";
      // Normalize whitespace for scriptlet payloads to ensure canonical keys ignore spacing differences
      const normalizedPayload = kind === "scriptlet" ? payload.replace(/\s+/g, " ").trim() : payload;
      return `${exception ? "@@" : ""}${scope || "modifier_or_selector_rule"}|${kind}=${normalizedPayload}`;
    }

    // A dollar sign inside a regex is part of the pattern. Only a suffix after
    // the closing slash can contain network modifiers.
    const regexEnd = input.startsWith("/") ? input.lastIndexOf("/") : -1;
    const isRegex = regexEnd > 0 && (regexEnd === input.length - 1 || input[regexEnd + 1] === "$");
    const dollar = isRegex ? (input[regexEnd + 1] === "$" ? regexEnd + 1 : -1) : input.indexOf("$");
    let target = dollar < 0 ? input : input.slice(0, dollar);
    const options = dollar < 0 ? "" : input.slice(dollar + 1);
    const hosts = target.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+([^\s#][^#]*)(?:#.*)?$/);
    if (hosts) target = hosts[1].trim();

    // Canonicalize only whole-host patterns. Never strip URL schemes, query
    // strings, path case, regex anchors, or a hostname's www label.
    const suffix = target.match(/^\|\|([a-z0-9.-]+)\^$/i);
    if (suffix) target = suffix[1].toLowerCase().replace(/\.$/, "");
    else if (/^[a-z0-9.-]+$/i.test(target)) target = target.toLowerCase().replace(/\.$/, "");
    if (!target) target = "modifier_or_selector_rule";

    // Complex modifier values can contain commas; retain them verbatim rather
    // than pretending that split(',') is a complete filter-language parser.
    if (/[\\/"']/.test(options)) return `${exception ? "@@" : ""}${target}|options=${options}`;
    let domain = "";
    const modifiers = options.split(",").filter(Boolean).map((modifier) => {
      const equal = modifier.indexOf("=");
      const name = (equal < 0 ? modifier : modifier.slice(0, equal)).trim().toLowerCase();
      const value = equal < 0 ? "" : modifier.slice(equal + 1);
      if (name === "domain") { domain = value.toLowerCase(); return ""; }
      return equal < 0 ? name : `${name}=${value}`;
    }).filter(Boolean).sort();
    return `${exception ? "@@" : ""}${target}${domain ? `|domain=${domain}` : ""}${modifiers.length ? `|mods=${modifiers.join(",")}` : ""}`;
  }

  /**
   * Processes an array of StoredRule objects, deduplicates them, and merges metadata.
   * @param rules An array of StoredRule objects.
   * @returns A Promise resolving to an array of unique StoredRule objects with merged metadata.
   */
  async processRules(rules: StoredRule[]): Promise<StoredRule[]> {
    this.clear();
    // Add parameter type and return type
    if (!Array.isArray(rules) || rules.length === 0) {
      console.warn("No rules to process");
      return [];
    }

    // Use StoredRule[] for the group value type
    const ruleGroups = new Map<string, StoredRule[]>();
    this.stats.total = rules.length;

    console.log(`\nProcessing ${rules.length} rules for deduplication...`);

    // First pass - group rules
    console.log("Starting rule grouping...");
    let processedCount = 0;
    for (const rule of rules) {
      processedCount++;
      try {
        // Check if rule and originalRule are valid
        if (!rule?.originalRule || typeof rule.originalRule !== "string") {
          this.stats.skipped++;
          continue;
        }

        const stripped = this.stripRule(rule.originalRule);

        // Log periodically
        // if (processedCount % 5000 === 0) {
        //   console.log(`[${processedCount}/${rules.length}] Rule: ${rule.originalRule} -> Key: ${stripped}`);
        // }

        if (!stripped) {
          this.stats.skipped++;
          continue;
        }

        // Grouping logic
        const group = ruleGroups.get(stripped);
        if (group) {
          group.push(rule);
        } else {
          ruleGroups.set(stripped, [rule]);
        }
      } catch (error: any) {
        // Add type to error
        console.warn(
          "Failed to process rule:",
          rule?.originalRule || "undefined",
          error.message,
        );
        this.stats.skipped++;
      }
    }
    console.log(
      `Finished grouping ${processedCount} rules into ${ruleGroups.size} groups.`,
    );

    // Second pass - identify and process duplicates
    this.filteredRules.clear(); // Ensure map is empty before filling
    for (const [stripped, group] of ruleGroups.entries()) {
      // Use entries() for clarity
      try {
        if (group.length > 1) {
          this.stats.duplicates += group.length - 1;
          const bestRule = this.selectBestRule(group);
          // Ensure metadata exists before merging, provide default if not
          this.filteredRules.set(stripped, { ...bestRule, metadata: this.mergeMetadata(group, bestRule) });
          this.stats.merged++;
        } else if (group.length === 1) {
          // Handle single rule group explicitly
          this.filteredRules.set(stripped, group[0]);
        }
        // If group is somehow empty (shouldn't happen with above logic), do nothing
      } catch (error: any) {
        // Add type to error
        console.warn("Failed to process rule group:", stripped, error.message);
        this.stats.conflicts++;
        // Keep the first rule as fallback if group exists
        if (group && group.length > 0) {
          this.filteredRules.set(stripped, group[0]);
        }
      }
    }

    // Pass 2.5: Subdomain Redundancy Pruning under parent wildcard blocks
    const unprunedList = Array.from(this.filteredRules.values());
    const optimizedList = this.pruneRedundantSubdomains(unprunedList);

    // Calculate final stats
    const finalStats: DeduplicatorStats = {
      ...this.stats,
      uniqueRules: optimizedList.length,
      duplicateGroups: [...ruleGroups.values()].filter((group) => group.length > 1).length, // Groups that had > 1 rule
      duplicatePercent:
        this.stats.total > 0
          ? ((this.stats.duplicates / this.stats.total) * 100).toFixed(2) + "%"
          : "0.00%",
      subdomainsPruned: unprunedList.length - optimizedList.length,
    };
    this.stats = finalStats; // Update internal stats

    console.log("\nDeduplication complete!");
    console.table(finalStats); // Use console.table for better output

    return optimizedList;
  }

  /**
   * Prunes child subdomains that are already completely covered by an existing
   * parent wildcard domain block (e.g. ||example.com^ blocks all *.example.com).
   * Allowlist exceptions (@@) and cosmetic rules (##) are never pruned.
   */
  public pruneRedundantSubdomains(rules: StoredRule[]): StoredRule[] {
    const parentWildcards = new Set<string>();
    const disabledParents = new Set(rules.filter((rule) => rule.metadata?.enabled !== false)
      .map((rule) => rule.originalRule.match(/^\|\|([a-z0-9.-]+)\^\$badfilter$/i)?.[1]?.toLowerCase())
      .filter((domain): domain is string => !!domain));

    // 1. Collect all root/parent wildcard domains without restricting modifiers
    for (const rule of rules) {
      if (rule.type === "blocking" && rule.metadata?.enabled !== false && !rule.originalRule.startsWith("@@")) {
        const match = rule.originalRule.match(/^\|\|([a-z0-9.-]+)\^$/i);
        if (match && !disabledParents.has(match[1].toLowerCase())) {
          parentWildcards.add(match[1].toLowerCase());
        }
      }
    }

    if (parentWildcards.size === 0) {
      return rules;
    }

    // 2. Identify redundant subdomains
    const result: StoredRule[] = [];
    let prunedCount = 0;

    for (const rule of rules) {
      // Never prune exceptions or cosmetic rules
      if (
        rule.type !== "blocking" ||
        rule.originalRule.startsWith("@@") ||
        rule.originalRule.includes("##")
      ) {
        result.push(rule);
        continue;
      }

      let targetDomain: string | null = null;
      if (rule.originalRule.startsWith("||")) {
        const match = rule.originalRule.match(/^\|\|([a-z0-9.-]+)\^$/i);
        if (match) {
          targetDomain = match[1].toLowerCase();
        }
      } else if (
        rule.originalRule.startsWith("0.0.0.0 ") ||
        rule.originalRule.startsWith("127.0.0.1 ")
      ) {
        const parts = rule.originalRule.trim().split(/\s+/);
        if (parts.length >= 2) {
          targetDomain = parts[1].toLowerCase();
        }
      } else if (
        !rule.originalRule.includes("/") &&
        !rule.originalRule.includes("$")
      ) {
        // Plain domain
        targetDomain = rule.originalRule.trim().toLowerCase();
      }

      if (!targetDomain) {
        result.push(rule);
        continue;
      }

      // Check if targetDomain has an active parent in parentWildcards
      let isRedundant = false;
      const dotIndex = targetDomain.indexOf(".");
      if (dotIndex > 0) {
        let parentCandidate = targetDomain.slice(dotIndex + 1);
        while (parentCandidate.includes(".")) {
          if (parentWildcards.has(parentCandidate)) {
            isRedundant = true;
            break;
          }
          const nextDot = parentCandidate.indexOf(".");
          if (nextDot === -1) break;
          parentCandidate = parentCandidate.slice(nextDot + 1);
        }
      }

      if (isRedundant) {
        prunedCount++;
        this.stats.duplicates++;
      } else {
        result.push(rule);
      }
    }

    if (prunedCount > 0) {
      console.log(
        `[RuleDeduplicator] Pruned ${prunedCount} redundant subdomain rules under parent wildcards.`,
      );
    }

    return result;
  }

  /**
   * Deduplicates and aggregates IP-based blocking rules (e.g. 0.0.0.0 ip, 127.0.0.1 ip, or CIDR).
   */
  public collapseIpRules(rules: StoredRule[]): StoredRule[] {
    const seenIps = new Set<string>();
    const result: StoredRule[] = [];

    for (const rule of rules) {
      const trimmed = (rule.originalRule || rule.raw || "").trim();
      const match = trimmed.match(
        /^(?:(?:0\.0\.0\.0|127\.0\.0\.1)\s+)?((?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:\/[0-9]{1,2})?)$/
      );

      if (match) {
        const ip = match[1];
        if (seenIps.has(ip)) {
          this.stats.duplicates++;
          continue;
        }
        seenIps.add(ip);
        result.push(rule);
      } else {
        result.push(rule);
      }
    }

    return result;
  }

  /**
   * Selects the "best" rule from a group of duplicates based on a scoring system.
   * @param rules An array of StoredRule objects that are duplicates.
   * @returns The selected best StoredRule.
   */
  selectBestRule(rules: StoredRule[]): StoredRule {
    // Add parameter type and return type
    // Filter out potentially null/undefined rules first
    const validRules = rules.filter((r) => r && r.originalRule);
    if (validRules.length === 0) {
      // Should not happen if grouping is correct, but handle defensively
      throw new Error("Cannot select best rule from empty or invalid group.");
    }
    if (validRules.length === 1) {
      return validRules[0];
    }

    return validRules.reduce((best, current) => {
      if ((current.metadata?.enabled !== false) !== (best.metadata?.enabled !== false)) {
        return current.metadata?.enabled !== false ? current : best;
      }
      // Prefer $important rule over non-important when scores are equal or lower
      const bestImportant = best.originalRule.includes('$important');
      const currentImportant = current.originalRule.includes('$important');
      if (currentImportant && !bestImportant) return current;
      if (!currentImportant && bestImportant) return best;
      // When merging a suffix block with exact hosts entries, retain coverage
      // of its subdomains regardless of provenance scoring.
      const currentSuffix = /^\|\|[a-z0-9.-]+\^$/i.test(current.originalRule);
      const bestSuffix = /^\|\|[a-z0-9.-]+\^$/i.test(best.originalRule);
      if (currentSuffix !== bestSuffix) return currentSuffix ? current : best;
      const currentScore = this.getRuleScore(current);
      const bestScore = this.getRuleScore(best);

      // Tie-breaking: prefer shorter original rule? Or rule from primary source?
      if (currentScore === bestScore) {
        // Example: Prefer shorter rule
        return current.originalRule.length < best.originalRule.length
          ? current
          : best;
      }

      return currentScore > bestScore ? current : best;
    }); // No need for initial value if we ensure validRules is not empty
  }

  /**
   * Merges metadata from a group of duplicate rules into the best rule's metadata.
   * @param group The array of duplicate StoredRule objects.
   * @param bestRule The StoredRule selected as the best.
   * @returns The merged RuleMetadata object.
   */
  mergeMetadata(
    group: StoredRule[],
    bestRule: StoredRule,
  ): MergedRuleMetadata {
    // Add parameter types and return type
    try {
      // Start with a copy of the best rule's metadata or an empty object
      const merged: MergedRuleMetadata = {
        ...(bestRule.metadata || {}),
      } as MergedRuleMetadata;

      // Combine sources
      const sources = new Set<string>(merged.sources || []);
      group.forEach((rule) => {
        if (rule?.metadata?.sources) {
          rule.metadata.sources.forEach((source) => {
            if (typeof source === "string") sources.add(source);
          });
        }
      });
      merged.sources = Array.from(sources);

      // Merge dates - keep earliest valid date string
      const dates = group
        .map((rule) => rule?.metadata?.dateAdded)
        .filter(
          (date): date is Date =>
            (date instanceof Date && Number.isFinite(date.getTime())) ||
            (typeof date === "string" && !isNaN(Date.parse(date))),
        )
        .map((date) => (date instanceof Date ? date : new Date(date)))
        .sort((a, b) => a.getTime() - b.getTime());

      if (dates.length > 0) {
        merged.dateAdded = dates[0];
      } else {
        merged.dateAdded = new Date();
      }

      // Combine modifiers
      const modifiers = new Set<string>((merged.modifiers as string[]) || []);
      group.forEach((rule) => {
        const ruleMetadata = rule?.metadata as ExtendedRuleMetadata;
        if (ruleMetadata?.modifiers) {
          ruleMetadata.modifiers.forEach((mod) => {
            if (typeof mod === "string") modifiers.add(mod);
          });
        }
      });
      merged.modifiers = Array.from(modifiers);

      // Keep track of original rules (alternatives)
      merged.alternatives = group
        .filter((r) => r !== bestRule && r?.originalRule)
        .map((r) => r.originalRule);

      // Ensure all required fields have values
      if (!merged.dateAdded) merged.dateAdded = new Date();
      if (!merged.lastUpdated) merged.lastUpdated = new Date();
      if (merged.enabled === undefined) merged.enabled = true;
      if (!merged.sourceInfo) {
        merged.sourceInfo = {
          category: "unknown",
          trusted: false,
          url: "",
          priority: 0,
        };
      }
      merged.tags = [...new Set(group.flatMap((rule) => rule.metadata?.tags || []))];
      merged.sourceInfo = { ...merged.sourceInfo };
      merged.dateAdded = new Date(merged.dateAdded);
      merged.lastUpdated = new Date(merged.lastUpdated);

      return merged;
    } catch (error: any) {
      console.warn("Failed to merge metadata:", error.message);
      // Return with all required fields populated
      return {
        ...bestRule.metadata,
        sources: bestRule.metadata?.sources || [],
        dateAdded: bestRule.metadata?.dateAdded || new Date(),
        lastUpdated: bestRule.metadata?.lastUpdated || new Date(),
        enabled:
          bestRule.metadata?.enabled !== undefined
            ? bestRule.metadata.enabled
            : true,
        sourceInfo: bestRule.metadata?.sourceInfo || {
          category: "unknown",
          trusted: false,
          url: "",
          priority: 0,
        },
        tags: bestRule.metadata?.tags || [],
      } as ExtendedRuleMetadata;
    }
  }

  /**
   * Calculates a score for a rule to help select the best among duplicates.
   * @param rule The StoredRule object to score.
   * @returns A numerical score.
   */
  getRuleScore(rule: StoredRule | null | undefined): number {
    // Add parameter type and return type
    let score = 0;
    if (!rule?.metadata || !rule.originalRule) return score; // Check originalRule too
    const originalRuleLower = rule.originalRule.toLowerCase(); // Safe now

    // Base scores
    if (rule.metadata.sources?.length)
      score += rule.metadata.sources.length * 2;

    // Cast to ExtendedRuleMetadata to access modifiers and attribution
    const metadata = rule.metadata as ExtendedRuleMetadata;
    if (Array.isArray(metadata.modifiers) && metadata.modifiers.length > 0) {
      score += metadata.modifiers.length * 2;
    }
    if (metadata.dateAdded) score += 5; // Consider date validity?

    // Bonus scores
    if (originalRuleLower.includes("$important")) score += 10;
    // Access sourceInfo safely
    if (metadata.sourceInfo?.trusted) score += 15;
    // Access attribution safely
    if (metadata.attribution?.toLowerCase().includes("greigh studios llc"))
      score += 20; // Lowercase for comparison

    // Domain-specific rules
    if (originalRuleLower.includes("$domain=")) score += 8;

    // Exact matches (needs refinement - what defines "exact"?)
    // This check is very basic, might need adjustment based on `stripRule` logic
    const corePart = rule.originalRule.split("$")[0].split("#")[0].trim();
    if (!/[*^|]/.test(corePart)) score += 5;

    return score;
  }
}
