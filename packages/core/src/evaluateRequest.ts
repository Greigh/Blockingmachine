/**
 * Runtime request evaluation — the verdict a compiled list gives one request URL.
 *
 * The repo's two existing matchers sit on either side of this one and cannot serve it. The
 * domain evaluator ({@link CompiledDomainRuleSet}) decides from a hostname alone, so it drops
 * every rule whose verdict needs request context — `$third-party`, `$removeparam`, path rules —
 * which is exactly the surface a MITM proxy needs. The extension compiles to Chrome DNR and
 * lets the browser match, so it has no verdict to share either. This evaluator is the request-
 * level answer: one list in, `evaluate(url, ctx)` out, and it is the semantics `/v1/check`
 * reports lifted to URL level (design doc §5.4).
 *
 * Rules enter through `parseFilterList`, the `RuleProcessor` classification path — cosmetic,
 * scriptlet and comment lines never reach the index. What remains is split two ways,
 * the same structure the mobile matcher uses: host-only rules (`||domain^`, bare domains) go
 * into suffix maps consulted by walking the request host's labels — exact-name hosts entries
 * beside them — so `||tracker.example^` covers `a.b.tracker.example` but never
 * `nottracker.example`; everything else — path patterns, `|url` anchors, `/regex/`, wildcard
 * hosts, and pattern-less rules such as `*$removeparam=` — is compiled into per-request tests
 * behind a literal-token shortlist, so a request only ever runs the handful of tests whose
 * token it contains.
 *
 * Semantics, in the order the verdict is decided:
 *
 *  - A rule matches only when its restricting conditions are met: `$third-party` needs
 *    `ctx.thirdParty === true` (`~third-party`, `first-party` need `false`), `$method=` needs
 *    `ctx.method`, resource-type modifiers (`$script`, `$image`, …) need `ctx.contentType`.
 *    A condition the context cannot answer — `$domain=` and the initiator-scoped `$denyallow=`
 *    most of all, since `RequestContext` carries no initiator — means the rule does not match.
 *    That is the conservative direction: a MITM proxy that guesses wrong breaks connectivity,
 *    one that under-matches stays safe.
 *  - Precedence is `exception` > `blocked` > `allowed`, except an `$important` blocking rule
 *    outranks plain exceptions and an `$important` exception outranks it back — the same
 *    ordering `CompiledDomainRuleSet` resolves at domain level. `coveringRule` is the winning
 *    match's raw text.
 *  - **Modify is not interception.** Rules carrying only modify modifiers — `removeparam`,
 *    `removeheader`, `csp`, `replace`, `urltransform`/`uritransform`, `header`,
 *    `referrerpolicy`, `permissions`, `stealth` — never produce a `blocked` action: they match
 *    and contribute transforms, and the verdict stays `allowed` unless a blocking or exception
 *    rule also matched. Generic `*$removeparam=` rules (the bulk of real URL-tracking lists)
 *    therefore strip parameters instead of blocking the web. Interception modifiers —
 *    `redirect`, `redirect-rule`, `empty`, `mp4`, `noop` — keep `blocked`, the honest verdict
 *    for a request this engine intercepts but cannot rewrite yet.
 *  - Transforms come from **all** matching non-exception rules, regardless of which rule won
 *    the action. `removeparam=name` collects `name`; bare, `*` or `/regex/` forms collapse to
 *    `"all"`; the `~name` exclusion form reports `"all"` with `keepParams: ["name"]`.
 *    `removeheader=name` collects header names (`request:`/`response:` prefixes stripped) and
 *    `csp=` keeps every matching rule's policy text — each lands as its own co-equal policy
 *    on the response.
 *  - An exception carrying a transform modifier is a *cancellation*, upstream `@@`-semantics:
 *    it still wins `exception` on precedence, and it suppresses the collected transform of
 *    that type and value — `@@||x.com^$removeparam=token` stops `token` being stripped, while
 *    a bare `@@||x.com^$removeparam` (or a `~name`/`*`/`/regex/` form) stops all parameter
 *    stripping. Bare `@@` exceptions suppress nothing.
 *  - `$badfilter` is resolved at index time: a rule whose identity a `$badfilter` marker names
 *    is never indexed at all, mirroring `CompiledDomainRuleSet`. `$match-case` is accepted but
 *    matched case-insensitively — the shared URL matchers compile `'i'` and offer no flag.
 *
 * `size` counts what was indexed. URLs over AdGuard's 4096-char bound are clamped before
 * matching, and an unparseable URL fails open to `allowed`.
 */

