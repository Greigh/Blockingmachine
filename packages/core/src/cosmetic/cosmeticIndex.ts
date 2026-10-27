/**
 * Cosmetic/scriptlet rule index — the response-depth half of the filter list.
 *
 * `browser.txt` carries ~130k element-hiding, style-injection and scriptlet rules
 * that the network evaluator has always ignored (`evaluateRequest.ts` indexes only
 * request rules). This index is the per-host answer for them: one pass over the
 * line array, then `forHost(host)` returns everything that page should receive —
 * hide selectors, raw style bodies and parsed scriptlet invocations — with
 * exceptions already applied.
 *
 * Syntaxes handled (the classification reference is `RuleProcessor.ts`):
 *
 *  - `[domains]##sel` / `[domains]#@#sel` — element hiding + exceptions.
 *  - `[domains]##+js(name, arg, …)` / `#@#+js(...)`, plus the AdGuard-flavoured
 *    single-`#` forms `[domains]#+js(...)` / `#@+js(...)` — scriptlet invocations
 *    and their exceptions.
 *  - `[domains]#%#//scriptlet('name', 'arg', …)` / `#@%#//scriptlet(...)` —
 *    AdGuard scriptlet invocations/exceptions. A `#%#`/`#@%#` body that is not a
 *    `//scriptlet(...)` call is an AdGuard raw-JS rule: it cannot map onto a named
 *    scriptlet and the injected runtime must never eval rule-provided source, so
 *    it is parsed-and-skipped (`stats.rawJsRules`).
 *  - `[domains]#$#sel { css }` / `[domains]#@$#sel { css }` — style rules +
 *    exceptions, keyed by their selector part.
 *  - `[domains]#?#sel` / `#@?#`, `#$?#` / `#@$?#` — extended-CSS and
 *    extended-style rules. The CSS-expressible subset is translated and
 *    emitted like its plain-marker twin (`:-abp-has(sel)` → `:has(sel)`,
 *    `:matches(sel)` → `:is(sel)` — flag 104); rules carrying procedural
 *    pseudos no `<style>` element can express (`:-abp-contains`,
 *    `:has-text`, `:matches-css*`, `:upward`, `:matches-path`, `if`,
 *    `remove`, `style`, the `abp-*` family, …) stay skipped, now counted
 *    in `stats.extendedUnsupported` rather than silently.
 *
 * Domain prefixes are comma-separated token lists; each token is an include
 * (`example.com`), an exclusion (`~ads.example.com`), an entity wildcard
 * (`sony.*` — the label that must be the registered domain's SLD, so `sony.*`
 * hits `sony.co.jp` but not `sonyplc.com` or `sony.com.evil.example`), or a
 * subdomain-scoped entity (`*.sony.*` — proper subdomains of any `sony`
 * entity only: `x.sony.com` and `y.sony.co.jp` match, the apex `sony.com`
 * does not — flag 112). A token
 * list of only `~` exclusions is a global rule that vetoes those hosts — that
 * shape is common in the wild (`~addtoany.com##a[href=…]`). `~` vetoes only the
 * rule it sits on. `[$path=…]` / `[$domain=…]` AdGuard modifier prefixes scope by
 * something this index cannot match, so those rules are skipped with a stat —
 * under-injecting a path-scoped rule is the honest direction.
 *
 * Exception semantics are uBO's: a `#@#` exception removes its literal selector
 * for that host wherever the selector came from (global or domain rule); one
 * whose selector was never injected is a no-op. Scriptlet exceptions are
 * literal-match on the whole call — name plus the exact arg list — so a
 * name-only `#@#+js(name)` cancels only the zero-arg call, and an empty-name
 * `#@#+js()` cancels every scriptlet on the host (bare, globally). A
 * `:matches-path(…)` tail scopes an exception to matching request paths —
 * `host#@#+js():matches-path(/ads/)` kills all scriptlets on `host/ads/*`
 * only (flag 107): the arg compiles like the `[$path=]` convention —
 * `/re/` is a regex, anything else is a path-anchored glob (`*` wildcards,
 * a trailing `|` end-anchor). When the caller supplies no path the
 * exception applies unconditionally — under-injecting scriptlets is the
 * honest direction for an exception the list meant to fire. A path-scoped
 * *invocation* (`##+js(name):matches-path(…)`) still skips via
 * `scopeModifiers`, the equally honest under-direction for rules. Names
 * canonicalize through the uBO↔AdGuard alias table
 * ({@link canonicalScriptletName}) before comparison — a deliberate superset
 * of uBO's text match. Names the table doesn't know are emitted raw
 * and counted in `skippedScriptlets` — running them is the library's decision.
 *
 * Lookup is one suffix walk over the host's labels (a dotted suffix map for plain
 * tokens, the entity set resolved through {@link decomposeDomain}'s registrable
 * domain). `forHost` returns `undefined` when nothing survives — the hot-path
 * skip that lets a page with no cosmetics pay near-zero cost.
 */

import { decomposeDomain } from "../ai/entropy.js";
import {
  checkListSelectorStructure,
  MAX_LIST_SELECTOR_LENGTH,
  translateExtendedSelector,
} from "./selectorSafety.js";

export interface ScriptletCall {
  /** Canonical name when the alias table resolved one, the raw list name otherwise. */
  name: string;
  args: string[];
}

export interface CosmeticPayload {
  /** Validated selectors for the `<style>sel{display:none!important}` element. */
  hide: string[];
  /** `#$#` raw CSS bodies — `selector { declarations }` text, injected verbatim. */
  styles: string[];
  /** Parsed scriptlet invocations; non-canonical names are included, not run yet. */
  scriptlets: ScriptletCall[];
  /** Emitted scriptlets whose name is not in {@link CANONICAL_SCRIPTLET_NAMES}. */
  skippedScriptlets: number;
}

export interface CosmeticIndexStats {
  /** Input lines examined. */
  totalLines: number;
  /** Lines with no cosmetic marker (network rules, comments, list headers). */
  notCosmetic: number;
  /** `#?#`/`#@?#` extended-CSS marker rules seen — translatable subset emitted. */
  extendedCss: number;
  /** `#$?#`/`#@$?#` extended-style marker rules seen — translatable subset emitted. */
  extendedStyles: number;
  /**
   * Extended-marker rules skipped for carrying procedural pseudos no
   * `<style>` element can express (`:contains`, `:has-text`,
   * `:matches-css*`, `:upward`, `:matches-path`, `abp-*`, unknown
   * functional pseudos). The honest-accounting bucket of flag 104.
   */
  extendedUnsupported: number;
  /** `[$modifier=…]`-prefixed rules and `+js` lines with a procedural tail. */
  scopeModifiers: number;
  /** `#%#`/`#@%#` bodies that are raw JS rather than a `//scriptlet(…)` call. */
  rawJsRules: number;
  /** Hide selectors rejected by the structural safety check. */
  invalidSelectors: number;
  /** Rules whose domain list contained no usable include or exclusion token. */
  unusableDomains: number;
  /** Marker found but the body could not be parsed (bad `+js`, empty body, …). */
  malformed: number;
}

