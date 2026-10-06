/**
 * Blocklist coverage analysis.
 *
 * A compiled list is judged by its size, but size is not the property that matters. What
 * matters is how many of its rules ever *fire* on real traffic, and how much of the blocking
 * a small head of the list is responsible for. A list where 0.5% of rules account for 99% of
 * blocks is not a 250,000-rule list; it is a 1,000-rule list with 249,000 lines of insurance.
 *
 * This module answers three questions from one trace of real request matches:
 *
 *   1. What fraction of the list actually matched? (`listHitRatePercent`)
 *   2. How concentrated is the blocking? (`curve`, `minimumRules`)
 *   3. How small could the list be and still block 99% of what it blocks today?
 *      (`minimumRules` at share 0.99)
 *
 * The trace is matched elsewhere — in the browser by the extension, and offline by replaying
 * captured requests through the domain evaluator — so this file is pure arithmetic and can be
 * asserted directly.
 *
 * Coverage also has to be measured against the rules the available trace can decide, and "can
 * decide" is not the same as "is in the list". The browser export carries three kinds of blocking
 * rule a *hostname* cannot settle: initiator-scoped (`$domain=`), request-scoped (`$script`,
 * `$replace=`) and path-preserving (a host anchor with a path suffix). Read from a hostname a
 * path-scoped rule is indistinguishable from a blanket block of its zone, so a hostname replay
 * either credits it with the whole zone or writes it off as undecidable — both wrong, and the
 * second one in the flattering direction, because a rule nobody can credit is a rule nobody can
 * blame for being dead weight.
 *
 * A **full request URL** settles the path, so {@link requestUrlMatcher} decides that bucket and
 * {@link isUrlDecidableRule} says which rules it will take. On the shipped list that is 6,230 of
 * 7,628 path-scoped rules — the share {@link pathRuleDecidability} computes, gated at 80% by
 * `check:path-decidability`. The rest are refused, because a URL genuinely does not contain the
 * answer: mostly path rules that also name a request type (`$script`, `$image`…), `$replace=` /
 * `$redirect=` response rewrites, and a residue of shapes no host anchor survives. A matcher that
 * guessed at them would put the over-count straight back.
 * What no URL settles is initiator- and request-scoped: whether a request was third-party is a
 * fact about the page that made it. Those keep their bucket, {@link blockingRuleScope} splits a
 * list into all four, and {@link countRuleScopes} counts them, so the headline rate stays stated
 * over the hostname-decidable set alone — where it is exact.
 */

import { refusedRegexReason } from './regexSafety.js';
import { stripTrailingChars } from './utils/textScan.js';

export interface RuleHitCount {
  /** The rule that matched, as it appears in the compiled list. */
  rule: string;
  /** How many requests it matched. */
  count: number;
}

export interface RuleSharePoint {
  /** Fraction of all matched requests this head of the list covers, 0–1. */
  share: number;
  /** Rules needed to reach that share. */
  rules: number;
  /** Those rules as a percentage of the whole list. */
  rulesPercent: number;
}

export interface HotRule {
  rule: string;
  count: number;
  /** Share of all matched requests, 0–1. */
  share: number;
  /** Running share up to and including this rule, 0–1. */
  cumulativeShare: number;
}

export interface CoverageReport {
  /** Network rules that can match a request (cosmetic/style rules excluded). */
  totalRules: number;
  /** Requests that some rule matched. */
  blockedRequests: number;
  /** Distinct rules that matched at least once. */
  matchedRules: number;
  /** Rules that never matched in this trace. */
  neverMatchedRules: number;
  /** `matchedRules / totalRules`, as a percentage. */
  listHitRatePercent: number;
  /** `neverMatchedRules / totalRules`, as a percentage. */
  deadWeightPercent: number;
  /** Coverage reachable by progressively larger heads of the list. */
  curve: RuleSharePoint[];
  /** The rules responsible for the most blocking. */
  topRules: HotRule[];
  /** Smallest head that reaches each share of the blocking. */
  minimumRules: RuleSharePoint[];
}

/** Shares the report reports on, in ascending order. */
export const COVERAGE_SHARES = [0.5, 0.75, 0.9, 0.95, 0.99, 1] as const;

/**
 * Rules that never take part in request matching.
 *
 * Cosmetic and scriptlet rules are enforced by content scripts against the DOM, not against a
 * request, so counting them in the denominator would understate the network list's hit rate by
 * roughly half on a real compiled list. The test is deliberately at least as strict as the filter
 * the extension's DNR pipeline applies when it decides a line is not a network rule: a line
 * rejected here can never be a request rule, and on a real export the extra strictness is worth
 * several thousand DOM-injection lines that would otherwise be counted as network rules.
 */
