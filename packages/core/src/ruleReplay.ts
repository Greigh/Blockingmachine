/**
 * Replaying captured requests through a compiled rule set.
 *
 * A coverage report measures rule hits against traffic that was matched *somewhere else* — in the
 * browser by the extension, or offline by replaying a captured trace. This is the offline half, and
 * it exists so there is exactly one of it: the CLI's report, the hot-set builder and the tests all
 * derive their numbers here rather than each keeping its own copy of the loop.
 *
 * The split matters as much as the counts, and there are three ways a winner can be reached.
 * A hostname alone decides a zone block, and those are the `hits` a hit rate is stated over. A
 * **full request URL** decides a path-scoped rule, by matching the path the request actually took
 * — those are `urlHits`, counted separately because a path rule is decided for a fraction of the
 * requests to its host and a hostname rule for all of them, so a rate that mixed them would divide
 * a rule count by decisions it never made. Everything else — a request type, the requesting page,
 * a response rewrite, or a path rule the trace had no URL for — stays undecidable and is returned
 * with the scope it needs, which is what lets a caller state a rate over the rules it can really
 * decide ({@link analyzeRuleCoverage}) and still account for what it could not.
 */

import { CompiledDomainRuleSet } from './ai/domainEvaluator.js';
import {
  blockingRuleScope,
  isUrlDecidableRule,
  requestUrlMatcher,
  type BlockingRuleScope,
  type RuleHitCount,
} from './coverage.js';

/**
 * One request to replay: where it went, and how many times it was observed.
 *
 * `url` is the whole point of the optional half. With it, a path-scoped rule can be *decided*
 * — matched against the path the request actually took — instead of being counted as a rule
 * the replay cannot evaluate. Without it the replay falls back to the hostname alone and
 * reports those rules the way it always has, so a hostname-only trace is still measured, just
 * less precisely.
 */
export interface ReplayRequest {
  host: string;
  /**
   * The full request URL, when the trace line carried one.
   *
   * Aggregating by host instead of by URL is what makes a path-scoped rule undecidable: a trace
   * of `https://cdn.example.com/x/ads.js` and `https://cdn.example.com/other.js` is two
   * requests that one rule blocks and another does not, and collapsing them to one host entry
   * destroys exactly the distinction the replay needs.
   */
  url?: string;
  count: number;
}

/**
 * Extracts a hostname from a full URL, an origin, or a bare hostname.
 *
 * Returns `null` for lines no honest parser should credit as a request — empty input, and
 * userinfo-bearing targets (`user@host`), where the part before the `@` is not a host at all.
 */
export function hostOf(target: string): string | null {
  let value = (target || '').trim().toLowerCase();
  if (!value) return null;

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.replace(/^\/\//, '');
  value = value.split('/')[0].split('?')[0].split('#')[0];
  value = value.replace(/:\d+$/, '');
  if (!value || value.includes('@')) return null;
  return value;
}

/**
 * Lower-cases a trace target and drops a trailing `#fragment`, which is never sent to a server
 * and would make two identical requests look like two different ones.
 */
function normalizeTraceUrl(target: string): string | null {
  const value = target.trim().toLowerCase().replace(/#.*$/, '');
  return value.includes('/') ? value : null;
}

/**
 * Parses a captured request trace into replayable requests.
 *
 * Each line is a hostname or a full URL, optionally followed by a repeat count, so both a raw
 * list of requests and an aggregated `host<TAB>count` export are accepted. Lines starting with
 * `#` or `!` are comments.
 *
 * A line that carries a path keeps it, and entries are aggregated per URL rather than per host.
 * That is what lets a path-scoped rule be decided against the request it actually describes
 * instead of being reported as a rule no replay can evaluate. A hostname-only trace still
 * parses; it just yields no URLs, and the replay falls back to the way it has always worked.
 *
 * This is the one trace parser: the coverage command, the hot-set builder, and the tests all
 * read the same input the same way, so a measurement cannot quietly mean a different set of
 * requests depending on who replayed it.
 */
export function parseRequestTrace(text: string): ReplayRequest[] {
  const totals = new Map<string, ReplayRequest>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;

    const parts = line.split(/\s+/);
    let count = 1;
    let target = line;
    if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
      count = Math.max(1, parseInt(parts[parts.length - 1], 10));
      target = parts.slice(0, -1).join('');
    }

    const host = hostOf(target);
    if (!host) continue;
    // Only a URL that survived `hostOf` intact, and that actually carries something after the
    // host, is worth keeping: a bare hostname has no path to decide anything with.
    const url = target.includes('/') ? normalizeTraceUrl(target) : undefined;
    if (url) {
      const existing = totals.get(url);
      if (existing) existing.count += count;
      else totals.set(url, { host, url, count });
    } else {
      const existing = totals.get(host);
      if (existing) existing.count += count;
      else totals.set(host, { host, count });
    }
  }

  return [...totals.values()];
}

