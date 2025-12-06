import type {
  FilterSource,
  CategoryName,
  RuleType,
  RuleModifier,
  StoredRule,
  ImportStats,
} from "../types.js";
import { CATEGORIES } from "../types.js";
import type { CommandOptions } from "../commands/BaseCommand.js";
import { StoredRuleModel } from "./db.js";
import fetch from "node-fetch";
import ProgressBar from "progress";
import crypto from "crypto";

function determineRuleType(rule: string): RuleType {
  if (rule.startsWith("||") || rule.includes("^")) return "domain";
  if (rule.startsWith("/") && rule.endsWith("/")) return "regex";
  if (rule.startsWith("@@")) return "exception";
  if (rule.includes("##") || rule.includes("#@#")) return "cosmetic";
  return "unknown";
}

function extractDomain(rule: string): string | undefined {
  // Remove any leading exception markers
  rule = rule.replace(/^@@/, "");

  // Handle domain-specific rules
  if (rule.startsWith("||")) {
    const domain = rule.slice(2).split(/[/:^]/)[0];
    return domain;
  }

  // Handle plain domain rules
  if (rule.match(/^[a-zA-Z0-9.-]+$/)) {
    return rule;
  }

  // Try to extract domain from more complex rules
  const match = rule.match(/[|]*([a-zA-Z0-9][a-zA-Z0-9.-]*[.][a-zA-Z]{2,})/);
  return match ? match[1] : undefined;
}

function isMobileRule(rule: string, source: FilterSource): boolean {
  const mobilePatterns = [
    /mobile|android|ios|app|tablet/i,
    /com\.(google|android|huawei|xiaomi|oppo|vivo|samsung)/,
    /\.(apk|ipa|app)$/,
    /play\.google\.com|apps\.apple\.com/,
  ];

  return (
    source.category === "mobile" ||
    mobilePatterns.some((pattern) => pattern.test(rule))
  );
}

function parseModifiers(rule: string): string[] {
  const modifiers: string[] = [];
  const dollarIndex = rule.lastIndexOf("$");

  if (dollarIndex === -1) return modifiers;

  const modifierString = rule.slice(dollarIndex + 1);
  const parts = modifierString.split(",");

  for (const part of parts) {
    // Just store the modifier as a string, don't parse into objects
    modifiers.push(part.trim());
  }

  return modifiers;
}

function processRule(raw: string, source: FilterSource): StoredRule | null {
  if (!raw || raw.startsWith("!") || raw.startsWith("[")) return null;

  const type = determineRuleType(raw);
  const domain = extractDomain(raw);
  const mobile = isMobileRule(raw, source);
  const category = mobile ? ("mobile" as CategoryName) : source.category;

  const modifiers = parseModifiers(raw);

  const hash = crypto.createHash("sha256").update(raw).digest("hex");

  return {
    raw,
    type,
    domain,
    hash,
    metadata: {
      sources: [source.name],
      dateAdded: new Date(),
      lastUpdated: new Date(),
      enabled: true,
      sourceInfo: {
        category,
        trusted: source.trusted ?? false,
        url: source.url,
      },
      tags: mobile ? ["mobile"] : [],
    },
    variants: [
      {
        rule: raw,
        source: source.name,
        dateAdded: new Date(),
        modifiers, // Now an array of strings, not objects
        tags: mobile ? ["mobile"] : [],
      },
    ],
  };
}

async function handleRuleConflict(
  newRule: StoredRule,
  existingRule: StoredRule | null,
): Promise<void> {
  const query = { hash: newRule.hash };

  if (newRule.metadata.sourceInfo.category === "custom") {
    await StoredRuleModel.findOneAndUpdate(query, newRule, { upsert: true });
    return;
  }

  if (existingRule) {
    const sources = new Set([
      ...existingRule.metadata.sources,
      ...newRule.metadata.sources,
    ]);
    const tags = new Set([
      ...existingRule.metadata.tags,
      ...newRule.metadata.tags,
    ]);

    // Only add variant if it's unique
    const variantExists = existingRule.variants?.some(
      (v: { rule: string }) => v.rule === newRule.raw,
    );

    const update: any = {
      $set: {
        "metadata.lastUpdated": new Date(),
        "metadata.sources": Array.from(sources),
        "metadata.tags": Array.from(tags),
      },
    };

    if (!variantExists) {
      update.$push = {
        variants: newRule.variants?.[0],
      };
    }

    await StoredRuleModel.findOneAndUpdate(query, update);
  } else {
    await StoredRuleModel.create(newRule);
  }
}

export class ImportProcessor {
  private logger: CommandOptions["logger"];
  private config: CommandOptions["config"];

  constructor(context: CommandOptions) {
    this.logger = context.logger;
    this.config = context.config;
  }

  async processAllSources(): Promise<ImportStats> {
    const stats: ImportStats = {
      totalRules: 0,
      uniqueRules: 0,
      categories: Object.keys(CATEGORIES).reduce(
        (acc, cat) => {
          acc[cat as CategoryName] = 0;
          return acc;
        },
        {} as Record<CategoryName, number>,
      ),
      sources: {},
    };

    for (const source of this.config.sources) {
      if (!source.enabled) continue;

      try {
        const validSource: FilterSource = {
          ...source,
          enabled: source.enabled ?? true,
          priority: source.priority ?? 50,
          trusted: source.trusted ?? false,
        };

        // Simple validation - just check required fields
        if (!validSource.name || !validSource.url || !validSource.category) {
          this.logger.error(
            `✗ ${validSource.name || "Unknown"}: Missing required fields`,
          );
          continue;
        }

        const text = await fetchWithRetry(validSource.url);
        if (!text) {
          throw new Error(`Failed to fetch source: ${validSource.url}`);
        }

        const parsedRules = text
          .split("\n")
          .map((line) => processRule(line.trim(), validSource))
          .filter((rule): rule is StoredRule => rule !== null);

        for (const rule of parsedRules) {
          const existingRule = await StoredRuleModel.findOne({ raw: rule.raw });
          await handleRuleConflict(rule, existingRule);
        }

        stats.totalRules += parsedRules.length;
        if (source.category) {
          const catName = source.category as CategoryName;
          stats.categories[catName] =
            (stats.categories[catName] || 0) + parsedRules.length;
        }
        stats.sources[source.name] = parsedRules.length;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "An unknown error occurred";
        this.logger.error(`✗ ${source.name}: ${errorMessage}`);
      }
    }

    return stats;
  }
}

async function fetchWithRetry(url: string, retries = 3): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);
      return await response.text();
    } catch (error: unknown) {
      if (i === retries - 1) {
        if (error instanceof Error) {
          throw error;
        }
        throw new Error("Failed to fetch resource");
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, i)),
      );
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
}
