/**
 * Cosmetic Element Hider
 * Injects stylesheet rules to collapse ad frames, banners, and cookie consent modals.
 * Idempotent, safe from CSS injection, and prevents DOM element leakage.
 */
export function injectCosmeticStyles(selectors: string[]): void {
  if (!selectors || selectors.length === 0) return;

  // Sanitize selectors: prevent CSS injection or malformed bracket escapes
  const validSelectors = selectors.filter(
    (s) => typeof s === 'string' && s.trim().length > 0 && !s.includes('{') && !s.includes('}')
  );
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

  const existing = document.getElementById('bm-cosmetic-shield') as HTMLStyleElement | null;
  if (existing) {
    if (existing.textContent !== css) {
      existing.textContent = css;
    }
    return;
  }

  const styleEl = document.createElement('style');
  styleEl.id = 'bm-cosmetic-shield';
  styleEl.textContent = css;

  const target = document.head || document.documentElement;
  if (target) {
    target.appendChild(styleEl);
  }
}