/** A scope a blocking rule can need beyond the hostname. */
export type ContextScope = Exclude<BlockingRuleScope, 'hostname'>;

export interface RuleReplay {
  /** Winning blocking rules a hostname alone can decide, with the requests each decided. */
  hits: RuleHitCount[];
  /**
   * Winning blocking rules that were *decided* by matching a path-scoped rule against a
   * request URL.
   *
   * Separate from {@link hits} rather than folded into it, because the two are measured over
   * different denominators: a hostname rule is decided for every request on its host, a path
   * rule only for the requests whose path it matches, and a hit rate that mixed them would be
   * counting a number of rules against a number of decisions it never made.
   */
  urlHits: RuleHitCount[];
  /** Winning blocking rules a replay still cannot decide, each tagged with the scope it needs. */
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
  /** Requests settled by matching a path-scoped rule against a URL, and the rules that did it. */
  urlDecidedRequests: number;
  urlDecidedRules: number;
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
  const urlDecided = new Map<string, number>();
  const scoped = new Map<string, { scope: ContextScope; count: number }>();
  const contextHosts = new Set<string>();
  const exceptions = new Map<string, number>();

  // Every path-scoped rule the URL matcher can decide, compiled once rather than per request.
  // A rule the matcher declines is simply absent, and is then reported the way it always was.
  const decide = createReplayDecider(ruleSet);

  let blockedRequests = 0;
  let blockedHosts = 0;
  let allowlistedHosts = 0;
  let scopedRequests = 0;
  let urlDecidedRequests = 0;

  for (const entry of requests) {
    const count = Number.isFinite(entry.count) ? Math.max(0, Math.floor(entry.count)) : 0;
    if (count <= 0) continue;

    const decision = decide(entry);

    if (decision.verdict === 'exception' && decision.rule) {
      exceptions.set(decision.rule, (exceptions.get(decision.rule) ?? 0) + count);
      allowlistedHosts += 1;
      continue;
    }

    if (decision.verdict !== 'blocked' || !decision.rule) continue;
    const winner = decision.rule;

    blockedRequests += count;
    blockedHosts += 1;

    if (decision.decidedByUrl) {
      urlDecided.set(winner, (urlDecided.get(winner) ?? 0) + count);
      urlDecidedRequests += count;
      continue;
    }

    // A rule that needs a request type or the requesting page cannot be validated from a
    // hostname *or* a URL, so it keeps the scoped label. A path rule that the matcher declined
    // lands here too, which is exactly the honest outcome for a hostname-only trace.
    const scope = (decision.scope === 'hostname' ? 'hostname' : decision.scope) as ContextScope | 'hostname';
    if (scope === 'hostname') {
      hosts.set(winner, (hosts.get(winner) ?? 0) + count);
    } else {
      const existing = scoped.get(winner);
      if (existing) existing.count += count;
      else scoped.set(winner, { scope, count });
      contextHosts.add(entry.host);
      scopedRequests += count;
    }
  }

  return {
    hits: [...hosts.entries()].map(([rule, count]) => ({ rule, count })),
    urlHits: [...urlDecided.entries()].map(([rule, count]) => ({ rule, count })),
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
    urlDecidedRequests,
    urlDecidedRules: urlDecided.size,
  };
}

/**
 * What a compiled list decided for one request.
 *
 * `allowed` and `exception` are kept apart on purpose even though both mean "not blocked".
 * An exception is a *rule* that fired and said let this through, which is the decision a trimmed
 * list is most likely to lose: a hot set that keeps the blocks but drops an allowlist does not
 * under-protect, it starts blocking requests the full export deliberately released. Collapsing the
 * two would make that invisible to any comparison built on this type.
 */
export type ReplayVerdict = 'blocked' | 'allowed' | 'exception';

