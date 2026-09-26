import type { StoredRule } from '../RuleStore.js';
import { sanitizeDomain } from './hostname.js';
import {
  COMPOUND_CCTLDS,
  DYNAMIC_DNS_SUFFIXES,
  FOUR_PART_PUBLIC_SUFFIXES,
  THREE_PART_PUBLIC_SUFFIXES,
} from './entropy.js';
import { normalizeHostname } from './reputation.js';
import type {
  DomainRuleMatch,
  DomainEvaluationResult,
} from './types.js';

/**
 * Checks if a domain string is a Top-Level Domain (TLD) or recognized multi-part public suffix.
 * Prevents overbroad wildcard matching (e.g. ||com^ or ||co.uk^) from causing catastrophic false positives.
 */
function isPublicSuffixOrTld(domain: string): boolean {
  if (!domain) return true;
  const clean = domain.toLowerCase().trim();
  if (!clean.includes('.')) return true;
  return (
    FOUR_PART_PUBLIC_SUFFIXES.has(clean) ||
    THREE_PART_PUBLIC_SUFFIXES.has(clean) ||
    COMPOUND_CCTLDS.has(clean) ||
    DYNAMIC_DNS_SUFFIXES.has(clean)
  );
}

/**
 * Creates a safe, bounded matcher function for wildcard patterns containing '*'.
 * Rejects overbroad single-token wildcards (e.g. '*', '*.*', '*.com') to protect against false positives.
 */
function createWildcardMatcher(pattern: string): ((target: string) => boolean) | null {
  const p = pattern.toLowerCase().trim();
  if (!p) return null;

  // Protect against overly broad wildcards without sufficient domain anchoring
  const nonWildcardChars = p.replace(/[*.]/g, '');
  if (nonWildcardChars.length < 2) {
    return null;
  }

  // Fast path for standard '*.domain.com'
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    if (isPublicSuffixOrTld(base)) {
      return null; // Do not allow wildcarding an entire TLD or public suffix
    }
    return (target: string) => target === base || target.endsWith('.' + base);
  }

  // Convert glob pattern to safe anchored regex
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    const rx = new RegExp(`^${escaped}$`, 'i');
    return (target: string) => rx.test(target);
  } catch {
    return null;
  }
}

