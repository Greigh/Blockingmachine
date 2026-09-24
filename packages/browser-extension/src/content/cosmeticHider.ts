/**
 * Cosmetic Element Hider
 * Injects stylesheet rules to collapse ad frames, banners, and cookie consent modals.
 */
export function injectCosmeticStyles(selectors: string[]): void {
  if (selectors.length === 0) return;

  const styleEl = document.createElement('style');
  styleEl.id = 'bm-cosmetic-shield';
  styleEl.textContent = `
    ${selectors.join(', ')} {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      height: 0 !important;
      min-height: 0 !important;
    }
  `;

  (document.head || document.documentElement).appendChild(styleEl);
}
