import type { StoredRule } from "../RuleStore.js";
import { cleanDomainPattern } from "../createMetadata.js";
import type { FilterListMetadata } from "../types.js";

export type FilterFormat =
  | "adguard"
  | "abp"
  | "hosts"
  | "dnsmasq"
  | "unbound"
  | "domains"
  | "plain";

export type FilterMetadata = FilterListMetadata;

export function generateHeader(
  metadata: FilterMetadata,
  format: FilterFormat,
): string {
  // Common header for all filter list formats
  const lines: string[] = [];

  if (format === "adguard" || format === "abp") {
    // AdGuard/ABP format headers
    lines.push("[Adblock Plus 2.0]");
    lines.push("! Title: " + metadata.title);
    lines.push("! Description: " + metadata.description);
    lines.push("! Homepage: " + metadata.homepage);
    lines.push("! Version: " + metadata.version);
    lines.push("! Last updated: " + metadata.lastUpdated);

    if (metadata.expires) {
      lines.push("! Expires: " + metadata.expires);
    }

    if (metadata.author) {
      lines.push("! Author: " + metadata.author);
    }

    if (metadata.license) {
      lines.push("! License: " + metadata.license);
    }

    // Stats
    const totalRules = metadata.stats?.totalRules ?? 0;
    const uniqueRules = metadata.stats?.uniqueRules ?? totalRules;

    lines.push("! Total rules: " + totalRules);
    lines.push("! Unique rules: " + uniqueRules);

    if (metadata.stats?.blockingRules !== undefined) {
      lines.push("! Blocking rules: " + metadata.stats.blockingRules);
    }

    if (metadata.stats?.exceptionRules !== undefined) {
      lines.push("! Exception rules: " + metadata.stats.exceptionRules);
    }

    // Format-specific
    if (format === "adguard") {
      lines.push("! Format: AdGuard");
      lines.push("! This file contains rules optimized for AdGuard products");
    } else {
      lines.push("! Format: Adblock Plus");
      lines.push(
        "! This file contains rules compatible with Adblock Plus and uBlock Origin",
      );
    }
  } else if (format === "hosts") {
    const totalDomains = metadata.stats?.uniqueRules ?? metadata.stats?.totalRules ?? 0;
    // Hosts file format headers
    lines.push("# " + metadata.title);
    lines.push("# Description: " + metadata.description);
    lines.push("# Homepage: " + metadata.homepage);
    lines.push("# Version: " + metadata.version);
    lines.push("# Last updated: " + metadata.lastUpdated);
    lines.push("# Total domains: " + totalDomains);
    lines.push("#");
    lines.push("# Format: Hosts");
    lines.push(
      "# This file is in hosts file format for use with system hosts file",
    );
    lines.push("#");
    lines.push(
      "# ===============================================================",
    );
    lines.push("");
    lines.push("127.0.0.1 localhost");
    lines.push("::1 localhost");
    lines.push("");
    lines.push("# Blockingmachine Generated Rules Below");
  } else if (format === "dnsmasq") {
    const rulesCount = metadata.stats?.uniqueRules ?? metadata.stats?.totalRules ?? 0;
    // DNSMasq format headers
    lines.push("# " + metadata.title);
    lines.push("# Description: " + metadata.description);
    lines.push("# Homepage: " + metadata.homepage);
    lines.push("# Version: " + metadata.version);
    lines.push("# Last updated: " + metadata.lastUpdated);
    lines.push("# Format: dnsmasq");
    lines.push("# Rules count: " + rulesCount);
  } else if (format === "unbound") {
    const rulesCount = metadata.stats?.uniqueRules ?? metadata.stats?.totalRules ?? 0;
    // Unbound format headers
    lines.push("# " + metadata.title);
    lines.push("# Description: " + metadata.description);
    lines.push("# Homepage: " + metadata.homepage);
    lines.push("# Version: " + metadata.version);
    lines.push("# Last updated: " + metadata.lastUpdated);
    lines.push("# Format: Unbound");
    lines.push("# Rules count: " + rulesCount);
    lines.push("");
    lines.push("server:");
  } else if (format === "domains") {
    const rulesCount = metadata.stats?.uniqueRules ?? metadata.stats?.totalRules ?? 0;
    // Plain domains list
    lines.push("# " + metadata.title);
    lines.push("# Description: " + metadata.description);
    lines.push("# Homepage: " + metadata.homepage);
    lines.push("# Version: " + metadata.version);
    lines.push("# Last updated: " + metadata.lastUpdated);
    lines.push("# Format: Domain list");
    lines.push("# Rules count: " + rulesCount);
  } else {
    const rulesCount = metadata.stats?.uniqueRules ?? metadata.stats?.totalRules ?? 0;
    // Plain/default format headers
    lines.push("# " + metadata.title);
    lines.push("# Description: " + metadata.description);
    lines.push("# Homepage: " + metadata.homepage);
    lines.push("# Version: " + metadata.version);
    lines.push("# Last updated: " + metadata.lastUpdated);
    lines.push("# Rules count: " + rulesCount);
  }

  // Generator info for all formats
  const commentPrefix = format === "adguard" || format === "abp" ? "! " : "# ";
  lines.push(commentPrefix + "Generated by Blockingmachine v" + metadata.version);
  lines.push("");

  return lines.join("\n");
}

export function formatRule(rule: StoredRule, format: FilterFormat): string {
  // Return early if rule isn't valid
  if (!rule.raw) return "";

  // For exception rules in formats that don't support exceptions natively
  const isExcept =
    rule.isException ||
    rule.type === "unblocking" ||
    rule.raw.startsWith("@@") ||
    rule.raw.includes("#@#");

  if (
    isExcept &&
    ["hosts", "dnsmasq", "unbound", "domains"].includes(format)
  ) {
    // Skip exception rules for these formats, or handle with a comment
    return `# EXCEPTION: ${rule.raw}`;
  }

  const domain = rule.domain || rule.metadata?.domain || cleanDomainPattern(rule.raw);

  switch (format) {
    case "hosts":
      if (domain) {
        return `0.0.0.0 ${domain}`;
      }
      return "";

    case "dnsmasq":
      if (domain) {
        return `address=/${domain}/0.0.0.0`;
      }
      return "";

    case "unbound":
      if (domain) {
        return `  local-zone: "${domain}" always_nxdomain`;
      }
      return "";

    case "domains":
      if (domain) {
        return domain;
      }
      return "";

    case "plain":
      return rule.raw || "";

    case "adguard":
    case "abp":
    default:
      // For AdGuard/ABP formats, return the raw rule
      return rule.raw;
  }
}

export function generateFilterList(
  rules: StoredRule[],
  metadata: FilterMetadata,
  format: FilterFormat,
): string {
  const header = generateHeader(metadata, format);

  // Process rules based on format
  const formattedRules = rules
    .map((rule) => formatRule(rule, format))
    .filter(Boolean) // Remove empty strings
    .join("\n");

  return formattedRules ? `${header}${formattedRules}\n` : header;
}
