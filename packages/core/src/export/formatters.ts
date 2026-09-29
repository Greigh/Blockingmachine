import type { StoredRule } from "../RuleStore.js";
import type { SupportedFormat } from "../types.js";
import { cleanDomainPattern } from "../createMetadata.js";

/**
 * Privoxy action-file section headers.
 *
 * Privoxy evaluates an action file top-down and — unlike a Shadowrocket/Surge rule set — **the last
 * action that matches a URL wins**. A child bypass therefore has to be emitted *after* the parent
 * block it escapes. The sections are emitted by the format drivers, not by `formatPrivoxyRule`:
 * where a section begins is a document-level decision and a single rule cannot know it.
 */
export const PRIVOXY_BLOCK_SECTION = "{+block{Blockingmachine Blocklist}}";
export const PRIVOXY_BYPASS_SECTION = "{-block}";

/**
 * The record section a BIND master file needs before any policy record.
 *
 * BIND refuses to load a primary zone whose file has no SOA, so a file of bare policy records does
 * not load at all. The SOA/NS pair below is the one the BIND ARM's own RPZ example uses.
 */
export const RPZ_ZONE_PREAMBLE = [
  "$TTL 3600",
  "@ IN SOA localhost. root.localhost. ( 1 3600 600 604800 86400 )",
  "@ IN NS localhost.",
].join("\n");

/** A stored rule must represent one enabled input line. */
export function isExportableRule(rule: StoredRule): boolean {
  return !!rule?.raw?.trim() && rule.metadata?.enabled !== false &&
    !/[\r\n\u0085\u2028\u2029]/.test(rule.raw);
}

const COSMETIC_MARKER = /#(?:@?(?:#|\?#|\$#|\$\?#|%#)|[.,])|\$\$/;

/**
 * The comment prefix a format's own syntax uses.
 *
 * A DNS master file (BIND) is not `named.conf`: it holds resource records, and its comment
 * character is `;` — `#` is a parse error there, not a comment.
 */
export function exportCommentPrefix(format: SupportedFormat): string {
  if (format === "adguard" || format === "abp" || format === "all") return "! ";
  if (format === "bind") return "; ";
  return "# ";
}

/** An inert line recording an exception, in the target format's own comment syntax. */
export function formatExceptionComment(
  rule: StoredRule,
  format: SupportedFormat,
  overridden = false,
): string {
  const label = overridden ? "EXCEPTION OVERRIDDEN BY $important" : "EXCEPTION";
  return `${exportCommentPrefix(format)}${label}: ${rule.raw}`;
}

export function isException(rule: StoredRule): boolean {
  return !!rule && !!(
    rule.isException || rule.type === "unblocking" || rule.type === "exception" ||
    rule.raw.trim().startsWith("@@") || /#@(?:#|\?#|%#|\$#|\$\?#)/.test(rule.raw)
  );
}

/** Cosmetic selectors and scriptlet arguments may contain literal dollar signs. */
export function getNetworkModifiers(rule: StoredRule): string[] {
  if (COSMETIC_MARKER.test(rule.raw)) return [];
  const dollarIndex = rule.raw.indexOf("$");
  return dollarIndex < 0 ? [] : rule.raw.slice(dollarIndex + 1).split(",").map(mod => mod.trim().toLowerCase());
}

const BROWSER_ONLY_TYPES = new Set([
  "cosmetic",
  "css",
  "extended-css",
  "html",
  "html-filtering",
  "scriptlet",
  "parameter",
  "transform",
  "javascript",
  "csp",
  "redirect",
  "replace",
  "removeheader",
  "permissions",
]);

export function isBrowserOnlyRule(rule: StoredRule): boolean {
  if (!isExportableRule(rule)) return true;
  if (COSMETIC_MARKER.test(rule.raw) || BROWSER_ONLY_TYPES.has(rule.type)) return true;
  if (rule.raw.split("$")[0].includes("/")) return true;

  // Every other option narrows, rewrites, or changes the request semantics and
  // cannot be represented by an unconditional domain sinkhole.
  return getNetworkModifiers(rule).some(mod => mod !== "important" && mod !== "badfilter");
}

