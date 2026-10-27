/**
 * Structural selector safety — the half of selector validation every consumer shares.
 *
 * A cosmetic rule is text that ends up inside a `<style>` element, so the check that
 * matters for *list-sourced* rules is only whether the selector can break out of the
 * stylesheet or the element around it. The extension's picker path layers breadth
 * guards on top of this — universal-selector, bare-tag and specificity heuristics —
 * because a *user's* bad click must not blank the web. List authors legitimately
 * ship `body` and `html`-rooted selectors (uBO and AdGuard apply them raw), so those
 * guards deliberately do NOT live here: this module is the structural-escape half
 * only, and `browser-extension/src/shared/cosmeticRules.ts` composes on top of it.
 *
 * This file is the single source of truth for the dangerous-character test — the
 * extension imports it rather than keeping its own copy (`no fork`, spec §4).
 */

/**
 * Characters that could terminate the rule or open a declaration block.
 *
 * `>` is deliberately absent (it is the child combinator, and style text is not
 * parsed as markup), and so is `\`, which is how legitimate selectors escape
 * quotes. The characters that can actually break out of a rule — `{`, `}`, `;`,
 * `@`, comment openers — are blocked outright, so escaping cannot help. `<` is
 * blocked because the payload lands in a `<style>` element and `</style>` is a
 * real breakout, not because a `<` could ever match an element.
 */
export const DANGEROUS_SELECTOR_CHARS = /[{}<;@]|\/\*/;

/**
 * Length cap for a user-entered (picker) selector. List-sourced rules get the far
 * more generous {@link MAX_LIST_SELECTOR_LENGTH} — real compiled lists ship
 * selectors past 400 chars, so the picker cap cannot be reused there.
 */
export const MAX_SELECTOR_LENGTH = 400;

/**
 * Length cap for a list-sourced selector: the same 4096-char bound AdGuard applies
 * to rule text (and this repo already applies to request URLs in
 * `evaluateRequest.ts`). Wild lists carry a handful of pathological
 * comma-joined selectors past this; they are dropped and counted, not injected.
 */
export const MAX_LIST_SELECTOR_LENGTH = 4096;

export interface SelectorSafetyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Structural validation only — it cannot know how many elements a selector
 * matches without a DOM, and it does not care: breadth is the picker layer's
 * problem. Non-strings, emptiness, over-cap length and structural characters are
 * the whole contract. Pass {@link MAX_LIST_SELECTOR_LENGTH} for list-sourced
 * selectors; the default is the picker cap.
 */
export function checkSelectorStructure(
  selector: unknown,
  maxLength: number = MAX_SELECTOR_LENGTH,
): SelectorSafetyResult {
  if (typeof selector !== "string")
    return { ok: false, reason: "not a string" };
  const trimmed = selector.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.length > maxLength) return { ok: false, reason: "too long" };
  if (DANGEROUS_SELECTOR_CHARS.test(trimmed)) {
    return { ok: false, reason: "contains structural characters" };
  }
  return { ok: true };
}

/**
 * The list-sourced variant of {@link checkSelectorStructure}. A naive
 * character-class test rejects ~2% of real filter lists: `[style*="border-box;
 * display:"]`, `[onclick="go()"]` and friends legitimately carry `;`, `{}` and
 * `@` inside quoted attribute matchers, where they cannot escape the rule —
 * the CSS tokenizer keeps them inside the attribute's string component.
 *
 * So dangerous characters are rejected only at *bare selector position* —
 * outside quotes and outside `[…]` matchers — with one exception: `<` is
 * rejected everywhere, because the payload lands inside a `<style>` element
 * and HTML does not know CSS quoting — `</style` inside a quoted attribute
 * value terminates the element all the same. `{`/`}`/`;`/`@`/`/*` inside a
 * quoted attribute string are exactly as inert as the same characters inside
 * a quoted scriptlet arg.
 *
 * The bracket scan is quote-aware on the inside too: a `]` inside a quoted
 * attribute value (`[a="]"]`) is data, not the bracket close — without that,
 * the quoted `]` ends the scan, the closing `"` opens a checker-quote, and a
 * following `{` sails through. A quote left open at end-of-selector (top
 * level or inside brackets) means the scan never saw the tail of the input,
 * so it fails rather than certify text it never examined.
 */