export function isNetworkRule(line: string): boolean {
  const rule = line.trim();
  if (!rule) return false;
  if (rule.startsWith('!') || rule.startsWith('[')) return false;
  // `#` starts a comment, except inside the cosmetic separators `##`, `#@#`, `#?#`, `#%#`.
  if (rule.startsWith('#') && !/^#(?:#|@#|\?#|%#|\$#)/.test(rule)) return false;
  if (rule.includes('##') || rule.includes('#@#') || rule.includes('#?#')) return false;
  if (rule.includes('#%#')) return false;
  // AdGuard CSS injection (`#$#`) and its exception (`#@$#`), plus the `$@$` redirect form: all
  // three are applied by a content script against the DOM, never against a request.
  if (rule.includes('#$#') || rule.includes('#@$#')) return false;
  if (rule.includes('$@$')) return false;
  if (rule.includes('$$') || rule.includes('+js(')) return false;
  // DNS-only directives never reach a browser request matcher.
  if (rule.includes('$dnsrewrite') || rule.includes('$dnstype') || rule.includes('$client')) {
    return false;
  }
  return true;
}

/**
 * A rule split into the two halves that decide everything about it: what it matches, and the
 * `$`-modifiers that qualify the match.
 */
interface RuleParts {
  /** The pattern, with `@@` and `||` stripped. */
  body: string;
  /** Lower-cased `$`-modifiers, or an empty array when the rule carries none. */
  modifiers: string[];
  /** A slashed regex, which is matched against the whole URL. */
  isRegex: boolean;
}

function ruleParts(rule: string): RuleParts {
  const trimmed = (rule || '').trim();
  // A trailing `$` in a regex is an anchor, not a modifier separator.
  const isRegex = trimmed.startsWith('/') && trimmed.endsWith('/') && trimmed.length > 2;
  const separator = isRegex ? -1 : trimmed.lastIndexOf('$');
  const hasModifiers = separator > 0;
  return {
    body: (hasModifiers ? trimmed.slice(0, separator) : trimmed)
      .replace(/^@@/, '')
      .replace(/^\|{1,2}/, ''),
    modifiers: hasModifiers
      ? trimmed.slice(separator + 1).toLowerCase().split(',').map((part) => part.trim()).filter(Boolean)
      : [],
    isRegex,
  };
}

/**
 * Whether a rule's match depends on more than a hostname.
 *
 * A hostname-only replay cannot see the request path, the request type, or the initiator. A rule
 * that anchors a host and then constrains the path, or that carries a request modifier such as
 * `$third-party`, is therefore read as a blanket block of the whole zone. Such a rule can still be
 * the *stated* winner while a real browser would have let the request through, so coverage measured
 * this way is an upper bound. Counting how many of the rules that fired are of this kind is what
 * keeps the headline number honest.
 *
 * This is the blunt two-way test, and it is now the *stricter* of the two: it counts anything
 * that needs more than a hostname, including the path rules a URL replay can decide. For the
 * narrower question — what still cannot be decided once the trace carries URLs — use
 * {@link isUrlDecidableRule}, which excludes what it will take. {@link blockingRuleScope} is the
 * same judgement split into the buckets the browser actually expresses, and is what a coverage
 * report should count.
 */
export function isContextScopedRule(rule: string): boolean {
  const trimmed = (rule || '').trim();
  if (!trimmed) return false;
  const { body, modifiers, isRegex } = ruleParts(trimmed);
  // A slashed regex is matched against the whole URL.
  if (isRegex) return true;
  // `$important` only changes precedence; everything else needs request context.
  if (modifiers.some((part) => part !== 'important' && !part.startsWith('denyallow='))) return true;
  return body.includes('/');
}

/**
 * How much of a request the browser needs before it can apply a blocking rule.
 *
 * These are the buckets the DNR compiler actually emits, in the order they are tested: a rule that
 * names its own sites compiles to `initiatorDomains`, one that keeps a path compiles to a URL
 * pattern with a path, one that needs the request type compiles to `resourceTypes`, and only the
 * remainder is a blanket block of a zone.
 */
export type BlockingRuleScope = 'hostname' | 'initiator' | 'path' | 'request';

/** Host and path of one request, as a replay sees it. */
export interface RequestTarget {
  /** Hostname, lower-cased, port stripped. */
  host: string;
  /**
   * The request URL as captured, when the trace carried one.
   *
   * A path-scoped rule can only be *decided* with this. Without it the rule is reported as
   * needing context rather than matched by accident.
   */
  url?: string;
}

/**
 * Whether a blocking rule can be decided from a request's host and URL alone.
 *
 * Narrower than {@link blockingRuleScope}, and it is the distinction that matters for a replay.
 * `blockingRuleScope('||cdn.example.com^<star>/ads.js')` is `path`, and
 * `blockingRuleScope('||cdn.example.com^$third-party')` is `initiator` — but a full URL settles
 * the first and settles nothing about the second, because whether a request was third-party is a
 * fact about the page that made it and the capture does not carry one. Decidable-from-a-URL is
 * therefore the `path` bucket and nothing else, and a rule outside it keeps its honest "a replay
 * cannot decide this" label instead of being read as a zone block.
 */
export function isUrlDecidableRule(rule: string): boolean {
  const trimmed = (rule || '').trim();
  if (!isNetworkRule(trimmed)) return false;
  if (trimmed.startsWith('@@')) return false;
  if (blockingRuleScope(trimmed) !== 'path') return false;
  return requestUrlMatcher(trimmed) !== null;
}

/**
 * The ABP separator: one of `/`, `?`, `#`, or the end of the URL.
 *
 * Wrapped in a non-capturing group because it is spliced into a larger pattern, where a bare
 * top-level alternation would bind to the whole rule instead of to the one character.
 *
 * It is deliberately strict. `||cdn.example.com^<star>/ads.js` matches `cdn.example.com/ads.js`?
 * No: the separator consumes the `/`, the wildcard matches nothing, and the rule's own
 * `/ads.js` then has no leading slash left to match. It matches `cdn.example.com/x/ads.js`.
 * That is what Chrome's `urlFilter` does with the same string — this compiler hands
 * path-preserving rules to Chrome verbatim — so being lenient here would count a block the
 * browser never performs, which is the error the scoped bucket exists to prevent.
 */
// Chrome's urlFilter documents `^` as "anything except a letter, a digit, or `_ , - . %` — or
// the end of the URL": a negated character class, not the small `[/?#]` set the name suggests.
// `=`, `+`, `@`, `~`, `;`, `:` are separators too, so a path rule can be decided by a request
// that carries them — crediting the rule where the browser would credit it is the matcher's
// entire purpose.
const SEPARATOR = String.raw`(?:[^A-Za-z0-9_,\-.%]|$)`;

/**
 * Compiles a blocking rule into a test against a full request URL, or `null` when the rule
 * cannot be decided from one.
 *
 * Returns `null` rather than guessing for every form it does not implement, and that is the
 * point: a matcher that silently treated an unknown pattern as "matches" would re-introduce
 * exactly the error this function exists to remove, one level down. A rule it cannot decide
 * keeps the scoped label the report already gives it.
 *
 * The forms it does decide:
 *
 *  - `||host^/path`, `||host/path` — host anchor plus a path, the overwhelmingly common shape.
 *    `^` is the ABP separator and matches a slash, a query, a fragment, or the end of the URL.
 *  - `|http://host/path|` — a URL-prefix anchor.
 *  - `/pattern` — matched anywhere in the URL, with `*` as a wildcard.
 *  - `/regex/` — matched against the whole URL, capped at {@link MAX_URL_PATTERN_LENGTH} to keep
 *    a hostile list from stalling a replay.
 *
 * Only the *host* half is matched exactly — a subdomain counts, because `||example.com^` covers
 * it in a real browser.
 */
const MAX_URL_PATTERN_LENGTH = 2000;

export function requestUrlMatcher(rule: string): ((url: string) => boolean) | null {
  // Repeated from `isUrlDecidableRule` on purpose: this is the exported primitive, so anyone
  // calling it directly must get the same refusal the wrapper gives rather than a matcher for a
  // rule they were told is not a blocking rule.
  const trimmed = (rule || '').trim();
  if (!isNetworkRule(trimmed) || trimmed.startsWith('@@')) return null;

  const { body, modifiers, isRegex } = ruleParts(trimmed);
  // Any modifier beyond `important` is about the request or the page, which a URL does not
  // settle — `$third-party` most of all, which is exactly the misleading case.
  if (modifiers.some((modifier) => modifier !== 'important' && !modifier.startsWith('denyallow='))) return null;

  // A slashed regex applies to the whole URL. Bounded in length *and* in structure — a rule
  // like `/(a+)+/` compiles cleanly and then spends unbounded backtracking time on every URL
  // it sees, so the shapes that provably do that are refused rather than compiled.
  if (isRegex) {
    const pattern = trimmed.slice(1, -1);
    if (pattern.length > MAX_URL_PATTERN_LENGTH) return null;
    if (refusedRegexReason(pattern) !== null) return null;
    try {
      const expression = new RegExp(pattern, 'i');
      return (url) => expression.test(url);
    } catch {
      return null;
    }
  }

  // A body already carrying a scheme is a URL pattern rather than a host-and-path split.
  const scheme = body.match(/^https?:\/\//i);
  const rest = scheme ? body.slice(scheme[0].length) : body;
  // `||` anchoring: the host is an anchor, and the pattern after it applies to the whole URL.
  const hostAnchored = trimmed.startsWith('||');
  // `|` anchoring: match the whole URL from its start.
  const urlAnchored = !hostAnchored && trimmed.startsWith('|');

  if (hostAnchored || scheme) {
    // Everything up to the first separator character is the host. Splitting here rather than
    // with one greedy pattern is deliberate: a single regex swallows the `^` as part of the
    // path group, and then the separator never reaches the compiled pattern at all — the rule
    // silently degrades into "any path on this host", which is the exact over-count this
    // function exists to remove.
    const boundary = rest.search(/[\^/]/);
    if (boundary <= 0) return null;
    const hostPart = rest.slice(0, boundary);
    const tail = rest.slice(boundary);
    const hostPattern = compileHostPattern(hostPart);
    if (!hostPattern) return null;

    // Nothing but a separator and a terminator after the host is a whole-zone rule, not a
    // path rule: the caller has already established the scope, so this is only a guard.
    // The strips walk the string once — a `^`-lead then a `|`-run at the end — so a hostile
    // tail of separator repeats cannot make the scan quadratic.
    if (stripTrailingChars(tail.startsWith('^') ? tail.slice(1) : tail, '|').length === 0) {
      return null;
    }

    // The tail is what the path must look like, `^` included so the separator stays in the
    // pattern; a trailing `|` is syntax, not something to match.
    const pathPattern = stripTrailingChars(tail, '|');
    if (pathPattern.length > MAX_URL_PATTERN_LENGTH) return null;
    const path = new RegExp(compileGlobToRegex(pathPattern, SEPARATOR), 'i');
    return (url) => {
      const parsed = splitRequestUrl(url);
      if (!parsed || !hostPattern(parsed.host)) return false;
      return path.test(parsed.afterHost);
    };
  }

  if (urlAnchored) {
    const prefix = stripTrailingChars(rest, '|');
    if (!prefix) return null;
    return (url) => url.toLowerCase().startsWith(prefix.toLowerCase());
  }

  // A bare pattern is matched anywhere in the URL.
  if (!body) return null;
  if (body.length > MAX_URL_PATTERN_LENGTH) return null;
  const anywhere = new RegExp(compileGlobToRegex(body, ''), 'i');
  return (url) => anywhere.test(url);
}

/**
 * The exception half of {@link requestUrlMatcher}: a matcher for `@@` rules whose pattern
 * carries a path — `@@||host/path`, `@@||host^` + a path tail, `@@|http://host/x`, `@@/re/`.
 *
 * The split is deliberate. A zone exception (`@@||host^`) is decided by the hostname indexes
 * and never reaches here; a path-carrying one cannot live in those indexes, because indexing
 * it under the host alone would release every request to the host — the unsafe direction to
 * widen an allowlist. So it is compiled against the full URL instead, exactly the way a path
 * block is, and applied only to the requests that match.
 *
 * Returns `null` for anything that is not an exception describing a URL shape: a bare `@@word`
 * stays an exact-host exception rather than being *widened* into a URL-substring allowlist,
 * and `@@||host^` keeps its zone meaning instead of paying for a matcher it does not need.
 */
export function exceptionRequestUrlMatcher(rule: string): ((url: string) => boolean) | null {
  const trimmed = (rule || '').trim();
  if (!isNetworkRule(trimmed) || !trimmed.startsWith('@@')) return null;

  const { body: pattern } = ruleParts(trimmed);
  const carriesSlash = pattern.includes('/');
  // A `^` with anything after it — `^*/x`, `^*.js`, `^|…` excluded — is a path constraint too.
  // `indexOf` finds the leftmost `^` just as the regex's leftmost match did.
  const caret = pattern.indexOf('^');
  const caretTail = stripTrailingChars(caret < 0 ? '' : pattern.slice(caret + 1), '|');
  if (!carriesSlash && caretTail.length === 0) return null;

  // `@@` stripped: the matcher sees the same `||host/path` shape a blocking rule carries.
  return requestUrlMatcher(trimmed.slice(2));
}

/**
 * Host portion of a `||host^path` rule, as a predicate.
 *
 * `||example.com^` covers subdomains in a real browser, hence the `(?:.*\.)?` prefix. A `*`
 * inside the host matches within one label only (`[^.]*`), so no wildcard in a list can carry
 * a match across a dot and off into a different registrable domain.
 */
function compileHostPattern(hostPart: string): ((host: string) => boolean) | null {
  const host = hostPart.toLowerCase();
  if (!host) return null;
  const inner = host.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*');
  try {
    const compiled = new RegExp(`^(?:.*\\.)?${inner}$`, 'i');
    return (candidate) => compiled.test(candidate);
  } catch {
    return null;
  }
}

/**
 * Host and the remainder of a URL, so a host-and-path rule can test each half against the right
 * one. Returns `null` for anything that is not an absolute URL.
 */
function splitRequestUrl(url: string): { host: string; afterHost: string } | null {
  const trimmed = (url || '').trim();
  const match = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([\s\S]*)$/i);
  if (!match) return null;
  const authority = match[1].split('@').pop() ?? '';
  const host = authority.replace(/:\d+$/, '').toLowerCase();
  if (!host) return null;
  return { host, afterHost: match[2] };
}

/**
 * ABP pattern text to a regular-expression source.
 *
 * `*` is the only wildcard ABP defines. `separator` is inserted where a `^` sits, and it is
 * **consumed**, which is the part that looks like a bug and is not.
 *
 * These rules are not interpreted as ABP — they are handed to Chrome as a DNR `urlFilter`
 * verbatim (`validatePathFilter` accepts `||host/path` and passes it through), so the replay has to
 * model Chrome's urlFilter syntax rather than the ABP syntax the rule was written in. Chrome
 * documents `^` as "a separator character… this also matches the end of the URL", which is a
 * character that gets matched, not a zero-width assertion. So in `||host^ads.js` the `^` stands
 * for the slash itself and `ads.js` continues after it, and a wildcard-then-slash tail needs one
 * more path segment before its own slash — the browser really does decline to block `/ads.js` for
 * a rule written that way. Being lenient here would credit the replay with a block the browser
 * never performs, which is the over-count the matcher exists to remove.
 *
 * The character *class* follows Chrome's documented set: any character that is not a letter,
 * digit, `_`, `,`, `-`, `.` or `%` — {@link SEPARATOR} — so `=`, `+`, `@`, `~`, `;` and `:` end a
 * host or separate a path segment exactly as the browser reads them.
 */
function compileGlobToRegex(pattern: string, separator: string): string {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      out += '.*';
    } else if (char === '^') {
      out += separator || SEPARATOR;
    } else {
      out += char.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

/** Modifiers that make a verdict depend on the page that made the request. */
const INITIATOR_MODIFIERS = new Set(['domain', 'from', 'to', 'third-party', 'first-party']);

/**
 * Classifies one compiled line by how much of a request the browser needs to decide it.
 *
 * Returns `null` for anything that is not a blocking network rule — a comment, a cosmetic or
 * scriptlet line, a DNS-only directive, an exception, or a `$badfilter` marker — so the caller can
 * count a list without pre-filtering it.
 *
 * A line can qualify on several axes at once (`/pop.js$domain=x` is both hostless and
 * initiator-scoped); the buckets are exclusive, and the precedence is `initiator`, then `path`,
 * then `request`. The initiator wins because the site the rule is scoped to decides whether it
 * applies at all, before any question about the URL is reached.
 */
export function blockingRuleScope(rule: string): BlockingRuleScope | null {
  const trimmed = (rule || '').trim();
  if (!isNetworkRule(trimmed)) return null;
  if (trimmed.startsWith('@@')) return null;
  const { body, modifiers, isRegex } = ruleParts(trimmed);
  if (modifiers.includes('badfilter')) return null;

  // The name of each modifier, with any `~` negation and `=value` removed.
  const names = modifiers
    .map((part) => part.replace(/^~/, '').split('=')[0].trim())
    .filter((name) => name && name !== 'important' && name !== 'denyallow');

  if (names.some((name) => INITIATOR_MODIFIERS.has(name))) return 'initiator';
  // A scheme is stripped first: `https://host` is a host rule, `https://host/a` is not.
  const path = stripTrailingChars(body.replace(/^https?:\/\//i, ''), '^|');
  if (isRegex || names.includes('path') || path.includes('/')) return 'path';
  if (names.length > 0) return 'request';
  return 'hostname';
}

/** How many blocking rules a list carries in each scope. */
export interface RuleScopeCounts {
  /** Verdict follows from the requested host alone, and a replay can measure it exactly. */
  hostname: number;
  /** Verdict needs the page that made the request (`$domain=`, `$from=`, `$third-party`). */
  initiator: number;
  /** Verdict needs the request URL's path or a regex match against the whole URL. */
  path: number;
  /** Verdict needs the request type, or rewrites the response (`$script`, `$popup`, `$replace=`). */
  request: number;
  /** Every blocking rule: the four buckets together, exceptions and cosmetics excluded. */
  total: number;
}

/** Counts the blocking rules a compiled list carries, by the scope each one needs. */
export function countRuleScopes(lines: readonly string[]): RuleScopeCounts {
  const counts: RuleScopeCounts = { hostname: 0, initiator: 0, path: 0, request: 0, total: 0 };
  for (const line of lines) {
    const scope = blockingRuleScope(line);
    if (!scope) continue;
    counts[scope] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * How much of a list's path-scoped blocking a captured URL can actually decide.
 *
 * The path bucket is only *potentially* decidable: `||host/path$script` also names a request
 * type, which no URL carries, and a mangled host anchor refuses outright. {@link share} is the
 * number a gate wants — the residue is measured, not assumed, so a list update that floods the
 * bucket with undecidable shapes shows up here rather than in a coverage run nobody read.
 */
export interface PathRuleDecidability {
  /** Blocking rules whose verdict needs the request path or a whole-URL pattern. */
  pathScoped: number;
  /** Of those, the ones {@link isUrlDecidableRule} will decide given a request URL. */
  urlDecidable: number;
  /** `urlDecidable / pathScoped`; 0 when the list carries no path-scoped rules at all. */
  share: number;
}

/** Measures {@link PathRuleDecidability} over a compiled list's lines. */
export function pathRuleDecidability(lines: readonly string[]): PathRuleDecidability {
  let pathScoped = 0;
  let urlDecidable = 0;
  for (const line of lines) {
    if (blockingRuleScope(line) !== 'path') continue;
    pathScoped += 1;
    if (isUrlDecidableRule(line)) urlDecidable += 1;
  }
  return { pathScoped, urlDecidable, share: pathScoped === 0 ? 0 : urlDecidable / pathScoped };
}

/** Counts the network rules in a compiled list. */
export function countNetworkRules(lines: readonly string[]): number {
  let count = 0;
  for (const line of lines) {
    if (isNetworkRule(line)) count++;
  }
  return count;
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Sorted hit counts, largest first, with duplicate rules merged. */
function normalizeHits(hits: readonly RuleHitCount[]): Array<{ rule: string; count: number }> {
  const merged = new Map<string, number>();
  for (const hit of hits) {
    if (!hit || typeof hit.rule !== 'string') continue;
    const count = Number.isFinite(hit.count) ? Math.max(0, Math.floor(hit.count)) : 0;
    if (count <= 0) continue;
    merged.set(hit.rule, (merged.get(hit.rule) ?? 0) + count);
  }
  return [...merged.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}

/**
 * Fewest rules, taken largest-first, whose counts reach `share` of the total.
 *
 * The rule that crosses the threshold counts in full — a list cannot ship half a rule — so the
 * result is the honest "cut here" boundary rather than a fractional interpolation.
 */
export function minimumRulesForShare(sortedCounts: readonly number[], share: number): number {
  const total = sortedCounts.reduce((sum, count) => sum + count, 0);
  if (total <= 0 || sortedCounts.length === 0) return 0;

  const shareOf = (rules: number): number =>
    sortedCounts.slice(0, rules).reduce((sum, count) => sum + count, 0) / total;

  const target = Math.min(1, Math.max(0, share));
  if (target <= 0) return 0;
  if (shareOf(sortedCounts.length) < target) return sortedCounts.length;

  // Binary search: coverage is monotonic in the number of rules taken.
  let low = 1;
  let high = sortedCounts.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (shareOf(mid) >= target) high = mid;
    else low = mid + 1;
  }
  return low;
}

export interface AnalyzeCoverageInput {
  /** Size of the compiled network list the trace was measured against. */
  totalRules: number;
  /** Observed matches: which rule fired, and how often. */
  hits: readonly RuleHitCount[];
  /** How many hot rules to include. */
  topLimit?: number;
}

export function analyzeRuleCoverage(input: AnalyzeCoverageInput): CoverageReport {
  const sorted = normalizeHits(input.hits);
  const counts = sorted.map((entry) => entry.count);
  const total = counts.reduce((sum, count) => sum + count, 0);

  // A rule that matched is in the list by definition, so a caller that passes a stale or
  // truncated list size cannot produce a hit rate above 100%.
  const totalRules = Math.max(Math.floor(input.totalRules) || 0, sorted.length);
  const matchedRules = sorted.length;
  const neverMatchedRules = Math.max(0, totalRules - matchedRules);

  let running = 0;
  const topLimit = Math.max(1, input.topLimit ?? 10);
  const topRules: HotRule[] = sorted.slice(0, topLimit).map((entry) => {
    running += entry.count;
    return {
      rule: entry.rule,
      count: entry.count,
      share: total > 0 ? round(entry.count / total, 4) : 0,
      cumulativeShare: total > 0 ? round(running / total, 4) : 0,
    };
  });

  const toPoint = (share: number): RuleSharePoint => {
    const rules = minimumRulesForShare(counts, share);
    return {
      share,
      rules,
      rulesPercent: totalRules > 0 ? round((rules / totalRules) * 100, 4) : 0,
    };
  };

  // 100% means every request the list blocks is blocked — which needs only the rules that
  // actually fired, not the whole list. That difference is the point of the report.
  const curve = COVERAGE_SHARES.map(toPoint);
  const minimumRules = curve.filter((point) => point.share < 1);

  return {
    totalRules,
    blockedRequests: total,
    matchedRules,
    neverMatchedRules,
    listHitRatePercent: totalRules > 0 ? round((matchedRules / totalRules) * 100, 4) : 0,
    deadWeightPercent: totalRules > 0 ? round((neverMatchedRules / totalRules) * 100, 4) : 0,
    curve,
    topRules,
    minimumRules,
  };
}

/** A rule that fired but was left out of a trimmed list. */
export interface HotRuleDrop {
  rule: string;
  count: number;
  /** Share of the measured requests it carried, 0–1. */
  share: number;
}

export interface SelectHotListInput {
  /** The full compiled list the hot set is drawn from. */
  lines: readonly string[];
  /** Blocking rules that fired, and how often. */
  hits: readonly RuleHitCount[];
  /**
   * Exception rules that fired. They must be kept: an allow decision the source list made is part
   * of the behaviour being preserved, and a trimmed list that drops it blocks *more* than the list
   * it replaced — the loudest possible regression.
   */
  exceptions?: readonly string[];
  /** Share of the measured requests to carry. Defaults to 1 — every block that was observed. */
  share?: number;
}

export interface HotListSelection {
  /**
   * The rules to ship: the blocking rules that carry the coverage, hottest first, then the kept
   * exceptions. Hottest-first is deliberate — a truncated or budget-clipped list degrades
   * gracefully, because the rules that carry the most blocking are the ones that survived the cut
   * a reader would make.
   */
  lines: string[];
  /** The kept blocking rules, by the scope each one needs. */
  scopes: RuleScopeCounts;
  /** Fired exception rules kept, so the list makes the same allow decisions the source did. */
  keptExceptions: string[];
  /** Measured requests the kept rules carry. */
  coveredRequests: number;
  /** Measured requests in the input the selection was derived from. */
  totalRequests: number;
  /** `coveredRequests / totalRequests`, 0–1. */
  coverage: number;
  /** Blocking rules that fired and were left out, largest first. Empty at `share: 1`. */
  dropped: HotRuleDrop[];
  /** Blocking rules in the source list that never fired on the input at all. */
  unfiredRules: number;
  /** Lines in the source list, comments included. */
  sourceLines: number;
  /** The share that was requested. */
  share: number;
}

/**
 * Builds a trimmed list from the rules a measurement actually saw fire.
 *
 * The selection is deliberately made from *measured* matches rather than from the shape of the
 * rules: the coverage curve already says which head of the list carries the blocking, and this
 * turns that head into a list that can be shipped. Two properties make the result safe to replace
 * a bigger list with, on the traffic it was measured on:
 *
 *  1. **Every verdict is preserved.** Only rules that won are included, so a host that was blocked
 *     still matches its winner, and a host that was left alone matches nothing — the source list
 *     had no rule for it that fired. Exception rules that fired are kept for the same reason.
 *  2. **A rule that fired is in the source list.** A stale or truncated ledger cannot inject a rule
 *     the list does not carry, so the artifact can only ever be a subset of what it replaced.
 *
 * What is *not* preserved is everything the measurement never exercised. That is the trade, and it
 * is reported (`unfiredRules`, `dropped`) rather than hidden: a hot set is exact for the traffic it
 * came from and says nothing about traffic it has not seen.
 *
 * The size of the result is therefore a property of the *sample*, not of the list. A short, quiet
 * session yields a small hot set; a longer or busier one fires more rules and yields a bigger one,
 * so the count is a floor to grow from rather than a fixed figure to compare against.
 */
export function selectHotList(input: SelectHotListInput): HotListSelection {
  const sorted = normalizeHits(input.hits);
  const counts = sorted.map((entry) => entry.count);
  const totalRequests = counts.reduce((sum, count) => sum + count, 0);
  const share = Math.min(1, Math.max(0, input.share ?? 1));

  // The same boundary the coverage curve reports, so "the head that carries 99%" means the same
  // thing here as it does there.
  const keepCount = minimumRulesForShare(counts, share);
  const kept = sorted.slice(0, keepCount);
  const dropped = sorted.slice(keepCount);

  // Only lines the source list actually carries can be shipped.
  const available = new Set(input.lines.map((line) => line.trim()).filter(Boolean));
  const keptRules = kept.filter((entry) => available.has(entry.rule));
  const keptExceptions = [...new Set(input.exceptions ?? [])]
    .filter((rule) => available.has(rule))
    .sort();

  const coveredRequests = keptRules.reduce((sum, entry) => sum + entry.count, 0);
  const lines = [...keptRules.map((entry) => entry.rule), ...keptExceptions];
  const firedBlocking = new Set(sorted.map((entry) => entry.rule));
  const sourceScopes = countRuleScopes(input.lines);

  return {
    lines,
    scopes: countRuleScopes(keptRules.map((entry) => entry.rule)),
    keptExceptions,
    coveredRequests,
    totalRequests,
    coverage: totalRequests > 0 ? round(coveredRequests / totalRequests, 4) : 0,
    dropped: dropped.map((entry) => ({
      rule: entry.rule,
      count: entry.count,
      share: totalRequests > 0 ? round(entry.count / totalRequests, 4) : 0,
    })),
    unfiredRules: Math.max(0, sourceScopes.total - firedBlocking.size),
    sourceLines: input.lines.length,
    share,
  };
}

/**
 * Renders a hot set as a compilable filter list, with a header that states what it is and what it
 * cost. Deterministic — no clock, no paths outside the two inputs — so `--check` can diff it.
 */
export function formatHotList(
  selection: HotListSelection,
  meta: { source: string; measuredOn: string; derivation?: string },
): string {
  const percentOf = (value: number) => `${(value * 100).toFixed(1)}%`;
  const percentOfSource = (count: number) =>
    selection.sourceLines > 0 ? round((count / selection.sourceLines) * 100, 3) : 0;

  const header = [
    '! Blockingmachine hot set — generated by scripts/build-hot-list.mjs. Do not edit by hand.',
    '!',
    `! Source:          ${meta.source} (${selection.sourceLines.toLocaleString()} lines)`,
    `! Measured on:     ${meta.measuredOn}`,
    // The flags that produced this file, in the order the script writes them. It is what
    // `build-hot-list.mjs --check` replays when the caller names no input, so a list derived from
    // the accumulated browser ledger stays verifiable without the check being hard-wired to
    // whichever fixture the list happened to start from.
    ...(meta.derivation ? [`! Derivation:      ${meta.derivation}`] : []),
    `! Coverage:        ${selection.coveredRequests.toLocaleString()} of ${selection.totalRequests.toLocaleString()} measured blocks (${percentOf(selection.coverage)}) in ${selection.lines.length.toLocaleString()} rules (${percentOfSource(selection.lines.length)}% of the source list)`,
    `! Scopes kept:     ${selection.scopes.hostname.toLocaleString()} hostname-decidable · ${selection.scopes.initiator.toLocaleString()} initiator-scoped · ${selection.scopes.path.toLocaleString()} path-scoped · ${selection.scopes.request.toLocaleString()} request-scoped`,
    `! Exceptions kept: ${selection.keptExceptions.length.toLocaleString()}, so the list makes the same allow decisions the source made`,
    `! Left behind:     ${selection.unfiredRules.toLocaleString()} blocking rules that never fired on this measurement${selection.dropped.length > 0 ? `, plus ${selection.dropped.length.toLocaleString()} that fired and fell outside the ${percentOf(selection.share)} share` : ''}`,
    '!',
    '! This is a measured hot set, not a general blocklist. It is exact for the traffic it was',
    '! derived from — same blocked hosts, same blocked requests — and says nothing about traffic it',
    '! has not seen. Re-derive it per deployment; do not treat it as a substitute for the full list',
    '! on an unmeasured network.',
    '!',
    '! Read the rule count as a floor, not a fixed size. The measurement is a sample — a short',
    '! session on one machine — and a longer or busier one exercises more of the source list and adds',
    '! hot rules. The trace also records requests as *attempted*: a connection that was refused or',
    '! failed still counts, which is what a network blocker sees anyway.',
    '',
  ].join('\n');

  return `${header}${selection.lines.join('\n')}\n`;
}

/** What a hot list records about the inputs that produced it. */
export interface HotListDerivation {
  /** The rule list the selection was made from. */
  list?: string;
  /** A browser-reported rule-hit ledger, when that is what was measured. */
  hits?: string;
  /** A captured request trace, when that is what was replayed. */
  trace?: string;
  /**
   * Session-export files (or directories of them) merged inline, when the measurement arrived as
   * the extension's own exports rather than a pre-merged ledger. More than one is normal.
   */
  sessions?: string[];
  /** Fraction of the measured set requested; 1 means "keep everything that fired". */
  share?: number;
}

/**
 * The inputs a generated hot list records, read back from its own header.
 *
 * This is the other half of `formatHotList`'s `derivation` line, and it lives beside it on purpose:
 * one writes the line and the other reads it, so a change to the format that left the reader behind
 * would be a change to this file rather than a silent difference between the writer in
 * `scripts/build-hot-list.mjs` and whatever it has to agree with.
 *
 * It exists because `--check` has to re-derive the list from the inputs that produced it. The
 * checked-in list was derived from one trace fixture for as long as that was true, and a check
 * hard-wired to the fixture turns into a check that fails the moment the list is derived from the
 * accumulated browser ledger instead — which would push whoever arrives there towards dropping the
 * check, and the check is the only thing keeping a hand-edited hot list honest.
 *
 * Returns `null` for a list written before the line existed, so the caller can fall back rather
 * than guess.
 */
export function parseHotListDerivation(text: string): HotListDerivation | null {
  // The `! Derivation: …` line, found by walking lines rather than `/^!\s*Derivation:\s*(.+)$/m` —
  // the regex's `\s*` could backtrack over a run of spaces line-start by line-start.
  let captured: string | null = null;
  for (const raw of (text ?? '').split('\n')) {
    if (!raw.startsWith('!')) continue;
    const afterBang = raw.slice(1).trimStart();
    if (!afterBang.startsWith('Derivation:')) continue;
    const rem = afterBang.slice('Derivation:'.length);
    // `(.+)` needs at least one character after the whitespace run — a bare `!Derivation:`
    // does not match and the scan continues to the next line, as the regex did.
    if (rem.length === 0) continue;
    captured = rem;
    break;
  }
  if (captured === null) return null;
  const tokens = captured.trim().split(/\s+/);
  const declared: HotListDerivation = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const flag = tokens[i];
    const value = tokens[i + 1];
    if (value === undefined) continue;
    if (flag === '--list') declared.list = value;
    else if (flag === '--hits') declared.hits = value;
    else if (flag === '--trace') declared.trace = value;
    else if (flag === '--sessions')
      declared.sessions = [...(declared.sessions ?? []), value];
    else if (flag === '--share') declared.share = Number(value);
    // Any other token is from a newer format than this reader; skipping it keeps the ones this
    // reader does know usable, which is better than refusing the whole line.
    i += 1;
  }
  if (!declared.hits && !declared.trace && !(declared.sessions?.length)) return null;
  return declared;
}

function percent(value: number): string {
  return `${value.toFixed(value < 10 ? 2 : 1)}%`;
}

function shareLabel(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Plain-text report, one line per row. Colour and layout belong to the caller. */
export function formatCoverageReport(report: CoverageReport): string[] {
  const lines: string[] = [];
  const head99 = report.minimumRules.find((point) => point.share === 0.99);
  const head95 = report.minimumRules.find((point) => point.share === 0.95);

  lines.push(
    `Rule coverage: ${report.matchedRules.toLocaleString()} of ${report.totalRules.toLocaleString()} network rules matched ` +
      `(${percent(report.listHitRatePercent)})`,
  );
  lines.push(
    `${report.blockedRequests.toLocaleString()} matched requests · ` +
      `${report.neverMatchedRules.toLocaleString()} rules never fired (${percent(report.deadWeightPercent)} of the list)`,
  );

  if (head95 && head99) {
    lines.push(
      `Head of the list: ${head95.rules.toLocaleString()} rules cover 95% of blocks, ` +
        `${head99.rules.toLocaleString()} cover 99% (${percent(head99.rulesPercent)} of the list)`,
    );
  }

  lines.push('');
  lines.push('Coverage curve (largest-contributing rules first)');
  for (const point of report.curve) {
    lines.push(
      `  ${shareLabel(point.share).padStart(4)} of blocks  →  ${point.rules.toLocaleString().padStart(9)} rules  (${percent(point.rulesPercent)} of list)`,
    );
  }

  if (report.topRules.length > 0) {
    lines.push('');
    lines.push('Hottest rules');
    for (const rule of report.topRules) {
      lines.push(
        `  ${String(rule.count).padStart(7)} ×  ${percent(rule.share * 100).padStart(6)}  (cum ${percent(rule.cumulativeShare * 100)})  ${rule.rule}`,
      );
    }
  }

  return lines;
}
