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
  return { ok: true };
}