import { exceptionRequestUrlMatcher, requestUrlMatcher } from "./coverage.js";
import { parseFilterList } from "./RuleProcessor.js";
import { isValidDomainName } from "./utils/ruleSyntax.js";

/** Context a caller knows about the request; anything absent makes dependent rules not match. */
export interface RequestContext {
  /** True when the request crosses a site boundary — the `$third-party` gate. */
  thirdParty?: boolean;
  /** HTTP method, matched against `$method=get|post` case-insensitively. */
  method?: string;
  /**
   * The ABP request-type token (`document`, `script`, `image`, `xmlhttprequest`, …), compared
   * verbatim against resource-type modifiers. It is not a MIME type — callers map their world.
   */
  contentType?: string;
}

export interface RequestVerdict {
  /** What the list decided: a matching block, a matching exception, or no rule at all. */
  action: "blocked" | "exception" | "allowed";
  /** Raw text of the rule that won the action; null when nothing matched. */
  coveringRule: string | null;
  /**
   * Request reshapes from **all** matching non-exception rules, regardless of which won the
   * action — minus whatever matching `@@` transform exceptions cancel.
   */
  transforms: {
    /** Parameter names to strip, or `"all"` when a matching rule strips everything. */
    removeParams: string[] | "all";
    /** Parameter names a `~name` exclusion keeps when `removeParams` is `"all"`. */
    keepParams: string[];
    /** Header names to strip before forwarding. */
    removeHeaders: string[];
    /** Every matching rule's `$csp=` policy text — each becomes its own co-equal policy. */
    csp?: string[];
  };
}

export interface RequestEvaluator {
  evaluate(url: string, ctx?: RequestContext): RequestVerdict;
  /** How many rules were indexed — the denominator a reload can report. */
  readonly size: number;
}

/** Classified types that can decide anything about a request. Everything else never applies. */
const REQUEST_RULE_TYPES = new Set([
  "blocking",
  "unblocking",
  "parameter",
  "removeparam",
  "removeheader",
  "csp",
  "redirect",
]);

/**
 * Modifiers that reshape a request or response without blocking it. A rule carrying only
 * these — no interception modifier alongside — matches but cannot produce a `blocked` action,
 * which is what keeps generic `*$removeparam=` lists from being a block-everything rule.
 */
const MODIFY_MODIFIERS = new Set([
  "removeparam",
  "removeheader",
  "csp",
  "replace",
  "urltransform",
  "uritransform",
  "header",
  "referrerpolicy",
  "permissions",
  "stealth",
]);

/**
 * Modifiers whose action this verdict can only express as "the request was intercepted" —
 * closest to `blocked` until a pipeline can rewrite the destination or synthesize the body.
 */
const INTERCEPTION_MODIFIERS = new Set([
  "redirect",
  "redirect-rule",
  "empty",
  "mp4",
  "noop",
]);

/**
 * ABP resource-type modifiers, evaluated against `ctx.contentType` as an exact token. Any
 * other restricting modifier needs context `RequestContext` does not carry, so a rule that
 * carries it can never fire — pushing `NEVER` into its conditions is the honest refusal.
 */
const RESOURCE_TYPE_MODIFIERS = new Set([
  "document",
  "subdocument",
  "script",
  "stylesheet",
  "image",
  "font",
  "media",
  "object",
  "object-subrequest",
  "xmlhttprequest",
  "ping",
  "websocket",
  "other",
]);

const NEVER = () => false;

/** AdGuard's bound on the URLs its engine matches; longer inputs are clamped, not refused. */
const MAX_URL_LENGTH = 4096;

