/**
 * Selector engine.
 *
 * The contract that fixes the old picker: a returned selector has been *verified*
 * against the live document to match the element it was built for, and to match
 * nothing else. There is no "best effort" fallback that returns a bare tag name —
 * when no safe selector exists we return `null` and the caller says so, instead
 * of injecting a rule that hides every `div` on the site.
 *
 * The query is injectable so the algorithm is unit-testable without a DOM.
 */

import {
  escapeAttributeValue,
  escapeIdentifier,
  isUtilityClass,
  looksDynamic,
  validateCosmeticSelector,
} from '../shared/cosmeticRules.js';

export interface SelectorEngineOptions {
  /** Elements matching a selector, in document order. */
  query: (selector: string) => Element[];
  /** How far up the tree to walk when building a scoped path. */
  maxDepth?: number;
  /** Maximum elements a "similar elements" selector may match. */
  maxSimilarMatches?: number;
}

export interface SelectorResult {
  selector: string | null;
  /** How many elements the selector matches. */
  matches: number;
  /** Why no selector was produced. */
  reason?: string;
}

const ATTRIBUTE_CANDIDATES = [
  'data-testid',
  'data-test',
  'data-test-id',
  'data-ad-unit',
  'data-ad-slot',
  'data-ad-client',
  'data-slot',
  'data-cy',
  'data-qa',
  'aria-label',
];

const SKIP_TAGS = new Set(['HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META']);

function defaultQuery(selector: string): Element[] {
  if (typeof document === 'undefined') return [];
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch {
    return [];
  }
}

export class SelectorEngine {
  private readonly query: (selector: string) => Element[];
  private readonly maxDepth: number;
  private readonly maxSimilarMatches: number;

  constructor(options: Partial<SelectorEngineOptions> = {}) {
    this.query = options.query ?? defaultQuery;
    this.maxDepth = options.maxDepth ?? 6;
    this.maxSimilarMatches = options.maxSimilarMatches ?? 150;
  }

  /** Direct children of an element, for path building. */
  private childrenOf(el: Element): Element[] {
    const parent = el.parentElement;
    return parent ? Array.from(parent.children) : [];
  }

  private tag(el: Element): string {
    return (el.tagName || 'div').toLowerCase();
  }

  /**
   * Zero-based index of `el` among its parent's children (what `:nth-child(n)`
   * uses, counting all element siblings).
   */
  private childIndex(el: Element): number {
    return this.childrenOf(el).indexOf(el) + 1;
  }

  /** Verified: matches exactly this element and nothing else. */
  private isUniqueFor(selector: string, el: Element): boolean {
    const matches = this.query(selector);
    return matches.length === 1 && matches[0] === el;
  }

  private countMatches(selector: string): number {
    return this.query(selector).length;
  }

  /** Attributes worth building a selector from, most stable first. */
  private attributeCandidates(el: Element): string[] {
    const tag = this.tag(el);
    const out: string[] = [];
    for (const attr of ATTRIBUTE_CANDIDATES) {
      const value = el.getAttribute?.(attr);
      if (!value || value.length > 80) continue;
      out.push(`${tag}[${attr}="${escapeAttributeValue(value)}"]`);
    }
    // Pure attribute form is more portable when the tag may vary.
    for (const attr of ATTRIBUTE_CANDIDATES) {
      const value = el.getAttribute?.(attr);
      if (!value || value.length > 80) continue;
      out.push(`[${attr}="${escapeAttributeValue(value)}"]`);
    }
    // Links are frequently identified by their destination.
    if (tag === 'a') {
      const href = el.getAttribute?.('href');
      if (href && href.length <= 80 && (href.startsWith('/') || href.startsWith('http'))) {
        out.push(`a[href="${escapeAttributeValue(href)}"]`);
      }
    }
    return out;
  }

  /**
   * Classes worth using, most distinctive first.
   *
   * Two-character classes are kept: `.ad` and friends are among the most common
   * ad-container hooks on the web, and every candidate is verified against the
   * document before it is returned, so a short class cannot produce a rule that
   * matches more than intended. They are also what makes compound selectors
   * possible when a single class is ambiguous.
   */
  private classCandidates(el: Element): string[] {
    const classes = Array.from(el.classList ?? []).filter(
      (c) => c && c.length >= 2 && !c.startsWith('bm-') && !looksDynamic(c) && !isUtilityClass(c),
    );
    if (classes.length === 0) return [];

    const tag = this.tag(el);
    const out: string[] = [];
    // Single classes first: shortest surviving rule wins.
    for (const c of classes) out.push(`.${escapeIdentifier(c)}`);
    // Then compounds, most selective first.
    const escaped = classes.map((c) => escapeIdentifier(c));
    for (let size = Math.min(3, escaped.length); size >= 2; size--) {
      out.push(`${tag}.${escaped.slice(0, size).join('.')}`);
      out.push(`.${escaped.slice(0, size).join('.')}`);
    }
    return out;
  }

