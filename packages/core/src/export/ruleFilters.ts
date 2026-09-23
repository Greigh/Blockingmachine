import type { StoredRule } from "../types.js";
import { cleanDomainPattern } from "../createMetadata.js";
import { isException } from "./formatters.js";

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

    // Exclude cosmetic rules, scriptlets, and standalone comments
    if (
      rule.raw.startsWith("#") ||
      rule.raw.startsWith("!") ||
      rule.raw.includes("##") ||
      rule.raw.includes("#@#") ||
      rule.raw.includes("#?#") ||
      rule.raw.includes("#$#") ||
      rule.raw.includes("#$?#") ||
      rule.raw.includes("#%#") ||
      rule.raw.includes("#@%#") ||
      rule.raw.includes("#@$#") ||
      rule.raw.includes("$$") ||
      rule.raw.includes("#.") ||
      rule.raw.includes("#,")
    ) {
      return false;
    }

    // ABP rules with URL paths cannot be blocked at DNS level
    if (rule.raw.startsWith("||") || rule.raw.startsWith("@@||")) {
      const rawNoPrefix = rule.raw.replace(/^(@@)?\|\|/, "").split("$")[0];
      if (rawNoPrefix.includes("/")) return false;
    } else if (rule.raw.includes("/")) {
      return false;
    }

    // Check modifiers (parse all comma-separated modifiers after $)
    const dollarIdx = rule.raw.indexOf("$");
    if (dollarIdx !== -1) {
      const modString = rule.raw.slice(dollarIdx + 1);
      const mods = modString.split(",");
      for (const rawMod of mods) {
        const modName = rawMod.split("=")[0].trim().toLowerCase();
        if (NETWORK_RULE_BROWSER_MODIFIERS.has(modName)) {
          return false;
        }
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

export interface DnsPrecedenceResult {
  /** Blocking rules that survive exception resolution, sorted alphabetically by domain */
  activeBlocks: StoredRule[];
  /** Exceptions that actively allowlist a domain or subdomain */
  effectiveExceptions: StoredRule[];
  /** Exceptions that were overridden by an $important blocking rule */
  overriddenExceptions: StoredRule[];
  /** Subdomain exceptions that fall under a blocked parent zone (for dnsmasq/unbound bypass) */
  subdomainExceptions: { parentDomain: string; subdomain: string; rule: StoredRule }[];
  /** Set of all allowlisted domains (lowercase) */
  allowlistedDomains: Set<string>;
}

/**
 * Resolves standard adblock precedence semantics ($important modifiers, exact domain
 * and subdomain allowlisting) for DNS-level exports (hosts, dnsmasq, unbound, bind).
 * Ensures allowlisted domains are pruned from blocking sinkholes.
 */
export function resolveDnsPrecedence(rules: StoredRule[]): DnsPrecedenceResult {
  const dnsRules = filterDNSRules(rules);

  const rawExceptions: StoredRule[] = [];
  const rawBlocks: StoredRule[] = [];

  for (const rule of dnsRules) {
    if (isException(rule)) {
      rawExceptions.push(rule);
    } else {
      rawBlocks.push(rule);
    }
  }

  // Parse exceptions and their $important status
  interface ExceptionRecord {
    domain: string;
    isImportant: boolean;
    rule: StoredRule;
  }
  const exceptionMap = new Map<string, ExceptionRecord>();
  for (const rule of rawExceptions) {
    const domain = cleanDomainPattern(rule.raw) || rule.domain;
    if (!domain) continue;
    const cleanDom = domain.toLowerCase();
    const isImportant = rule.raw.includes("$important");
    const existing = exceptionMap.get(cleanDom);
    if (!existing || (!existing.isImportant && isImportant)) {
      exceptionMap.set(cleanDom, { domain: cleanDom, isImportant, rule });
    }
  }

  const activeBlocksMap = new Map<string, StoredRule>();
  const effectiveExceptionsMap = new Map<string, StoredRule>();
  const overriddenExceptionsMap = new Map<string, StoredRule>();
  const allowlistedDomains = new Set<string>();

  for (const blockRule of rawBlocks) {
    const domain = cleanDomainPattern(blockRule.raw) || blockRule.domain;
    if (!domain) continue;
    const blockDom = domain.toLowerCase();
    const isImportantBlock = blockRule.raw.includes("$important");

    // Check if an exception covers this block rule
    let coveredByException: ExceptionRecord | null = null;
    for (const [exDom, exRecord] of exceptionMap) {
      if (blockDom === exDom || blockDom.endsWith("." + exDom)) {
        if (!coveredByException || (!coveredByException.isImportant && exRecord.isImportant)) {
          coveredByException = exRecord;
        }
      }
    }

    if (coveredByException) {
      if (isImportantBlock && !coveredByException.isImportant) {
        // Important block overrides normal exception
        overriddenExceptionsMap.set(coveredByException.domain, coveredByException.rule);
        activeBlocksMap.set(blockDom, blockRule);
      } else {
        // Exception wins: block rule is pruned from active sinkholes
        effectiveExceptionsMap.set(coveredByException.domain, coveredByException.rule);
        allowlistedDomains.add(blockDom);
      }
    } else {
      // No exception applies: block is retained
      activeBlocksMap.set(blockDom, blockRule);
    }
  }

  // Include standalone exceptions not explicitly shadowed by a block rule
  for (const [exDom, exRecord] of exceptionMap) {
    if (!overriddenExceptionsMap.has(exDom)) {
      effectiveExceptionsMap.set(exDom, exRecord.rule);
      allowlistedDomains.add(exDom);
    }
  }

  // Detect subdomain exceptions under active parent zone blocks (for dnsmasq/unbound bypass)
  const subdomainExceptions: { parentDomain: string; subdomain: string; rule: StoredRule }[] = [];
  for (const [exDom, exRule] of effectiveExceptionsMap) {
    for (const [blockDom] of activeBlocksMap) {
      if (exDom !== blockDom && exDom.endsWith("." + blockDom)) {
        subdomainExceptions.push({ parentDomain: blockDom, subdomain: exDom, rule: exRule });
      }
    }
  }

  // Sort active blocks and effective exceptions deterministically
  const activeBlocks = Array.from(activeBlocksMap.values()).sort((a, b) => {
    const domA = (cleanDomainPattern(a.raw) || a.domain || "").toLowerCase();
    const domB = (cleanDomainPattern(b.raw) || b.domain || "").toLowerCase();
    return domA.localeCompare(domB);
  });

  const effectiveExceptions = Array.from(effectiveExceptionsMap.values()).sort((a, b) => {
    const domA = (cleanDomainPattern(a.raw) || a.domain || "").toLowerCase();
    const domB = (cleanDomainPattern(b.raw) || b.domain || "").toLowerCase();
    return domA.localeCompare(domB);
  });

  const overriddenExceptions = Array.from(overriddenExceptionsMap.values());

  return {
    activeBlocks,
    effectiveExceptions,
    overriddenExceptions,
    subdomainExceptions,
    allowlistedDomains,
  };
}
