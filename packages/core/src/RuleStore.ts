import { createRuleMetadata } from "./createMetadata.js";
import { RuleProcessor } from "./RuleProcessor.js";
import crypto from "crypto";
import { performance } from "perf_hooks";

// --- Base Types ---
export type RuleType =
  | "domain"
  | "regex"
  | "exception"
  | "cosmetic"
  | "unknown"
  | "blocking"
  | "unblocking"
  | "scriptlet"
  | "csp"
  | "redirect"
  | "replace"
  | "removeheader"
  | "removeparam"
  | "parameter" // Add parameter type
  | "html-filtering"
  | "permissions"
  | "extended-css";

export type GenericRuleType = Extract<
  RuleType,
  | "scriptlet"
  | "csp"
  | "redirect"
  | "replace"
  | "removeheader"
  | "removeparam"
  | "parameter" // Add parameter
  | "html-filtering"
  | "permissions"
  | "extended-css"
>;

export type RuleClassificationType =
  | RuleType
  | "preprocessor"
  | "hint"
  | "comment"
  | null;

// --- Rule Interfaces ---
export interface RuleModifier {
  type: string;
  value?: string;
  domains?: string[];
}

export interface RuleMetadata {
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
  domain?: string;
  selector?: string;
}

export interface StoredRule {
  raw: string;
  originalRule: string;
  hash: string;
  type: RuleType;
  domain?: string;
  isException?: boolean; // Add this field
  metadata: RuleMetadata;
  variants?: Array<{
    rule: string;
    source: string;
    dateAdded: Date;
    modifiers: RuleModifier[];
    tags: string[];
  }>;
}

// --- Statistics Interface ---
export interface RuleStats {
  totalProcessed: number;
  duplicates: number;
  merged: number;
  skipped: number;
  invalid: number;
  blocking: number;
  unblocking: number;
  cosmetic: number;
  scriptlet: number;
  preprocessor: number;
  hint: number;
  csp: number;
  redirect: number;
  replace: number;
  removeheader: number;
  removeparam: number;
  "html-filtering": number;
  permissions: number;
  "extended-css": number;
}

// --- RuleStore Class ---
export class RuleStore {
  // --- Class Properties with Types ---
  private ruleProcessor: RuleProcessor;
  private blockingRules: Map<string, StoredRule>; // Key: domain/pattern or hash
  private unblockingRules: Map<string, StoredRule>; // Key: domain/pattern or hash
  private cosmeticRules: Map<string, StoredRule>; // Key: selector
  private scriptletRules: Map<string, StoredRule>; // Key: hash
  private cspRules: Map<string, StoredRule>; // Key: hash
  private redirectRules: Map<string, StoredRule>; // Key: hash
  private replaceRules: Map<string, StoredRule>; // Key: hash
  private removeHeaderRules: Map<string, StoredRule>; // Key: hash
  private removeParamRules: Map<string, StoredRule>; // Key: hash
  private htmlFilteringRules: Map<string, StoredRule>; // Key: hash
  private extendedCssRules: Map<string, StoredRule>; // Key: hash
  private permissionsRules: Map<string, StoredRule>; // Key: hash
  // Add maps for other types if needed (preprocessor, hint are just counted for now)

  private stats: RuleStats;

  // --- Constructor ---
  constructor(ruleProcessor: RuleProcessor) {
    // Basic validation for ruleProcessor dependency
    if (!ruleProcessor || typeof ruleProcessor.classifyRule !== "function") {
      throw new Error("RuleStore requires a valid RuleProcessor instance.");
    }
    this.ruleProcessor = ruleProcessor;

    // Initialize maps for each rule type
    this.blockingRules = new Map();
    this.unblockingRules = new Map();
    this.cosmeticRules = new Map();
    this.scriptletRules = new Map();
    this.cspRules = new Map();
    this.redirectRules = new Map();
    this.replaceRules = new Map();
    this.removeHeaderRules = new Map();
    this.removeParamRules = new Map();
    this.htmlFilteringRules = new Map();
    this.extendedCssRules = new Map();
    this.permissionsRules = new Map();

    // Initialize stats object
    this.stats = {
      totalProcessed: 0,
      duplicates: 0,
      merged: 0,
      skipped: 0,
      invalid: 0,
      blocking: 0,
      unblocking: 0,
      cosmetic: 0,
      scriptlet: 0,
      preprocessor: 0,
      hint: 0,
      csp: 0,
      redirect: 0,
      replace: 0,
      removeheader: 0,
      removeparam: 0,
      "html-filtering": 0,
      permissions: 0,
      "extended-css": 0,
    };
  }

