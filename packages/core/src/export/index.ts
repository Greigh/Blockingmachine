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
  rulesInput?: StoredRule[] | RuleStore,
): Promise<StoredRule[]> {
  let rules: StoredRule[] = [];

  if (Array.isArray(rulesInput)) {
    rules = rulesInput;
  } else if (rulesInput instanceof RuleStore) {
    rules = rulesInput.getUniqueRules();
  } else if (Array.isArray(options.rules)) {
    rules = options.rules;
  } else if (options.store instanceof RuleStore) {
    rules = options.store.getUniqueRules();
  } else {
    const ruleProcessor = new RuleProcessor();
    const store = new RuleStore(ruleProcessor);
    rules = store.getUniqueRules();
  }

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

  const baseRules = [...filteredRules];

  // Export to each format specified with format-specific rules and stats
  const formatsToExport = options.formats || ["all"];
  for (const format of formatsToExport) {
    let formatRules = baseRules;
    if (["hosts", "dnsmasq", "unbound"].includes(format)) {
      formatRules = filterDNSRules(baseRules);
    } else if (["adguard", "abp"].includes(format)) {
      formatRules = filterBrowserRules(baseRules);
    }

    const formatMeta: FilterListMetadata = {
      ...meta,
      lastUpdated: new Date().toISOString(),
      stats: {
        totalRules: formatRules.length,
        blockingRules: formatRules.filter((rule) => rule.type === "blocking")
          .length,
        exceptionRules: formatRules.filter(
          (rule) => rule.type === "unblocking" || rule.isException,
        ).length,
      },
    };

    const outputPath = join(outputDir, `${format}.txt`);
    await exportFormat(format, outputPath, formatRules, formatMeta);
    console.log(
      `Exported ${formatRules.length} rules to ${outputPath} in ${format} format`,
    );
  }

  return baseRules;
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