export function checkListSelectorStructure(
  selector: unknown,
  maxLength: number = MAX_LIST_SELECTOR_LENGTH,
): SelectorSafetyResult {
  if (typeof selector !== "string")
    return { ok: false, reason: "not a string" };
  const trimmed = selector.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.length > maxLength) return { ok: false, reason: "too long" };

  let quote = "";
  let bracketDepth = 0;
  let bracketQuote = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "<") {
      // Only `</style` can break the element, but a `<` is never a legitimate
      // selector character, so quotes and brackets earn no exemption.
      return { ok: false, reason: "contains structural characters" };
    }
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (bracketDepth > 0) {
      // Inside an attribute matcher a `"`/`'` opens a quoted value in which
      // `]` is data, not the bracket close — `[a="]"]` must not let the
      // quoted `]` end the scan and leave a stray `"` behind to open a
      // checker-quote that swallows a following `{`.
      if (bracketQuote) {
        if (ch === "\\") i++;
        else if (ch === bracketQuote) bracketQuote = "";
        continue;
      }
      if (ch === "'" || ch === '"') {
        bracketQuote = ch;
        continue;
      }
      if (ch === "]") bracketDepth--;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      bracketDepth = 1;
      continue;
    }
    if (
      ch === "{" ||
      ch === "}" ||
      ch === ";" ||
      ch === "@" ||
      (ch === "/" && trimmed[i + 1] === "*")
    ) {
      return { ok: false, reason: "contains structural characters" };
    }
  }
  // An unclosed quote means the tail of the selector was never scanned —
  // fail closed rather than certify text the checker never saw.
  if (quote || bracketQuote) {
    return { ok: false, reason: "contains structural characters" };
  }
  return { ok: true };
}

/**
 * The extended-CSS → native-CSS translation gate for `#?#`/`#@?#`/`#$?#`/`#@$?#`
 * rules (flag 104). Modern engines evaluate `:has()` natively, so the
 * translatable subset is exactly the pseudo rewrites below; everything else
 * procedural (`:contains()`, `:has-text()`, `:matches-css*()`, `:upward()`,
 * `:xpath()`, `:matches-attr()`, `:matches-path()`, `:if()`, `:style()`,
 * `:remove()`, the `:-abp-*`/`abp-*` spellings, …) cannot be expressed in a
 * `<style>` element and reports `unsupported` so the caller can count it
 * honestly instead of emitting an inert selector.
 *
 * The walk is quote- and bracket-aware on the same terms as
 * {@link checkListSelectorStructure}: a `:` inside a quoted string or an
 * attribute matcher is data, never a pseudo (`[title=":has(x)"]` passes
 * through unflagged and unrewritten). Pseudo names are read inside `:has()`
 * arguments too — parens deliberately do not hide a nested extended pseudo,
 * because `:has(> .x:contains(y))` is exactly as untranslatable as a top-level
 * `:contains`.
 *
 * An *unknown* functional pseudo (`:something-new(`) is also unsupported: the
 * extended markers only exist for procedural selectors, so a functional pseudo
 * the allowlist does not know is an upstream experiment, not native CSS.
 * Unknown *bare* names (`:hover`-style, no `(`) pass through — worst case they
 * are inert in the emitted rule, which fails toward under-injection.
 *
 * `::` pseudo-elements are never classified: every extended engine writes its
 * pseudos single-colon, and `::part()`/`::slotted()` are native.
 */
export interface ExtendedSelectorTranslation {
  ok: boolean;
  /** The rewritten selector — identical input when nothing needed a rewrite. */
  selector: string;
  /** The pseudo name that made the rule untranslatable, when `!ok`. */
  unsupported?: string;
}