  // Helper to generate SHA-256 hash
  private generateHash(rule: string): string {
    return crypto.createHash("sha256").update(rule).digest("hex");
  }

  // Generic Handler for Map-based Rules
  // Use the more specific GenericRuleType for the 'type' parameter
  private addGenericRule(
    map: Map<string, StoredRule>,
    type: GenericRuleType,
    metadata: RuleMetadata,
    originalRule: string,
  ): void {
    // Map 'parameter' type to 'removeparam' stat key if necessary
    const statType = (
      type === "parameter" ? "removeparam" : type
    ) as keyof RuleStats;

    // Check if the mapped statType is valid before proceeding
    if (!(statType in this.stats)) {
      console.error(
        `[addGenericRule] Invalid or unhandled stat type: '${statType}' (mapped from '${type}') for rule: ${originalRule}`,
      );
      this.stats.invalid++;
      return;
    }

    const ruleHash = this.generateHash(originalRule);
    const key = ruleHash; // Use hash as the key for generic rules

    const existingRule = map.get(key);

    if (!existingRule) {
      map.set(key, {
        raw: originalRule,
        originalRule: originalRule,
        hash: ruleHash,
        type: type as RuleType,
        metadata: {
          sources: metadata.sources || [],
          dateAdded: new Date(),
          lastUpdated: new Date(),
          enabled: true,
          sourceInfo: {
            category: metadata.sourceInfo?.category || "unknown",
            trusted: false,
            url: metadata.sourceInfo?.url || "",
            priority: metadata.sourceInfo?.priority || 0, // Add default priority
          },
          tags: [],
          domain: metadata.domain || undefined,
          selector: metadata.selector || undefined,
        },
      });
      // Increment the specific stat count using the mapped statType
      if (this.stats[statType] !== undefined) {
        this.stats[statType]++;
      } else {
        // This should theoretically not happen due to the check above
        console.warn(
          `[addGenericRule] Stat key '${statType}' not found for incrementing.`,
        );
      }
    } else {
      // Handle duplicate: Merge sources
      if (metadata?.sources && Array.isArray(metadata.sources)) {
        const currentSources = new Set(existingRule.metadata.sources || []);
        let updated = false;
        for (const src of metadata.sources) {
          if (!currentSources.has(src)) {
            currentSources.add(src);
            updated = true;
          }
        }
        if (updated) {
          existingRule.metadata.sources = Array.from(currentSources);
          this.stats.merged++; // Increment merged count
        }
      }
      this.stats.duplicates++;
    }
  }

