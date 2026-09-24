/**
 * Procedural Scriptlet Injector
 * Injects anti-adblock defusers and property stubs into the target page before inline scripts execute.
 */
export function injectScriptlet(scriptSource: string): void {
  const scriptEl = document.createElement('script');
  scriptEl.textContent = `(function() {
    try {
      ${scriptSource}
    } catch (e) {
      console.warn('[Blockingmachine Scriptlet Error]', e);
    }
  })();`;
  (document.head || document.documentElement).appendChild(scriptEl);
  scriptEl.remove();
}

/**
 * Standard Anti-Adblock Defusers (Admiral, Google Funding Choices, generic detection traps)
 */
export function injectDefaultDefusers(): void {
  // Stubs for common anti-adblock flags
  const defuserCode = `
    window.__adguard_abp = false;
    window.canRunAds = true;
    window.isAdBlockActive = false;
    window._adblock = false;
    // Defuse Google Funding Choices / Privacy Messaging consent overlay loops
    if (typeof window.googlefc === 'undefined') {
      window.googlefc = { callbackQueue: [] };
    }
  `;
  injectScriptlet(defuserCode);
}