/** Scan rules with no ≥3-char literal get no index token — they always run. */
const MIN_TOKEN_LENGTH = 3;

/** One rule, compiled to the index: precomputed flags, conditions and transform payload. */
interface CompiledRequestRule {
  raw: string;
  isException: boolean;
  isImportant: boolean;
  /** `$badfilter` identity — pattern plus sorted modifiers, matching `domainEvaluator`. */
  identity: string;
  /** Restricting conditions; every one must hold for the rule to match. */
  conditions: Array<(ctx: RequestContext) => boolean>;
  /**
   * Whether a match can produce the `blocked` action — false for modify-only rules. On an
   * exception the flag is moot; exceptions suppress transforms instead of contributing them.
   */
  contributesBlock: boolean;
  /** True on the bare/all-parameters forms — also the `@@` signal for "suppress the type". */
  removeAllParams: boolean;
  removeParamNames: string[];
  /** `~name` exclusions carried alongside a remove-all — the `keepParams` transform. */
  keepParamNames: string[];
  removeHeaders: string[];
  /** Bare `removeheader` — on an exception it suppresses every collected header strip. */
  removeAllHeaders: boolean;
  /** Whether the rule carries `csp` at all — a bare `@@…$csp` suppresses any collected csp. */
  hasCspModifier: boolean;
  /** Every `csp=` value on the rule (a comma-split tail can carry more than one). */
  csp: string[];
}

/** A path/pattern rule and its URL test — the scan-list half of the index. */
interface ScannedRule {
  rule: CompiledRequestRule;
  test: (url: string) => boolean;
}

/**
 * Split a raw rule into pattern body and verbatim `$`-modifiers. `@@` is stripped from the
 * body (the caller tracks `isException`), so the body is what a URL matcher would see. An
 * empty body is kept — `*$removeparam=` and `$removeparam=` are match-all rules upstream.
 * Modifier NAMES are case-insensitive (the caller folds them); modifier VALUES are left
 * byte-exact because `$csp` policy text and `$removeparam`/`$removeheader` names are
 * case-sensitive — a whole-tail `.toLowerCase()` here would corrupt
 * `csp=script-src 'sha256-AbCdEf='`.
 */
function splitRule(raw: string): { body: string; modifiers: string[] } {
  let work = raw.trim();
  if (work.startsWith("@@")) work = work.slice(2).trim();
  // A slashed `/regex/` keeps its `$` — inside a pattern it is an anchor, not a separator.
  const isRegex = work.startsWith("/") && work.endsWith("/") && work.length > 2;
  const separator = isRegex ? -1 : work.lastIndexOf("$");
  const body = separator < 0 ? work : work.slice(0, separator);
  const modifiers =
    separator < 0 || separator === work.length - 1
      ? []
      : work
          .slice(separator + 1)
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
  return { body, modifiers };
}

/** The `$badfilter` identity of a rule: exception marker plus pattern plus sorted modifiers. */
function ruleIdentity(body: string, isException: boolean, modifiers: string[]): string {
  const mods = modifiers.filter((part) => part !== "badfilter").sort();
  return (
    (isException ? "@@" : "") +
    body.toLowerCase() +
    (mods.length ? `$${mods.join(",")}` : "")
  );
}

