import type {
  StoredRule,
  SupportedFormat,
  FilterListMetadata,
  ExportOptions,
} from "../types.js";
import { StoredRuleModel } from "./db.js";
import { resolveDnsPrecedence } from "@blockingmachine/core";
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
  const isException =
    rule.type === "exception" ||
    rule.type === "unblocking" ||
    rule.raw.startsWith("@@") ||
    rule.raw.includes("#@#") ||
    rule.raw.includes("#@%") ||
    rule.raw.includes("#@$");

  switch (format) {
    case "hosts":
      if (isException) return `# EXCEPTION: ${rule.raw}`;
      if (!rule.domain) return "";
      return `0.0.0.0 ${rule.domain}`;
    case "dnsmasq":
      if (isException) return `# EXCEPTION: ${rule.raw}`;
      if (!rule.domain) return "";
      return `address=/${rule.domain}/0.0.0.0`;
    case "unbound":
      if (isException) return `# EXCEPTION: ${rule.raw}`;
      if (!rule.domain) return "";
      return `local-zone: "${rule.domain}" redirect\nlocal-data: "${rule.domain} A 0.0.0.0"`;
    case "bind":
      if (isException) return `# EXCEPTION: ${rule.raw}`;
      if (!rule.domain) return "";
      return `zone "${rule.domain}" { type master; file "null.zone.file"; };`;
    case "privoxy":
      if (isException) return `# EXCEPTION: ${rule.raw}`;
      if (!rule.domain) return "";
      return `.${rule.domain}`;
    case "shadowrocket":
      if (isException) return `# EXCEPTION: ${rule.raw}`;
      if (!rule.domain) return "";
      return `DOMAIN-SUFFIX,${rule.domain},REJECT`;
    case "adguard":
    case "abp":
    case "all":
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

    let formattedRules: string[] = [];
    const isDns = [
      "hosts",
      "dnsmasq",
      "unbound",
      "bind",
      "privoxy",
      "shadowrocket",
    ].includes(format);

    if (isDns) {
      const precedence = resolveDnsPrecedence(rules as any);
      for (const r of precedence.activeBlocks) {
        const line = formatRuleForType(r as any, format);
        if (line) formattedRules.push(line);
      }
      if (format === "dnsmasq") {
        for (const sub of precedence.subdomainExceptions) {
          formattedRules.push(`server=/${sub.subdomain}/#`);
        }
      } else if (format === "unbound") {
        for (const sub of precedence.subdomainExceptions) {
          formattedRules.push(`local-zone: "${sub.subdomain}" transparent`);
        }
      }
      for (const ex of precedence.effectiveExceptions) {
        formattedRules.push(`# EXCEPTION: ${ex.raw}`);
      }
      for (const ov of precedence.overriddenExceptions) {
        formattedRules.push(`# EXCEPTION OVERRIDDEN BY $important: ${ov.raw}`);
      }
    } else {
      formattedRules = rules
        .map((rule) => formatRuleForType(rule, format))
        .filter((line) => Boolean(line && line.trim()));
    }

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
    query["metadata.sourceInfo.category"] = { $in: options.categories };
  }

  if (options.excludeCategories?.length) {
    query["metadata.sourceInfo.category"] = {
      ...(query["metadata.sourceInfo.category"] || {}),
      $nin: options.excludeCategories,
    };
  }

  if (options.tags?.length) {
    query["metadata.tags"] = { $in: options.tags };
  }

  const rules = (await StoredRuleModel.find(
    query,
  ).lean()) as unknown as StoredRule[];

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
