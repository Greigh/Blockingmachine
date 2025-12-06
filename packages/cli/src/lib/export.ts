import type {
  StoredRule,
  SupportedFormat,
  FilterListMetadata,
  ExportOptions,
} from "../types.js";
import { StoredRuleModel } from "./db.js";
import fs from "fs/promises";
import path from "path";

// Helper functions
function generateHeader(
  meta: FilterListMetadata,
  format: SupportedFormat,
): string {
  switch (format) {
    case "hosts":
      return [
        "# Title: " + meta.title,
        "# Description: " + meta.description,
        "# Homepage: " + meta.homepage,
        "# Version: " + meta.version,
        "# Last updated: " + meta.lastUpdated,
        "",
      ].join("\n");
    case "dnsmasq":
      return ["# " + meta.title, "# Generated: " + meta.lastUpdated, ""].join(
        "\n",
      );
    case "unbound":
      return [
        "# " + meta.title,
        "# Generated: " + meta.lastUpdated,
        "server:",
        "",
      ].join("\n");
    default:
      return [
        "! Title: " + meta.title,
        "! Description: " + meta.description,
        "! Homepage: " + meta.homepage,
        "! Version: " + meta.version,
        "! Last updated: " + meta.lastUpdated,
        "",
      ].join("\n");
  }
}

function formatRuleForType(rule: StoredRule, format: SupportedFormat): string {
  if (!rule.domain) return rule.raw;

  switch (format) {
    case "hosts":
      return `0.0.0.0 ${rule.domain}`;
    case "dnsmasq":
      return `address=/${rule.domain}/0.0.0.0`;
    case "unbound":
      return `local-zone: "${rule.domain}" redirect\nlocal-data: "${rule.domain} A 0.0.0.0"`;
    case "bind":
      return `zone "${rule.domain}" { type master; file "null.zone.file"; };`;
    case "privoxy":
      // Privoxy requires domain entries like ".example.com" inside action files
      return `.${rule.domain}`;
    case "shadowrocket":
      return `DOMAIN-SUFFIX,${rule.domain},REJECT`;
    case "adguard":
    case "abp":
      return rule.raw;
    default:
      return rule.raw;
  }
}

// Main export functions
export async function exportFormat(
  format: SupportedFormat,
  outputDir: string,
  rules: StoredRule[],
  meta: FilterListMetadata,
): Promise<void> {
  try {
    await fs.mkdir(outputDir, { recursive: true });

    const formattedRules = rules.map((rule) => formatRuleForType(rule, format));
    const header = generateHeader(meta, format);
    const content = [header, ...formattedRules].join("\n");

    const outputPath = path.join(outputDir, `blocklist.${format}`);
    await fs.writeFile(outputPath, content, "utf8");
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    throw new Error(`Failed to export ${format} format: ${errorMessage}`);
  }
}

export async function exportWithOptions(
  outputDir: string,
  meta: FilterListMetadata,
  options: ExportOptions = {},
): Promise<void> {
  const query: any = {};

  if (options.categories?.length) {
    query.category = { $in: options.categories };
  }

  if (options.excludeCategories?.length) {
    query.category = { ...query.category, $nin: options.excludeCategories };
  }

  if (options.minPriority) {
    query.priority = { $gte: options.minPriority };
  }

  if (options.tags?.length) {
    query.tags = { $in: options.tags };
  }

  const rules = await StoredRuleModel.find(query).sort({ priority: -1 }).lean();

  for (const format of options.formats || ["adguard"]) {
    // Ensure format is a SupportedFormat
    if (isSupportedFormat(format)) {
      await exportFormat(format, outputDir, rules, meta);
    } else {
      console.warn(`Skipping unsupported format: ${format}`);
    }
  }
}

function isSupportedFormat(format: string): format is SupportedFormat {
  const supportedFormats: SupportedFormat[] = [
    "hosts",
    "dnsmasq",
    "unbound",
    "bind",
    "privoxy",
    "shadowrocket",
    "adguard",
    "abp",
    "all",
  ];
  return supportedFormats.includes(format as SupportedFormat);
}
