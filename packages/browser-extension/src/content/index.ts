import { injectCosmeticStyles } from './cosmeticHider.js';
import { STORAGE_KEY_COSMETICS } from '../shared/constants.js';

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

async function applyCosmetics(): Promise<void> {
  let combined = [...defaultCosmetics];
  try {
    if (chrome.storage?.local) {
      const res = await chrome.storage.local.get(STORAGE_KEY_COSMETICS);
      const dynamicCosmetics = res[STORAGE_KEY_COSMETICS];
      if (Array.isArray(dynamicCosmetics) && dynamicCosmetics.length > 0) {
        combined = Array.from(new Set([...defaultCosmetics, ...dynamicCosmetics]));
      }
    }
  } catch (err) {
    console.warn('[Blockingmachine] Failed to retrieve dynamic cosmetics:', err);
  }
  injectCosmeticStyles(combined);
}

// Inject baseline styles immediately to eliminate visual flash
injectCosmeticStyles(defaultCosmetics);
// Asynchronously apply full dynamic set from storage
applyCosmetics();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyCosmetics);
}

// Reactively re-inject when background service worker syncs updated cosmetic selectors
if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEY_COSMETICS]) {
      const newSelectors = changes[STORAGE_KEY_COSMETICS].newValue;
      if (Array.isArray(newSelectors)) {
        const combined = Array.from(new Set([...defaultCosmetics, ...newSelectors]));
        injectCosmeticStyles(combined);
      }
    }
  });
}

console.log('[Blockingmachine] In-page cosmetic shield active.');
