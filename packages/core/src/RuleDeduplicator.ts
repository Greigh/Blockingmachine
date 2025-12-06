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
}

// Use our extended RuleMetadata
interface MergedRuleMetadata extends ExtendedRuleMetadata {
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

  /**
   * Normalizes a rule string into a canonical key for deduplication.
   * @param rule The original rule string.
   * @returns A normalized string key, or an empty string if the rule is invalid/empty.
   */
  stripRule(rule: string | null | undefined): string {
    if (!rule) return "";
    try {
      const originalRule = rule;
      let stripped = rule;
      const isException = stripped.startsWith("@@");
      if (isException) {
        stripped = stripped.slice(2); // Here the @@ prefix is removed
      }

      // 1. Extract and Normalize Key Modifiers/Selectors
      const parts = {
        domain: (stripped.match(/\$domain=([^,$/]+)/)?.[1] || "")
          .toLowerCase()
          .trim(),
        // Ensure modifiers are handled correctly even if no '$' is present
        modifiers: (stripped.match(/\$([^#]*?)(?:##|#\?#|#@#|$)/)?.[1] || "")
          .split(",")
          .map((m) => m.split("=")[0].toLowerCase().trim())
          .filter((m) => m && m !== "domain") // Ensure 'domain' modifier itself isn't included here
          .sort()
          .join(","),
        selector: (stripped.match(/(?:##|#@#)(.+)/)?.[1] || "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim(),
        extendedSelector: (stripped.match(/#\?#(.+)/)?.[1] || "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim(),
      };

      // 2. Remove all modifiers, selectors, options from the core rule string
      stripped = stripped
        .replace(/\$.*$/, "") // Remove modifiers section
        .replace(/(?:##|#@#|#\?#).*$/, "") // Remove cosmetic/extended selectors
        .replace(/!\s*.*$/, ""); // Remove comments

      // 3. Refined Normalization of the Core Target String
      stripped = stripped
        .replace(/^(?:https?:\/\/)?(?:www\.)?/, "") // Remove http/https, www.
        .replace(/[?#].*$/, "") // Remove Query String and Anchor
        .replace(/[\^/]+$/, "") // Remove one or MORE trailing ^ or /
        .replace(/\.+$/, "") // Remove trailing dots
        .toLowerCase() // Lowercase the result
        .trim(); // Final trim

      // Handle cases where stripping leaves nothing
      if (
        !stripped &&
        (parts.modifiers || parts.selector || parts.extendedSelector)
      ) {
        stripped = "modifier_or_selector_rule"; // Use a placeholder key
      } else if (!stripped) {
        // console.warn(`[stripRule] Stripping resulted in empty key for: ${originalRule}`);
        return ""; // Return empty string if truly empty after stripping
      }

      // 4. Build the Normalized Key
      const components = [
        stripped,
        parts.domain && `domain=${parts.domain}`,
        parts.modifiers && `mods=${parts.modifiers}`, // Keep mods= prefix for clarity
        parts.selector && `sel=${parts.selector}`,
        parts.extendedSelector && `extsel=${parts.extendedSelector}`,
      ].filter(Boolean); // Filter out empty strings

      // The prefix is added back only at the very end
      let normalized = components.join("|");
      if (isException) normalized = "@@" + normalized;

      return normalized;
    } catch (error: any) {
      console.warn(`Failed to strip rule: ${rule}`, error.message);
      return rule;
    }
  }

  /**
   * Processes an array of StoredRule objects, deduplicates them, and merges metadata.
   * @param rules An array of StoredRule objects.
   * @returns A Promise resolving to an array of unique StoredRule objects with merged metadata.
   */
  async processRules(rules: StoredRule[]): Promise<StoredRule[]> {
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
          bestRule.metadata = this.mergeMetadata(group, bestRule);
          this.filteredRules.set(stripped, bestRule);
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

    // Calculate final stats
    const finalStats: DeduplicatorStats = {
      ...this.stats,
      uniqueRules: this.filteredRules.size,
      duplicateGroups: ruleGroups.size - this.filteredRules.size, // Groups that had > 1 rule
      duplicatePercent:
        this.stats.total > 0
          ? ((this.stats.duplicates / this.stats.total) * 100).toFixed(2) + "%"
          : "0.00%",
    };
    this.stats = finalStats; // Update internal stats

    console.log("\nDeduplication complete!");
    console.table(finalStats); // Use console.table for better output

    return Array.from(this.filteredRules.values());
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
  ): ExtendedRuleMetadata {
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
            date instanceof Date ||
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
      if (!merged.tags) merged.tags = [];

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
    if (metadata.attribution?.toLowerCase().includes("daniel hipskind"))
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
