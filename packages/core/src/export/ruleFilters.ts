import type { StoredRule } from "../types.js";
import { getDnsDomain, getNetworkModifiers, isException, isExportableRule } from "./formatters.js";

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
const DNS_ONLY_MODIFIERS = new Set([
  "client",
  "dnstype",
  "dnsrewrite",
  "ctag",
]);

const RESERVED_INFRASTRUCTURE_DOMAINS = new Set([
  "localhost",
  "local",
  "broadcasthost",
  "home.arpa",
  "ip6-localhost",
  "ip6-loopback",
  "invalid",
  "test",
  "example",
  "onion",
]);

const BARE_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "net.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "org.br",
  "net.br",
  "com.cn",
  "net.cn",
  "org.cn",
  "co.in",
  "net.in",
  "org.in",
  "github.io",
  "pages.dev",
  "vercel.app",
  "cloudfront.net",
  "azurewebsites.net",
  "amazonaws.com",
]);

/** Resolve cancellation while preserving unrelated rules on the same domain. */
function withoutBadfilters(rules: StoredRule[]): StoredRule[] {
  const enabled = rules.filter(isExportableRule);
  const key = (rule: StoredRule) => {
    const pattern = rule.raw.trim().split("$")[0];
    const modifiers = getNetworkModifiers(rule).filter(mod => mod !== "badfilter").sort();
    return `${pattern}$${modifiers.join(",")}`;
  };
  const disabled = new Set(enabled.filter(rule => getNetworkModifiers(rule).includes("badfilter")).map(key));
  return enabled.filter(rule => !getNetworkModifiers(rule).includes("badfilter") && !disabled.has(key(rule)));
}

export function filterDNSRules(rules: StoredRule[]): StoredRule[] {
  return withoutBadfilters(rules).filter((rule) => {
    if (!DNS_RULE_TYPES.has(rule.type)) return false;
    const domain = getDnsDomain(rule);
    if (!domain) return false;
    if (RESERVED_INFRASTRUCTURE_DOMAINS.has(domain) || domain.endsWith(".arpa")) return false;
    if (rule.raw.trim().startsWith("||") && BARE_PUBLIC_SUFFIXES.has(domain)) return false;
    return true;
  });
}

export function filterBrowserRules(rules: StoredRule[]): StoredRule[] {
  return rules.filter((rule) => {
    if (!BROWSER_SUITABLE_RULE_TYPES.has(rule.type)) return false;
    if (!isExportableRule(rule)) return false;

    // Parse network options only; CSS attribute selectors can contain `$`.
    if (getNetworkModifiers(rule).some(mod => DNS_ONLY_MODIFIERS.has(mod.split("=")[0].replace(/^~/, "")))) {
      return false;
    }

    // Prune reverse DNS arpa lookups from browser extensions
    if (rule.raw.includes(".arpa")) {
      return false;
    }

    // Prune raw hosts mappings for loopback / broadcasthost
    if (
      /^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+(?:localhost|broadcasthost|local)(?:\s|$)/i.test(
        rule.raw
      )
    ) {
      return false;
    }

    return true;
  });
}

export function filterBrowserOnlyRules(rules: StoredRule[]): StoredRule[] {
  return rules.filter((rule) => isExportableRule(rule) && BROWSER_ONLY_RULE_TYPES.has(rule.type));
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
    const domain = getDnsDomain(rule);
    if (!domain) continue;
    const cleanDom = domain.toLowerCase();
    const isImportant = getNetworkModifiers(rule).includes("important");
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
    const domain = getDnsDomain(blockRule);
    if (!domain) continue;
    const blockDom = domain.toLowerCase();
    const isImportantBlock = getNetworkModifiers(blockRule).includes("important");

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

  // A child exception must not create a bypass through an important parent.
  for (const [exDom, exRecord] of exceptionMap) {
    const importantCoveringBlock = !exRecord.isImportant && Array.from(activeBlocksMap).some(
      ([blockDom, blockRule]) => (exDom === blockDom || exDom.endsWith("." + blockDom)) &&
        getNetworkModifiers(blockRule).includes("important"),
    );
    if (importantCoveringBlock) {
      overriddenExceptionsMap.set(exDom, exRecord.rule);
      effectiveExceptionsMap.delete(exDom);
      allowlistedDomains.delete(exDom);
    } else {
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
    const domA = (getDnsDomain(a) || "").toLowerCase();
    const domB = (getDnsDomain(b) || "").toLowerCase();
    return domA.localeCompare(domB);
  });

  const effectiveExceptions = Array.from(effectiveExceptionsMap.values()).sort((a, b) => {
    const domA = (getDnsDomain(a) || "").toLowerCase();
    const domB = (getDnsDomain(b) || "").toLowerCase();
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