export interface ReplayDecision {
  verdict: ReplayVerdict;
  /** The rule that decided it: the winning block, or the exception that let it through. */
  rule: string | null;
  /** The scope the deciding rule needed beyond the hostname, or `null` when none did. */
  scope: BlockingRuleScope | null;
  /** True when a matched request URL, not the hostname, settled it. */
  decidedByUrl: boolean;
}

/**
 * Decides a single request against a compiled list.
 *
 * Exported because the precedence here — a path rule outranks a bare zone block, and an
 * exception outranks both — is the whole content of "what this list would do to that request",
 * and anything comparing two lists needs it exactly. Keeping one implementation is what stops a
 * comparison from quietly re-deriving the precedence and agreeing with itself: a test that
 * reimplemented these three lines could keep passing after the rule below them changed.
 *
 * The path rules are compiled per call, so prefer {@link createReplayDecider} when deciding many
 * requests against the same set.
 */
export function decideRequest(
  ruleSet: CompiledDomainRuleSet,
  request: Pick<ReplayRequest, 'host' | 'url'>,
): ReplayDecision {
  return createReplayDecider(ruleSet)(request);
}

/** {@link decideRequest} with the path rules compiled once, for many requests. */
export function createReplayDecider(
  ruleSet: CompiledDomainRuleSet,
): (request: Pick<ReplayRequest, 'host' | 'url'>) => ReplayDecision {
  const pathRules = urlDecidableRules(ruleSet);

  return (request) => {
    const result = ruleSet.evaluate(request.host);

    // A path-scoped rule that matches this request's URL beats a bare zone block of the same
    // host: it is strictly the narrower statement, and reading the zone block as its winner
    // would credit the list with blocking every request to that host when it blocks one path.
    //
    // It never overrides an allowlist. A hostname exception has already won above, and a
    // path-carrying exception matching this URL is the same deliberate decision at the
    // narrower scope — it lets this request through while the rest of the zone stays decided
    // by the real rules. An $important block still outranks a regular path exception, and an
    // $important path exception outranks it back, the precedence evaluate() documents.
    const pathWinner = request.url === undefined ? undefined : matchPathRule(pathRules, request.url);

    if (result.verdict === 'exception' && result.exceptionRule) {
      return {
        verdict: 'exception',
        rule: result.exceptionRule,
        scope: null,
        decidedByUrl: false,
      };
    }

    const pathException = request.url === undefined ? undefined : ruleSet.matchPathException(request.url);
    if (pathException) {
      const importantBlockWon =
        result.verdict === 'blocked' &&
        result.matchingRules.some((m) => m.rule === result.matchingRule && m.isImportant);
      if (pathException.isImportant || !importantBlockWon) {
        return { verdict: 'exception', rule: pathException.rule, scope: 'path', decidedByUrl: true };
      }
    }

    const winner =
      pathWinner ??
      (result.verdict === 'blocked' ? result.matchingRule ?? result.matchingRules[0]?.rule : undefined);

    if (!winner) {
      return { verdict: 'allowed', rule: null, scope: null, decidedByUrl: false };
    }

    return {
      verdict: 'blocked',
      rule: winner,
      scope: blockingRuleScope(winner) ?? 'hostname',
      decidedByUrl: pathWinner !== undefined,
    };
  };
}

/** A compiled path-scoped rule the URL matcher is willing to decide. */
interface PathRule {
  rule: string;
  test: (url: string) => boolean;
}

/**
 * Every path-scoped rule in the compiled list, in list order, paired with a URL matcher.
 *
 * `getIndexedBlockingRuleCount` is deliberately not used to enumerate them: it counts what the
 * domain evaluator indexed, which is the hostname-decidable set by construction, so it cannot
 * name the rules this needs. Reading them back off the source list is the only place both are
 * visible at once.
 */
function urlDecidableRules(ruleSet: CompiledDomainRuleSet): PathRule[] {
  const rules = ruleSet.getSourceRules();
  const compiled: PathRule[] = [];
  for (const rule of rules) {
    if (typeof rule !== 'string' || !isUrlDecidableRule(rule)) continue;
    const test = requestUrlMatcher(rule);
    if (test) compiled.push({ rule: rule.trim(), test });
  }
  return compiled;
}

/** The first path rule matching this URL, in list order. */
function matchPathRule(rules: readonly PathRule[], url: string): string | undefined {
  for (const entry of rules) {
    if (entry.test(url)) return entry.rule;
  }
  return undefined;
}
