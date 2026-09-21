import type {
  AiVerdict,
  CompactionResult,
  RuleConflictResult,
  RuleCoverageResult,
  SynthesisTarget,
  ThreatCategory,
} from './types.js';
import { COMPOUND_CCTLDS } from './entropy.js';

export interface RuleSynthesisInput {
  domain: string;
  verdict: AiVerdict;
  category: ThreatCategory;
  cnames?: string[];
  isSubdomain?: boolean;
  target?: SynthesisTarget;
  includeComments?: boolean;
  confidence?: number;
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

interface TrieNode {
  children: Map<string, TrieNode>;
  isWildcard: boolean;
  coveringWildcardRule?: string;
  isExact: boolean;
  coveringExactRule?: string;
}

/**
 * Ultra-fast in-memory Reverse-Domain Suffix Trie.
 * Provides O(K) lookup complexity (where K = domain label depth) to verify if a domain
 * is covered by wildcard or exact rules across hundreds of thousands of filter rules.
 * @beta
 */
export class RuleCoverageTrie {
  private root: TrieNode = {
    children: new Map(),
    isWildcard: false,
    isExact: false,
  };
  private ruleCount = 0;

  public insertRule(rawRule: string): void {
    if (!rawRule || typeof rawRule !== 'string') return;
    const rule = rawRule.trim();
    if (!rule || rule.startsWith('!') || rule.startsWith('#') || rule.startsWith('@@')) {
      return;
    }

    // 1. Hosts format: 0.0.0.0 domain or 127.0.0.1 domain
    const hostsMatch = rule.match(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9_.-]+)/i);
    if (hostsMatch) {
      const host = sanitizeDomain(hostsMatch[1]);
      if (host) {
        this.addDomain(host, false, rule);
        this.ruleCount++;
      }
      return;
    }

    // 2. Standard ABP / AdGuard domain rule: ||domain^ or ||domain^$options
    const abpMatch = rule.match(/^\|\|([a-z0-9_.-]+)\^/i);
    if (abpMatch) {
      const ruleDomain = sanitizeDomain(abpMatch[1]);
      if (ruleDomain) {
        this.addDomain(ruleDomain, true, rule);
        this.ruleCount++;
      }
      return;
    }

    // 3. Exact raw domain match
    const rawClean = sanitizeDomain(rule);
    if (rawClean) {
      this.addDomain(rawClean, false, rule);
      this.ruleCount++;
    }
  }

  public insertRules(rules: string[]): void {
    if (!Array.isArray(rules)) return;
    for (const rule of rules) {
      this.insertRule(rule);
    }
  }

  private addDomain(domain: string, isWildcard: boolean, rule: string): void {
    const labels = domain.split('.').reverse();
    let current = this.root;

    for (const label of labels) {
      let next = current.children.get(label);
      if (!next) {
        next = { children: new Map(), isWildcard: false, isExact: false };
        current.children.set(label, next);
      }
      current = next;
    }

    if (isWildcard) {
      current.isWildcard = true;
      if (!current.coveringWildcardRule) {
        current.coveringWildcardRule = rule;
      }
    } else {
      current.isExact = true;
      if (!current.coveringExactRule) {
        current.coveringExactRule = rule;
      }
    }
  }

  public isCovered(domain: string): RuleCoverageResult {
    const clean = sanitizeDomain(domain);
    if (!clean) return { isCovered: false };

    const labels = clean.split('.').reverse();
    let current = this.root;

    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      const next = current.children.get(label);
      if (!next) {
        return { isCovered: false };
      }
      current = next;

      // Wildcard rule set at this level covers all deeper subdomains
      if (current.isWildcard) {
        return { isCovered: true, coveringRule: current.coveringWildcardRule };
      }
    }

    // At the exact leaf domain, check if exact match rule was set
    if (current.isExact) {
      return { isCovered: true, coveringRule: current.coveringExactRule };
    }

    return { isCovered: false };
  }

  public get size(): number {
    return this.ruleCount;
  }

  public clear(): void {
    this.root = { children: new Map(), isWildcard: false, isExact: false };
    this.ruleCount = 0;
  }
}

