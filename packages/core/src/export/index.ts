import type { StoredRule } from "../RuleStore.js";
import { RuleStore } from "../RuleStore.js";
import { RuleProcessor } from "../RuleProcessor.js"; // Add this import
import type {
  FilterListMetadata,
  SupportedFormat,
  ExportOptions,
} from "../types.js";
import { formatRuleForType } from "./formatters.js";
import { generateHeader } from "./headers.js";
import { filterDNSRules, filterBrowserRules } from "./ruleFilters.js";
import { writeFile } from "fs/promises";
import { join } from "path";

// Export functions defined in this file
export async function exportFormat(
  format: SupportedFormat,
  outputPath: string,
  rules: StoredRule[],
  meta: FilterListMetadata,
): Promise<void> {
  const header = generateHeader(meta, format);

  const formattedRules = rules
    .map((rule) => formatRuleForType(rule, format))
    .filter(Boolean)
    .join("\n");

  const output = `${header}\n${formattedRules}`;

  await writeFile(outputPath, output, "utf8");
}

export async function exportWithOptions(
  outputDir: string,
  meta: FilterListMetadata,
  options: ExportOptions = {},
): Promise<StoredRule[]> {
  const ruleProcessor = new RuleProcessor(); // Create a RuleProcessor instance
  const store = new RuleStore(ruleProcessor); // Pass it to RuleStore

  // Use getUniqueRules() instead of getAllRules()
  const rules = store.getUniqueRules();

  let filteredRules = [...rules]; // Create a copy to avoid modifying the original

  // Rest of your filtering logic stays the same
  if (options.categories?.length) {
    filteredRules = filteredRules.filter((rule: StoredRule) =>
      options.categories?.includes(rule.metadata.sourceInfo.category),
    );
  }

  if (options.excludeCategories?.length) {
    filteredRules = filteredRules.filter(
      (rule: StoredRule) =>
        !options.excludeCategories?.includes(rule.metadata.sourceInfo.category),
    );
  }

  if (options.minPriority) {
    filteredRules = filteredRules.filter(
      (rule: StoredRule) =>
        rule.metadata.sourceInfo.priority >= options.minPriority!,
    );
  }

  if (options.tags?.length) {
    filteredRules = filteredRules.filter((rule: StoredRule) =>
      rule.metadata.tags.some((tag: string) => options.tags?.includes(tag)),
    );
  }

  // Apply format-specific filters
  for (const format of options.formats || ["all"]) {
    if (["hosts", "dnsmasq", "unbound"].includes(format)) {
      filteredRules = filterDNSRules(filteredRules);
    } else if (["adguard", "abp"].includes(format)) {
      filteredRules = filterBrowserRules(filteredRules);
    }
  }

  // Update metadata with stats from the filtered rules
  const updatedMeta = {
    ...meta,
    lastUpdated: new Date().toISOString(),
    stats: {
      totalRules: filteredRules.length,
      blockingRules: filteredRules.filter((rule) => rule.type === "blocking")
        .length,
      exceptionRules: filteredRules.filter((rule) => rule.type === "unblocking")
        .length,
    },
  };

  // Export to each format specified
  for (const format of options.formats || ["all"]) {
    const outputPath = join(outputDir, `${format}.txt`);
    await exportFormat(format, outputPath, filteredRules, updatedMeta);
    console.log(
      `Exported ${filteredRules.length} rules to ${outputPath} in ${format} format`,
    );
  }

  return filteredRules;
}

// Re-export from other files
export * from "./formatters.js";
export * from "./headers.js";
export * from "./ruleFilters.js";

// Re-export types from the types file
export type {
  FilterListMetadata,
  ExportOptions,
  SupportedFormat,
} from "../types.js";
