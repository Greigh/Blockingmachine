/**
 * Replaying captured requests through a compiled rule set.
 *
 * A coverage report measures rule hits against traffic that was matched *somewhere else* — in the
 * browser by the extension, or offline by replaying a captured trace. This is the offline half, and
 * it exists so there is exactly one of it: the CLI's report, the hot-set builder and the tests all
 * derive their numbers here rather than each keeping its own copy of the loop.
 *
 * The split matters as much as the counts. A winner that needs a path, a request type or the
 * requesting page cannot be validated from a hostname, so it is returned separately from the
 * hostname-decidable winners and marked with the scope it needs — that is what lets a caller state
 * a hit rate over the rules it can actually decide ({@link analyzeRuleCoverage}) and still count
 * what a replay could not.
 */

import { CompiledDomainRuleSet } from './ai/domainEvaluator.js';
import { blockingRuleScope, type BlockingRuleScope, type RuleHitCount } from './coverage.js';

/** One request to replay: a host, and how many times it was observed. */
export interface ReplayRequest {
  host: string;
  count: number;
}

/** A scope a blocking rule can need beyond the hostname. */
export type ContextScope = Exclude<BlockingRuleScope, 'hostname'>;

export interface RuleReplay {
  /** Winning blocking rules a hostname alone can decide, with the requests each decided. */
  hits: RuleHitCount[];
  /** Winning blocking rules that need more context, each tagged with the scope it needs. */
  scopedHits: Array<{ scope: ContextScope; rule: string; count: number }>;
  /** Winning exception rules, with the requests each allowlisted. */
  exceptions: RuleHitCount[];
  /** Requests a blocking rule decided, and how many distinct hosts that was. */
  blockedRequests: number;
  blockedHosts: number;
  /** Hosts a winning exception let through, with the requests they carried. */
  allowlistedHosts: number;
  /** Distinct hosts, and requests, whose winning rule needed more than a hostname. */
  scopedHosts: number;
  scopedRequests: number;
}

/**
 * Replays requests through a compiled rule set in one pass.
 *
 * Only a winning *block* counts as blocking: an allowlist that matched decided the request the
 * other way, so folding it in would credit the list for blocking it did not do.
 */
export function replayRuleHits(
  ruleSet: CompiledDomainRuleSet,
  requests: ReadonlyArray<ReplayRequest>,
): RuleReplay {
  const hosts = new Map<string, number>();
  const scoped = new Map<string, { scope: ContextScope; count: number }>();
  const contextHosts = new Set<string>();
  const exceptions = new Map<string, number>();

  let blockedRequests = 0;
  let blockedHosts = 0;
  let allowlistedHosts = 0;
  let scopedRequests = 0;

  for (const entry of requests) {
    const count = Number.isFinite(entry.count) ? Math.max(0, Math.floor(entry.count)) : 0;
    if (count <= 0) continue;

    const result = ruleSet.evaluate(entry.host);
    if (result.verdict === 'blocked') {
      const winner = result.matchingRule ?? result.matchingRules[0]?.rule;
      if (!winner) continue;
      blockedRequests += count;
      blockedHosts += 1;

      // A rule that needs a path, a request type or the requesting page cannot be validated from a
      // hostname — a replay has read it as a blanket block of the whole zone. It is kept out of the
      // hostname-decidable tally and reported as its own.
      const scope = blockingRuleScope(winner) ?? 'hostname';
      if (scope === 'hostname') {
        hosts.set(winner, (hosts.get(winner) ?? 0) + count);
      } else {
        const existing = scoped.get(winner);
        if (existing) existing.count += count;
        else scoped.set(winner, { scope, count });
        contextHosts.add(entry.host);
        scopedRequests += count;
      }
    } else if (result.verdict === 'exception' && result.exceptionRule) {
      exceptions.set(result.exceptionRule, (exceptions.get(result.exceptionRule) ?? 0) + count);
      allowlistedHosts += 1;
    }
  }

  return {
    hits: [...hosts.entries()].map(([rule, count]) => ({ rule, count })),
    scopedHits: [...scoped.entries()].map(([rule, entry]) => ({
      scope: entry.scope,
      rule,
      count: entry.count,
    })),
    exceptions: [...exceptions.entries()].map(([rule, count]) => ({ rule, count })),
    blockedRequests,
    blockedHosts,
    allowlistedHosts,
    scopedHosts: contextHosts.size,
    scopedRequests,
  };
}
