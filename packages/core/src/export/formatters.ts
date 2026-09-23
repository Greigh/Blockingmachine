import type { StoredRule } from "../RuleStore.js";
import type { SupportedFormat } from "../types.js";
import { cleanDomainPattern } from "../createMetadata.js";

export function isException(rule: StoredRule): boolean {
  return !!(
    rule.isException ||
    rule.type === "unblocking" ||
    rule.raw.startsWith("@@") ||
    rule.raw.includes("#@#") ||
    rule.raw.includes("#@%") ||
    rule.raw.includes("#@$") ||
    rule.raw.includes("#$?#")
  );
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

const BROWSER_MODIFIERS = new Set([
  "app",
  "header",
  "method",
  "popup",
  "strict-first-party",
  "strict-third-party",
  "document",
  "font",
  "image",
  "media",
  "object",
  "other",
  "ping",
  "script",
  "stylesheet",
  "subdocument",
  "websocket",
  "xmlhttprequest",
  "content",
  "elemhide",
]);

export function isBrowserOnlyRule(rule: StoredRule): boolean {
  if (!rule || !rule.raw) return true;

  // Cosmetic, scriptlet, extended CSS, HTML filtering patterns
  if (
    rule.raw.includes("##") ||
    rule.raw.includes("#@#") ||
    rule.raw.includes("#?#") ||
    rule.raw.includes("#$#") ||
    rule.raw.includes("#%#") ||
    rule.raw.includes("$$")
  ) {
    return true;
  }

  // Type check
  if (rule.type && BROWSER_ONLY_TYPES.has(rule.type)) {
    return true;
  }

  // Path check on ABP network rules (e.g. ||domain.com/path)
  if (rule.raw.startsWith("||") || rule.raw.startsWith("@@||")) {
    const rawNoPrefix = rule.raw.replace(/^(@@)?\|\|/, "").split("$")[0];
    if (rawNoPrefix.includes("/")) {
      return true;
    }
  }

  // Browser-only modifiers check
  const dollarIdx = rule.raw.indexOf("$");
  if (dollarIdx !== -1) {
    const mods = rule.raw.slice(dollarIdx + 1).split(",");
    for (const rawMod of mods) {
      const mod = rawMod.split("=")[0].trim().toLowerCase();
      if (BROWSER_MODIFIERS.has(mod)) {
        return true;
      }
    }
  }

  return false;
}

export function getDnsDomain(rule: StoredRule): string | undefined {
  if (isBrowserOnlyRule(rule)) return undefined;
  return cleanDomainPattern(rule.raw) || undefined;
}

export function formatAdguardRule(rule: StoredRule): string {
  if (!rule || !rule.raw) return "";
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
  if (/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+/.test(raw)) {
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
        if (isBrowserOnlyRule(rule)) return "";
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
    if (isBrowserOnlyRule(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `0.0.0.0 ${domain}`;
}

function formatDnsmasqRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (isBrowserOnlyRule(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `address=/${domain}/0.0.0.0`;
}

function formatUnboundRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (isBrowserOnlyRule(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `local-zone: "${domain}" static`;
}

function formatBindRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (isBrowserOnlyRule(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `zone "${domain}" { type master; file "null.zone.file"; };`;
}

function formatPrivoxyRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (isBrowserOnlyRule(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `{ +block { ${domain} } }`;
}

function formatShadowrocketRule(rule: StoredRule): string {
  if (isException(rule)) {
    if (isBrowserOnlyRule(rule)) return "";
    return `# EXCEPTION: ${rule.raw}`;
  }
  const domain = getDnsDomain(rule);
  if (!domain) return "";
  return `DOMAIN,${domain},REJECT`;
}
