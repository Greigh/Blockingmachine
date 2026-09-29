/**
 * Cosmetic rule safety.
 *
 * A cosmetic rule is CSS the extension injects into every matching page, so a
 * bad rule is not a cosmetic problem — a selector like `div` or `body` or `*`
 * would blank the entire web. Every selector that reaches a stylesheet must pass
 * through here first, whether it came from the visual picker, the context menu,
 * or storage written by an older version.
 */

/** Attributes that carry no styling intent but often identify a region. */
const UNIVERSAL_SELECTOR = /^\s*(\*|html|body|:root)\s*$/i;
const BARE_TAG = /^[a-z][a-z0-9-]*$/i;
/**
 * Characters that could terminate the rule or open a declaration block.
 *
 * `>` is deliberately absent (it is the child combinator, and style text is not
 * parsed as markup), and so is `\`, which is how legitimate selectors escape
 * quotes. The characters that can actually break out of a rule — `{`, `}`, `;`,
 * `@`, comment openers — are blocked outright, so escaping cannot help.
 */
const DANGEROUS_CHARS = /[{}<;@]|\/\*/;
const MAX_SELECTOR_LENGTH = 400;

export interface SelectorValidation {
  ok: boolean;
  reason?: string;
}

/**
 * Structural validation only — it cannot know how many elements a selector
 * matches without a DOM. Use {@link validateCosmeticSelector} when a document is
 * available for the match-count guard.
 */
export function checkSelectorSyntax(selector: unknown): SelectorValidation {
  if (typeof selector !== 'string') return { ok: false, reason: 'not a string' };
  const trimmed = selector.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_SELECTOR_LENGTH) return { ok: false, reason: 'too long' };
  if (DANGEROUS_CHARS.test(trimmed)) return { ok: false, reason: 'contains structural characters' };
  if (UNIVERSAL_SELECTOR.test(trimmed)) return { ok: false, reason: 'targets the whole document' };
  if (BARE_TAG.test(trimmed)) {
    // `aside` alone hides every aside on every site that loads this rule.
    return { ok: false, reason: 'bare tag name matches unrelated elements' };
  }
  // A rule must carry some specificity: a class, id, attribute, pseudo-class, or
  // a compound/path expression. This is what separates `.ad-slot` from `aside`.
  if (!/[.#[\]():>~+ ]/.test(trimmed)) return { ok: false, reason: 'not specific enough' };
  return { ok: true };
}

/**
 * Full validation. `matchCount` is how many elements the selector currently
 * matches — pass `undefined` when that is unknown (e.g. background context).
 */
export function validateCosmeticSelector(
  selector: unknown,
  matchCount?: number,
  options: { maxMatches?: number } = {},
): SelectorValidation {
  const syntax = checkSelectorSyntax(selector);
  if (!syntax.ok) return syntax;

  const maxMatches = options.maxMatches ?? 200;
  if (typeof matchCount === 'number' && matchCount > maxMatches) {
    // Hiding 200+ elements from one click is far more likely to be a bad
    // selector than a real annoyance.
    return { ok: false, reason: `matches ${matchCount} elements` };
  }
  return { ok: true };
}

/**
 * Filters untrusted or stored selectors down to the ones that are safe to
 * inject. Duplicates are removed and order is preserved.
 */
export function sanitizeCosmeticSelectors(
  selectors: unknown,
  options: { maxMatches?: number; matchCount?: (selector: string) => number | undefined } = {},
): string[] {
  if (!Array.isArray(selectors)) return [];
  const out: string[] = [];
  for (const candidate of selectors) {
    const result = validateCosmeticSelector(
      candidate,
      options.matchCount ? options.matchCount(String(candidate).trim()) : undefined,
      { maxMatches: options.maxMatches },
    );
    if (!result.ok) continue;
    const selector = String(candidate).trim();
    if (!out.includes(selector)) out.push(selector);
  }
  return out;
}

/**
 * Escapes a value for use inside a quoted attribute selector, e.g.
 * `[aria-label="…"]`. `CSS.escape` is for identifiers and corrupts quoted
 * strings (`Sign in` becomes `Sign\ in`, which no longer matches), so quoted
 * values get their own escape.
 */
export function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
}

/**
 * Escapes an identifier (id, class) for use after `#` or `.`.
 * Falls back to a conservative escape when `CSS.escape` is unavailable.
 */
export function escapeIdentifier(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/([^\w-])/g, '\\$1').replace(/^(\d)/, '\\3$1 ');
}

/**
 * True when an id or class looks machine-generated (hashes, UUIDs, long digit
 * runs). Such names change between deploys and make fragile rules.
 */
export function looksDynamic(token: string): boolean {
  if (!token) return true;
  if (/[0-9a-f]{8,}/i.test(token)) return true;
  if (/^[0-9]+$/.test(token)) return true;
  if (/\d{4,}/.test(token)) return true;
  // e.g. `css-1x2y3z`, `styled-abc`, `sc-bdVaJa`
  if (/^(css|styled|sc)-[a-z0-9]{4,}$/i.test(token)) return true;
  return false;
}

/** Framework/CSS utility classes that carry no meaning for a blocking rule. */
const UTILITY_CLASSES = new Set([
  'flex',
  'block',
  'inline',
  'hidden',
  'grid',
  'relative',
  'absolute',
  'fixed',
  'sticky',
  'static',
  'container',
  'wrapper',
  'row',
  'col',
  'columns',
  'clearfix',
  'visible',
  'invisible',
  'sr-only',
]);

export function isUtilityClass(token: string): boolean {
  return UTILITY_CLASSES.has(token) || /^(sm|md|lg|xl|xxl|hover|focus|active|dark|light):/.test(token);
}
