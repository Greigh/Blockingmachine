import type { StoredRule } from '../RuleStore.js';
import { cleanDomainPattern } from '../createMetadata.js';
import { sanitizeDomain } from './ruleSynthesizer.js';

export type DomainVerdict = 'blocked' | 'exception' | 'not_blocked';

export interface DomainRuleMatch {
  rule: string;
  pattern: string;
  isWildcard: boolean;
  isImportant: boolean;
  source?: string;
  ruleType?: string;
}

export interface DomainEvaluationResult {
  domain: string;
  verdict: DomainVerdict;
  matchingRule?: string;
  matchingRules: DomainRuleMatch[];
  exceptionRule?: string;
  overriddenRules: string[];
  details: string;
}

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

  for (const item of rules) {
    if (!item) continue;
    const rawRule = typeof item === 'string' ? item.trim() : item.raw?.trim() || '';
    if (!rawRule || rawRule.startsWith('!') || rawRule.startsWith('#')) {
      continue;
    }

    const source = typeof item === 'string' ? undefined : item.metadata?.sourceInfo?.url || item.metadata?.sources?.[0];
    const ruleType = typeof item === 'string' ? undefined : item.type;
    const isImportant = rawRule.includes('$important');

    const isEx =
      rawRule.startsWith('@@') ||
      (typeof item !== 'string' && (item.isException || item.type === 'unblocking'));

    if (isEx) {
      // Check exception pattern match
      const pattern = cleanDomainPattern(rawRule) || (typeof item !== 'string' ? item.domain : null);
      if (pattern) {
        const cleanPattern = pattern.toLowerCase();
        if (cleanTarget === cleanPattern || cleanTarget.endsWith('.' + cleanPattern)) {
          matchingExceptions.push({
            rule: rawRule,
            pattern: cleanPattern,
            isWildcard: cleanTarget.endsWith('.' + cleanPattern) && cleanTarget !== cleanPattern,
            isImportant,
            source,
            ruleType: ruleType || 'unblocking',
          });
        }
      }
    } else {
      // Check blocking pattern match
      // 1. Standard ABP wildcard: ||domain^
      const abpMatch = rawRule.match(/^\|\|([a-z0-9_.-]+)\^/i);
      if (abpMatch) {
        const pattern = abpMatch[1].toLowerCase().trim();
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

      // 2. Hosts entry: 0.0.0.0 domain or 127.0.0.1 domain
      const hostsMatch = rawRule.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+([a-z0-9_.-]+)/i);
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

      // 3. DNSMasq address=/domain/0.0.0.0
      const dnsmasqMatch = rawRule.match(/^address=\/([a-z0-9_.-]+)\//i);
      if (dnsmasqMatch) {
        const pattern = dnsmasqMatch[1].toLowerCase().trim();
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

      // 4. Fallback pattern from cleanDomainPattern
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

  // Precedence resolution
  const importantException = matchingExceptions.find((e) => e.isImportant);
  const importantBlock = matchingBlocks.find((b) => b.isImportant);

  if (importantException) {
    return {
      domain: cleanTarget,
      verdict: 'exception',
      matchingRule: importantException.rule,
      matchingRules: matchingExceptions,
      exceptionRule: importantException.rule,
      overriddenRules: matchingBlocks.map((b) => b.rule),
      details: 'Domain is allowlisted by an $important exception rule (overrides all blocking rules).',
    };
  }

  if (importantBlock) {
    return {
      domain: cleanTarget,
      verdict: 'blocked',
      matchingRule: importantBlock.rule,
      matchingRules: matchingBlocks,
      overriddenRules: matchingExceptions.map((e) => e.rule),
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
      overriddenRules: matchingBlocks.map((b) => b.rule),
      details: 'Domain is explicitly allowlisted by an exception rule.',
    };
  }

  if (matchingBlocks.length > 0) {
    return {
      domain: cleanTarget,
      verdict: 'blocked',
      matchingRule: matchingBlocks[0].rule,
      matchingRules: matchingBlocks,
      overriddenRules: [],
      details: `Domain matches ${matchingBlocks.length} active blocking rule(s).`,
    };
  }

  return {
    domain: cleanTarget,
    verdict: 'not_blocked',
    matchingRules: [],
    overriddenRules: [],
    details: 'No matching blocking rules found.',
  };
}