/** The hostname of a request URL, or null when nothing honest can be read from it. */
function requestHost(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let rest = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (rest.startsWith("//")) rest = rest.slice(2);
  const boundary = rest.search(/[/?#]/);
  const authority = boundary < 0 ? rest : rest.slice(0, boundary);
  const host = authority
    .split("@")
    .pop()!
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (!host || !/^[a-z0-9._-]+$|^[0-9a-f:]+$/i.test(host)) return null;
  return host;
}

/**
 * The host a host-only rule indexes under, or null when the body is not one. `||domain^`,
 * `||domain`, `domain` and `domain^` are all domain rules — the same reading the DNR compiler
 * and the mobile matcher give them — while `*` marks a wildcard host for the scan list.
 */
function hostOnlyPattern(body: string): string | null {
  let b = body;
  if (b.startsWith("||")) b = b.slice(2);
  else if (b.startsWith("|") || b.startsWith("/")) return null;
  if (b.includes("/")) return null;
  b = b.replace(/\^+$/, "").replace(/\.+$/, "");
  // A `^` surviving the trailing strip is a mid-pattern separator — path content, not a host.
  if (b.includes("^") || !b || !b.includes(".")) return null;
  return b.toLowerCase();
}

/** Host glob for wildcard host-only rules (`||*.x.com^`): `*` stays inside one label. */
function wildcardHostTest(hostPattern: string): ((host: string) => boolean) | null {
  const inner = hostPattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^.]*");
  try {
    const compiled = new RegExp(`^(?:.*\\.)?${inner}$`, "i");
    return (host) => compiled.test(host);
  } catch {
    return null;
  }
}

/**
 * A single-`|` start anchor (`|http://x/p`): a literal prefix the URL must begin with, a
 * trailing `|` demanding an exact match. The shared URL matcher strips `|` syntax and reads
 * the same text as host+path — matching `https://x/p` and `/px` alike — so the anchored shape
 * is evaluated here rather than delegated.
 */
function urlAnchorTest(body: string): ((url: string) => boolean) | null {
  let pattern = body.slice(1);
  const exact = pattern.endsWith("|");
  if (exact) pattern = pattern.slice(0, -1);
  if (!pattern) return null;
  const needle = pattern.toLowerCase();
  return exact
    ? (url) => url.toLowerCase() === needle
    : (url) => url.toLowerCase().startsWith(needle);
}

/**
 * The literal substring a scan rule cannot match without — the longest run of non-metachar
 * characters (`*`, `^`, `|` are the only specials ABP pattern text has) of at least
 * {@link MIN_TOKEN_LENGTH}. A rule that can match must see its token in the URL, so the index
 * keys on it and `evaluate` only runs tests whose token the URL contains. Regex bodies and
 * anything with an escape return null and live in the always-scan residue.
 */
function literalToken(body: string): string | null {
  if (!body || body.includes("\\")) return null;
  if (body.startsWith("/") && body.endsWith("/") && body.length > 2) return null;
  let best = "";
  let run = "";
  for (const char of body) {
    if (char === "*" || char === "^" || char === "|") {
      if (run.length > best.length) best = run;
      run = "";
    } else {
      run += char;
    }
  }
  if (run.length > best.length) best = run;
  const token = best.toLowerCase();
  return token.length >= MIN_TOKEN_LENGTH ? token : null;
}

/** Compile one classified rule; null when nothing about it can be indexed. */
function compileRule(
  raw: string,
  isExceptionFlag: boolean,
): { rule: CompiledRequestRule; body: string; isBadfilter: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const isException = isExceptionFlag || trimmed.startsWith("@@");
  const { body, modifiers: rawModifiers } = splitRule(trimmed);
  // A body-less rule still indexes when it carries modifiers (`$removeparam=` is match-all);
  // one without either is a stray `$` and nothing to compile.
  if (!body && rawModifiers.length === 0) return null;
  // Names are case-insensitive, values are not: fold only the name half of each modifier so
  // `CSP=` parses while `csp=script-src 'sha256-AbCd'` keeps its case-sensitive policy text.
  const modifiers = rawModifiers.map((part) => {
    const eq = part.indexOf("=");
    const name = (eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase();
    return eq < 0 ? name : name + part.slice(eq);
  });

  const rule: CompiledRequestRule = {
    raw: trimmed,
    isException,
    isImportant: modifiers.includes("important"),
    identity: ruleIdentity(body, isException, modifiers),
    conditions: [],
    contributesBlock: true,
    removeAllParams: false,
    removeParamNames: [],
    keepParamNames: [],
    removeHeaders: [],
    removeAllHeaders: false,
    hasCspModifier: false,
    csp: [],
  };
  let isBadfilter = false;
  let hasModify = false;
  let hasInterception = false;

  for (const modifier of modifiers) {
    const negated = modifier.startsWith("~");
    const eq = modifier.indexOf("=");
    const name = (negated ? modifier.slice(1) : modifier)
      .slice(0, eq < 0 ? undefined : eq)
      .trim();
    const value = eq < 0 ? "" : modifier.slice(eq + 1);

    if (name === "important" || name === "match-case") continue;
    if (name === "badfilter") {
      isBadfilter = true;
      continue;
    }
    if (name === "third-party") {
      rule.conditions.push(
        negated
          ? (ctx) => ctx.thirdParty === false
          : (ctx) => ctx.thirdParty === true,
      );
      continue;
    }
    if (name === "first-party") {
      rule.conditions.push((ctx) => ctx.thirdParty === false);
      continue;
    }
    if (name === "method" && !negated && value) {
      const methods = new Set(value.split("|").map((entry) => entry.trim().toUpperCase()));
      rule.conditions.push(
        (ctx) => ctx.method !== undefined && methods.has(ctx.method.toUpperCase()),
      );
      continue;
    }
    if (MODIFY_MODIFIERS.has(name) && !negated) {
      hasModify = true;
      if (name === "removeparam") {
        // Bare, `*` and `/regex/` forms strip everything; `~name` strips everything but the
        // named parameters, which is `keepParams`; `a|b` strips a and b.
        if (!value || value === "*" || value.startsWith("/")) {
          rule.removeAllParams = true;
        } else {
          for (const entry of value.split("|")) {
            const param = entry.trim();
            if (!param) continue;
            if (param.startsWith("~")) {
              rule.removeAllParams = true;
              const kept = param.slice(1).trim();
              if (kept) rule.keepParamNames.push(kept);
            } else if (param.startsWith("/")) {
              rule.removeAllParams = true;
            } else {
              rule.removeParamNames.push(param);
            }
          }
        }
      } else if (name === "removeheader") {
        // `request:`/`response:` prefixes name the side the strip applies to; the pipeline
        // decides which it can act on, so the transform keeps the bare header name. A bare
        // modifier only matters on exceptions, where it suppresses the whole type.
        const header = value.replace(/^(?:request|response):/, "").trim();
        if (header) rule.removeHeaders.push(header);
        else rule.removeAllHeaders = true;
      } else if (name === "csp") {
        rule.hasCspModifier = true;
        if (value) rule.csp.push(value);
      }
      // replace/urltransform/header/referrerpolicy/permissions/stealth are modify actions
      // this verdict cannot express — they still mark the rule non-blocking.
      continue;
    }
    if (INTERCEPTION_MODIFIERS.has(name) && !negated) {
      hasInterception = true;
      continue;
    }
    if (RESOURCE_TYPE_MODIFIERS.has(name)) {
      rule.conditions.push(
        negated
          ? (ctx) => ctx.contentType !== undefined && ctx.contentType.toLowerCase() !== name
          : (ctx) => ctx.contentType !== undefined && ctx.contentType.toLowerCase() === name,
      );
      continue;
    }
    // Everything else needs context this interface does not carry — `$domain=` and the
    // initiator-scoped `$denyallow=` above all — so the rule can never fire. The refusal is
    // explicit rather than a silent zone collapse.
    rule.conditions.push(NEVER);
  }

  // Modify-only rules match to transform, not to block — an interception modifier alongside
  // is the only thing that restores `blocked` on a rule carrying a modify action.
  rule.contributesBlock = !hasModify || hasInterception;

  return { rule, body, isBadfilter };
}

function addToMap(map: Map<string, CompiledRequestRule[]>, key: string, rule: CompiledRequestRule): void {
  const existing = map.get(key);
  if (existing) existing.push(rule);
  else map.set(key, [rule]);
}

function addToScan(map: Map<string, ScannedRule[]>, residue: ScannedRule[], body: string, entry: ScannedRule): void {
  const token = literalToken(body);
  if (!token) {
    residue.push(entry);
    return;
  }
  const existing = map.get(token);
  if (existing) existing.push(entry);
  else map.set(token, [entry]);
}

/**
 * Compiles raw filter lines into a request evaluator.
 *
 * The index mirrors the mobile matcher's structure: `||domain^`-shaped rules go into suffix
 * maps walked along the request host's labels, and path/pattern rules — anything carrying a
 * `/`, a `|` anchor, a wildcard host, a `/regex/`, or no pattern at all — are compiled into
 * per-request tests shortlisted by a literal-token index.
 */
export function createRequestEvaluator(rawRules: string[]): RequestEvaluator {
  const stored = parseFilterList(rawRules.join("\n"), "request-evaluator");

  const hostBlocks = new Map<string, CompiledRequestRule[]>();
  const hostExceptions = new Map<string, CompiledRequestRule[]>();
  const exactBlocks = new Map<string, CompiledRequestRule[]>();
  const exactExceptions = new Map<string, CompiledRequestRule[]>();
  const scanTokens = new Map<string, ScannedRule[]>();
  const scanResidue: ScannedRule[] = [];

  // Pass one collects `$badfilter` identities; pass two indexes — a marker that lands after
  // the rule it mirrors still disables it, and no runtime check is ever needed.
  const badfilters = new Set<string>();
  const compiled: Array<{ rule: CompiledRequestRule; body: string }> = [];
  for (const storedRule of stored) {
    if (!REQUEST_RULE_TYPES.has(storedRule.type)) continue;
    const entry = compileRule(storedRule.raw, storedRule.isException === true);
    if (!entry) continue;
    if (entry.isBadfilter) {
      badfilters.add(entry.rule.identity);
      continue;
    }
    compiled.push(entry);
  }

  for (const { rule, body } of compiled) {
    // Resolved at index time, not at evaluate: a marker's target is never indexed at all.
    if (badfilters.has(rule.identity)) continue;

    // A hosts-file entry is an exact-name block; its siblings are expanded to one rule each
    // upstream, and it matches the host itself rather than a zone.
    const hostsEntry = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+(\S+)/.exec(body);
    if (hostsEntry) {
      const host = hostsEntry[1].toLowerCase().replace(/\.+$/, "");
      if (host) addToMap(rule.isException ? exactExceptions : exactBlocks, host, rule);
      continue;
    }

    const hostKey = hostOnlyPattern(body);
    if (hostKey && !hostKey.includes("*") && isValidDomainName(hostKey)) {
      addToMap(rule.isException ? hostExceptions : hostBlocks, hostKey, rule);
      continue;
    }

    let test: ((url: string) => boolean) | null;
    if (!body || body === "*") {
      // Pattern-less (`$removeparam=` and `*` rules) — match-all upstream.
      test = () => true;
    } else if (hostKey && hostKey.includes("*")) {
      // Host-only but wildcarded (`||*.x.com^`): a host predicate, any path.
      const hostTest = wildcardHostTest(hostKey);
      test = hostTest
        ? (url) => {
            const host = requestHost(url);
            return host !== null && hostTest(host);
          }
        : null;
    } else if (body.startsWith("|") && !body.startsWith("||")) {
      // `|url` start anchor — a literal prefix, not the matcher's host+path reading.
      test = urlAnchorTest(body);
    } else {
      // The URL matchers want the rule text back, `@@` included for the exception half.
      const matcherRule = (rule.isException ? "@@" : "") + body;
      test = rule.isException
        ? exceptionRequestUrlMatcher(matcherRule)
        : requestUrlMatcher(matcherRule);
    }
    if (test) addToScan(scanTokens, scanResidue, body, { rule, test });
  }

  let size = scanResidue.length;
  for (const map of [hostBlocks, hostExceptions, exactBlocks, exactExceptions, scanTokens]) {
    for (const list of map.values()) size += list.length;
  }

  function evaluate(rawUrl: string, ctx: RequestContext = {}): RequestVerdict {
    const url = rawUrl.length > MAX_URL_LENGTH ? rawUrl.slice(0, MAX_URL_LENGTH) : rawUrl;
    const host = requestHost(url);
    const matched: CompiledRequestRule[] = [];

    if (host) {
      const pushAll = (list: CompiledRequestRule[] | undefined) => {
        if (list) matched.push(...list);
      };
      pushAll(exactBlocks.get(host));
      pushAll(exactExceptions.get(host));
      // Suffix walk: `a.b.x.com` consults itself, `b.x.com`, `x.com`, then `com` — a rule
      // only ever sees the host and its subdomains, which is what `||domain^` means.
      let candidate = host;
      for (;;) {
        pushAll(hostBlocks.get(candidate));
        pushAll(hostExceptions.get(candidate));
        const dot = candidate.indexOf(".");
        if (dot < 0) break;
        candidate = candidate.slice(dot + 1);
      }
    }

    // Only the rules whose literal token the URL contains can match; residue always runs.
    const haystack = url.toLowerCase();
    for (const [token, list] of scanTokens) {
      if (!haystack.includes(token)) continue;
      for (const entry of list) if (entry.test(url)) matched.push(entry.rule);
    }
    for (const entry of scanResidue) if (entry.test(url)) matched.push(entry.rule);

    const active = matched.filter((rule) => rule.conditions.every((holds) => holds(ctx)));

    // Transforms: non-exception rules contribute, exceptions suppress — value-equal, with a
    // bare-modifier exception clearing its whole transform type.
    let removeAll = false;
    let suppressRemoveAll = false;
    const removeParamSet = new Set<string>();
    const keepParamSet = new Set<string>();
    const suppressParamNames = new Set<string>();
    const removeHeaderSet = new Set<string>();
    const suppressHeaderNames = new Set<string>();
    let suppressHeaderAll = false;
    let cspSuppressed = false;
    const cspValues = new Set<string>();
    const suppressCspValues = new Set<string>();

    for (const rule of active) {
      if (rule.isException) {
        if (rule.removeAllParams) suppressRemoveAll = true;
        for (const param of rule.removeParamNames) suppressParamNames.add(param);
        if (rule.removeAllHeaders) suppressHeaderAll = true;
        for (const header of rule.removeHeaders) suppressHeaderNames.add(header);
        if (rule.hasCspModifier) {
          if (rule.csp.length === 0) cspSuppressed = true;
          else for (const value of rule.csp) suppressCspValues.add(value);
        }
      } else {
        if (rule.removeAllParams) removeAll = true;
        for (const param of rule.removeParamNames) removeParamSet.add(param);
        for (const param of rule.keepParamNames) keepParamSet.add(param);
        for (const header of rule.removeHeaders) removeHeaderSet.add(header);
        for (const value of rule.csp) cspValues.add(value);
      }
    }

    // Precedence, mirroring CompiledDomainRuleSet: important exception > important block >
    // exception > block > nothing. Modify-only rules never fill a block slot.
    const winner =
      active.find((rule) => rule.isException && rule.isImportant) ??
      active.find((rule) => !rule.isException && rule.isImportant && rule.contributesBlock) ??
      active.find((rule) => rule.isException) ??
      active.find((rule) => !rule.isException && rule.contributesBlock) ??
      null;

    // A bare `@@…$csp` clears the whole transform; a valued one clears only its own policy.
    const csp = cspSuppressed ? [] : [...cspValues].filter((v) => !suppressCspValues.has(v));

    let removeParams: string[] | "all";
    if (suppressRemoveAll) removeParams = [];
    else if (removeAll) removeParams = "all";
    else removeParams = [...removeParamSet].filter((param) => !suppressParamNames.has(param));

    return {
      action: winner === null ? "allowed" : winner.isException ? "exception" : "blocked",
      coveringRule: winner?.raw ?? null,
      transforms: {
        removeParams,
        keepParams: suppressRemoveAll ? [] : [...keepParamSet],
        removeHeaders: suppressHeaderAll
          ? []
          : [...removeHeaderSet].filter((header) => !suppressHeaderNames.has(header)),
        ...(csp.length ? { csp } : {}),
      },
    };
  }

  return { evaluate, size };
}
