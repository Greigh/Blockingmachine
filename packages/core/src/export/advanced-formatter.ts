import type { StoredRule } from "../RuleStore.js";
import type { FilterListMetadata } from "../types.js";
import {
  isException,
  isBrowserOnlyRule,
  getDnsDomain,
  formatAdguardRule,
} from "./formatters.js";

export type FilterFormat =
  "adguard" | "abp" | "hosts" | "dnsmasq" | "unbound" | "domains" | "plain";

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
    const totalDomains =
      metadata.stats?.uniqueRules ?? metadata.stats?.totalRules ?? 0;
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
    const rulesCount =
      metadata.stats?.uniqueRules ?? metadata.stats?.totalRules ?? 0;
    // DNSMasq format headers
    lines.push("# " + metadata.title);
    lines.push("# Description: " + metadata.description);
    lines.push("# Homepage: " + metadata.homepage);
    lines.push("# Version: " + metadata.version);
    lines.push("# Last updated: " + metadata.lastUpdated);
    lines.push("# Format: dnsmasq");
    lines.push("# Rules count: " + rulesCount);
  } else if (format === "unbound") {
    const rulesCount =
      metadata.stats?.uniqueRules ?? metadata.stats?.totalRules ?? 0;
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
    const rulesCount =
      metadata.stats?.uniqueRules ?? metadata.stats?.totalRules ?? 0;
    // Plain domains list
    lines.push("# " + metadata.title);
    lines.push("# Description: " + metadata.description);
    lines.push("# Homepage: " + metadata.homepage);
    lines.push("# Version: " + metadata.version);
    lines.push("# Last updated: " + metadata.lastUpdated);
    lines.push("# Format: Domain list");
    lines.push("# Rules count: " + rulesCount);
  } else {
    const rulesCount =
      metadata.stats?.uniqueRules ?? metadata.stats?.totalRules ?? 0;
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
  lines.push(
    commentPrefix + "Generated by Blockingmachine v" + metadata.version,
  );
  lines.push("");

  return lines.join("\n");
}

export function formatRule(rule: StoredRule, format: FilterFormat): string {
  // Return early if rule isn't valid
  if (!rule || !rule.raw) return "";

  const isExcept = isException(rule);

  switch (format) {
    case "hosts": {
      if (isExcept) {
        if (isBrowserOnlyRule(rule)) return "";
        return `# EXCEPTION: ${rule.raw}`;
      }
      const domain = getDnsDomain(rule);
      return domain ? `0.0.0.0 ${domain}` : "";
    }
    case "dnsmasq": {
      if (isExcept) {
        if (isBrowserOnlyRule(rule)) return "";
        return `# EXCEPTION: ${rule.raw}`;
      }
      const domain = getDnsDomain(rule);
      return domain ? `address=/${domain}/0.0.0.0` : "";
    }
    case "unbound": {
      if (isExcept) {
        if (isBrowserOnlyRule(rule)) return "";
        return `# EXCEPTION: ${rule.raw}`;
      }
      const domain = getDnsDomain(rule);
      return domain ? `  local-zone: "${domain}" always_nxdomain` : "";
    }
    case "domains": {
      if (isExcept) {
        if (isBrowserOnlyRule(rule)) return "";
        return `# EXCEPTION: ${rule.raw}`;
      }
      const domain = getDnsDomain(rule);
      return domain || "";
    }
    case "adguard":
    case "abp":
      return formatAdguardRule(rule);
    case "plain":
    default:
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
