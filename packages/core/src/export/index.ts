import type { StoredRule } from "../RuleStore.js";
import { RuleStore } from "../RuleStore.js";
import { RuleProcessor } from "../RuleProcessor.js";
import type {
  FilterListMetadata,
  SupportedFormat,
  ExportOptions,
} from "../types.js";
import { EXPORT_FORMATS } from "../types.js";
import { formatRuleForType, isException, isExportableRule } from "./formatters.js";
import { generateHeader } from "./headers.js";
import {
  filterDNSRules,
  filterBrowserRules,
  resolveDnsPrecedence,
} from "./ruleFilters.js";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

// Export functions defined in this file
export async function exportFormat(
  format: SupportedFormat,
  outputPath: string,
  rules: StoredRule[],
  meta: FilterListMetadata,
): Promise<void> {
  if (format !== "all" && !EXPORT_FORMATS.includes(format)) {
    throw new Error(`Unsupported export format: ${format}`);
  }
  rules = rules.filter(isExportableRule);
  const isDnsFormat = [
    "hosts",
    "dnsmasq",
    "unbound",
    "bind",
    "privoxy",
    "shadowrocket",
    "domains",
  ].includes(format);

  if (isDnsFormat) {
    const precedence = resolveDnsPrecedence(rules);
    const lines: string[] = [];

    // Active blocks
    for (const rule of precedence.activeBlocks) {
      const line = formatRuleForType(rule, format);
      if (line) lines.push(line);
    }

    // Subdomain bypasses
    if (format === "dnsmasq") {
      for (const sub of precedence.subdomainExceptions) {
        lines.push(`server=/${sub.subdomain}/#`);
      }
    } else if (format === "unbound") {
      for (const sub of precedence.subdomainExceptions) {
        lines.push(`  local-zone: "${sub.subdomain}" transparent`);
      }
    }

    // Effective exception comments
    for (const exRule of precedence.effectiveExceptions) {
      lines.push(`# EXCEPTION: ${exRule.raw}`);
    }

    for (const ovRule of precedence.overriddenExceptions) {
      lines.push(
        `# EXCEPTION OVERRIDDEN BY $important: ${ovRule.raw}`,
      );
    }

    const uniqueLines = Array.from(new Set(lines));
    const header = generateHeader(meta, format);
    const output = `${header}\n${uniqueLines.join("\n")}`;
    await writeFile(outputPath, output, "utf8");
    return;
  }

  if (format === "adguard" || format === "abp") {
    // Canonical sections
    const whitelistRules: string[] = [];
    const scriptletRules: string[] = [];
    const cosmeticRules: string[] = [];
    const networkRules: string[] = [];

    for (const rule of filterBrowserRules(rules)) {
      const formatted = formatRuleForType(rule, format);
      if (!formatted) continue;

      if (isException(rule)) {
        whitelistRules.push(formatted);
      } else if (
        rule.type === "scriptlet" ||
        rule.raw.includes("##+js(") ||
        rule.raw.includes("#@#+js(") ||
        rule.raw.includes("#%#") ||
        rule.raw.includes("#@%#") ||
        rule.raw.includes("#$#") ||
        rule.raw.includes("#@$#") ||
        rule.raw.includes("#$?#")
      ) {
        scriptletRules.push(formatted);
      } else if (
        rule.type === "cosmetic" ||
        rule.type === "extended-css" ||
        rule.type === "html-filtering" ||
        rule.raw.includes("##") ||
        rule.raw.includes("#?#") ||
        rule.raw.includes("$$")
      ) {
        cosmeticRules.push(formatted);
      } else {
        networkRules.push(formatted);
      }
    }

    const uniqueWhitelist = Array.from(new Set(whitelistRules)).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    const uniqueScriptlets = Array.from(new Set(scriptletRules)).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    const uniqueCosmetics = Array.from(new Set(cosmeticRules)).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    const uniqueNetwork = Array.from(new Set(networkRules)).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );

    const sections: { title: string; rules: string[] }[] = [
      { title: "Whitelist & Exception Rules", rules: uniqueWhitelist },
      { title: "Procedural Scriptlet Defusers", rules: uniqueScriptlets },
      { title: "Cosmetic & Element Hiding Rules", rules: uniqueCosmetics },
      { title: "Network Blocking Rules", rules: uniqueNetwork },
    ];

    const bodyParts: string[] = [];
    for (const sec of sections) {
      if (sec.rules.length > 0) {
        bodyParts.push(
          `! ===============================================================\n! ${sec.title}\n! ===============================================================\n${sec.rules.join("\n")}`,
        );
      }
    }

    const header = generateHeader(meta, format);
    const output = `${header}\n${bodyParts.join("\n\n")}`;
    await writeFile(outputPath, output, "utf8");
    return;
  }

  // Fallback default
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

  let filteredRules = rules.filter(isExportableRule);

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

  if (options.minPriority !== undefined) {
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
  const requestedFormats = options.formats ?? ["all"];
  for (const format of requestedFormats) {
    if (format !== "all" && !EXPORT_FORMATS.includes(format)) {
      throw new Error(`Unsupported export format: ${format}`);
    }
  }
  const formatsToExport = new Set(requestedFormats.flatMap(format => format === "all" ? [...EXPORT_FORMATS] : [format]));
  if (formatsToExport.size > 0) await mkdir(outputDir, { recursive: true });
  for (const format of formatsToExport) {
    let formatRules = baseRules;
    if (["hosts", "dnsmasq", "unbound", "bind", "privoxy", "shadowrocket", "domains"].includes(format)) {
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
