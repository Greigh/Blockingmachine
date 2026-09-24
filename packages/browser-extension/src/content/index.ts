import { injectCosmeticStyles } from './cosmeticHider.js';

// Default high-prevalence annoyance, tracker, and ad container selectors
const defaultCosmetics = [
  '.ad-container',
  '.adsbygoogle',
  '#cookie-notice',
  '.cookie-banner',
  '.fc-consent-root',
  '.optanon-alert-box-wrapper',
  'div[id^="google_ads_iframe"]',
  'div[class*="ad-slot"]'
];

// Inject styles early to avoid layout flicker
injectCosmeticStyles(defaultCosmetics);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => injectCosmeticStyles(defaultCosmetics));
}

console.log('[Blockingmachine] In-page cosmetic shield active.');