export interface CosmeticIndex {
  /**
   * Everything a page on `host` should receive, exceptions already applied —
   * `undefined` when nothing survives (the hot-path skip). The returned payload
   * is an index-owned, frozen object shared across repeat calls; callers must
   * not mutate it.
   *
   * `path` is the request path the page was fetched under — `/ads/x?y=1`,
   * or a full URL whose path+search is taken. It refines `:matches-path(…)`
   * scriptlet exceptions to the paths the list scoped them to; a path-scoped
   * exception applies unconditionally when no path is supplied (the
   * under-injection direction — flag 107).
   */
  forHost(host: string, path?: string): CosmeticPayload | undefined;
  /** Indexed populations: hide selectors, hide/style exceptions, scriptlet calls + exceptions, style rules. */
  size(): {
    selectors: number;
    exceptions: number;
    scriptlets: number;
    scriptletExceptions: number;
    styles: number;
  };
  /** Build-time counters for everything parsed-and-skipped. */
  readonly stats: CosmeticIndexStats;
}

/**
 * The canonical scriptlet names this index resolves to — the set Task 2's
 * injected library implements. Everything the alias table maps here is a known
 * quantity; everything else is emitted raw and counted in `skippedScriptlets`.
 */
export const CANONICAL_SCRIPTLET_NAMES: ReadonlySet<string> = new Set([
  "set-constant",
  "abort-on-property-read",
  "abort-on-property-write",
  "abort-current-inline-script",
  "abort-on-stack-trace",
  "prevent-setTimeout",
  "prevent-setInterval",
  "adjust-setTimeout",
  "adjust-setInterval",
  "prevent-fetch",
  "prevent-xhr",
  "prevent-addEventListener",
  "prevent-window-open",
  "nowebrtc",
  "json-prune",
  "remove-attr",
  "remove-class",
  "set-local-storage-item",
  "set-session-storage-item",
  "remove-local-storage-item",
  "href-sanitizer",
  "spoof-css",
  "prevent-eval-if",
  "no-protected-audience",
]);

/**
 * uBO / Nano / legacy-AdGuard spellings → the name the injected library consumes.
 * Keys are lower-cased, `.js`-stripped. Values are the canonical set above where
 * one exists; a handful resolve to real upstream names outside the implemented
 * set (`remove-node-text`, `prevent-refresh`, …) so stats report the intent —
 * those are still counted as skipped since the library can't run them.
 */
const SCRIPTLET_NAME_ALIASES: Readonly<Record<string, string>> = {
  // → the canonical set
  aopr: "abort-on-property-read",
  aopw: "abort-on-property-write",
  acs: "abort-current-inline-script",
  acis: "abort-current-inline-script",
  "abort-current-script": "abort-current-inline-script",
  aost: "abort-on-stack-trace",
  aeld: "prevent-addEventListener",
  "addeventlistener-defuser": "prevent-addEventListener",
  nostif: "prevent-setTimeout",
  "no-settimeout-if": "prevent-setTimeout",
  nosiif: "prevent-setInterval",
  "no-setinterval-if": "prevent-setInterval",
  "nano-stb": "adjust-setTimeout",
  "nano-settimeout-booster": "adjust-setTimeout",
  "nano-sib": "adjust-setInterval",
  "nano-setinterval-booster": "adjust-setInterval",
  "no-fetch-if": "prevent-fetch",
  "no-xhr-if": "prevent-xhr",
  nowoif: "prevent-window-open",
  "no-window-open-if": "prevent-window-open",
  "window.open-defuser": "prevent-window-open",
  noeval: "prevent-eval-if",
  "noeval-if": "prevent-eval-if",
  "no-eval-if": "prevent-eval-if",
  set: "set-constant",
  setconstant: "set-constant",
  ra: "remove-attr",
  rc: "remove-class",
  // AdGuard's legacy camelCase spellings — each lower-cased camel key resolves
  // to a name in the canonical set (verified, not guessed).
  abortonpropertyread: "abort-on-property-read",
  abortonpropertywrite: "abort-on-property-write",
  abortcurrentinlinescript: "abort-current-inline-script",
  abortonstacktrace: "abort-on-stack-trace",
  preventsettimeout: "prevent-setTimeout",
  preventsetinterval: "prevent-setInterval",
  adjustsettimeout: "adjust-setTimeout",
  adjustsetinterval: "adjust-setInterval",
  preventfetch: "prevent-fetch",
  preventxhr: "prevent-xhr",
  preventaddeventlistener: "prevent-addEventListener",
  preventwindowopen: "prevent-window-open",
  jsonprune: "json-prune",
  removeattr: "remove-attr",
  removeclass: "remove-class",
  setlocalstorageitem: "set-local-storage-item",
  setsessionstorageitem: "set-session-storage-item",
  removelocalstorageitem: "remove-local-storage-item",
  hrefsanitizer: "href-sanitizer",
  spoofcss: "spoof-css",
  preventevalif: "prevent-eval-if",
  noprotectedaudience: "no-protected-audience",
  // camelCase forms of the existing `no-*-if` spellings.
  nowindowopenif: "prevent-window-open",
  noevalif: "prevent-eval-if",
  nofetchif: "prevent-fetch",
  noxhrif: "prevent-xhr",
  nosettimeoutif: "prevent-setTimeout",
  nosetintervalif: "prevent-setInterval",
  // → real upstream names outside the implemented set (counted as skipped)
  rpnt: "remove-node-text",
  removenodetext: "remove-node-text",
  rmnt: "remove-node-text",
  "replace-node-text": "remove-node-text",
  aell: "addEventListener-logger",
  norafif: "prevent-requestAnimationFrame",
  "no-requestanimationframe-if": "prevent-requestAnimationFrame",
  "refresh-defuser": "prevent-refresh",
  "no-refresh-if": "prevent-refresh",
  norefreshif: "prevent-refresh",
  norequestanimationframeif: "prevent-requestAnimationFrame",
  "cookie-remover": "remove-cookie",
  nobab: "prevent-bab",
  "no-bab": "prevent-bab",
  "bab-defuser": "prevent-bab",
  "trusted-rpnt": "trusted-replace-node-text",
  "trusted-rpfr": "trusted-replace-fetch-response",
  "trusted-set": "trusted-set-constant",
};

