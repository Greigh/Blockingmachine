import type { StoredRule } from "../types.js";

// Rule Type Sets
const DNS_RULE_TYPES = new Set(["blocking", "unblocking"]);
const BROWSER_ONLY_RULE_TYPES = new Set([
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
const BROWSER_SUITABLE_RULE_TYPES = new Set([
  "blocking",
  "unblocking",
  ...BROWSER_ONLY_RULE_TYPES,
]);
const NETWORK_RULE_BROWSER_MODIFIERS = new Set([
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

export function filterDNSRules(rules: StoredRule[]): StoredRule[] {
  return rules.filter((rule) => {
    if (!DNS_RULE_TYPES.has(rule.type)) return false;
    if (!rule.raw) return false;

    // Exclude rules with specific patterns
    if (/[#]/.test(rule.raw) && !rule.raw.includes("$denyallow")) return false;
    if (rule.raw.includes("$$")) return false;
    if (rule.raw.includes("/") && !rule.raw.match(/^(@@)?\|\|/)) return false;

    // Check modifiers
    const modifierPattern = /\$([a-z0-9_-]+)(?:=|$)/gi;
    let match;
    while ((match = modifierPattern.exec(rule.raw))) {
      if (NETWORK_RULE_BROWSER_MODIFIERS.has(match[1].toLowerCase())) {
        return false;
      }
    }
    return true;
  });
}

export function filterBrowserRules(rules: StoredRule[]): StoredRule[] {
  return rules.filter((rule) => BROWSER_SUITABLE_RULE_TYPES.has(rule.type));
}

export function filterBrowserOnlyRules(rules: StoredRule[]): StoredRule[] {
  return rules.filter((rule) => BROWSER_ONLY_RULE_TYPES.has(rule.type));
}