  // Main method to add a rule string
  addRule(originalRule: string, sourceName: string = "unknown"): void {
    this.stats.totalProcessed++;
    const trimmedRule = originalRule.trim();

    // Skip empty lines immediately
    if (!trimmedRule) {
      this.stats.skipped++;
      return;
    }

    // Explicitly type the result of classifyRule
    const type: RuleClassificationType =
      this.ruleProcessor.classifyRule(trimmedRule);

    // Skip comments or unclassified/invalid types
    // Adjust this check based on what classifyRule actually returns for invalid/comments
    if (!type || type === "comment") {
      this.stats.skipped++;
      return;
    }

    // Create metadata
    const metadata = createRuleMetadata(
      sourceName,
      type === "preprocessor" || type === "hint" ? "unknown" : type, // Convert non-RuleType to 'unknown'
      trimmedRule,
    );
    if (!metadata.sources) {
      metadata.sources = [sourceName];
    } else if (!Array.isArray(metadata.sources)) {
      metadata.sources = [String(metadata.sources)]; // Ensure it's an array
    }

    try {
      let targetMap: Map<string, StoredRule> | null = null;
      let isGenericHandledType = false;

      // The switch now operates on the explicitly typed 'type' variable
      switch (type) {
        case "blocking":
        case "unblocking":
          this.handleStandardRule(trimmedRule, type, metadata);
          break; // Exit switch
        case "cosmetic":
          this.handleCosmeticRule(trimmedRule, metadata);
          break; // Exit switch

        // Cases handled by addGenericRule
        case "scriptlet":
          targetMap = this.scriptletRules;
          isGenericHandledType = true;
          break; // Exit switch
        case "csp":
          targetMap = this.cspRules;
          isGenericHandledType = true;
          break; // Exit switch
        case "redirect":
          targetMap = this.redirectRules;
          isGenericHandledType = true;
          break; // Exit switch
        case "replace":
          targetMap = this.replaceRules;
          isGenericHandledType = true;
          break; // Exit switch
        case "removeheader":
          targetMap = this.removeHeaderRules;
          isGenericHandledType = true;
          break; // Exit switch
        case "removeparam": // Fall-through
        case "parameter": // Both use removeParamRules map
          targetMap = this.removeParamRules;
          isGenericHandledType = true;
          break; // Exit switch
        case "html-filtering":
          targetMap = this.htmlFilteringRules;
          isGenericHandledType = true;
          break; // Exit switch
        case "permissions":
          targetMap = this.permissionsRules;
          isGenericHandledType = true;
          break; // Exit switch
        case "extended-css":
          targetMap = this.extendedCssRules;
          isGenericHandledType = true;
          break; // Exit switch

        // Types only counted
        case "preprocessor":
        case "hint":
          // Ensure type is a valid key before incrementing
          const statKey = type as keyof RuleStats;
          if (statKey in this.stats && this.stats[statKey] !== undefined) {
            this.stats[statKey]++;
          } else {
            console.warn(
              `[addRule] Stat key '${type}' not found or undefined for incrementing.`,
            );
          }
          // No targetMap assigned, will skip addGenericRule call below
          break; // Exit switch

        default:
          // This case now handles any string value from classifyRule not explicitly listed
          console.warn(
            `[RuleStore.addRule] Unhandled or unknown type: ${type} for rule: ${trimmedRule}`,
          );
          this.stats.invalid++;
          // No targetMap assigned, will skip addGenericRule call below
          break; // Exit switch
      }

      // Call addGenericRule only if a targetMap was assigned AND it's a type meant for it
      if (targetMap && isGenericHandledType) {
        // The 'type' variable is narrowed within the cases above.
        // Casting to GenericRuleType is safe here because isGenericHandledType is true.
        this.addGenericRule(
          targetMap,
          type as GenericRuleType,
          metadata,
          trimmedRule,
        );
      }
    } catch (error) {
      console.error(
        `[RuleStore.addRule] Error processing rule: ${trimmedRule}`,
        error,
      );
      this.stats.invalid++;
    }
  }

  // Handles blocking and unblocking rules (domain/pattern or hash keyed)
  private handleStandardRule(
    originalRule: string,
    type: "blocking" | "unblocking",
    metadata: RuleMetadata,
  ): void {
    let key: string | null;
    let isHashKey = false;

    // Determine if it should use a hash key (global modifiers, etc.)
    if (
      originalRule.includes("$") &&
      !originalRule.includes("#") &&
      !originalRule.includes("##")
    ) {
      // Simple check: if '$' is present but not cosmetic/scriptlet markers, assume hash key needed
      key = this.generateHash(originalRule);
      isHashKey = true;
    } else {
      // Extract domain pattern manually since cleanDomainPattern doesn't exist
      key = this.extractDomainFromRule(originalRule);
    }

    if (!key) {
      console.warn(
        `[handleStandardRule] Could not determine key for ${type} rule: ${originalRule}`,
      );
      this.stats.invalid++;
      return;
    }

    const ruleMap =
      type === "unblocking" ? this.unblockingRules : this.blockingRules;
    const existingRule = ruleMap.get(key);
    const ruleHash = this.generateHash(originalRule);

    if (existingRule?.hash === ruleHash) {
      // Exact duplicate based on hash
      this.stats.duplicates++;
      // Optionally merge sources if needed (similar to addGenericRule)
      return;
    }

    // If keys match but hashes differ, it might be a conflict or update.
    // For simplicity, we'll overwrite if the key isn't a hash,
    // or add if the key is a hash (allowing multiple hash-keyed rules).
    if (existingRule && !isHashKey) {
      console.warn(
        `[handleStandardRule] Overwriting rule with same key '${key}' but different content. Old: ${existingRule.originalRule}, New: ${originalRule}`,
      );
      // Optionally increment a specific stat for overwrites
    }

    const ruleData: StoredRule = {
      raw: originalRule,
      originalRule,
      hash: ruleHash,
      type: type,
      metadata: {
        sources: metadata.sources || [],
        dateAdded: new Date(),
        lastUpdated: new Date(),
        enabled: true,
        sourceInfo: {
          category: metadata.sourceInfo?.category || "unknown",
          trusted: false,
          url: metadata.sourceInfo?.url || "",
          priority: metadata.sourceInfo?.priority || 0,
        },
        tags: [],
        domain: isHashKey ? undefined : key,
      },
    };

    ruleMap.set(key, ruleData);
    this.stats[type]++; // Increment specific stat
  }

