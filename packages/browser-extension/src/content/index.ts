import { injectDefaultDefusers } from './scriptletInjector';
import { injectCosmeticStyles } from './cosmeticHider';

// Immediately inject anti-adblock defusers on page start
injectDefaultDefusers();

// Default high-prevalence annoyance and ad container selectors
const defaultCosmetics = [
  '.ad-container',
  '.adsbygoogle',
  '#cookie-notice',
  '.cookie-banner',
  '.fc-consent-root',
  '.optanon-alert-box-wrapper'
];

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => injectCosmeticStyles(defaultCosmetics));
} else {
  injectCosmeticStyles(defaultCosmetics);
}

console.log('[Blockingmachine] In-page cosmetic & procedural shield active.');
