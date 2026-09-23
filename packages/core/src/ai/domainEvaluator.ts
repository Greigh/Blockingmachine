import type { StoredRule } from '../RuleStore.js';
import { cleanDomainPattern } from '../createMetadata.js';
import { sanitizeDomain } from './ruleSynthesizer.js';
import type {
  DomainRuleMatch,
  DomainEvaluationResult,
} from './types.js';

/**
 * Cross-references a target domain against a set of filter rules (StoredRule objects or raw strings)
 * and determines the final blocking verdict with strict RFC/adblock precedence semantics:
 * 1. $important exception overrides $important block and normal blocks.
 * 2. $important block overrides regular exceptions (without $important).
 * 3. Regular exception overrides regular blocks.
 * 4. Regular blocks apply if no winning exception exists.
 */
export function evaluateDomainRules(
  targetDomain: string,
  rules: (StoredRule | string)[],
): DomainEvaluationResult {
  const cleanTarget = sanitizeDomain(targetDomain);
  if (!cleanTarget) {
    return {
      domain: targetDomain,
      verdict: 'not_blocked',
      matchingRules: [],
      overriddenRules: [],
      details: 'Invalid domain format.',
    };
  }

  const matchingExceptions: DomainRuleMatch[] = [];
  const matchingBlocks: DomainRuleMatch[] = [];
  const badfilterMatches: { rule: string; pattern: string }[] = [];
  const overriddenRules: string[] = [];

  for (const item of rules) {
    if (!item) continue;
    const rawRule = typeof item === 'string' ? item.trim() : item.raw?.trim() || '';
    if (!rawRule || rawRule.startsWith('!') || rawRule.startsWith('#')) {
      continue;
    }

    const source = typeof item === 'string' ? undefined : item.metadata?.sourceInfo?.url || item.metadata?.sources?.[0];
    const ruleType = typeof item === 'string' ? undefined : item.type;
    const isImportant = rawRule.includes('$important');
    const isBadfilter = rawRule.includes('$badfilter');

    // Helper to test if cleanTarget matches a domain pattern (including wildcards)
    const matchesTarget = (pattern: string): boolean => {
      const p = pattern.toLowerCase().trim();
      if (!p) return false;
      if (cleanTarget === p) return true;
      if (cleanTarget.endsWith('.' + p)) return true;
      if (p.startsWith('*.')) {
        const base = p.slice(2);
        return cleanTarget === base || cleanTarget.endsWith('.' + base);
      }
      if (p.includes('*')) {
        const regexStr = '^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
        return new RegExp(regexStr, 'i').test(cleanTarget);
      }
      return false;
    };

    // If rule has $badfilter, it acts to disable existing rules rather than block traffic
    if (isBadfilter) {
      const cleanPat = rawRule
        .replace(/^(?:@@\|\||@@|\|\|)/, '')
        .split('^')[0]
        .split('$')[0]
        .trim()
        .toLowerCase();
      if (cleanPat && matchesTarget(cleanPat)) {
        badfilterMatches.push({ rule: rawRule, pattern: cleanPat });
      }
      continue;
    }

    const isEx =
      rawRule.startsWith('@@') ||
      (typeof item !== 'string' && (item.isException || item.type === 'unblocking'));

    if (isEx) {
      // Check exception pattern match
      const abpExMatch = rawRule.match(/^@@\|\|([a-z0-9_.*-]+)\^/i);
      const pattern = abpExMatch
        ? abpExMatch[1].toLowerCase().trim()
        : cleanDomainPattern(rawRule) || (typeof item !== 'string' ? item.domain : null);
      if (pattern && matchesTarget(pattern)) {
        const cleanPattern = pattern.toLowerCase();
        matchingExceptions.push({
          rule: rawRule,
          pattern: cleanPattern,
          isWildcard: cleanTarget.endsWith('.' + cleanPattern) && cleanTarget !== cleanPattern,
          isImportant,
          source,
          ruleType: ruleType || 'unblocking',
        });
      }
    } else {
      // Check blocking pattern match
      // 1. Standard ABP wildcard: ||domain^ (supports * wildcards)
      const abpMatch = rawRule.match(/^\|\|([a-z0-9_.*-]+)\^/i);
      if (abpMatch) {
        const pattern = abpMatch[1].toLowerCase().trim();
        if (matchesTarget(pattern)) {
          matchingBlocks.push({
            rule: rawRule,
            pattern,
            isWildcard: true,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
          });
          continue;
        }
      }

      // 2. Hosts entry: 0.0.0.0 domain or 127.0.0.1 domain
      const hostsMatch = rawRule.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+([a-z0-9_.*-]+)/i);
      if (hostsMatch) {
        const pattern = hostsMatch[1].toLowerCase().trim();
        if (cleanTarget === pattern) {
          matchingBlocks.push({
            rule: rawRule,
            pattern,
            isWildcard: false,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
          });
          continue;
        }
      }

      // 3. DNSMasq: address=/domain/0.0.0.0
      const dnsmasqMatch = rawRule.match(/^address=\/([a-z0-9_.*-]+)\//i);
      if (dnsmasqMatch) {
        const pattern = dnsmasqMatch[1].toLowerCase().trim();
        if (matchesTarget(pattern)) {
          matchingBlocks.push({
            rule: rawRule,
            pattern,
            isWildcard: true,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
          });
          continue;
        }
      }

      // 4. Unbound: local-zone: "domain" always_nxdomain / static / refuse
      const unboundMatch = rawRule.match(/^local-zone:\s*"([a-z0-9_.*-]+)"/i);
      if (unboundMatch) {
        const pattern = unboundMatch[1].toLowerCase().trim();
        if (matchesTarget(pattern)) {
          matchingBlocks.push({
            rule: rawRule,
            pattern,
            isWildcard: true,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
          });
          continue;
        }
      }

      // 5. Pi-hole regex format: (^|\.)domain$
      const piholeMatch = rawRule.match(/^\(\^\|\\\.\)([a-z0-9_\\.-]+)\$$/i);
      if (piholeMatch) {
        const pattern = piholeMatch[1].replace(/\\/g, '').toLowerCase().trim();
        if (matchesTarget(pattern)) {
          matchingBlocks.push({
            rule: rawRule,
            pattern,
            isWildcard: true,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
          });
          continue;
        }
      }

      // 6. Direct wildcard: *.domain.com
      const wildcardMatch = rawRule.match(/^\*\.([a-z0-9_.-]+)/i);
      if (wildcardMatch) {
        const pattern = wildcardMatch[1].toLowerCase().trim();
        if (cleanTarget === pattern || cleanTarget.endsWith('.' + pattern)) {
          matchingBlocks.push({
            rule: rawRule,
            pattern,
            isWildcard: true,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
          });
          continue;
        }
      }

      // 7. Fallback pattern from cleanDomainPattern
      const pattern = cleanDomainPattern(rawRule) || (typeof item !== 'string' ? item.domain : null);
      if (pattern) {
        const cleanPattern = pattern.toLowerCase();
        if (cleanTarget === cleanPattern) {
          matchingBlocks.push({
            rule: rawRule,
            pattern: cleanPattern,
            isWildcard: false,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
          });
        } else if (rawRule.startsWith('||') && cleanTarget.endsWith('.' + cleanPattern)) {
          matchingBlocks.push({
            rule: rawRule,
            pattern: cleanPattern,
            isWildcard: true,
            isImportant,
            source,
            ruleType: ruleType || 'blocking',
          });
        }
      }
    }
  }

  // Filter out any blocking rules that were explicitly neutralized by a $badfilter rule
  const activeBlocks: DomainRuleMatch[] = [];
  for (const block of matchingBlocks) {
    const disabledBy = badfilterMatches.find(
      (bf) => bf.pattern === block.pattern || block.pattern.endsWith('.' + bf.pattern),
    );
    if (disabledBy) {
      overriddenRules.push(block.rule);
    } else {
      activeBlocks.push(block);
    }
  }

  // Precedence resolution
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
