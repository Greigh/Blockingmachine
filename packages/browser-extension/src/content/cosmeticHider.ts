/**
 * Cosmetic Element Hider
 * Injects stylesheet rules to collapse ad frames, banners, and cookie consent modals.
 * Idempotent, safe from CSS injection, and prevents DOM element leakage.
 */

import { sanitizeCosmeticSelectors } from '../shared/cosmeticRules.js';

const STYLE_ELEMENT_ID = 'bm-cosmetic-shield';

/**
 * Upper bound on how many elements a single rule may hide. A picker mistake or a
 * corrupted stored rule should never be able to blank a page, so anything
 * matching more than this is dropped rather than injected.
 */
const MAX_MATCHES_PER_SELECTOR = 250;

function matchCount(selector: string): number | undefined {
  if (typeof document === 'undefined') return undefined;
  try {
    return document.querySelectorAll(selector).length;
  } catch {
    // An unparsable selector would throw here and count as 0 matches; report
    // undefined so validation falls back to its structural checks only.
    return undefined;
  }
}

export function injectCosmeticStyles(selectors: string[]): void {
  if (!selectors || selectors.length === 0) return;

  const validSelectors = sanitizeCosmeticSelectors(selectors, {
    maxMatches: MAX_MATCHES_PER_SELECTOR,
    matchCount,
  });
  if (validSelectors.length === 0) return;

  const css = `
    ${validSelectors.join(',\n')} {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      height: 0 !important;
      min-height: 0 !important;
    }
  `;

  const existing = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (existing) {
    if (existing.textContent !== css) {
      existing.textContent = css;
    }
    return;
  }

  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ELEMENT_ID;
  styleEl.textContent = css;

  const target = document.head || document.documentElement;
  if (target) {
    target.appendChild(styleEl);
  }
}
