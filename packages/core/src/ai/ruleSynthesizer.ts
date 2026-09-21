import type { AiVerdict, RuleCoverageResult, ThreatCategory } from './types.js';

export interface RuleSynthesisInput {
  domain: string;
  verdict: AiVerdict;
  category: ThreatCategory;
  cnames?: string[];
  isSubdomain?: boolean;
}

/**
 * Sanitizes and validates a domain or IPv4 address per RFC 1035 / RFC 1123 standards.
 * Prevents rule injection attacks by stripping schemes, paths, ports, newlines,
 * carriage returns, control characters, and ABP modifier characters.
 *
 * @returns Sanitized lowercase domain/IP string, or null if the input is malformed or invalid.
 * @beta
 */
export function sanitizeDomain(input: string): string | null {
  if (!input || typeof input !== 'string') {
    return null;
  }

  // 1. Immediate rejection of control characters, newlines, tabs, and filter list syntax injection characters
  if (/[\r\n\t\0\x00-\x1f\x7f$^|@#!,;<>"`']/.test(input)) {
    return null;
  }

  // 2. Strip URL scheme, path, query parameters, fragment, and port numbers
  let clean = input.trim().toLowerCase();
  clean = clean.replace(/^[a-z]+:\/\//i, '');
  clean = clean.split('/')[0];
  clean = clean.split('?')[0];
  clean = clean.split('#')[0];
  clean = clean.split(':')[0];

  // 3. Remove leading and trailing dots
  clean = clean.replace(/^\.+|\.+$/g, '');

  if (clean.length === 0 || clean.length > 253) {
    return null;
  }

  // 4. Validate standard IPv4 address
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const ipMatch = clean.match(ipv4Regex);
  if (ipMatch) {
    const octets = [Number(ipMatch[1]), Number(ipMatch[2]), Number(ipMatch[3]), Number(ipMatch[4])];
    const allValid = octets.every((o) => o >= 0 && o <= 255);
    return allValid ? clean : null;
  }

  // 5. Validate standard RFC 1123 domain labels
  const labels = clean.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      return null;
    }
    // Must contain only alphanumeric characters and hyphens
    if (!/^[a-z0-9-]+$/i.test(label)) {
      return null;
    }
    // Cannot begin or end with a hyphen
    if (label.startsWith('-') || label.endsWith('-')) {
      return null;
    }
  }

  return clean;
}

/**
 * Checks if a domain is already covered by an existing set of ABP or hosts rules,
 * either via exact match or wildcard parent domain rule (e.g. ||tracker.com^ covers sub.tracker.com).
 *
 * @beta
 */
export function isDomainCoveredByRules(
  domain: string,
  existingRules: string[],
): RuleCoverageResult {
  const target = sanitizeDomain(domain);
  if (!target || !Array.isArray(existingRules) || existingRules.length === 0) {
    return { isCovered: false };
  }

  for (const rawRule of existingRules) {
    if (!rawRule || typeof rawRule !== 'string') continue;
    const rule = rawRule.trim();

    // Skip comments and empty lines
    if (!rule || rule.startsWith('!') || rule.startsWith('#')) {
      continue;
    }

    // Skip exception/allowlist rules (@@...)
    if (rule.startsWith('@@')) {
      continue;
    }

    // 1. Hosts format: 0.0.0.0 domain or 127.0.0.1 domain
    const hostsMatch = rule.match(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9_.-]+)/i);
    if (hostsMatch) {
      const host = sanitizeDomain(hostsMatch[1]);
      if (host && host === target) {
        return { isCovered: true, coveringRule: rule };
      }
      continue;
    }

    // 2. Standard ABP / AdGuard domain rule: ||domain^ or ||domain^$options
    const abpMatch = rule.match(/^\|\|([a-z0-9_.-]+)\^/i);
    if (abpMatch) {
      const ruleDomain = sanitizeDomain(abpMatch[1]);
      if (ruleDomain) {
        // Exact match (e.g. ||tracker.com^ covers tracker.com)
        // Wildcard subdomain match (e.g. ||tracker.com^ covers sub.tracker.com and a.b.tracker.com)
        if (target === ruleDomain || target.endsWith(`.${ruleDomain}`)) {
          return { isCovered: true, coveringRule: rule };
        }
      }
      continue;
    }

    // 3. Exact raw domain match
    const rawClean = sanitizeDomain(rule);
    if (rawClean && rawClean === target) {
      return { isCovered: true, coveringRule: rule };
    }
  }

  return { isCovered: false };
}

/**
 * Synthesizes ABP/AdGuard-compatible blocking rules for detected ad/tracker infrastructure.
 * @beta
 */
export function synthesizeRules(input: RuleSynthesisInput): string[] {
  const { domain, verdict, category, cnames } = input;
  const cleanDomain = sanitizeDomain(domain);

  if (!cleanDomain || verdict === 'clean') {
    return [];
  }

  const rules: string[] = [];

  // 1. Primary Network Blocking Rule (Standard ABP / AdGuard DNS syntax)
  if (category === 'Advertising' || verdict === 'ad_server') {
    rules.push(`||${cleanDomain}^`);
  } else if (category === 'Telemetry/Analytics' || verdict === 'tracker') {
    rules.push(`||${cleanDomain}^`);
    rules.push(`||${cleanDomain}^$third-party`);
  } else if (category === 'CNAME Cloaking') {
    rules.push(`||${cleanDomain}^`);
    if (cnames && cnames.length > 0) {
      const lastCname = sanitizeDomain(cnames[cnames.length - 1]);
      if (lastCname) {
        rules.push(`||${lastCname}^`);
      }
    }
  } else {
    // General block
    rules.push(`||${cleanDomain}^`);
  }

  // 2. Add Hosts-file compatible format
  rules.push(`0.0.0.0 ${cleanDomain}`);

  return Array.from(new Set(rules));
}

/**
 * Synthesizes an ABP/AdGuard-compatible exception/allowlist rule for false positives.
 * @beta
 */
export function synthesizeAllowlistRule(domain: string): string {
  const cleanDomain = sanitizeDomain(domain);
  if (!cleanDomain) {
    return '';
  }
  return `@@||${cleanDomain}^`;
}