/** Canonical names keyed by their lower-case form, so case variants fold too. */
const CANONICAL_LOWER: ReadonlyMap<string, string> = new Map(
  [...CANONICAL_SCRIPTLET_NAMES].map((name) => [name.toLowerCase(), name]),
);

/**
 * Resolves a list-authored scriptlet name to the canonical spelling the injected
 * library consumes — uBO terse (`aopr`), Nano (`nano-sib`), AdGuard legacy
 * camelCase (`abortOnPropertyRead`, `noWindowOpenIf`) and `ubo`-prefixed
 * spellings (`ubo-set-constant`) all fold into one name set. The `ubo` prefix
 * strips only onto a known name — a coincidental `ubo`-leading unknown stays
 * raw. Unknown names are returned raw.
 */
export function canonicalScriptletName(rawName: string): string {
  const key = rawName.endsWith(".js") ? rawName.slice(0, -3) : rawName;
  const lower = key.toLowerCase();
  const direct = SCRIPTLET_NAME_ALIASES[lower] ?? CANONICAL_LOWER.get(lower);
  if (direct) return direct;
  const stripped = lower.replace(/^ubo[-_.]?/, "");
  if (stripped !== lower) {
    const resolved =
      SCRIPTLET_NAME_ALIASES[stripped] ?? CANONICAL_LOWER.get(stripped);
    if (resolved) return resolved;
  }
  return key;
}

/** One domain-prefix token: a host suffix, a `*.`-prefixed subdomains-only
 * suffix (AdGuard semantics — the apex is not covered), an entity whose SLD
 * must equal `name`, a `*.`-prefixed entity (subdomains of the entity only —
 * `*.sony.*` covers `x.sony.com` but never the apex `sony.com`), or `~*`'s
 * match-everything exclusion. */
type DomainToken =
  | { kind: "host"; suffix: string }
  | { kind: "sub"; suffix: string }
  | { kind: "entity"; name: string }
  | { kind: "subEntity"; name: string }
  | { kind: "all" };

type EntryKind =
  | "hide"
  | "hideException"
  | "style"
  | "styleException"
  | "scriptlet"
  | "scriptletException";

interface CosmeticEntry {
  kind: EntryKind;
  /** Hide/exception literal selector, or the style rule's selector part. */
  selector: string;
  /** `#$#` raw body — `selector { declarations }`, injected verbatim. */
  css?: string;
  /** Parsed scriptlet invocation (name already canonicalized at build). */
  call?: ScriptletCall;
  /**
   * `:matches-path(…)` scope — only ever set on `scriptletException`
   * entries. The exception applies when the lookup carries no path or the
   * path matches; a supplied non-matching path keeps it out of the answer.
   */
  pathPattern?: RegExp;
  /** `~` exclusions carried by the rule this entry came from — veto it only. */
  excludes: DomainToken[];
}

interface MarkerHit {
  /** Index of the `#` that opens the marker — everything before it is the domain prefix. */
  index: number;
  /** Everything at/after `bodyIndex` is the rule body. */
  bodyIndex: number;
  kind:
    | "hide"
    | "hideException"
    | "style"
    | "styleException"
    | "scriptlet"
    | "scriptletException"
    | "extendedCss"
    | "extendedCssException"
    | "extendedStyle"
    | "extendedStyleException";
}

/**
 * Finds the first cosmetic marker in the line. Markers are checked longest-first
 * at each `#` position so `#@$?#` never degrades into `#@$#` + junk, and the
 * first `#` wins because domain prefixes can't contain `#`. A `##`/`#@#` whose
 * body opens with `+js(` is the uBO scriptlet/exception form, not a selector.
 */
function findMarker(line: string): MarkerHit | null {
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) !== 35 /* # */) continue;
    const at = line.charCodeAt(i + 1);
    if (at === 64 /* @ */) {
      if (line.startsWith("#@$?#", i))
        return { index: i, bodyIndex: i + 5, kind: "extendedStyleException" };
      if (line.startsWith("#@?#", i))
        return { index: i, bodyIndex: i + 4, kind: "extendedCssException" };
      if (line.startsWith("#@$#", i))
        return { index: i, bodyIndex: i + 4, kind: "styleException" };
      if (line.startsWith("#@%#", i))
        return { index: i, bodyIndex: i + 4, kind: "scriptletException" };
      if (line.startsWith("#@+js(", i))
        return { index: i, bodyIndex: i + 2, kind: "scriptletException" };
      if (line.startsWith("#@#", i))
        return { index: i, bodyIndex: i + 3, kind: "hideException" };
      continue;
    }
    if (line.startsWith("#$?#", i))
      return { index: i, bodyIndex: i + 4, kind: "extendedStyle" };
    if (line.startsWith("#?#", i))
      return { index: i, bodyIndex: i + 3, kind: "extendedCss" };
    if (line.startsWith("#$#", i))
      return { index: i, bodyIndex: i + 3, kind: "style" };
    if (line.startsWith("#%#", i))
      return { index: i, bodyIndex: i + 3, kind: "scriptlet" };
    if (line.startsWith("#+js(", i))
      return { index: i, bodyIndex: i + 1, kind: "scriptlet" };
    if (line.startsWith("##", i))
      return { index: i, bodyIndex: i + 2, kind: "hide" };
  }
  return null;
}

/**
 * Parses the domain prefix into include/exclude tokens. `~` marks an exclusion,
 * a trailing `.*` marks an entity wildcard, a leading `*.` scopes to subdomains
 * only (AdGuard semantics — `*.foo.com` does not cover bare `foo.com`), a bare
 * `*` token makes the rule global, and `~*` is AdGuard's exclude-everything —
 * the rule applies nowhere, not everywhere. The combined `*.sony.*` shape is
 * both qualifiers at once — subdomains of any `sony` entity, never the apex
 * itself (flag 112). Tokens that can never be a host —
 * whitespace, `/`, `>`, quotes, brackets — are dropped; when the list held
 * include tokens but none survive, the caller skips the rule rather than letting
 * it silently become global.
 */
