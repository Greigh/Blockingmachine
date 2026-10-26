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
 * `nottracker.example`; everything else — path patterns, `|url` anchors, `/regex/` — is
 * compiled through `requestUrlMatcher` / `exceptionRequestUrlMatcher` and scanned per request.
 *
 * Semantics, in the order the verdict is decided:
 *
 *  - A rule matches only when its restricting conditions are met: `$third-party` needs
 *    `ctx.thirdParty === true` (`~third-party`, `first-party` need `false`), `$method=` needs
 *    `ctx.method`, resource-type modifiers (`$script`, `$image`, …) need `ctx.contentType`.
 *    A condition the context cannot answer — `$domain=` most of all, since `RequestContext`
 *    carries no initiator — means the rule does not match. That is the conservative direction:
 *    a MITM proxy that guesses wrong breaks connectivity, one that under-matches stays safe.
 *  - Precedence is `exception` > `blocked` > `allowed`, except an `$important` blocking rule
 *    outranks plain exceptions and an `$important` exception outranks it back — the same
 *    ordering `CompiledDomainRuleSet` resolves at domain level. `coveringRule` is the winning
 *    match's raw text.
 *  - Transforms are independent of the action: `$removeparam`, `$removeheader` and `$csp` are
 *    collected from **every** matching rule, so an exception like `@@||x.com^$removeparam=token`
 *    lets the request through *and* still strips the parameter. Bare `$removeparam` (or
 *    `~name`/`/regex/` forms the `string[]` shape cannot express) reports `"all"`.
 *  - `$badfilter` disables the rule it mirrors, `$denyallow=` exonerates named hosts from a
 *    block, both mirroring `CompiledDomainRuleSet`. `$match-case` is accepted but matched
 *    case-insensitively — the shared URL matchers compile `'i'` and do not offer the flag.
 *
 * Non-blocking actions a verdict cannot express are still honest about matching: `$redirect`
 * and `$empty`-style rules match and report `blocked` (the request is intercepted either way);
 * `$replace`, `permissions` and DOM-side types are filtered out by classification and never
 * indexed. `size` counts what was indexed.
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
   * Request reshapes from **all** matching rules, regardless of which won the action — an
   * exception that allows the request can still strip its parameters or headers.
   */
  transforms: {
    /** Parameter names to strip, or `"all"` when any matching rule strips everything. */
    removeParams: string[] | "all";
    /** Header names to strip before forwarding. */
    removeHeaders: string[];
    /** A `$csp=` policy the response should carry; absent when no matching rule set one. */
    csp?: string;
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

/** One rule, compiled to the index: precomputed flags, conditions and transform payload. */
interface CompiledRequestRule {
  raw: string;
  isException: boolean;
  isImportant: boolean;
  /** `$badfilter` identity — pattern plus sorted modifiers, matching `domainEvaluator`. */
  identity: string;
  /** Restricting conditions; every one must hold for the rule to match. */
  conditions: Array<(ctx: RequestContext) => boolean>;
  /** `$denyallow=` hosts exempted from this block. */
  denyAllowDomains: string[];
  /** True when this rule strips every query parameter. */
  removeAllParams: boolean;
  removeParamNames: string[];
  removeHeaders: string[];
  csp?: string;
}

/** A path/pattern rule and its URL test — the scan-list half of the index. */
interface ScannedRule {
  rule: CompiledRequestRule;
  test: (url: string) => boolean;
}

/**
 * Split a raw rule into pattern body and lower-cased `$`-modifiers. `@@` is reported through
 * `isException` and stripped from the body, so the body is what a URL matcher would see.
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
          .toLowerCase()
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
 * trailing `|` turning it into an exact match. The shared URL matcher reads the same text as
 * host+path and would match `https://x/p` — looser than the anchor promises — so this shape
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

/** Compile one classified rule; null when nothing about it can be indexed. */
function compileRule(
  raw: string,
  isExceptionFlag: boolean,
): { rule: CompiledRequestRule; body: string; isBadfilter: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const isException = isExceptionFlag || trimmed.startsWith("@@");
  const { body, modifiers } = splitRule(trimmed);
  if (!body) return null;

  const rule: CompiledRequestRule = {
    raw: trimmed,
    isException,
    isImportant: modifiers.includes("important"),
    identity: ruleIdentity(body, isException, modifiers),
    conditions: [],
    denyAllowDomains: [],
    removeAllParams: false,
    removeParamNames: [],
    removeHeaders: [],
    csp: undefined,
  };
  let isBadfilter = false;

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
    if (name === "denyallow" && !negated && value) {
      for (const entry of value.split("|")) {
        const domain = entry.trim().replace(/^\*\./, "").toLowerCase();
        if (domain) rule.denyAllowDomains.push(domain);
      }
      continue;
    }
    if (name === "removeparam") {
      // Bare, `*`, `~name` and `/regex/` all mean "strip everything" to this shape — the
      // `string[]` form cannot express an exclusion or a pattern, and `"all"` is the honest
      // nearest rather than a guess.
      if (!value || value === "*" || value.startsWith("~") || value.startsWith("/")) {
        rule.removeAllParams = true;
      } else {
        for (const entry of value.split("|")) {
          const param = entry.trim();
          if (param) rule.removeParamNames.push(param);
        }
      }
      continue;
    }
    if (name === "removeheader") {
      // `request:`/`response:` prefixes name the side the strip applies to; the pipeline
      // decides which it can act on, so the transform keeps the bare header name.
      const header = value.replace(/^(?:request|response):/, "").trim();
      if (header) rule.removeHeaders.push(header);
      continue;
    }
    if (name === "csp") {
      if (value && rule.csp === undefined) rule.csp = value;
      continue;
    }
    // Actions this verdict expresses as "the request was intercepted" — closest to blocked.
    if (name === "redirect" || name === "redirect-rule" || name === "empty" || name === "mp4" || name === "noop") {
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
    // Everything else needs context this interface does not carry (`$domain=` above all), so
    // the rule can never fire — the refusal is explicit rather than a silent zone collapse.
    rule.conditions.push(NEVER);
  }

  return { rule, body, isBadfilter };
}

function addToMap(map: Map<string, CompiledRequestRule[]>, key: string, rule: CompiledRequestRule): void {
  const existing = map.get(key);
  if (existing) existing.push(rule);
  else map.set(key, [rule]);
}

/**
 * Compiles raw filter lines into a request evaluator.
 *
 * The index mirrors the mobile matcher's structure: `||domain^`-shaped rules go into suffix
 * maps walked along the request host's labels, and path/pattern rules — anything carrying a
 * `/`, a `|` anchor, a wildcard host or a `/regex/` — are compiled into per-request tests.
 */
export function createRequestEvaluator(rawRules: string[]): RequestEvaluator {
  const stored = parseFilterList(rawRules.join("\n"), "request-evaluator");

  const hostBlocks = new Map<string, CompiledRequestRule[]>();
  const hostExceptions = new Map<string, CompiledRequestRule[]>();
  const exactBlocks = new Map<string, CompiledRequestRule[]>();
  const exactExceptions = new Map<string, CompiledRequestRule[]>();
  const blockScan: ScannedRule[] = [];
  const exceptionScan: ScannedRule[] = [];
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
    if (hostKey && hostKey.includes("*")) {
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
    if (test) (rule.isException ? exceptionScan : blockScan).push({ rule, test });
  }

  const size =
    [...hostBlocks.values(), ...hostExceptions.values(), ...exactBlocks.values(), ...exactExceptions.values()]
      .reduce((count, list) => count + list.length, 0) +
    blockScan.length +
    exceptionScan.length;

  function evaluate(url: string, ctx: RequestContext = {}): RequestVerdict {
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

    for (const entry of blockScan) if (entry.test(url)) matched.push(entry.rule);
    for (const entry of exceptionScan) if (entry.test(url)) matched.push(entry.rule);

    const active = matched.filter(
      (rule) =>
        rule.conditions.every((holds) => holds(ctx)) &&
        (rule.isException ||
          rule.denyAllowDomains.length === 0 ||
          !rule.denyAllowDomains.some(
            (domain) => host === domain || (host !== null && host.endsWith(`.${domain}`)),
          )) &&
        !badfilters.has(rule.identity),
    );

    let removeAll = false;
    const removeParamSet = new Set<string>();
    const removeHeaderSet = new Set<string>();
    let csp: string | undefined;
    for (const rule of active) {
      if (rule.removeAllParams) removeAll = true;
      for (const param of rule.removeParamNames) removeParamSet.add(param);
      for (const header of rule.removeHeaders) removeHeaderSet.add(header);
      if (rule.csp !== undefined && csp === undefined) csp = rule.csp;
    }

    // Precedence, mirroring CompiledDomainRuleSet: important exception > important block >
    // exception > block > nothing.
    const winner =
      active.find((rule) => rule.isException && rule.isImportant) ??
      active.find((rule) => !rule.isException && rule.isImportant) ??
      active.find((rule) => rule.isException) ??
      active.find((rule) => !rule.isException) ??
      null;

    return {
      action: winner === null ? "allowed" : winner.isException ? "exception" : "blocked",
      coveringRule: winner?.raw ?? null,
      transforms: {
        removeParams: removeAll ? "all" : [...removeParamSet],
        removeHeaders: [...removeHeaderSet],
        ...(csp !== undefined ? { csp } : {}),
      },
    };
  }

  return { evaluate, size };
}
