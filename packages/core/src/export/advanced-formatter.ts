import type { StoredRule } from "../RuleStore.js";
import type { FilterListMetadata } from "../types.js";
import {
  isException,
  isBrowserOnlyRule,
  getDnsDomain,
  formatAdguardRule,
} from "./formatters.js";
import { resolveDnsPrecedence } from "./ruleFilters.js";

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
  // DNS sinkhole formats: resolve adblock precedence and prune allowlisted domains
  if (
    format === "hosts" ||
    format === "dnsmasq" ||
    format === "unbound" ||
    format === "domains"
  ) {
    const precedence = resolveDnsPrecedence(rules);
    const emittedLines: string[] = [];

    // 1. Emitted active blocking rules (alphabetically sorted)
    for (const rule of precedence.activeBlocks) {
      const line = formatRule(rule, format);
      if (line) emittedLines.push(line);
    }

    // 2. Subdomain exceptions overriding wildcard parent blocks
    if (format === "dnsmasq") {
      for (const sub of precedence.subdomainExceptions) {
        emittedLines.push(`server=/${sub.subdomain}/#`);
      }
    } else if (format === "unbound") {
      for (const sub of precedence.subdomainExceptions) {
        emittedLines.push(`  local-zone: "${sub.subdomain}" transparent`);
      }
    }

    // 3. Effective exception comments
    for (const exRule of precedence.effectiveExceptions) {
      emittedLines.push(`# EXCEPTION: ${exRule.raw}`);
    }

    // 4. Overridden exceptions
    for (const ovRule of precedence.overriddenExceptions) {
      emittedLines.push(
        `# EXCEPTION OVERRIDDEN BY $important: ${ovRule.raw}`,
      );
    }

    const uniqueEmitted = Array.from(new Set(emittedLines));

    const effectiveMeta: FilterMetadata = {
      ...metadata,
      stats: {
        ...metadata.stats,
        totalRules: metadata.stats?.totalRules ?? uniqueEmitted.length,
        uniqueRules: uniqueEmitted.length,
        blockingRules: precedence.activeBlocks.length,
        exceptionRules: precedence.effectiveExceptions.length,
      },
    };

    const header = generateHeader(effectiveMeta, format);
    const body = uniqueEmitted.join("\n");
    return body ? `${header}${body}\n` : header;
  }

  // Browser filter list formats: canonical section ordering & deterministic sorting
  if (format === "adguard" || format === "abp") {
    const whitelistRules: string[] = [];
    const scriptletRules: string[] = [];
    const cosmeticRules: string[] = [];
    const networkRules: string[] = [];

    for (const rule of rules) {
      const formatted = formatRule(rule, format);
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

    // Deduplicate and sort deterministically within each section
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

    const totalFilterRules =
      uniqueWhitelist.length +
      uniqueScriptlets.length +
      uniqueCosmetics.length +
      uniqueNetwork.length;

    const effectiveMeta: FilterMetadata = {
      ...metadata,
      stats: {
        ...metadata.stats,
        totalRules: metadata.stats?.totalRules ?? totalFilterRules,
        uniqueRules: totalFilterRules,
        blockingRules: uniqueNetwork.length,
        exceptionRules: uniqueWhitelist.length,
      },
    };

    const header = generateHeader(effectiveMeta, format);

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

    const body = bodyParts.join("\n\n");
    return body ? `${header}${body}\n` : header;
  }

  // Plain / custom formats
  const formattedRulesList = rules
    .map((rule) => formatRule(rule, format))
    .filter(Boolean);

  const effectiveMeta: FilterMetadata = {
    ...metadata,
    stats: {
      ...metadata.stats,
      totalRules: metadata.stats?.totalRules ?? formattedRulesList.length,
      uniqueRules: formattedRulesList.length,
    },
  };

  const header = generateHeader(effectiveMeta, format);
  const formattedRules = formattedRulesList.join("\n");

  return formattedRules ? `${header}${formattedRules}\n` : header;
}