/**
 * Checks if a domain is already covered by an existing set of ABP or hosts rules,
 * either via exact match or wildcard parent domain rule (e.g. ||tracker.com^ covers sub.tracker.com).
 * Utilizes RuleCoverageTrie for high-performance sub-millisecond evaluation.
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

  const trie = new RuleCoverageTrie();
  trie.insertRules(existingRules);
  return trie.isCovered(target);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Synthesizes target-specific blocking rules for detected ad/tracker/threat infrastructure.
 * Supports universal ABP syntax, AdGuard Home, Pi-hole regex, uBlock Origin, Unbound, dnsmasq, and hosts.
 *
 * @beta
 */
export function synthesizeRules(input: RuleSynthesisInput): string[] {
  const { domain, verdict, category, cnames, target = 'all', includeComments = false, confidence = 90 } = input;
  const cleanDomain = sanitizeDomain(domain);

  if (!cleanDomain || verdict === 'clean') {
    return [];
  }

  const rules: string[] = [];

  // Target-specific formatting
  switch (target) {
    case 'adguard': {
      rules.push(`||${cleanDomain}^`);
      if (category === 'Advertising' || verdict === 'ad_server') {
        rules.push(`||${cleanDomain}^$dnsrewrite=NOERROR;NODATA`);
      } else if (category === 'Telemetry/Analytics' || verdict === 'tracker') {
        rules.push(`||${cleanDomain}^$third-party`);
      } else if (category === 'Malware/Phishing' || verdict === 'malicious') {
        rules.push(`||${cleanDomain}^$important`);
      }
      if (cnames && cnames.length > 0) {
        const lastCname = sanitizeDomain(cnames[cnames.length - 1]);
        if (lastCname && lastCname !== cleanDomain) {
          rules.push(`||${lastCname}^`);
        }
      }
      break;
    }

    case 'pihole': {
      // Regex format for Pi-hole v5/v6: (^|\.)domain$
      rules.push(`(^|\\.)${escapeRegex(cleanDomain)}$`);
      rules.push(`0.0.0.0 ${cleanDomain}`);
      break;
    }

    case 'ublock': {
      rules.push(`||${cleanDomain}^`);
      if (category === 'Telemetry/Analytics' || verdict === 'tracker') {
        rules.push(`||${cleanDomain}^$third-party`);
      }
      // Provide cosmetic defuser scriptlet for ad domains
      if (category === 'Advertising' || verdict === 'ad_server') {
        rules.push(`${cleanDomain}##+js(set, adsBlocked, true)`);
      }
      break;
    }

    case 'unbound': {
      rules.push(`local-zone: "${cleanDomain}" always_nxdomain`);
      break;
    }

    case 'dnsmasq': {
      rules.push(`address=/${cleanDomain}/0.0.0.0`);
      break;
    }

    case 'hosts': {
      rules.push(`0.0.0.0 ${cleanDomain}`);
      break;
    }

    case 'all':
    default: {
      // Primary standard ABP rule
      if (category === 'Advertising' || verdict === 'ad_server') {
        rules.push(`||${cleanDomain}^`);
      } else if (category === 'Telemetry/Analytics' || verdict === 'tracker') {
        rules.push(`||${cleanDomain}^`);
        rules.push(`||${cleanDomain}^$third-party`);
      } else if (category === 'CNAME Cloaking') {
        rules.push(`||${cleanDomain}^`);
        if (cnames && cnames.length > 0) {
          const lastCname = sanitizeDomain(cnames[cnames.length - 1]);
          if (lastCname && lastCname !== cleanDomain) {
            rules.push(`||${lastCname}^`);
          }
        }
      } else {
        rules.push(`||${cleanDomain}^`);
      }

      // Add standard hosts entry
      rules.push(`0.0.0.0 ${cleanDomain}`);
      break;
    }
  }

  const uniqueRules = Array.from(new Set(rules));

  if (includeComments) {
    const timestamp = new Date().toISOString().split('T')[0];
    const comments = [
      `! [Blockingmachine AI] Verdict: ${verdict} | Category: ${category} (${confidence}% confidence)`,
      `! Target: ${cleanDomain} | Date: ${timestamp}`,
    ];
    return [...comments, ...uniqueRules];
  }

  return uniqueRules;
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

/**
 * Determines whether a domain string is a valid parent zone eligible for wildcard compaction.
 * Protects against over-compaction onto TLDs or compound ccTLDs (e.g. .co.uk, .com.au),
 * which would dangerously block entire public suffixes.
 * @beta
 */
export function isValidParentZone(parent: string): boolean {
  if (!parent || !parent.includes('.')) return false;
  if (COMPOUND_CCTLDS.has(parent)) return false;

  const parts = parent.split('.');
  if (parts.length < 2) return false;

  // If the last two labels form a compound ccTLD (e.g. 'co.uk'),
  // the parent zone must have at least 3 labels (e.g. 'domain.co.uk')
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (COMPOUND_CCTLDS.has(lastTwo)) {
    return parts.length >= 3;
  }

  // Standard TLD requires at least 2 labels (e.g. 'domain.com')
  return parts.length >= 2;
}

/**
 * Clusters subdomains and collapses them into parent wildcard rules when >= threshold
 * subdomains share the same parent zone. Eliminates list bloat by 70–90%.
 *
 * @beta
 */
export function compactSubdomainRules(domains: string[], threshold = 3): CompactionResult {
  const sanitized = Array.from(
    new Set(
      domains
        .map((d) => sanitizeDomain(d))
        .filter((d): d is string => Boolean(d)),
    ),
  );

  if (sanitized.length === 0) {
    return {
      originalCount: 0,
      compactedCount: 0,
      compactedRules: [],
      savingsPercent: 0,
      collapsedGroups: [],
    };
  }

  // Map parent zones to their child subdomains
  const parentZoneMap = new Map<string, Set<string>>();

  for (const domain of sanitized) {
    const parts = domain.split('.');
    // Needs at least 3 labels to have a parent subdomain zone (e.g. s1.ads.tracker.com -> ads.tracker.com and tracker.com)
    if (parts.length >= 3) {
      // 1. One level up (e.g. sub.analytics.domain.com -> analytics.domain.com)
      const directParent = parts.slice(1).join('.');
      if (isValidParentZone(directParent)) {
        if (!parentZoneMap.has(directParent)) {
          parentZoneMap.set(directParent, new Set());
        }
        parentZoneMap.get(directParent)!.add(domain);
      }

      // 2. Two levels up if deeper (e.g. a.b.tracker.com -> tracker.com)
      if (parts.length >= 4) {
        const apexParent = parts.slice(2).join('.');
        if (isValidParentZone(apexParent)) {
          if (!parentZoneMap.has(apexParent)) {
            parentZoneMap.set(apexParent, new Set());
          }
          parentZoneMap.get(apexParent)!.add(domain);
        }
      }
    }
  }

  // Identify qualifying parent zones that meet the threshold
  const collapsedGroups: CompactionResult['collapsedGroups'] = [];
  const coveredSubdomains = new Set<string>();

  // Sort parent zones by length descending so most specific sub-branches collapse first
  const sortedParents = Array.from(parentZoneMap.entries())
    .filter(([, children]) => children.size >= threshold)
    .sort((a, b) => b[0].split('.').length - a[0].split('.').length);

  for (const [parent, children] of sortedParents) {
    const unabsorbed = Array.from(children).filter((c) => !coveredSubdomains.has(c));
    if (unabsorbed.length >= threshold) {
      collapsedGroups.push({
        parentDomain: parent,
        subdomains: unabsorbed,
        rule: `||${parent}^`,
      });
      for (const child of unabsorbed) {
        coveredSubdomains.add(child);
      }
    }
  }

  // Compile final compacted rules
  const compactedRules: string[] = [];

  // 1. Add collapsed parent rules
  for (const group of collapsedGroups) {
    compactedRules.push(group.rule);
  }

  // 2. Add remaining uncollapsed individual domains
  for (const domain of sanitized) {
    if (!coveredSubdomains.has(domain)) {
      compactedRules.push(`||${domain}^`);
    }
  }

  const uniqueCompacted = Array.from(new Set(compactedRules));
  const savingsPercent = Math.round(
    ((sanitized.length - uniqueCompacted.length) / (sanitized.length || 1)) * 100,
  );

  return {
    originalCount: sanitized.length,
    compactedCount: uniqueCompacted.length,
    compactedRules: uniqueCompacted,
    savingsPercent: Math.max(0, savingsPercent),
    collapsedGroups,
  };
}

/**
 * Cross-references a proposed blocking rule against existing allowlist rules (@@...).
 * Detects if the proposed rule is shadowed by an allowlist rule and suggests an
 * override with the $important modifier.
 *
 * @beta
 */
export function checkRuleConflict(rule: string, existingAllowRules: string[]): RuleConflictResult {
  if (!rule || !Array.isArray(existingAllowRules) || existingAllowRules.length === 0) {
    return { hasConflict: false };
  }

  // Extract domain from block rule (e.g. ||tracker.com^, 0.0.0.0 tracker.com, (^|\.)tracker\.com$)
  let targetDomain = '';
  const abpMatch = rule.match(/^\|\|([a-z0-9_.-]+)\^/i);
  if (abpMatch) {
    targetDomain = abpMatch[1].toLowerCase().trim();
  } else {
    const hostsMatch = rule.match(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([a-z0-9_.-]+)/i);
    if (hostsMatch) {
      targetDomain = hostsMatch[1].toLowerCase().trim();
    } else {
      const piholeMatch = rule.match(/^\(\^\|\\\.\)([a-z0-9_\\.-]+)\$$/i);
      if (piholeMatch) {
        targetDomain = piholeMatch[1].replace(/\\/g, '').toLowerCase().trim();
      } else {
        targetDomain = rule.replace(/[$^|!#]/g, '').trim().toLowerCase();
      }
    }
  }

  if (!targetDomain) {
    return { hasConflict: false };
  }

  const buildOverride = (originalRule: string, domain: string): string => {
    if (originalRule.startsWith('||')) {
      if (originalRule.includes('$')) {
        const [base, optsStr] = originalRule.split('$', 2);
        const opts = optsStr.split(',').map((o) => o.trim()).filter(Boolean);
        if (!opts.includes('important')) {
          opts.push('important');
        }
        return `${base}$${opts.join(',')}`;
      }
      return `${originalRule}$important`;
    }
    // For hosts format (0.0.0.0 domain) or Pi-hole regex, synthesize canonical ABP $important override
    return `||${domain}^$important`;
  };

  for (const rawAllow of existingAllowRules) {
    if (!rawAllow || !rawAllow.startsWith('@@')) continue;
    const allowRule = rawAllow.trim();

    // Check exact or wildcard allowlist domain: @@||domain^
    const allowAbpMatch = allowRule.match(/^@@\|\|([a-z0-9_.-]+)\^/i);
    if (allowAbpMatch) {
      const allowDomain = allowAbpMatch[1].toLowerCase().trim();
      if (targetDomain === allowDomain || targetDomain.endsWith(`.${allowDomain}`)) {
        return {
          hasConflict: true,
          conflictingAllowRule: allowRule,
          suggestedOverrideRule: buildOverride(rule, targetDomain),
          reason: `Proposed rule is neutralized by allowlist rule "${allowRule}". Use $important to enforce blocking.`,
        };
      }
    }

    // Direct domain allow: @@domain
    const cleanAllow = allowRule.replace(/^(?:@@\|\||@@)/, '').split('^')[0].split('$')[0].toLowerCase().trim();
    if (cleanAllow && (targetDomain === cleanAllow || targetDomain.endsWith(`.${cleanAllow}`))) {
      return {
        hasConflict: true,
        conflictingAllowRule: allowRule,
        suggestedOverrideRule: buildOverride(rule, targetDomain),
        reason: `Proposed rule is neutralized by allowlist rule "${allowRule}". Use $important to enforce blocking.`,
      };
    }
  }

  return { hasConflict: false };
}
