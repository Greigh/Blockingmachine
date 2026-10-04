import type {
  StoredRule,
  SupportedFormat,
  FilterListMetadata,
  ExportOptions,
} from "../types.js";
import { StoredRuleModel } from "./db.js";
import { resolveDnsPrecedence, getDnsDomain, bindRpzBlockRecords, bindRpzPassthruRecords, BIND_NULL_ZONE_FILE, formatRule as formatRuleInCore } from "@blockingmachine/core";
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
    case "shadowrocket":
      // Comments are `#` and the rules live under a `[Rule]` section: the default `!` header this
      // would otherwise fall through to is AdGuard syntax, which a Shadowrocket config rejects.
      return [
        "# " + meta.title,
        "# Generated: " + meta.lastUpdated,
        "# Format: Shadowrocket rule set (Surge-compatible)",
        "[Rule]",
        "",
      ].join("\n");
    case "privoxy":
      // A Privoxy action file is section-based, so the block section opens before the patterns.
      return [
        "# " + meta.title,
        "# Generated: " + meta.lastUpdated,
        "# Format: Privoxy action file",
        "{+block{Blockingmachine Blocklist}}",
        "",
      ].join("\n");
    case "bind":
      // A BIND Response Policy Zone is a master file: `;` comments, and an SOA before any record.
      return [
        "; " + meta.title,
        "; Generated: " + meta.lastUpdated,
        "; Format: BIND Response Policy Zone (RPZ)",
        ";   zone \"rpz.blockingmachine\" { type master; file \"db.blockingmachine.rpz\"; };",
        ";   response-policy { zone \"rpz.blockingmachine\"; };",
        "$TTL 3600",
        "@ IN SOA localhost. root.localhost. ( 1 3600 600 604800 86400 )",
        "@ IN NS localhost.",
        "",
      ].join("\n");
    case "bind-null":
      // `#`, and this is a `named.conf` fragment rather than a zone file: the semicolon that
      // comments a zone file *ends a statement* in named.conf, so a `;` header is a syntax error
      // there. The default `!` header this would fall through to is worse still — AdGuard syntax
      // that `named-checkconf` rejects outright. Both were caught by loading the real artifact,
      // not by reading the format docs.
      return [
        "# " + meta.title,
        "# Generated: " + meta.lastUpdated,
        "# Format: BIND shared null-zone stanzas (named.conf fragment)",
        "# Save db.blockingmachine.null once (its three lines are in the core export's header),",
        '# then include this file: include "/etc/bind/blockingmachine-zones.conf";',
        "# A null zone has one behaviour, so an allowed subdomain is recorded as a comment and is",
        "# NOT honoured, and it answers NXDOMAIN for subdomains but NODATA at the apex.",
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
      // Delegated, not restated. This branch used to emit `redirect` + `local-data "…" A 0.0.0.0`,
      // which blocks correctly and is 75% larger on disk than the alternative — but it is not what
      // core emits, so a CLI deployment and a Hub deployment of the same rules answered differently
      // on the wire, and the Hub's reachability check (which reads NXDOMAIN as proof) called a
      // working CLI deployment `not-loaded`. Two copies of one rule is how that happened; there is
      // now one, and `always_nxdomain` is the answer both the check and the live rig read.
      return formatRuleInCore(rule, "unbound");
    case "bind":
      if (isException) return `; EXCEPTION: ${rule.raw}`;
      if (!rule.domain) return "";
      // RPZ policy record. A per-domain master zone cannot load: BIND refuses a primary zone whose
      // file holds no SOA, and one file cannot serve 100k origins. The wildcard sibling is added by
      // the caller, which owns the pair.
      return `${rule.domain} CNAME .`;
    case "bind-null":
      if (isException) return `# EXCEPTION: ${rule.raw}`;
      if (!rule.domain) return "";
      return `zone "${rule.domain}" { type master; file "${BIND_NULL_ZONE_FILE}"; };`;
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
      "bind-null",
      "privoxy",
      "shadowrocket",
    ].includes(format);

    if (isDns) {
      const precedence = resolveDnsPrecedence(rules as any);
      for (const r of precedence.activeBlocks) {
        // RPZ needs a pair per domain — the name and a wildcard for its subdomains — or a bare
        // QNAME trigger matches only that name. The pair is built by the core helper rather than
        // restated here, because this file already drifted from core once and a second copy of the
        // rule is exactly how that happens again.
        if (format === "bind") {
          const domain = getDnsDomain(r as any);
          if (domain) formattedRules.push(...bindRpzBlockRecords(domain));
          continue;
        }
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
      } else if (format === "bind") {
        for (const sub of precedence.subdomainExceptions) {
          formattedRules.push(...bindRpzPassthruRecords(sub.subdomain));
        }
      } else if (format === "bind-null") {
        for (const sub of precedence.subdomainExceptions) {
          formattedRules.push(`# EXCEPTION: @@||${sub.subdomain}^`);
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
    "bind-null",
    "privoxy",
    "shadowrocket",
    "adguard",
    "abp",
    "all",
  ];
  return supportedFormats.includes(format as SupportedFormat);
}
