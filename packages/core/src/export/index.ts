import type { StoredRule } from "../RuleStore.js";
import { RuleStore } from "../RuleStore.js";
import { RuleProcessor } from "../RuleProcessor.js";
import type {
  FilterListMetadata,
  SupportedFormat,
  ExportOptions,
} from "../types.js";
import { EXPORT_FORMATS } from "../types.js";
import { formatRuleForType, formatExceptionComment, isException, isExportableRule, PRIVOXY_BYPASS_SECTION, bindRpzPassthruRecords, getDnsDomain, BIND_NULL_ZONE_FILE } from "./formatters.js";
import {
  bindNullDelegatedZoneFile,
  bindNullZoneStanza,
  renderBindNullDelegatedZone,
} from "./bindDelegation.js";
import { generateHeader } from "./headers.js";
import {
  filterDNSRules,
  filterBrowserRules,
  resolveDnsPrecedence,
} from "./ruleFilters.js";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { resolveNs } from "dns/promises";

export interface ExportFormatOptions {
  /**
   * The NS resolver a `bind-null` delegation consults — the parent's real authoritative
   * nameservers are what the allowed child delegates back to. Injectable because an
   * honest test of the honour path should not depend on the network the suite runs on.
   */
  resolveNs?: (domain: string) => Promise<string[]>;
}

// Export functions defined in this file
export async function exportFormat(
  format: SupportedFormat,
  outputPath: string,
  rules: StoredRule[],
  meta: FilterListMetadata,
  options?: ExportFormatOptions,
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
    "bind-null",
    "privoxy",
    "shadowrocket",
    "domains",
  ].includes(format);

  if (isDnsFormat) {
    const precedence = resolveDnsPrecedence(rules);
    const lines: string[] = [];

    // `bind-null` delegations resolve before the stanza loop, because the stanza a delegated
    // parent emits points at its own zone file rather than the shared one. The delegation is
    // the only mechanism that releases a child of a null zone (proved on live `named`), and
    // it costs per-parent zone data the shared file cannot express — so each affected parent
    // gets `db.bm.null.<parent>` written beside this artifact, carrying the child's `IN NS`
    // back to the parent's real authority. A parent whose `NS` will not resolve keeps the
    // shared stanza and its exceptions stay `NOT HONOURED`: an honest miss, not a pretend one.
    const bindNullZoneFiles = new Map<string, string>();
    const bindNullDelegated = new Map<string, string>();
    if (format === "bind-null" && precedence.subdomainExceptions.length > 0) {
      const lookup = options?.resolveNs ?? resolveNs;
      const byParent = new Map<string, Set<string>>();
      for (const sub of precedence.subdomainExceptions) {
        const set = byParent.get(sub.parentDomain) ?? new Set<string>();
        set.add(sub.subdomain);
        byParent.set(sub.parentDomain, set);
      }
      for (const [parent, children] of [...byParent.entries()].sort()) {
        let nsNames: string[] = [];
        try {
          nsNames = (await lookup(parent)).filter(
            (ns): ns is string => typeof ns === "string" && ns.trim().length > 0,
          );
        } catch {
          // No reachable authority — leave the exception NOT HONOURED below.
          continue;
        }
        if (nsNames.length === 0) continue;
        const file = bindNullDelegatedZoneFile(parent);
        bindNullDelegated.set(parent, file);
        bindNullZoneFiles.set(file, renderBindNullDelegatedZone(parent, [...children], nsNames));
      }
    }

    // A Shadowrocket/Surge rule set is first-match-wins, so a child bypass has to be emitted
    // before the parent block it escapes.
    if (format === "shadowrocket") {
      for (const sub of precedence.subdomainExceptions) {
        lines.push(`DOMAIN-SUFFIX,${sub.subdomain},DIRECT`);
      }
    }

    // Active blocks
    for (const rule of precedence.activeBlocks) {
      if (format === "bind-null") {
        const domain = getDnsDomain(rule);
        if (domain) {
          lines.push(
            bindNullZoneStanza(domain, bindNullDelegated.get(domain) ?? BIND_NULL_ZONE_FILE),
          );
        }
        continue;
      }
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
    } else if (format === "privoxy") {
      // Last match wins in an action file, so the bypass section has to come *after* the blocks it
      // escapes — the mirror image of the Shadowrocket ordering above.
      if (precedence.subdomainExceptions.length > 0) {
        lines.push(PRIVOXY_BYPASS_SECTION);
        for (const sub of precedence.subdomainExceptions) {
          lines.push(`.${sub.subdomain}`);
        }
      }
    } else if (format === "bind") {
      // RPZ resolves on the longest match, so a child passthru needs no ordering at all. It is
      // emitted as a pair — the child and its wildcard — so the exemption covers the subtree the
      // source rule released, and the parent's block wildcard does not re-block it.
      for (const sub of precedence.subdomainExceptions) {
        lines.push(...bindRpzPassthruRecords(sub.subdomain));
      }
    } else if (format === "bind-null") {
      // A null zone cannot release a child in shared zone data — the parent answers before
      // any forwarding or policy lookup. The one mechanism that works, an `NS` delegation in
      // the parent's own zone, is resolved above: a delegated child is recorded DELEGATED
      // with the file that carries it; one whose parent's authority could not be resolved is
      // recorded NOT HONOURED rather than dropped, because a silently re-blocked allowlist is
      // the failure nobody can see.
      for (const sub of precedence.subdomainExceptions) {
        const zoneFile = bindNullDelegated.get(sub.parentDomain);
        lines.push(
          zoneFile
            ? `# EXCEPTION DELEGATED: @@||${sub.subdomain}^ — ${zoneFile}`
            : `# EXCEPTION NOT HONOURED: @@||${sub.subdomain}^`,
        );
      }
    }

    // Effective exception comments
    for (const exRule of precedence.effectiveExceptions) {
      lines.push(formatExceptionComment(exRule, format));
    }

    for (const ovRule of precedence.overriddenExceptions) {
      lines.push(formatExceptionComment(ovRule, format, true));
    }

    const uniqueLines = Array.from(new Set(lines));
    const header = generateHeader(meta, format);
    const output = `${header}\n${uniqueLines.join("\n")}`;
    await writeFile(outputPath, output, "utf8");

    // The per-parent zone files the delegated stanzas point at. They land beside the
    // fragment — a `named.conf` include of the fragment alone would otherwise reference
    // files nothing wrote.
    for (const [file, contents] of bindNullZoneFiles) {
      await writeFile(join(dirname(outputPath), file), contents, "utf8");
    }
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
    if (["hosts", "dnsmasq", "unbound", "bind", "bind-null", "privoxy", "shadowrocket", "domains"].includes(format)) {
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
