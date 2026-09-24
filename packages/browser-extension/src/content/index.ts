import { injectCosmeticStyles } from './cosmeticHider.js';
import { ElementPicker } from './elementPicker.js';
import {
  STORAGE_KEY_COSMETICS,
  STORAGE_KEY_USER_COSMETICS,
  STORAGE_KEY_COSMETICS_ENABLED,
} from '../shared/constants.js';

// Default high-prevalence annoyance, tracker, and ad container selectors
const defaultCosmetics = [
  '.ad-container',
  '.adsbygoogle',
  '#cookie-notice',
  '.cookie-banner',
  '.fc-consent-root',
  '.optanon-alert-box-wrapper',
  'div[id^="google_ads_iframe"]',
  'div[class*="ad-slot"]',
];

const picker = new ElementPicker();

async function applyCosmetics(): Promise<void> {
  try {
    if (chrome.storage?.local) {
      const res = await chrome.storage.local.get([
        STORAGE_KEY_COSMETICS,
        STORAGE_KEY_USER_COSMETICS,
        STORAGE_KEY_COSMETICS_ENABLED,
      ]);

      const isEnabled = res[STORAGE_KEY_COSMETICS_ENABLED] !== false;
      if (!isEnabled) {
        // Remote control toggle turned cosmetics off
        const existing = document.getElementById('bm-cosmetic-shield');
        if (existing) existing.remove();
        return;
      }

      let combined = [...defaultCosmetics];
      const dynamicCosmetics = res[STORAGE_KEY_COSMETICS];
      if (Array.isArray(dynamicCosmetics) && dynamicCosmetics.length > 0) {
        combined = [...combined, ...dynamicCosmetics];
      }

      const userCosmetics = res[STORAGE_KEY_USER_COSMETICS];
      if (Array.isArray(userCosmetics) && userCosmetics.length > 0) {
        combined = [...combined, ...userCosmetics];
      }

      injectCosmeticStyles(Array.from(new Set(combined)));
    } else {
      injectCosmeticStyles(defaultCosmetics);
    }
  } catch (err) {
    console.warn('[Blockingmachine] Failed to retrieve dynamic cosmetics:', err);
    injectCosmeticStyles(defaultCosmetics);
  }
}

// Inject baseline styles immediately to eliminate visual flash
injectCosmeticStyles(defaultCosmetics);
// Asynchronously apply full dynamic set from storage
applyCosmetics();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyCosmetics);
}

// Reactively re-inject when storage updates (e.g. background sync or remote control)
if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName === 'local' &&
      (changes[STORAGE_KEY_COSMETICS] ||
        changes[STORAGE_KEY_USER_COSMETICS] ||
        changes[STORAGE_KEY_COSMETICS_ENABLED])
    ) {
      applyCosmetics();
    }
  });
}

// Listen for element picker activations from popup or background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'START_ELEMENT_PICKER') {
    picker.start();
    sendResponse({ success: true });
    return true;
  }
  if (message?.type === 'TOGGLE_COSMETICS') {
    applyCosmetics();
    sendResponse({ success: true });
    return true;
  }
});

console.log('[Blockingmachine] In-page cosmetic shield active.');