export function getDnsDomain(rule: StoredRule): string | undefined {
  if (isBrowserOnlyRule(rule) || getNetworkModifiers(rule).includes("badfilter")) return undefined;
  return cleanDomainPattern(rule.raw) || undefined;
}

export function formatAdguardRule(rule: StoredRule): string {
  if (!isExportableRule(rule)) return "";
  const raw = rule.raw.trim();

  // If rule is already valid ABP / AdGuard syntax, preserve as-is
  if (
    raw.startsWith("||") ||
    raw.startsWith("@@") ||
    raw.startsWith("|") ||
    raw.startsWith("!") ||
    raw.startsWith("[") ||
    raw.includes("##") ||
    raw.includes("#@#") ||
    raw.includes("#?#") ||
    raw.includes("#$#") ||
    raw.includes("#%#") ||
    raw.includes("$$")
  ) {
    return raw;
  }

  // Convert hosts file rules (0.0.0.0 domain or 127.0.0.1 domain) to ABP syntax
  if (/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+/.test(raw)) {
    const domain = cleanDomainPattern(raw);
    if (domain) {
      return isException(rule) ? `@@||${domain}^` : `||${domain}^`;
    }
  }

  // Convert bare domain rules to ABP syntax
  const cleanDomain = cleanDomainPattern(raw);
  if (cleanDomain && cleanDomain === raw.toLowerCase()) {
    return isException(rule) ? `@@||${cleanDomain}^` : `||${cleanDomain}^`;
  }

  return raw;
}

export function formatRuleForType(
  rule: StoredRule,
  format: SupportedFormat,
): string {
  if (!isExportableRule(rule)) return "";
  switch (format) {
    case "hosts":
      return formatHostsRule(rule);
    case "dnsmasq":
      return formatDnsmasqRule(rule);
    case "unbound":
      return formatUnboundRule(rule);
    case "bind":
      return formatBindRule(rule);
    case "privoxy":
      return formatPrivoxyRule(rule);
    case "shadowrocket":
      return formatShadowrocketRule(rule);
    case "domains":
      if (isException(rule)) {
        if (!getDnsDomain(rule)) return "";
        return `# EXCEPTION: ${rule.raw}`;
      }
      return getDnsDomain(rule) || "";
    case "plain":
      return rule.raw;
    case "adguard":
    case "abp":
      return formatAdguardRule(rule);
    case "all":
      return rule.raw;
    default:
      return rule.raw;
  }
}

function formatHostsRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `0.0.0.0 ${domain}`;
}

function formatDnsmasqRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `address=/${domain}/0.0.0.0`;
}

function formatUnboundRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `  local-zone: "${domain}" always_nxdomain`;
}

function formatBindRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return formatExceptionComment(rule, "bind");
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  // One `zone { type master; file … }` stanza per blocked domain cannot work: BIND refuses a
  // primary zone whose file holds no SOA, and no single file can serve 100k different origins. The
  // artifact is therefore a Response Policy Zone, where the records *are* the list. `CNAME .` is
  // RPZ's documented NXDOMAIN policy, and because the name is relative it is rewritten against the
  // RPZ origin — which is exactly how BIND recovers the name being blocked.
  return `${domain} CNAME .`;
}

function formatPrivoxyRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return formatExceptionComment(rule, "privoxy");
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  // The leading dot is the whole mechanism: a bare host in a Privoxy action file matches that host
  // only, while `.example.com` matches the domain and every subdomain of it.
  return `.${domain}`;
}

function formatShadowrocketRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  // `DOMAIN-SUFFIX`, not `DOMAIN`: the blocklist is keyed by registrable domain, and `DOMAIN`
  // matches that exact host only — every subdomain of a blocked domain would sail straight
  // through. `DOMAIN-SUFFIX` is what Shadowrocket and Surge users mean by a domain block.
  return `DOMAIN-SUFFIX,${domain},REJECT`;
}