  // Handles cosmetic rules (selector keyed)
  private handleCosmeticRule(
    originalRule: string,
    metadata: RuleMetadata,
  ): void {
    // Extract selector manually since extractSelector doesn't exist
    const selector = this.extractSelectorFromRule(originalRule);

    if (!selector) {
      if (!originalRule.includes("#$#") && !originalRule.includes("#%#")) {
        console.warn(
          `[handleCosmeticRule] Could not extract selector for rule: ${originalRule}`,
        );
        this.stats.invalid++;
      } else {
        console.warn(
          `[handleCosmeticRule] Rule with #$#/#%# classified as cosmetic, expected scriptlet: ${originalRule}`,
        );
        this.stats.invalid++;
      }
      return;
    }

    const key = selector;
    const ruleHash = this.generateHash(originalRule);
    const existingRule = this.cosmeticRules.get(key);

    if (existingRule?.hash === ruleHash) {
      this.stats.duplicates++;
      // Optionally merge sources
      return;
    }

    if (existingRule) {
      console.warn(
        `[handleCosmeticRule] Overwriting rule with same selector '${key}' but different content. Old: ${existingRule.originalRule}, New: ${originalRule}`,
      );
    }

    const ruleData: StoredRule = {
      raw: originalRule,
      originalRule,
      hash: ruleHash,
      type: "cosmetic",
      metadata: {
        sources: metadata.sources || [],
        dateAdded: new Date(),
        lastUpdated: new Date(),
        enabled: true,
        sourceInfo: {
          category: metadata.sourceInfo?.category || "unknown",
          trusted: false,
          url: metadata.sourceInfo?.url || "",
          priority: metadata.sourceInfo?.priority || 0,
        },
        tags: [],
        selector: key,
      },
    };

    this.cosmeticRules.set(key, ruleData);
    this.stats.cosmetic++;
  }

  // Combine rules from all relevant maps
  getUniqueRules(): StoredRule[] {
    console.log("\nCombining rules from all categories...");
    const allRules = [
      ...this.blockingRules.values(),
      ...this.unblockingRules.values(),
      ...this.cosmeticRules.values(),
      ...this.scriptletRules.values(),
      ...this.cspRules.values(),
      ...this.redirectRules.values(),
      ...this.replaceRules.values(),
      ...this.removeHeaderRules.values(),
      ...this.removeParamRules.values(),
      ...this.htmlFilteringRules.values(),
      ...this.permissionsRules.values(),
      ...this.extendedCssRules.values(),
    ];
    console.log(`   Combined ${allRules.length} rules.`);

    // Note: This combines rules based on their storage keys.
    // True uniqueness across types might require further hashing/comparison if needed.
    return allRules;
  }

  // Get the current statistics
  getStats(): RuleStats {
    return { ...this.stats }; // Return a copy
  }

  // Add these helper methods to RuleStore
  private extractDomainFromRule(rule: string): string | null {
    // Simple domain extraction logic
    const cleanRule = rule.replace(/^@@/, ""); // Remove exception marker

    // Handle different rule formats
    if (cleanRule.includes("##") || cleanRule.includes("#@#")) {
      // Cosmetic rule - extract domain part
      const parts = cleanRule.split(/##|#@#/);
      return parts[0] || null;
    }

    if (cleanRule.includes("$")) {
      // Rule with modifiers - extract part before $
      const parts = cleanRule.split("$");
      return parts[0] || null;
    }

    // Simple domain or pattern
    return cleanRule || null;
  }

  private extractSelectorFromRule(rule: string): string | null {
    // Extract CSS selector from cosmetic rules
    if (rule.includes("##")) {
      const parts = rule.split("##");
      return parts[1] || null;
    }

    if (rule.includes("#@#")) {
      const parts = rule.split("#@#");
      return parts[1] || null;
    }

    return null;
  }
}
