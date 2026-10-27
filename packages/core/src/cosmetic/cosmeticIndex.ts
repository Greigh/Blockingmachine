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
 *  - `[domains]#?#sel` / `#@?#`, `#$?#` / `#@$?#` — extended-CSS and extended-style
 *    rules: parsed and skipped (`stats.extendedCss` / `stats.extendedStyles`);
 *    procedural selectors are their own phase, not this one.
 *
 * Domain prefixes are comma-separated token lists; each token is an include
 * (`example.com`), an exclusion (`~ads.example.com`), or an entity wildcard
 * (`sony.*` — the label that must be the registered domain's SLD, so `sony.*`
 * hits `sony.co.jp` but not `sonyplc.com` or `sony.com.evil.example`). A token
 * list of only `~` exclusions is a global rule that vetoes those hosts — that
 * shape is common in the wild (`~addtoany.com##a[href=…]`). `~` vetoes only the
 * rule it sits on. `[$path=…]` / `[$domain=…]` AdGuard modifier prefixes scope by
 * something this index cannot match, so those rules are skipped with a stat —
 * under-injecting a path-scoped rule is the honest direction.
 *
 * Exception semantics are uBO's: a `#@#` exception removes its literal selector
 * for that host wherever the selector came from (global or domain rule); one
 * whose selector was never injected is a no-op. Scriptlet exceptions cancel the
 * same canonical name, either name-only (`+js(name)`) or name + exact args.
 * Scriptlet names are normalized through the uBO↔AdGuard alias table
 * ({@link canonicalScriptletName}); names the table doesn't know are emitted raw
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
  /** `#?#`/`#@?#` extended-CSS rules — parsed and skipped this phase. */
  extendedCss: number;
  /** `#$?#`/`#@$?#` extended-style rules — parsed and skipped this phase. */
  extendedStyles: number;
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
   */
  forHost(host: string): CosmeticPayload | undefined;
  /** Indexed populations: hide selectors, hide exceptions, scriptlet calls, style rules. */
  size(): {
    selectors: number;
    exceptions: number;
    scriptlets: number;
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
  // → real upstream names outside the implemented set (counted as skipped)
  rpnt: "remove-node-text",
  rmnt: "remove-node-text",
  "replace-node-text": "remove-node-text",
  aell: "addEventListener-logger",
  norafif: "prevent-requestAnimationFrame",
  "no-requestanimationframe-if": "prevent-requestAnimationFrame",
  "refresh-defuser": "prevent-refresh",
  "no-refresh-if": "prevent-refresh",
  "cookie-remover": "remove-cookie",
  nobab: "prevent-bab",
  "no-bab": "prevent-bab",
  "bab-defuser": "prevent-bab",
  "trusted-rpnt": "trusted-replace-node-text",
  "trusted-rpfr": "trusted-replace-fetch-response",
  "trusted-set": "trusted-set-constant",
};

/**
 * Resolves a list-authored scriptlet name to the canonical spelling the injected
 * library consumes — uBO terse (`aopr`), Nano (`nano-sib`) and legacy camelCase
 * (`setConstant`) all fold into one name set. Unknown names are returned raw.
 */
export function canonicalScriptletName(rawName: string): string {
  const key = rawName.endsWith(".js") ? rawName.slice(0, -3) : rawName;
  return SCRIPTLET_NAME_ALIASES[key.toLowerCase()] ?? key;
}