function parseDomainList(prefix: string): {
  includes: DomainToken[];
  excludes: DomainToken[];
  global: boolean;
  hadInvalidInclude: boolean;
} {
  const includes: DomainToken[] = [];
  const excludes: DomainToken[] = [];
  let global = false;
  let hadInvalidInclude = false;
  const parts = prefix.split(",");
  for (const rawPart of parts) {
    let token = rawPart.trim().toLowerCase();
    if (!token) continue;
    const excluded = token.startsWith("~");
    if (excluded) token = token.slice(1).trim();
    const subdomainsOnly = token.startsWith("*.");
    if (subdomainsOnly) token = token.slice(2);
    if (!token) continue;
    if (token === "*") {
      // A bare `*` include is the global form; `~*` excludes every host, so
      // the rule applies nowhere — inverting it to `global` would inject the
      // rule on the exact complement of what the list author meant.
      if (excluded) excludes.push({ kind: "all" });
      else global = true;
      continue;
    }
    if (token.endsWith(".*")) {
      const name = token.slice(0, -2);
      if (name && !name.includes(".") && !/[^\p{L}\p{N}_-]/u.test(name)) {
        (excluded ? excludes : includes).push(
          subdomainsOnly
            ? { kind: "subEntity", name }
            : { kind: "entity", name },
        );
      } else if (!excluded) {
        hadInvalidInclude = true;
      }
      continue;
    }
    // Loose host-token validation: letters (incl. IDN), digits, `.`, `-`, `_`.
    if (/[^\p{L}\p{N}._-]/u.test(token) || token.includes("..")) {
      if (excluded) continue; // A dead exclusion can only fail to veto.
      hadInvalidInclude = true;
      continue;
    }
    (excluded ? excludes : includes).push(
      subdomainsOnly
        ? { kind: "sub", suffix: token }
        : { kind: "host", suffix: token },
    );
  }
  return { includes, excludes, global, hadInvalidInclude };
}

/** Hostname normalization the proxy already applies — repeated defensively here. */
function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** `example.com` matches `example.com` and `a.b.example.com` — never `notexample.com`. */
function hostTokenMatches(suffix: string, host: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * JS string-literal escapes for a quoted scriptlet arg — the AdGuard
 * `//scriptlet('…')` contract. `\n`/`\t`/`\r`/`\b`/`\f`/`\v`/`\0`/`\/` map like
 * JS; `\xHH` and `\uHHHH` decode; anything else drops the backslash, which is
 * what a JS string does with an unrecognized escape.
 */
function unescapeQuotedArg(text: string): string {
  if (!text.includes("\\")) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "\\" || i + 1 >= text.length) {
      out += ch;
      continue;
    }
    const next = text[++i];
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "0":
        out += "\0";
        break;
      case "x": {
        const hex = text.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
        } else {
          out += "x";
        }
        break;
      }
      case "u": {
        const hex = text.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += "u";
        }
        break;
      }
      default:
        // `\'`, `\"`, `\\`, `\,`, `/` → the char itself; unknown escapes too.
        out += next;
    }
  }
  return out;
}

/**
 * Splits a scriptlet argument string on top-level commas. Quotes (`'`/`"`/`` ` ``)
 * group, a `\` escapes the next character, and `{}`/`[]`/`()` blocks nest — uBO
 * lists pass bare object literals (`+js(set, x, { cmd: { y: 1 } })`) and
 * parenthesised calls whose inner commas must not split. A quote only opens a
 * quoted span at the *start* of an arg — a mid-token `'` is an apostrophe
 * (`it's`), not a string delimiter, and must not swallow the rest of the list.
 * Outside quotes `\,` unescapes to a literal comma; other backslashes stay
 * (regex args like `/\"homad\"/ ` carry them). `` `…` `` args (uBO ≥1.61) are
 * raw literals — no backslash processing on unquoting.
 */
function splitScriptletArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote = "";
  let depth = 0;
  const push = () => {
    const trimmed = current.trim();
    current = "";
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (
      trimmed.length >= 2 &&
      (first === "'" || first === '"' || first === "`") &&
      last === first
    ) {
      const inner = trimmed.slice(1, -1);
      args.push(first === "`" ? inner : unescapeQuotedArg(inner));
    } else {
      args.push(trimmed);
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && i + 1 < text.length) {
        current += ch + text[++i];
        continue;
      }
      if (ch === quote) quote = "";
      current += ch;
      continue;
    }
    if (ch === "\\") {
      // `\,` is an escaped comma; any other escape rides through verbatim so a
      // regex arg like `/a\.b/` keeps its backslash.
      if (i + 1 < text.length && text[i + 1] === ",") {
        current += ",";
        i += 1;
      } else if (i + 1 < text.length) {
        current += ch + text[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      // Only an arg-leading quote delimits — `it's` mid-token is literal.
      if (!current.trim()) quote = ch;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      current += ch;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      if (depth > 0) depth--;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return args;
}

/**
 * Reads the `)` that closes a `+js(`/`//scriptlet(` call — quote-aware
 * (`'`/`"`/`` ` ``), and `{}`/`[]`/`()`-depth aware so object-literal args and
 * parenthesised expressions can't end the call early. Returns -1 when the
 * call never closes. Known limitation: `/` is not treated as a delimiter, so
 * a *bare* regex arg containing an unbalanced `)` (`+js(set, x, /a)b/)`)
 * closes the call early — wild lists quote or backtick such args, matching
 * uBO's own tolerance here rather than growing a regex-literal scanner.
 */
function findCallClose(text: string, openIndex: number): number {
  let quote = "";
  let depth = 0;
  for (let i = openIndex + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) return ch === ")" ? i : -1;
      depth--;
    }
  }
  return -1;
}

/**
 * Parses `+js(name, arg, …)` or `//scriptlet('name', 'arg', …)` into a call.
 * Returns the parsed call plus the raw text trailing the closing paren — a
 * `:matches-path(...)`/`[...]` tail makes the rule scoped, which the caller
 * classifies (flag 107). An empty name parses through as `name: ""` — the
 * `#@#+js()` kill-all sentinel — and the caller decides whether the shape is
 * meaningful (an exception) or malformed (an invocation).
 */
function parseScriptletCall(
  body: string,
): { call: ScriptletCall; trailingText: string } | null {
  const trimmed = body.trim();
  const open = trimmed.startsWith("+js(")
    ? 3
    : trimmed.startsWith("//scriptlet(")
      ? 11
      : -1;
  if (open < 0) return null;
  let close = findCallClose(trimmed, open);
  if (close < 0) {
    // Wild lists ship unterminated quoted args (`+js(aeld, , '\'')` is real
    // upstream data) — uBO tolerates them, so fall back to the last `)` before
    // declaring the whole call malformed.
    close = trimmed.lastIndexOf(")");
    if (close <= open) return null;
  }
  const inner = trimmed.slice(open + 1, close);
  const trailingText = trimmed.slice(close + 1).trim();
  const args = splitScriptletArgs(inner);
  const rawName = args.shift()?.trim() ?? "";
  return {
    call: {
      name: rawName === "" ? "" : canonicalScriptletName(rawName),
      args,
    },
    trailingText,
  };
}

