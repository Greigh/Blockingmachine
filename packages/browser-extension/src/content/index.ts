import { injectCosmeticStyles } from './cosmeticHider.js';
import { ElementPicker } from './elementPicker.js';
import { ElementAiScanner } from './elementScanner.js';
import { loadElementFeedback } from './elementAiFeedback.js';
import { showToast } from './pageToast.js';
import {
  STORAGE_KEY_COSMETICS,
  STORAGE_KEY_USER_COSMETICS,
  STORAGE_KEY_COSMETICS_ENABLED,
  STORAGE_KEY_ELEMENT_AI_FEEDBACK,
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

interface ContextTarget {
  element: Element | null;
  at: number;
}

/** How long a right-click target stays valid for a menu action. */
const CONTEXT_TARGET_TTL_MS = 60_000;

/**
 * Content scripts can be injected more than once per frame (manifest plus a
 * programmatic injection, or after an extension reload in a live tab). Running
 * the module body twice would register duplicate listeners and double-handle
 * every message, so the whole install is guarded.
 */
const installFlag = '__blockingmachineContentInstalled';

function install(): void {
  // One classifier per frame, shared by the picker and the page scan, so a user
  // decision taken through either surface is immediately visible to the other.
  const scanner = new ElementAiScanner();
  const picker = new ElementPicker({ scanner });

  // Restore decisions the user made on earlier pages. The model is only as good as
  // what it remembers, and a page-level classifier forgets on navigation.
  void loadElementFeedback(scanner.getClassifier()).then((count) => {
    if (count > 0) {
      console.log(`[Blockingmachine] Element AI: ${count} learned decisions restored.`);
    }
  });

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[STORAGE_KEY_ELEMENT_AI_FEEDBACK]) {
        void loadElementFeedback(scanner.getClassifier());
      }
    });
  }

  // ─── Cosmetics ──────────────────────────────────────────────────────────────

  async function applyCosmetics(): Promise<void> {
    try {
      if (!chrome.storage?.local) {
        injectCosmeticStyles(defaultCosmetics);
        return;
      }

      const res = await chrome.storage.local.get([
        STORAGE_KEY_COSMETICS,
        STORAGE_KEY_USER_COSMETICS,
        STORAGE_KEY_COSMETICS_ENABLED,
      ]);

      const isEnabled = res[STORAGE_KEY_COSMETICS_ENABLED] !== false;
      if (!isEnabled) {
        // Remote control toggle turned cosmetics off.
        document.getElementById('bm-cosmetic-shield')?.remove();
        return;
      }

      const asStringList = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];

      const combined = [
        ...defaultCosmetics,
        ...asStringList(res[STORAGE_KEY_COSMETICS]),
        ...asStringList(res[STORAGE_KEY_USER_COSMETICS]),
      ];

      injectCosmeticStyles(Array.from(new Set(combined)));
    } catch (err) {
      console.warn('[Blockingmachine] Failed to retrieve dynamic cosmetics:', err);
      injectCosmeticStyles(defaultCosmetics);
    }
  }

  // Inject baseline styles immediately to eliminate visual flash.
  injectCosmeticStyles(defaultCosmetics);
  void applyCosmetics();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void applyCosmetics());
  }

  // Reactively re-inject when storage updates (background sync or remote control).
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (
        areaName === 'local' &&
        (changes[STORAGE_KEY_COSMETICS] ||
          changes[STORAGE_KEY_USER_COSMETICS] ||
          changes[STORAGE_KEY_COSMETICS_ENABLED])
      ) {
        void applyCosmetics();
      }
    });
  }

  // ─── Right-click target capture ─────────────────────────────────────────────

  // Recorded cheaply and always, so the context-menu actions ("Block element",
  // "Block similar", "Copy selector") can act on the exact element the user
  // right-clicked. Capturing on contextmenu is far cheaper than building a
  // selector for every hover on every page.
  let contextTarget: ContextTarget = { element: null, at: 0 };

  document.addEventListener(
    'contextmenu',
    (event) => {
      contextTarget = {
        element: event.target instanceof Element ? event.target : null,
        at: Date.now(),
      };
    },
    true,
  );

  function freshContextTarget(): Element | null {
    const { element, at } = contextTarget;
    if (!element || Date.now() - at > CONTEXT_TARGET_TTL_MS) return null;
    if (!element.isConnected) return null;
    return element;
  }

  // ─── Clipboard ──────────────────────────────────────────────────────────────

  async function copyText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall through to the legacy path (no clipboard permission in frame).
    }

    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('data-bm-ui', 'clipboard');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.documentElement.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  // ─── Messages ───────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'START_ELEMENT_PICKER':
        picker.start();
        sendResponse({ success: true });
        return true;

      case 'STOP_ELEMENT_PICKER':
        picker.stop();
        sendResponse({ success: true });
        return true;

      case 'TOGGLE_COSMETICS':
        void applyCosmetics();
        sendResponse({ success: true });
        return true;

      case 'PING':
        sendResponse({ success: true, url: location.href });
        return false;

      case 'SCAN_PAGE_FOR_ADS': {
        // Report what the element AI would do on this page without touching it.
        try {
          const result = scanner.scan();
          sendResponse({
            success: true,
            scanned: result.scanned,
            hideCount: result.hideCount,
            suggestCount: result.suggestCount,
            groups: result.groups.map((group) => ({
              key: group.key,
              selector: group.selector,
              matches: group.matches,
              elementClass: group.elementClass,
              count: group.count,
              confidence: group.confidence,
              label: group.label,
              reason: group.reason,
            })),
          });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
        return false;
      }

      case 'HIGHLIGHT_AI_CANDIDATES': {
        picker.start();
        sendResponse({ success: true });
        return false;
      }

      case 'BLOCK_AI_CANDIDATES': {
        const requested = Array.isArray(message.payload?.selectors) ? message.payload.selectors : null;
        const groups = requested
          ? scanner.lastScan()?.groups.filter((group) => requested.includes(group.selector)) ?? []
          : scanner.scan().groups;
        void picker.blockAiGroups(groups).then((result) => sendResponse({ success: true, ...result }));
        return true;
      }

      case 'ELEMENT_AI_FEEDBACK': {
        const element = freshContextTarget();
        if (!element) {
          sendResponse({ success: false, error: 'The right-clicked element is no longer available.' });
          return false;
        }
        const keep = message.payload?.action === 'keep';
        void (keep ? picker.keepElement(element) : picker.markElement(element, 'hide')).then((ok) =>
          sendResponse({ success: ok }),
        );
        return true;
      }

      case 'ELEMENT_AI_VERDICT': {
        const element = freshContextTarget();
        if (!element) {
          sendResponse({ success: false });
          return false;
        }
        const prediction = scanner.classifyElement(element);
        sendResponse({
          success: true,
          verdict: {
            elementClass: prediction.elementClass,
            action: prediction.action,
            confidence: prediction.confidence,
            corroboration: prediction.corroboration,
            reasons: prediction.reasons,
            elementsOnPage: scanner.lastScan()?.hideCount ?? 0,
          },
        });
        return false;
      }

      case 'BLOCK_CONTEXT_TARGET': {
        const element = freshContextTarget();
        if (!element) {
          sendResponse({ success: false, error: 'The right-clicked element is no longer available.' });
          return false;
        }
        picker.blockElement(element).then((ok) =>
          sendResponse({ success: ok, selector: picker.selectorFor(element) }),
        );
        return true;
      }

      case 'BLOCK_SIMILAR_CONTEXT_TARGET': {
        const element = freshContextTarget();
        if (!element) {
          sendResponse({ success: false, error: 'The right-clicked element is no longer available.' });
          return false;
        }
        picker.blockSimilarTo(element).then((ok) => sendResponse({ success: ok }));
        return true;
      }

      case 'BLOCK_SELECTOR': {
        const selector = typeof message.payload?.selector === 'string' ? message.payload.selector : '';
        if (!selector) {
          sendResponse({ success: false, error: 'No selector supplied.' });
          return false;
        }
        picker
          .applyRule(selector, message.payload?.matches ?? 1, message.payload?.mode === 'similar' ? 'similar' : 'element')
          .then((ok) => sendResponse({ success: ok }));
        return true;
      }

      case 'COPY_FROM_PAGE': {
        const text = typeof message.payload?.text === 'string' ? message.payload.text : '';
        if (!text) {
          sendResponse({ success: false });
          return false;
        }
        copyText(text).then((ok) => {
          if (ok) showToast({ message: 'Copied to clipboard.', tone: 'success' });
          sendResponse({ success: ok });
        });
        return true;
      }

      case 'COPY_CONTEXT_SELECTOR': {
        const element = freshContextTarget();
        if (!element) {
          sendResponse({ success: false, error: 'The right-clicked element is no longer available.' });
          return false;
        }
        const selector = picker.selectorFor(element);
        if (!selector) {
          sendResponse({ success: false, error: 'No unique selector for that element.' });
          return false;
        }
        copyText(selector).then((ok) => {
          if (ok) showToast({ message: `Copied selector: ${selector}`, tone: 'success' });
          sendResponse({ success: ok, selector });
        });
        return true;
      }

      case 'SHOW_PAGE_TOAST': {
        const text = typeof message.payload?.message === 'string' ? message.payload.message : '';
        if (text) {
          showToast({
            message: text,
            tone: message.payload?.tone === 'warn' ? 'warn' : message.payload?.tone === 'success' ? 'success' : 'info',
          });
        }
        sendResponse({ success: Boolean(text) });
        return false;
      }

      default:
        return false;
    }
  });
}

const globalScope = window as unknown as Record<string, unknown>;
if (!globalScope[installFlag]) {
  globalScope[installFlag] = true;
  install();
  console.log('[Blockingmachine] In-page cosmetic shield active.');
}