/** One domain-prefix token: a host suffix, or an entity whose SLD must equal `name`. */
type DomainToken =
  { kind: "host"; suffix: string } | { kind: "entity"; name: string };

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
    | "extendedStyle";
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
        return { index: i, bodyIndex: i + 5, kind: "extendedStyle" };
      if (line.startsWith("#@?#", i))
        return { index: i, bodyIndex: i + 4, kind: "extendedCss" };
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
 * a trailing `.*` marks an entity wildcard, a leading `*.` is normalized away,
 * and a bare `*` token makes the rule global. Tokens that can never be a host —
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
    if (token.startsWith("*.")) token = token.slice(2);
    if (!token) continue;
    if (token === "*") {
      global = true;
      continue;
    }
    if (token.endsWith(".*")) {
      const name = token.slice(0, -2);
      if (name && !name.includes(".") && !/[^\p{L}\p{N}_-]/u.test(name)) {
        (excluded ? excludes : includes).push({ kind: "entity", name });
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
    (excluded ? excludes : includes).push({ kind: "host", suffix: token });
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
 * Splits a scriptlet argument string on top-level commas. Quotes (`'`/`"`)
 * group, a `\` escapes the next character, and `{}`/`[]` blocks nest — uBO lists
 * pass bare object literals (`+js(set, x, { cmd: { y: 1 } })`) whose inner commas
 * must not split. Outside quotes `\,` unescapes to a literal comma; other
 * backslashes stay (regex args like `/\"homad\"/ ` carry them).
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
      (first === "'" || first === '"') &&
      last === first
    ) {
      args.push(unescapeQuotedArg(trimmed.slice(1, -1)));
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
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      current += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
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
 * Reads the `)` that closes a `+js(`/`//scriptlet(` call — quote-aware, and
 * `{}`/`[]`/`()`-depth aware so object-literal args and parenthesised regexes
 * can't end the call early. Returns -1 when the call never closes.
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
    if (ch === "'" || ch === '"') {
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
 * Returns the parsed call plus whether non-whitespace text trails the closing
 * paren — a `:matches-path(...)`/`[...]` tail makes the rule path-scoped, which
 * the index cannot match, so the caller skips it rather than over-apply it.
 */
function parseScriptletCall(
  body: string,
): { call: ScriptletCall; trailing: boolean } | null {
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
  const trailing = trimmed.slice(close + 1).trim().length > 0;
  const args = splitScriptletArgs(inner);
  const rawName = args.shift()?.trim() ?? "";
  if (!rawName) return null;
  return { call: { name: canonicalScriptletName(rawName), args }, trailing };
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
    scopeModifiers: 0,
    rawJsRules: 0,
    invalidSelectors: 0,
    unusableDomains: 0,
    malformed: 0,
  };

  // Global rules (no include token — includes only-`~` lists and `*`), keyed
  // domain rules, and entity rules each keep the rule's own exclusions on the
  // entry so a `~` vetoes its own rule only.
  const globalEntries: CosmeticEntry[] = [];
  const domainEntries = new Map<string, CosmeticEntry[]>();
  const entityEntries = new Map<string, CosmeticEntry[]>();
  let hasEntityRules = false;

  const counts = { selectors: 0, exceptions: 0, scriptlets: 0, styles: 0 };

  const store = (
    domains: ReturnType<typeof parseDomainList>,
    entry: CosmeticEntry,
  ) => {
    if (domains.global || domains.includes.length === 0) {
      globalEntries.push(entry);
      return;
    }
    for (const token of domains.includes) {
      if (token.kind === "entity") {
        hasEntityRules = true;
        const bucket = entityEntries.get(token.name);
        if (bucket) bucket.push(entry);
        else entityEntries.set(token.name, [entry]);
      } else {
        const bucket = domainEntries.get(token.suffix);
        if (bucket) bucket.push(entry);
        else domainEntries.set(token.suffix, [entry]);
      }
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

    if (kind === "extendedCss") {
      stats.extendedCss++;
      continue;
    }
    if (kind === "extendedStyle") {
      stats.extendedStyles++;
      continue;
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
        if (parsed.trailing) {
          stats.scopeModifiers++;
          continue;
        }
        store(domains, {
          kind,
          selector: "",
          call: parsed.call,
          excludes: domains.excludes,
        });
        counts.scriptlets++;
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

  const lookupHost = (host: string): CosmeticPayload | undefined => {
    const h = normalizeHost(host);
    if (!h) return undefined;

    const bag: CosmeticEntry[] = [];
    // Suffix walk: `a.b.example.com` sees `example.com` and `b.example.com`
    // entries but never `notexample.com`'s.
    for (let start = 0; ;) {
      const bucket = domainEntries.get(start === 0 ? h : h.slice(start));
      if (bucket) bag.push(...bucket);
      const dot = h.indexOf(".", start);
      if (dot < 0) break;
      start = dot + 1;
    }

    let sld: string | undefined;
    const sldOf = (): string | undefined => {
      if (sld === undefined) {
        const decomposed = decomposeDomain(h);
        sld = decomposed.tld ? decomposed.sld : "";
      }
      return sld;
    };

    if (hasEntityRules) {
      const name = sldOf();
      if (name) {
        const bucket = entityEntries.get(name);
        if (bucket) bag.push(...bucket);
      }
    }
    if (globalEntries.length) bag.push(...globalEntries);
    if (bag.length === 0) return undefined;

    const tokenMatches = (token: DomainToken): boolean =>
      token.kind === "host"
        ? hostTokenMatches(token.suffix, h)
        : sldOf() === token.name;

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
      if (entry.excludes.some(tokenMatches)) continue;
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
            ex.name === call.name &&
            (ex.args.length === 0 ||
              (ex.args.length === call.args.length &&
                ex.args.every((arg, i) => arg === call.args[i]))),
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

  const index: CosmeticIndex = {
    stats,

    size: () => ({ ...counts }),

    forHost(host: string): CosmeticPayload | undefined {
      const h = normalizeHost(host);
      if (!h) return undefined;
      const cached = payloadCache.get(h);
      if (cached !== undefined || payloadCache.has(h)) return cached;
      const payload = lookupHost(h);
      payloadCache.delete(h);
      if (payloadCache.size >= PAYLOAD_CACHE_MAX) {
        const oldest = payloadCache.keys().next().value;
        if (oldest !== undefined) payloadCache.delete(oldest);
      }
      payloadCache.set(h, payload);
      return payload;
    },
  };

  return index;
}