/** Domain-only evaluation cannot establish request type, initiator or redirects. */
function ruleModifiers(rule: string): string[] {
  // Dollar signs in hosts-file comments and DNS configuration are literal text.
  if (/^(?:(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s|address=|server=|local-)/.test(rule)) return [];
  // A trailing $ in a regex is an anchor, not a modifier separator.
  if (rule.startsWith('/') && rule.endsWith('/')) return [];
  const separator = rule.lastIndexOf('$');
  return separator < 0 || separator === rule.length - 1
    ? [] : rule.slice(separator + 1).toLowerCase().split(',').map((part) => part.trim());
}

/** Preserve all hostname labels; metadata extraction intentionally strips www. */
function extractDomainPattern(rule: string): string | null {
  const mask = ruleModifiers(rule).length ? rule.slice(0, rule.lastIndexOf('$')) : rule;
  const hostname = mask.replace(/^@@/, '').replace(/^\|{1,2}/, '')
    .replace(/^https?:\/\//i, '').replace(/[\^/|]+$/, '');
  return /^[a-z0-9_.-]+$/i.test(hostname) ? sanitizeDomain(hostname) : null;
}

function ruleIdentity(rule: string): string {
  const modifiers = ruleModifiers(rule).filter((part) => part !== 'badfilter').sort();
  const pattern = ruleModifiers(rule).length ? rule.slice(0, rule.lastIndexOf('$')) : rule;
  return pattern.toLowerCase() + (modifiers.length ? `$${modifiers.join(',')}` : '');
}

export interface ParsedRuleEntry {
  rawRule: string;
  pattern: string;
  source?: string;
  ruleType: string;
  isImportant: boolean;
  isException: boolean;
  isWildcard: boolean;
  denyAllowDomains?: string[];
  wildcardTester?: (target: string) => boolean;
}

/**
 * Compiled and indexed set of filter rules providing ultra-high performance domain lookups (O(1) to O(L))
 * and complete AdGuard/uBO precedence resolution:
 * 1. $badfilter deactivates matching rules across lists.
 * 2. $denyallow exonerates specified subdomains from block rules.
 * 3. $important exception overrides $important block and regular blocks.
 * 4. $important block overrides regular exceptions.
 * 5. Regular exception overrides regular blocks.
 * 6. Regular blocks apply if no winning exception exists.
 * @beta
 */
export class CompiledDomainRuleSet {
  private readonly exactBlocks = new Map<string, DomainRuleMatch[]>();
  private readonly exactExceptions = new Map<string, DomainRuleMatch[]>();
  private readonly domainBlocks = new Map<string, DomainRuleMatch[]>();
  private readonly domainExceptions = new Map<string, DomainRuleMatch[]>();
  private readonly wildcardBlocks: Array<{
    match: DomainRuleMatch;
    test: (target: string) => boolean;
    denyAllowDomains?: string[];
  }> = [];
  private readonly wildcardExceptions: Array<{
    match: DomainRuleMatch;
    test: (target: string) => boolean;
  }> = [];
  private readonly badfilters = new Set<string>();
  private totalRuleCount = 0;

  constructor(rules: (StoredRule | string)[]) {
    this.compile(rules);
  }

  private addRuleToMap(map: Map<string, DomainRuleMatch[]>, key: string, match: DomainRuleMatch): void {
    const existing = map.get(key);
    if (existing) {
      existing.push(match);
    } else {
      map.set(key, [match]);
    }
  }

  private compile(rules: (StoredRule | string)[]): void {
    if (!Array.isArray(rules)) return;

    for (const item of rules) {
      if (!item) continue;
      const rawRule = typeof item === 'string' ? item.trim() : item.raw?.trim() || '';
      if (!rawRule || rawRule.startsWith('!') || rawRule.startsWith('#') || rawRule.startsWith('[')) {
        continue;
      }

      this.totalRuleCount++;
      const source = typeof item === 'string' ? undefined : item.metadata?.sourceInfo?.url || item.metadata?.sources?.[0];
      const ruleType = typeof item === 'string' ? undefined : item.type;
      const modifiers = ruleModifiers(rawRule);
      const isImportant = modifiers.includes('important');
      if (modifiers.includes('badfilter')) {
        this.badfilters.add(ruleIdentity(rawRule));
        continue;
      }
      // Request-scoped or response-changing rules are not unconditional DNS blocks.
      if (modifiers.some((part) => part !== 'important' && !part.startsWith('denyallow='))) {
        continue;
      }

      // 2. Parse $denyallow modifier
      let denyAllowDomains: string[] | undefined;
      const denyAllowMatch = rawRule.match(/[\$,]denyallow=([a-z0-9_.*|-]+)/i);
      if (denyAllowMatch) {
        denyAllowDomains = denyAllowMatch[1]
          .toLowerCase()
          .split('|')
          .map((d) => d.trim())
          .filter(Boolean);
      }

      const isEx =
        rawRule.startsWith('@@') ||
        (typeof item !== 'string' && (item.isException || item.type === 'unblocking'));

      // 3. Exception Rules
      if (isEx) {
        const abpExMatch = rawRule.match(/^@@\|\|([a-z0-9_.*-]+)\^/i);
        const pattern = abpExMatch
          ? abpExMatch[1].toLowerCase().trim()
          : extractDomainPattern(rawRule) || (typeof item !== 'string' ? item.domain : null);

        if (pattern) {
          const cleanPattern = pattern.toLowerCase().trim();
          if (cleanPattern.includes('*')) {
            const tester = createWildcardMatcher(cleanPattern);
            if (tester) {
              this.wildcardExceptions.push({
                match: {
                  rule: rawRule,
                  pattern: cleanPattern,
                  isWildcard: true,
                  isImportant,
                  source,
                  ruleType: ruleType || 'unblocking',
                },
                test: tester,
              });
            }
          } else {
            const match: DomainRuleMatch = {
              rule: rawRule,
              pattern: cleanPattern,
              isWildcard: rawRule.startsWith('@@||'),
              isImportant,
              source,
              ruleType: ruleType || 'unblocking',
            };
            if (rawRule.startsWith('@@||')) {
              this.addRuleToMap(this.domainExceptions, cleanPattern, match);
            } else {
              this.addRuleToMap(this.exactExceptions, cleanPattern, match);
            }
          }
        }
        continue;
      }

      // 4. Blocking Rules

      // 4a. Standard ABP wildcard: ||domain^
      const abpMatch = rawRule.match(/^\|\|([a-z0-9_.*-]+)\^/i);
      if (abpMatch) {
        const pattern = abpMatch[1].toLowerCase().trim();
        if (pattern.includes('*')) {
          const tester = createWildcardMatcher(pattern);
          if (tester) {
            this.wildcardBlocks.push({
              match: {
                rule: rawRule,
                pattern,
                isWildcard: true,
                isImportant,
                source,
                ruleType: ruleType || 'blocking',
              },
              test: tester,
              denyAllowDomains,
            });
          }
        } else {
          this.addRuleToMap(this.domainBlocks, pattern, {
            rule: rawRule,
            pattern,
            isWildcard: true,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
            denyAllowDomains,
          });
        }
        continue;
      }

      // 4b. Hosts entry: 0.0.0.0 / 127.0.0.1 / ::1 / :: (supports multiple space-separated domains per line)
      if (/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+/i.test(rawRule)) {
        const lineWithoutIp = rawRule.replace(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+/i, '').split('#')[0].trim();
        const hostEntries = lineWithoutIp.split(/\s+/).filter(Boolean);
        for (const entry of hostEntries) {
          const pattern = entry.toLowerCase().trim();
          if (pattern && !pattern.includes('*')) {
            this.addRuleToMap(this.exactBlocks, pattern, {
              rule: rawRule,
              pattern,
              isWildcard: false,
              isImportant,
              source,
              ruleType: ruleType || 'blocking',
              denyAllowDomains,
            });
          }
        }
        continue;
      }

      // 4c. DNSMasq: address=/domain/... or server=/domain/...
      if (rawRule.startsWith('address=/') || rawRule.startsWith('server=/')) {
        const parts = rawRule.split('/').filter(Boolean);
        // Domain candidates are intermediate segments between slashes
        const domainCandidates = parts.slice(1, parts.length > 2 && /^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::|#)$/.test(parts[parts.length - 1]) ? parts.length - 1 : undefined);
        for (const cand of domainCandidates) {
          const pattern = cand.toLowerCase().trim();
          if (pattern) {
            if (pattern.includes('*')) {
              const tester = createWildcardMatcher(pattern);
              if (tester) {
                this.wildcardBlocks.push({
                  match: {
                    rule: rawRule,
                    pattern,
                    isWildcard: true,
                    isImportant,
                    source,
                    ruleType: ruleType || 'blocking',
                  },
                  test: tester,
                  denyAllowDomains,
                });
              }
            } else {
              this.addRuleToMap(this.domainBlocks, pattern, {
                rule: rawRule,
                pattern,
                isWildcard: true,
                isImportant,
                source,
                ruleType: ruleType || 'blocking',
                denyAllowDomains,
              });
            }
          }
        }
        continue;
      }

      // 4d. Unbound: local-zone: "domain." action or local-data: "domain A 0.0.0.0"
      if (rawRule.startsWith('local-zone:') || rawRule.startsWith('local-data:')) {
        const quoteMatch = rawRule.match(/local-(?:zone|data):\s*"([a-z0-9_.*-]+)\.?"/i);
        if (quoteMatch) {
          const pattern = quoteMatch[1].toLowerCase().trim().replace(/\.+$/, '');
          if (pattern) {
            this.addRuleToMap(this.domainBlocks, pattern, {
              rule: rawRule,
              pattern,
              isWildcard: true,
              isImportant,
              source,
              ruleType: ruleType || 'blocking',
              denyAllowDomains,
            });
            continue;
          }
        }
      }

      // 4e. Slashed regular expression: /pattern/
      if (rawRule.startsWith('/') && rawRule.endsWith('/') && rawRule.length > 2) {
        const regexStr = rawRule.slice(1, -1);
        try {
          const rx = new RegExp(regexStr, 'i');
          this.wildcardBlocks.push({
            match: {
              rule: rawRule,
              pattern: regexStr,
              isWildcard: true,
              isImportant,
              source,
              ruleType: ruleType || 'blocking',
            },
            test: (target: string) => rx.test(target),
            denyAllowDomains,
          });
          continue;
        } catch {
          // Ignore invalid regex syntax
        }
      }

      // 4f. Pi-hole regex format: (^|\.)domain$
      if (rawRule.startsWith('(^|\\.)') || rawRule.startsWith('(?:^|\\.)')) {
        try {
          const rx = new RegExp(rawRule, 'i');
          this.wildcardBlocks.push({
            match: {
              rule: rawRule,
              pattern: rawRule,
              isWildcard: true,
              isImportant,
              source,
              ruleType: ruleType || 'blocking',
            },
            test: (target: string) => rx.test(target),
            denyAllowDomains,
          });
          continue;
        } catch {
          // Ignore
        }
      }

      // 4g. Direct wildcard: *.domain.com
      const wildcardMatch = rawRule.match(/^\*\.([a-z0-9_.-]+)/i);
      if (wildcardMatch) {
        const pattern = wildcardMatch[1].toLowerCase().trim();
        if (pattern && !isPublicSuffixOrTld(pattern)) {
          this.addRuleToMap(this.domainBlocks, pattern, {
            rule: rawRule,
            pattern,
            isWildcard: true,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
            denyAllowDomains,
          });
          continue;
        }
      }

      // 4h. RPZ format: domain.com CNAME . or *.domain.com CNAME .
      const rpzMatch = rawRule.match(/^(\*\.)?([a-z0-9_.-]+)\s+(?:CNAME\s+\.|A\s+0\.0\.0\.0|AAAA\s+::)/i);
      if (rpzMatch) {
        const pattern = rpzMatch[2].toLowerCase().trim();
        if (pattern) {
          this.addRuleToMap(this.domainBlocks, pattern, {
            rule: rawRule,
            pattern,
            isWildcard: true,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
            denyAllowDomains,
          });
          continue;
        }
      }

      // 4i. Fallback domain pattern
      const pattern = extractDomainPattern(rawRule) || (typeof item !== 'string' ? item.domain : null);
      if (pattern) {
        const cleanPattern = pattern.toLowerCase().trim();
        if (cleanPattern.includes('*')) {
          const tester = createWildcardMatcher(cleanPattern);
          if (tester) {
            this.wildcardBlocks.push({
              match: {
                rule: rawRule,
                pattern: cleanPattern,
                isWildcard: true,
                isImportant,
                source,
                ruleType: ruleType || 'blocking',
              },
              test: tester,
              denyAllowDomains,
            });
          }
        } else if (rawRule.startsWith('||')) {
          this.addRuleToMap(this.domainBlocks, cleanPattern, {
            rule: rawRule,
            pattern: cleanPattern,
            isWildcard: true,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
            denyAllowDomains,
          });
        } else {
          this.addRuleToMap(this.exactBlocks, cleanPattern, {
            rule: rawRule,
            pattern: cleanPattern,
            isWildcard: false,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
            denyAllowDomains,
          });
        }
      }
    }
  }

  /**
   * Evaluates a domain against all compiled rules with strict RFC/adblock precedence.
   */
  public evaluate(targetDomain: string): DomainEvaluationResult {
    const normalized = typeof targetDomain === 'string' ? normalizeHostname(targetDomain) : '';
    const cleanTarget = sanitizeDomain(normalized);
    if (!cleanTarget) {
      return {
        domain: targetDomain,
        verdict: 'not_blocked',
        matchingRules: [],
        overriddenRules: [],
        details: 'Invalid domain format.',
      };
    }

    let matchingExceptions: DomainRuleMatch[] = [];
    const matchingBlocks: DomainRuleMatch[] = [];
    const overriddenRules: string[] = [];

    // Helper to evaluate $denyallow on a block match
    const isDenyAllowed = (denyAllowDomains?: string[]): boolean => {
      if (!denyAllowDomains || denyAllowDomains.length === 0) return false;
      return denyAllowDomains.some((d) => cleanTarget === d || cleanTarget.endsWith('.' + d));
    };

    // 1. Exact match lookup
    const exactEx = this.exactExceptions.get(cleanTarget);
    if (exactEx) matchingExceptions.push(...exactEx);

    const exactBlk = this.exactBlocks.get(cleanTarget);
    if (exactBlk) {
      for (const m of exactBlk) {
        if (!isDenyAllowed(m.denyAllowDomains)) {
          matchingBlocks.push(m);
        }
      }
    }

    // 2. Domain & parent zone hierarchy lookup (O(L) depth)
    const parts = cleanTarget.split('.');
    for (let i = 0; i < parts.length; i++) {
      const zone = parts.slice(i).join('.');
      // Guard against public suffix matching: never match subdomains when zone is a bare TLD/public suffix
      if (i > 0 && isPublicSuffixOrTld(zone)) {
        continue;
      }

      const exMatches = this.domainExceptions.get(zone);
      if (exMatches) {
        for (const m of exMatches) {
          matchingExceptions.push({
            ...m,
            isWildcard: cleanTarget !== zone,
          });
        }
      }

      const blkMatches = this.domainBlocks.get(zone);
      if (blkMatches) {
        for (const m of blkMatches) {
          if (!isDenyAllowed(m.denyAllowDomains)) {
            matchingBlocks.push({
              ...m,
              isWildcard: cleanTarget !== zone,
            });
          }
        }
      }
    }

    // 3. Wildcard and Regex rules
    for (const w of this.wildcardExceptions) {
      if (w.test(cleanTarget)) {
        matchingExceptions.push(w.match);
      }
    }

    for (const w of this.wildcardBlocks) {
      if (!isDenyAllowed(w.denyAllowDomains) && w.test(cleanTarget)) {
        matchingBlocks.push(w.match);
      }
    }

    // 4. $badfilter neutralization
    const activeBlocks: DomainRuleMatch[] = [];
    for (const block of matchingBlocks) {
      const disabledBy = this.badfilters.has(ruleIdentity(block.rule));
      if (disabledBy) {
        overriddenRules.push(block.rule);
      } else {
        activeBlocks.push(block);
      }
    }

    matchingExceptions = matchingExceptions.filter((exception) => {
      if (!this.badfilters.has(ruleIdentity(exception.rule))) return true;
      overriddenRules.push(exception.rule);
      return false;
    });

    // 5. Precedence resolution
    const importantException = matchingExceptions.find((e) => e.isImportant);
    const importantBlock = activeBlocks.find((b) => b.isImportant);

    if (importantException) {
      return {
        domain: cleanTarget,
        verdict: 'exception',
        matchingRule: importantException.rule,
        matchingRules: matchingExceptions,
        exceptionRule: importantException.rule,
        overriddenRules: Array.from(new Set([...overriddenRules, ...activeBlocks.map((b) => b.rule)])),
        details: 'Domain is allowlisted by an $important exception rule (overrides all blocking rules).',
      };
    }

    if (importantBlock) {
      return {
        domain: cleanTarget,
        verdict: 'blocked',
        matchingRule: importantBlock.rule,
        matchingRules: activeBlocks,
        overriddenRules: Array.from(new Set([...overriddenRules, ...matchingExceptions.map((e) => e.rule)])),
        details: 'Domain is blocked by an $important blocking rule (overrides normal exception rules).',
      };
    }

    if (matchingExceptions.length > 0) {
      return {
        domain: cleanTarget,
        verdict: 'exception',
        matchingRule: matchingExceptions[0].rule,
        matchingRules: matchingExceptions,
        exceptionRule: matchingExceptions[0].rule,
        overriddenRules: Array.from(new Set([...overriddenRules, ...activeBlocks.map((b) => b.rule)])),
        details: 'Domain is explicitly allowlisted by an exception rule.',
      };
    }

    if (activeBlocks.length > 0) {
      return {
        domain: cleanTarget,
        verdict: 'blocked',
        matchingRule: activeBlocks[0].rule,
        matchingRules: activeBlocks,
        overriddenRules,
        details: `Domain matches ${activeBlocks.length} active blocking rule(s).${overriddenRules.length > 0 ? ` (${overriddenRules.length} rule(s) neutralized by $badfilter)` : ''}`,
      };
    }

    return {
      domain: cleanTarget,
      verdict: 'not_blocked',
      matchingRules: [],
      overriddenRules,
      details: overriddenRules.length > 0 ? 'All matching blocking rules were neutralized by $badfilter.' : 'No matching blocking rules found.',
    };
  }

  public isBlocked(targetDomain: string): boolean {
    return this.evaluate(targetDomain).verdict === 'blocked';
  }

  public findWinningRule(targetDomain: string): string | undefined {
    return this.evaluate(targetDomain).matchingRule;
  }

  public getRuleCount(): number {
    return this.totalRuleCount;
  }
}

/**
 * Creates and compiles a new CompiledDomainRuleSet from an array of rules.
 * @beta
 */
export function compileRuleSet(rules: (StoredRule | string)[]): CompiledDomainRuleSet {
  return new CompiledDomainRuleSet(rules);
}

/**
 * Cross-references a target domain against a set of filter rules (StoredRule objects or raw strings)
 * and determines the final blocking verdict with strict RFC/adblock precedence semantics:
 * 1. $badfilter deactivates matching rules across lists.
 * 2. $denyallow exonerates specified subdomains from block rules.
 * 3. $important exception overrides $important block and normal blocks.
 * 4. $important block overrides regular exceptions (without $important).
 * 5. Regular exception overrides regular blocks.
 * 6. Regular blocks apply if no winning exception exists.
 * @beta
 */
export function evaluateDomainRules(
  targetDomain: string,
  rules: (StoredRule | string)[],
): DomainEvaluationResult {
  return new CompiledDomainRuleSet(rules).evaluate(targetDomain);
}

/**
 * High-performance convenience helper returning whether a domain is blocked.
 * @beta
 */
export function isDomainBlocked(
  domain: string,
  rules: (StoredRule | string)[],
): boolean {
  return evaluateDomainRules(domain, rules).verdict === 'blocked';
}

/**
 * Returns the winning rule string that dictates the verdict for the target domain,
 * or undefined if the domain is not blocked and has no matching exception rule.
 * @beta
 */
export function findWinningRule(
  domain: string,
  rules: (StoredRule | string)[],
): string | undefined {
  return evaluateDomainRules(domain, rules).matchingRule;
}