/** Escapes a literal character for regex use. */
function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles a `:matches-path(arg)` trailing modifier to its matcher, or
 * classifies the tail. Returns:
 *
 *  - `null` — no trailing text at all (the call is unscoped),
 *  - `undefined` — trailing text that is not a well-formed
 *    `:matches-path(…)` (some other scope the index cannot honor — the
 *    caller counts it as a scope modifier),
 *  - a `RegExp` — the path test.
 *
 * The arg compiles by the `[$path=]` convention the rest of the pipeline
 * documents: wrapped in `/…/` it is a regex; anything else is a prefix-
 * anchored glob — `*` wildcards, a trailing `|` end-anchors the match, and
 * a bare literal is a path prefix (`/ads` covers `/ads`, `/ads/x`).
 * An arg that cannot compile degrades to "unscoped" — the exception then
 * applies unconditionally, the honest under-injection direction for a
 * scope whose intent cannot be recovered.
 */
function parsePathScope(trailing: string): RegExp | null | undefined {
  const t = trailing.trim();
  if (!t) return null;
  const marker = ":matches-path(";
  if (!t.startsWith(marker)) return undefined;
  const open = marker.length - 1;
  const close = findCallClose(t, open);
  if (close < 0 || t.slice(close + 1).trim() !== "") return undefined;
  const arg = t.slice(open + 1, close).trim();
  if (!arg) return null;
  if (arg.length >= 2 && arg.startsWith("/") && arg.endsWith("/")) {
    try {
      return new RegExp(arg.slice(1, -1), "i");
    } catch {
      return null;
    }
  }
  let pattern = arg;
  let endAnchored = false;
  if (pattern.endsWith("|")) {
    endAnchored = true;
    pattern = pattern.slice(0, -1);
  }
  // A leading `|` is redundant against the prefix anchor.
  if (pattern.startsWith("|")) pattern = pattern.slice(1);
  let source = "^";
  for (const ch of pattern) {
    source += ch === "*" ? ".*" : escapeRegExpChar(ch);
  }
  if (endAnchored) source += "$";
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

/**
 * Normalizes the optional `path` argument of `forHost` — a request path is
 * taken verbatim (a bare `x` gains its leading `/`), a full URL contributes
 * its `pathname + search`. Anything unusable degrades to `undefined`, the
 * no-path posture.
 */
function normalizeLookupPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  let p = path.trim();
  if (!p) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) {
    try {
      const parsed = new URL(p);
      p = parsed.pathname + parsed.search;
    } catch {
      return undefined;
    }
  }
  if (!p.startsWith("/")) p = `/${p}`;
  return p;
}

/** `#$#` body → the selector part that keys it, or null when there is no `{`. */
function styleSelectorKey(body: string): string | null {
  const brace = body.indexOf("{");
  if (brace < 0) return null;
  const key = body.slice(0, brace).trim();
  return key || null;
}

