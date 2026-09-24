/**
 * Procedural Scriptlet & Anti-Adblock Defusers
 * Executed in world: 'MAIN' at document_start to neutralize detection traps
 * before third-party tracking scripts execute.
 */

export function applyMainWorldDefusers(): void {
  try {
    const defineSafeProperty = (obj: any, prop: string, value: any) => {
      try {
        Object.defineProperty(obj, prop, {
          get: () => value,
          set: () => {},
          configurable: true,
          enumerable: true
        });
      } catch {
        try {
          obj[prop] = value;
        } catch {
          // Ignore sealed objects
        }
      }
    };

    // 1. Common Adblock Flag Probes
    const win = window as any;
    defineSafeProperty(win, 'canRunAds', true);
    defineSafeProperty(win, 'isAdBlockActive', false);
    defineSafeProperty(win, '_adblock', false);
    defineSafeProperty(win, '__adguard_abp', false);
    defineSafeProperty(win, 'adsBlocked', false);

    // 2. Google Funding Choices / Privacy & Messaging Traps
    if (typeof win.googlefc === 'undefined') {
      const googlefcStub = {
        callbackQueue: [] as any[],
        getAdBlockInfo: () => ({ status: 'disabled' }),
        getPublisherData: () => ({}),
        controlledMessagingFunction: () => {},
        showRevocationMessage: () => {}
      };
      defineSafeProperty(win, 'googlefc', googlefcStub);
    }

    // 3. FuckAdBlock / BlockAdBlock Defusers
    const fakeFabInstance = {
      on: (_event: string, callback: any) => {
        if (_event === 'notDetected' && typeof callback === 'function') {
          setTimeout(callback, 0);
        }
        return fakeFabInstance;
      },
      onDetected: () => fakeFabInstance,
      onNotDetected: (callback: any) => {
        if (typeof callback === 'function') setTimeout(callback, 0);
        return fakeFabInstance;
      },
      check: () => true,
      clearEvent: () => {},
      setOption: () => {}
    };

    function FakeBlockAdBlock(this: any) {
      return fakeFabInstance;
    }
    FakeBlockAdBlock.prototype = fakeFabInstance;

    win.FuckAdBlock = FakeBlockAdBlock;
    win.BlockAdBlock = FakeBlockAdBlock;
    win.fuckAdBlock = fakeFabInstance;
    win.blockAdBlock = fakeFabInstance;

    // 4. Admiral / CMP Anti-Adblock Annoyance Defuser
    if (!win.admiral) {
      win.admiral = () => {};
    }

    // 5. Generic bait element bypass
    // Many anti-adblockers check if an element with class .ad-zone has height === 0
    // We override offsetHeight/clientHeight for bait elements if inspected
    const origGetComputedStyle = win.getComputedStyle;
    if (origGetComputedStyle) {
      win.getComputedStyle = function (elt: Element, pseudoElt?: string | null) {
        const style = origGetComputedStyle.call(win, elt, pseudoElt);
        if (elt && (elt.classList?.contains('ad-zone') || elt.id === 'ad-detector')) {
          return new Proxy(style, {
            get(target, prop) {
              if (prop === 'display') return 'block';
              if (prop === 'visibility') return 'visible';
              return (target as any)[prop];
            }
          });
        }
        return style;
      };
    }
  } catch {
    // Fail silently in MAIN world
  }
}

// Automatically execute when loaded as defusers.js in MAIN world
if (typeof window !== 'undefined') {
  applyMainWorldDefusers();
}
