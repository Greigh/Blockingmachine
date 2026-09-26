import type { StoredRule } from "../RuleStore.js";
import type { SupportedFormat } from "../types.js";
import { cleanDomainPattern } from "../createMetadata.js";

/** A stored rule must represent one enabled input line. */
export function isExportableRule(rule: StoredRule): boolean {
  return !!rule?.raw?.trim() && rule.metadata?.enabled !== false &&
    !/[\r\n\u0085\u2028\u2029]/.test(rule.raw);
}

const COSMETIC_MARKER = /#(?:@?(?:#|\?#|\$#|\$\?#|%#)|[.,])|\$\$/;

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
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `zone "${domain}" { type master; file "null.zone.file"; };`;
}

function formatPrivoxyRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `{ +block { ${domain} } }`;
}

function formatShadowrocketRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (!getDnsDomain(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `DOMAIN,${domain},REJECT`;
}
