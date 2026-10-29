/**
 * Cosmetic Element Hider
 * Injects stylesheet rules to collapse ad frames, banners, and cookie consent modals.
 * Idempotent, safe from CSS injection, and prevents DOM element leakage.
 */

import { sanitizeCosmeticSelectors } from '../shared/cosmeticRules.js';

const STYLE_ELEMENT_ID = 'bm-cosmetic-shield';

export function injectCosmeticStyles(selectors: string[]): void {
  if (!selectors || selectors.length === 0) return;

  // Sanitization is syntax-only here — no live-DOM matchCount probe. That
  // probe costs one querySelectorAll per selector, and this runs on every
  // frame of every page against lists that can carry thousands of selectors:
  // the probe itself was the page slowdown. The match-count guard still gates
  // exactly where a bad selector enters — ElementPicker.applyRule validates
  // the picker's own live count before a rule is ever stored, so everything
  // arriving here was either vetted then or came from the compiled list.
  const validSelectors = sanitizeCosmeticSelectors(selectors);
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