export function createCosmeticIndex(lines: string[]): CosmeticIndex {
  const stats: CosmeticIndexStats = {
    totalLines: 0,
    notCosmetic: 0,
    extendedCss: 0,
    extendedStyles: 0,
    extendedUnsupported: 0,
    scopeModifiers: 0,
    rawJsRules: 0,
    invalidSelectors: 0,
    unusableDomains: 0,
    malformed: 0,
  };

  // Global rules (no include token — includes only-`~` lists and `*`), keyed
  // domain rules, and entity rules each keep the rule's own exclusions on the
  // entry so a `~` vetoes its own rule only. `*.foo.com` include tokens key
  // into `subdomainEntries` — the suffix walk consults them only for proper
  // subdomains, so the apex itself is not covered (AdGuard `*.` semantics).
  // `*.name.*` tokens key into `subEntityEntries` — consulted only when the
  // host's decomposition shows a label left of the registrable domain.
  // `globalEntries` holds every stored global for the merge path;
  // `globalConditional` is the subset carrying `~` exclusions or a
  // `:matches-path` scope — the only part of the global bucket a per-host
  // lookup still has to veto-check per host.
  const globalEntries: CosmeticEntry[] = [];
  const globalConditional: CosmeticEntry[] = [];
  const domainEntries = new Map<string, CosmeticEntry[]>();
  const subdomainEntries = new Map<string, CosmeticEntry[]>();
  const entityEntries = new Map<string, CosmeticEntry[]>();
  const subEntityEntries = new Map<string, CosmeticEntry[]>();
  let hasEntityRules = false;
  let hasSubEntityRules = false;
  // `:matches-path`-scoped exceptions make the resolved payload
  // path-dependent: `hasPathScoped` switches the payload cache to a
  // host+path key, and `hasGlobalPathScoped` (the subset in
  // `globalConditional`) gates the shared-global fast path, whose
  // `globalSharedPayload` is the no-path resolution.
  let hasPathScoped = false;
  let hasGlobalPathScoped = false;

  const counts = {
    selectors: 0,
    exceptions: 0,
    scriptlets: 0,
    scriptletExceptions: 0,
    styles: 0,
  };

  const store = (
    domains: ReturnType<typeof parseDomainList>,
    entry: CosmeticEntry,
  ) => {
    // A `~*` exclusion vetoes its own rule on every host — storing the entry
    // would only make every later lookup re-verify a rule that can never fire.
    if (entry.excludes.some((token) => token.kind === "all")) return;
    if (domains.global || domains.includes.length === 0) {
      globalEntries.push(entry);
      // A `:matches-path` scope needs a per-lookup check just like a `~`
      // exclusion — both live on the conditional side so the shared global
      // payload stays the no-path, no-veto resolution.
      if (entry.excludes.length > 0 || entry.pathPattern !== undefined) {
        globalConditional.push(entry);
        if (entry.pathPattern !== undefined) hasGlobalPathScoped = true;
      }
      return;
    }
    for (const token of domains.includes) {
      if (token.kind === "entity") {
        hasEntityRules = true;
        const bucket = entityEntries.get(token.name);
        if (bucket) bucket.push(entry);
        else entityEntries.set(token.name, [entry]);
      } else if (token.kind === "subEntity") {
        hasSubEntityRules = true;
        const bucket = subEntityEntries.get(token.name);
        if (bucket) bucket.push(entry);
        else subEntityEntries.set(token.name, [entry]);
      } else if (token.kind === "sub") {
        const bucket = subdomainEntries.get(token.suffix);
        if (bucket) bucket.push(entry);
        else subdomainEntries.set(token.suffix, [entry]);
      } else if (token.kind === "host") {
        const bucket = domainEntries.get(token.suffix);
        if (bucket) bucket.push(entry);
        else domainEntries.set(token.suffix, [entry]);
      }
      // "all" tokens are only ever exclusions (`~*`) — includes get `global`.
    }
  };

  for (const rawLine of lines) {
    stats.totalLines++;
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("!") ||
      (line.startsWith("[") && line.endsWith("]"))
    ) {
      stats.notCosmetic++;
      continue;
    }

    // `[$path=…]` / `[$domain=…]` scope a rule by something the index cannot
    // match; skipping beats silently injecting it on every page of the host.
    if (line.startsWith("[$")) {
      stats.scopeModifiers++;
      continue;
    }

    const marker = findMarker(line);
    if (!marker) {
      // `!`-style comments, list headers and network rules carry no marker.
      stats.notCosmetic++;
      continue;
    }

    let kind = marker.kind;
    const body = line.slice(marker.bodyIndex);

    // A `##`/`#@#` body that opens with `+js(` is the uBO scriptlet form.
    if (kind === "hide" && body.startsWith("+js(")) kind = "scriptlet";
    else if (kind === "hideException" && body.startsWith("+js("))
      kind = "scriptletException";

    // Extended markers are counted as seen, then routed through translation
    // in the switch below — the unsupported residue lands in
    // `extendedUnsupported`, never silently applied or silently dropped.
    if (kind === "extendedCss" || kind === "extendedCssException") {
      stats.extendedCss++;
    } else if (kind === "extendedStyle" || kind === "extendedStyleException") {
      stats.extendedStyles++;
    }

    const prefixText = line.slice(0, marker.index).trim();
    // An empty prefix is the global form (`##sel`, `#@#.sel`); a non-empty one
    // must yield at least one usable token — a prefix whose only usable tokens
    // are `~` exclusions is still global (the `~foo.com##sel` idiom), but a
    // prefix whose include tokens were all unusable scopes to nowhere honest,
    // so the rule is skipped rather than silently made global.
    const domains = prefixText
      ? parseDomainList(prefixText)
      : {
          includes: [] as DomainToken[],
          excludes: [] as DomainToken[],
          global: true,
          hadInvalidInclude: false,
        };
    if (
      !domains.global &&
      domains.includes.length === 0 &&
      (domains.excludes.length === 0 || domains.hadInvalidInclude)
    ) {
      stats.unusableDomains++;
      continue;
    }

    switch (kind) {
      case "hide": {
        const selector = body.trim();
        if (!selector) {
          stats.malformed++;
          continue;
        }
        if (
          !checkListSelectorStructure(selector, MAX_LIST_SELECTOR_LENGTH).ok
        ) {
          stats.invalidSelectors++;
          continue;
        }
        store(domains, { kind: "hide", selector, excludes: domains.excludes });
        counts.selectors++;
        continue;
      }
      case "hideException": {
        // Exceptions match by literal string equality — no safety check: the
        // worst a weird selector can do is fail to equal anything.
        const selector = body.trim();
        if (!selector) {
          stats.malformed++;
          continue;
        }
        store(domains, {
          kind: "hideException",
          selector,
          excludes: domains.excludes,
        });
        counts.exceptions++;
        continue;
      }
      case "style": {
        const css = body.trim();
        const selector = styleSelectorKey(css);
        // `</` can never appear in real CSS but does break a `<style>` element.
        if (!selector || css.includes("</")) {
          stats.malformed++;
          continue;
        }
        store(domains, {
          kind: "style",
          selector,
          css,
          excludes: domains.excludes,
        });
        counts.styles++;
        continue;
      }
      case "styleException": {
        const selector = styleSelectorKey(body.trim()) ?? body.trim();
        if (!selector) {
          stats.malformed++;
          continue;
        }
        store(domains, {
          kind: "styleException",
          selector,
          excludes: domains.excludes,
        });
        counts.exceptions++;
        continue;
      }
      case "extendedCss":
      case "extendedCssException": {
        // The CSS-expressible subset of `#?#`/`#@?#` (flag 104) — emitted
        // exactly like its `##`/`#@#` twin once the extended pseudos
        // translate. Procedural pseudos a `<style>` cannot express are
        // counted in `extendedUnsupported`; the translated result still
        // passes the same structural gate, so a `:has()` arg cannot
        // smuggle rule-breaking text past it.
        const raw = body.trim();
        if (!raw) {
          stats.malformed++;
          continue;
        }
        const translated = translateExtendedSelector(raw);
        if (!translated.ok) {
          stats.extendedUnsupported++;
          continue;
        }
        if (kind === "extendedCss") {
          if (
            !checkListSelectorStructure(
              translated.selector,
              MAX_LIST_SELECTOR_LENGTH,
            ).ok
          ) {
            stats.invalidSelectors++;
            continue;
          }
          store(domains, {
            kind: "hide",
            selector: translated.selector,
            excludes: domains.excludes,
          });
          counts.selectors++;
        } else {
          // Literal-match exceptions need no structural check — same
          // contract as `hideException`.
          store(domains, {
            kind: "hideException",
            selector: translated.selector,
            excludes: domains.excludes,
          });
          counts.exceptions++;
        }
        continue;
      }
      case "extendedStyle":
      case "extendedStyleException": {
        // `#$?#`/`#@$?#` — the `#$#`/`#@$#` twins with an extended selector.
        // The selector part translates like `#?#`; declarations ride
        // verbatim, and the whole body keeps the `#$#` `</` contract.
        const css = body.trim();
        const brace = css.indexOf("{");
        const selectorPart = (brace < 0 ? css : css.slice(0, brace)).trim();
        if (!selectorPart) {
          stats.malformed++;
          continue;
        }
        const translated = translateExtendedSelector(selectorPart);
        if (!translated.ok) {
          stats.extendedUnsupported++;
          continue;
        }
        if (kind === "extendedStyle") {
          // `</` can never appear in real CSS but does break the element —
          // checked on the whole body (declarations included), and the
          // translated selector itself takes the structural gate so a
          // rewritten pseudo can't open a bare declaration.
          if (
            brace < 0 ||
            css.includes("</") ||
            !checkListSelectorStructure(
              translated.selector,
              MAX_LIST_SELECTOR_LENGTH,
            ).ok
          ) {
            stats.malformed++;
            continue;
          }
          store(domains, {
            kind: "style",
            selector: translated.selector,
            css: `${translated.selector} ${css.slice(brace)}`,
            excludes: domains.excludes,
          });
          counts.styles++;
        } else {
          store(domains, {
            kind: "styleException",
            selector: translated.selector,
            excludes: domains.excludes,
          });
          counts.exceptions++;
        }
        continue;
      }
      case "scriptlet":
      case "scriptletException": {
        // AdGuard `#%#`/`#@%#` markers — only the `//scriptlet(…)` form maps onto
        // a named scriptlet; a raw-JS body is counted, never emitted (the
        // injected runtime does not eval rule-provided source). The `##+js` /
        // `#@#+js` re-detected kinds never reach this branch.
        if (
          (line.startsWith("#%#", marker.index) ||
            line.startsWith("#@%#", marker.index)) &&
          !body.trim().startsWith("//scriptlet(")
        ) {
          stats.rawJsRules++;
          continue;
        }
        const parsed = parseScriptletCall(body);
        if (!parsed) {
          stats.malformed++;
          continue;
        }
        // `:matches-path(…)` is the one trailing scope the index can honor
        // (flag 107); any other tail keeps the `scopeModifiers` posture.
        const pathScope = parsePathScope(parsed.trailingText);
        if (parsed.call.name === "") {
          // `#@#+js()` — the empty-name exception — is uBO's scriptlet
          // kill-all: it cancels every invocation the host would receive,
          // bare or `:matches-path`-scoped. Sentinel name `""` is what the
          // merge reads as cancel-all. The non-exception `##+js()` (any
          // tail) is meaningless, as is a kill-all carrying stray args or
          // an unreadable scope — all malformed.
          if (
            kind !== "scriptletException" ||
            parsed.call.args.length > 0 ||
            pathScope === undefined
          ) {
            stats.malformed++;
            continue;
          }
          if (pathScope !== null) hasPathScoped = true;
          store(domains, {
            kind,
            selector: "",
            call: parsed.call,
            pathPattern: pathScope ?? undefined,
            excludes: domains.excludes,
          });
          counts.scriptletExceptions++;
          continue;
        }
        if (pathScope === undefined) {
          stats.scopeModifiers++;
          continue;
        }
        if (pathScope !== null) {
          // A path-scoped invocation still skips — the under-direction for
          // a rule. The same scope on an EXCEPTION is the over-direction
          // flag 107 names, so it is stored and fires only on matching
          // paths (or unconditionally when the lookup carries no path).
          if (kind !== "scriptletException") {
            stats.scopeModifiers++;
            continue;
          }
          hasPathScoped = true;
          store(domains, {
            kind,
            selector: "",
            call: parsed.call,
            pathPattern: pathScope,
            excludes: domains.excludes,
          });
          counts.scriptletExceptions++;
          continue;
        }
        store(domains, {
          kind,
          selector: "",
          call: parsed.call,
          excludes: domains.excludes,
        });
        if (kind === "scriptlet") counts.scriptlets++;
        else counts.scriptletExceptions++;
        continue;
      }
      default:
        stats.malformed++;
    }
  }

  // Repeat lookups dominate (one call per page load, pages share hosts), so
  // resolved payloads are cached per normalized host; a full global bucket of
  // ~40k selectors makes the miss path linear in the payload, not the walk.
  const PAYLOAD_CACHE_MAX = 512;
  const payloadCache = new Map<string, CosmeticPayload | undefined>();

  /**
   * Merge one host's candidate entries into the frozen payload it shares with
   * repeat lookups — the exact filter/exception application the per-host cache
   * stores. `vetoed` reports whether an entry's own `~` exclusions or a
   * `:matches-path` scope keep it out of this answer; the shared global
   * payload is built with `() => false` because every conditional entry that
   * fires is part of it.
   */
  const resolveEntries = (
    bag: CosmeticEntry[],
    vetoed: (entry: CosmeticEntry) => boolean,
  ): CosmeticPayload | undefined => {
    const hideCandidates = new Set<string>();
    const hideExceptions = new Set<string>();
    const styleCandidates: { key: string; css: string }[] = [];
    const styleSeen = new Set<string>();
    const styleExceptions = new Set<string>();
    const scriptletCandidates: ScriptletCall[] = [];
    const scriptletSeen = new Set<string>();
    const scriptletExceptions: ScriptletCall[] = [];

    for (const entry of bag) {
      // A `~` exclusion vetoes only the rule it rode in on.
      if (vetoed(entry)) continue;
      switch (entry.kind) {
        case "hide":
          hideCandidates.add(entry.selector);
          break;
        case "hideException":
          hideExceptions.add(entry.selector);
          break;
        case "style":
          if (entry.css && !styleSeen.has(entry.css)) {
            styleSeen.add(entry.css);
            styleCandidates.push({ key: entry.selector, css: entry.css });
          }
          break;
        case "styleException":
          styleExceptions.add(entry.selector);
          break;
        case "scriptlet": {
          const call = entry.call!;
          // JSON over a joined string so `["a b","c"]` can't alias `["a","b c"]`.
          const dedupe = `${call.name}\0${JSON.stringify(call.args)}`;
          if (!scriptletSeen.has(dedupe)) {
            scriptletSeen.add(dedupe);
            scriptletCandidates.push(call);
          }
          break;
        }
        case "scriptletException":
          if (entry.call) scriptletExceptions.push(entry.call);
          break;
      }
    }

    const hide = [...hideCandidates].filter((sel) => !hideExceptions.has(sel));
    const styles = styleCandidates
      .filter((style) => !styleExceptions.has(style.key))
      .map((style) => style.css);
    const scriptlets = scriptletCandidates.filter(
      (call) =>
        !scriptletExceptions.some(
          (ex) =>
            // `#@#+js()` — the empty-name sentinel — cancels every scriptlet.
            ex.name === "" ||
            // Otherwise uBO is literal-match on the whole call content: name
            // plus the exact arg list, so a name-only exception cancels ONLY
            // the zero-arg call — `##+js(nobab, _)` survives `#@#+js(nobab)`.
            // Canonical-name comparison is a deliberate superset of uBO's
            // literal text match (it lets an `aopr` exception cancel an
            // `abort-on-property-read` invocation).
            (ex.name === call.name &&
              ex.args.length === call.args.length &&
              ex.args.every((arg, i) => arg === call.args[i])),
        ),
    );
    if (hide.length === 0 && styles.length === 0 && scriptlets.length === 0) {
      return undefined;
    }
    let skippedScriptlets = 0;
    for (const call of scriptlets) {
      if (!CANONICAL_SCRIPTLET_NAMES.has(call.name)) skippedScriptlets++;
    }
    // The payload is shared across repeat lookups and across callers — freeze
    // it so an in-place sort/filter in one consumer cannot poison the cache.
    return Object.freeze({
      hide: Object.freeze(hide) as string[],
      styles: Object.freeze(styles) as string[],
      scriptlets: Object.freeze(
        scriptlets.map((call) =>
          Object.freeze({
            name: call.name,
            args: Object.freeze(call.args) as string[],
          }),
        ),
      ) as ScriptletCall[],
      skippedScriptlets,
    });
  };

  // One payload for every host with no domain/subdomain/entity hits and no
  // vetoing `~` exclusion: the global bucket resolved once. Domainless hosts
  // are the hot path of a general browsing session — this keeps `forHost`
  // from allocating a fresh ~40k-entry merge per new host.
  const globalSharedPayload =
    globalEntries.length > 0 ? resolveEntries(globalEntries, () => false) : undefined;

  const lookupHost = (
    host: string,
    path: string | undefined,
  ): CosmeticPayload | undefined => {
    const h = normalizeHost(host);
    if (!h) return undefined;

    const bag: CosmeticEntry[] = [];
    // Suffix walk: `a.b.example.com` sees `example.com` and `b.example.com`
    // entries but never `notexample.com`'s. `*.`-scoped entries apply only
    // when the matched suffix is a strict ancestor (start > 0) — the apex
    // itself is excluded.
    for (let start = 0; ;) {
      const key = start === 0 ? h : h.slice(start);
      const bucket = domainEntries.get(key);
      if (bucket) bag.push(...bucket);
      if (start > 0) {
        const subBucket = subdomainEntries.get(key);
        if (subBucket) bag.push(...subBucket);
      }
      const dot = h.indexOf(".", start);
      if (dot < 0) break;
      start = dot + 1;
    }

    let decomposed: ReturnType<typeof decomposeDomain> | undefined;
    const decompOf = (): ReturnType<typeof decomposeDomain> =>
      (decomposed ??= decomposeDomain(h));
    let sld: string | undefined;
    const sldOf = (): string | undefined => {
      if (sld === undefined) {
        const d = decompOf();
        sld = d.tld ? d.sld : "";
      }
      return sld;
    };

    if (hasEntityRules || hasSubEntityRules) {
      const name = sldOf();
      if (name) {
        const bucket = entityEntries.get(name);
        if (bucket) bag.push(...bucket);
        // `*.name.*` — the subdomain-scoped entity — applies only when a
        // label precedes the registrable domain (flag 112): `x.sony.com`
        // sees the bucket, apex `sony.com` does not.
        if (hasSubEntityRules && decompOf().subdomains.length > 0) {
          const subBucket = subEntityEntries.get(name);
          if (subBucket) bag.push(...subBucket);
        }
      }
    }

    const tokenMatches = (token: DomainToken): boolean => {
      switch (token.kind) {
        case "host":
          return hostTokenMatches(token.suffix, h);
        case "sub":
          // `~*.foo.com` vetoes subdomains only — the apex keeps the rule.
          return h.endsWith(`.${token.suffix}`);
        case "all":
          // `~*` — matches every host, so the rule applies nowhere.
          return true;
        case "entity":
          return sldOf() === token.name;
        case "subEntity": {
          // `~*.name.*` — the exclusion mirrors the include: only proper
          // subdomains of the entity are vetoed; the apex keeps the rule.
          const d = decompOf();
          return (
            !!d.tld && d.sld === token.name && d.subdomains.length > 0
          );
        }
      }
    };

    // A `:matches-path`-scoped entry leaves the answer when the lookup
    // carries a path the scope doesn't match; no-path lookups keep it —
    // the no-path posture is the under-injection direction for exceptions.
    const outOfPathScope = (entry: CosmeticEntry): boolean =>
      entry.pathPattern !== undefined &&
      path !== undefined &&
      !entry.pathPattern.test(path);

    // Fast path: nothing host-specific hit, so the answer is the pre-resolved
    // global payload — unless a conditional global's `~` vetoes this host, in
    // which case the merge must run with that entry absent. The shared
    // payload is the no-path resolution, so a path-carrying lookup that
    // could veto a scoped global exception takes the merge instead.
    if (
      bag.length === 0 &&
      globalEntries.length > 0 &&
      !(hasGlobalPathScoped && path !== undefined)
    ) {
      let vetoed = false;
      for (const entry of globalConditional) {
        if (entry.excludes.some(tokenMatches)) {
          vetoed = true;
          break;
        }
      }
      if (!vetoed) return globalSharedPayload;
    }

    if (globalEntries.length) bag.push(...globalEntries);
    if (bag.length === 0) return undefined;
    // `~` exclusions and `:matches-path` scopes both veto per entry — the
    // path-aware predicate is the flag-107 half of this lookup.
    return resolveEntries(
      bag,
      (entry) => entry.excludes.some(tokenMatches) || outOfPathScope(entry),
    );
  };

  const index: CosmeticIndex = {
    stats,

    size: () => ({ ...counts }),

    forHost(host: string, path?: string): CosmeticPayload | undefined {
      const h = normalizeHost(host);
      if (!h) return undefined;
      // The answer is path-dependent only when `:matches-path` exceptions
      // exist at all — every other rule set shares the host-keyed cache
      // regardless of the path a caller passes.
      const p = hasPathScoped ? normalizeLookupPath(path) : undefined;
      const key = p === undefined ? h : `${h}\0${p}`;
      if (payloadCache.has(key)) {
        const cached = payloadCache.get(key);
        // LRU touch on hits too — a bare get() returns the value (including
        // a cached `undefined`) without refreshing recency, so the busiest
        // hosts were the first eviction victims.
        payloadCache.delete(key);
        payloadCache.set(key, cached);
        return cached;
      }
      const payload = lookupHost(h, p);
      if (payloadCache.size >= PAYLOAD_CACHE_MAX) {
        const oldest = payloadCache.keys().next().value;
        if (oldest !== undefined) payloadCache.delete(oldest);
      }
      payloadCache.set(key, payload);
      return payload;
    },
  };

  return index;
}