/** Functional pseudo-classes a modern engine evaluates natively. */
const NATIVE_FUNCTIONAL_PSEUDOS: ReadonlySet<string> = new Set([
  "has",
  "not",
  "is",
  "where",
  "nth-child",
  "nth-last-child",
  "nth-of-type",
  "nth-last-of-type",
  "nth-col",
  "nth-last-col",
  "lang",
  "dir",
  "host",
  "host-context",
  "slotted",
  "part",
  "state",
  "current",
  "past",
  "future",
]);

/**
 * Procedural pseudo names known across the uBO/AdGuard/ABP extended engines —
 * flagged bare or functional, because a list author reaching for them means
 * the procedural reading.
 */
const EXTENDED_PSEUDO_NAMES: ReadonlySet<string> = new Set([
  // Text/property matching — no native reading exists.
  "contains",
  "has-text",
  "min-text-length",
  "matches-css",
  "matches-css-before",
  "matches-css-after",
  "matches-attr",
  "matches-property",
  // Page-scope and tree-walking predicates.
  "matches-path",
  "matches-domain",
  "matches-media",
  "upward",
  "nth-ancestor",
  "xpath",
  "if",
  "if-not",
  "watch-attr",
  "watch-attrs",
  "others",
  // Action pseudos (AdGuard `sel:remove()`, `sel:style { }`, ABP `:-abp-properties`).
  "remove",
  "style",
  "properties",
]);

/**
 * Translates the extended-CSS subset of a selector body to native CSS, or
 * reports the first untranslatable pseudo. Rewrites performed:
 *
 *  - `:-abp-has(sel)` (ABP) → `:has(sel)`
 *  - `:matches(sel)` (pre-standard :is) → `:is(sel)`
 *
 * Everything else about the string is preserved verbatim — whitespace,
 * combinators, attribute matchers and all.
 */
export function translateExtendedSelector(
  selector: string,
): ExtendedSelectorTranslation {
  let out = "";
  let quote = "";
  let bracketDepth = 0;
  let bracketQuote = "";
  const n = selector.length;
  for (let i = 0; i < n; ) {
    const ch = selector[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += selector[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i++;
      continue;
    }
    if (bracketDepth > 0) {
      out += ch;
      if (bracketQuote) {
        if (ch === "\\" && i + 1 < n) {
          out += selector[i + 1];
          i += 2;
          continue;
        }
        if (ch === bracketQuote) bracketQuote = "";
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') bracketQuote = ch;
      else if (ch === "]") bracketDepth--;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < n) {
      // An escaped colon is data (`a\:has`), never a pseudo opener.
      out += ch + selector[i + 1];
      i += 2;
      continue;
    }
    if (ch === "[") {
      bracketDepth = 1;
      out += ch;
      i++;
      continue;
    }
    if (ch === ":") {
      if (selector[i + 1] === ":") {
        // Pseudo-elements are native in this syntax — never classified.
        out += "::";
        i += 2;
        continue;
      }
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_-]/.test(selector[j])) j++;
      const name = selector.slice(i + 1, j).toLowerCase();
      if (name === "") {
        out += ch;
        i++;
        continue;
      }
      const functional = selector[j] === "(";
      if (name === "-abp-has") {
        out += ":has";
        i = j;
        continue;
      }
      if (name === "matches" && functional) {
        out += ":is";
        i = j;
        continue;
      }
      if (
        name.startsWith("-abp-") ||
        name.startsWith("abp-") ||
        EXTENDED_PSEUDO_NAMES.has(name)
      ) {
        return { ok: false, selector: out + selector.slice(i), unsupported: name };
      }
      if (functional && !NATIVE_FUNCTIONAL_PSEUDOS.has(name)) {
        return { ok: false, selector: out + selector.slice(i), unsupported: name };
      }
      // Known functional, or a bare pseudo — emit the `:` and let the name
      // ride through the loop as ordinary characters.
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return { ok: true, selector: out };
}