  /**
   * A structural path from a stable anchor down to the element, e.g.
   * `#main > div:nth-child(2) > aside:nth-child(1)`. Unique by construction
   * (only the final segment is index-based), and still verified before return.
   */
  private pathSelector(el: Element): string | null {
    // `segments` always describes the path *below* `current`, so an anchor can
    // replace `current`'s own segment instead of being prepended to it.
    const segments: string[] = [];
    let current: Element | null = el;

    for (let depth = 0; current && depth <= this.maxDepth; depth++) {
      const tag = this.tag(current);
      if (SKIP_TAGS.has(current.tagName)) return null;

      // Anchor on this element's own stable id, when it has one.
      const id = current.id;
      if (id && !looksDynamic(id)) {
        const anchor = `#${escapeIdentifier(id)}`;
        const candidate = segments.length ? `${anchor} > ${segments.join(' > ')}` : anchor;
        if (this.isUniqueFor(candidate, el)) return candidate;
      }

      segments.unshift(`${tag}:nth-child(${this.childIndex(current)})`);

      // Otherwise anchor at body, which always exists.
      const anchored = `body > ${segments.join(' > ')}`;
      if (this.isUniqueFor(anchored, el)) return anchored;

      current = current.parentElement;
    }

    return null;
  }

  /**
   * Best verified-unique selector for an element, or `null` when none can be
   * built safely.
   */
  public generate(el: Element): SelectorResult {
    if (!el) return { selector: null, matches: 0, reason: 'no element' };

    const candidates: string[] = [];

    // 1. A stable, unique id is the strongest anchor.
    const id = el.id;
    if (id && !looksDynamic(id)) candidates.push(`#${escapeIdentifier(id)}`);

    // 2. Stable identifying attributes.
    candidates.push(...this.attributeCandidates(el));

    // 3. Distinguishing classes.
    candidates.push(...this.classCandidates(el));

    for (const candidate of candidates) {
      const check = validateCosmeticSelector(candidate);
      if (!check.ok) continue;
      if (this.isUniqueFor(candidate, el)) {
        return { selector: candidate, matches: 1 };
      }
    }

    // 4. Structural fallback, bounded and verified.
    const path = this.pathSelector(el);
    if (path && this.isUniqueFor(path, el)) {
      const check = validateCosmeticSelector(path);
      if (check.ok) return { selector: path, matches: 1 };
    }

    return {
      selector: null,
      matches: 0,
      reason: 'No unique CSS selector could be built for this element.',
    };
  }

  /**
   * A selector matching elements "like this one" — same tag and a shared
   * identifying attribute or class. Used by "block similar elements" and by the
   * picker's widen action. Not required to be unique, but bounded.
   */
  public generateSimilar(el: Element): SelectorResult {
    if (!el) return { selector: null, matches: 0, reason: 'no element' };
    const tag = this.tag(el);
    const candidates: string[] = [];

    for (const attr of ATTRIBUTE_CANDIDATES) {
      const value = el.getAttribute?.(attr);
      if (!value) continue;
      const name = attr.replace(/^data-/, '');
      if (!name) continue;
      candidates.push(`${tag}[${attr}]`);
      candidates.push(`[${attr}]`);
    }

    for (const candidate of this.classCandidates(el)) candidates.push(candidate);
    candidates.push(`${tag}[class]`);

    for (const candidate of candidates) {
      const check = validateCosmeticSelector(candidate, undefined, {
        maxMatches: this.maxSimilarMatches,
      });
      if (!check.ok) continue;
      const matches = this.countMatches(candidate);
      if (matches === 0) continue;
      const bounded = validateCosmeticSelector(candidate, matches, {
        maxMatches: this.maxSimilarMatches,
      });
      if (bounded.ok) return { selector: candidate, matches };
    }

    return { selector: null, matches: 0, reason: 'No similar-element selector available.' };
  }

  /** How many elements a selector matches, for the HUD's preview count. */
  public count(selector: string): number {
    if (!selector) return 0;
    return this.countMatches(selector);
  }
}

export function createSelectorEngine(options: Partial<SelectorEngineOptions> = {}): SelectorEngine {
  return new SelectorEngine(options);
}
