/**
 * Scriptlet library suite — P2 Task 2. Two surfaces under test:
 *
 *  1. Emission correctness: `scriptletCallSource`/`renderScriptletBlock` must
 *     produce inline-script-safe text — `</script>`, `<!--`, U+2028/U+2029 are
 *     the only ways an interpolated arg can break out of the `<script>` body
 *     and they are all pinned here. `KNOWN_SCRIPTLETS` must exactly equal the
 *     core canonical set so Task 3's `skippedScriptlets` counter is accurate.
 *
 *  2. Runtime behavior: the emitted library + calls run through a hand-rolled
 *     fake `window`/`document`/`localStorage` harness (deliberately NOT jsdom —
 *     we want to prove the payloads degrade gracefully under a partial DOM,
 *     which is exactly what a hostile page hands us). Every handler body is
 *     individually guarded; a bad invocation must never kill the rest.
 */

import { describe, expect, test } from '@jest/globals';
import { CANONICAL_SCRIPTLET_NAMES } from '@blockingmachine/core';
import {
  KNOWN_SCRIPTLETS,
  renderScriptletBlock,
  scriptletCallSource,
  scriptletRuntimeSource,
  type CanonicalScriptlet,
} from '../pipeline/scriptlets.js';

interface FakePage {
  window: any;
  document: any;
  listeners: Record<string, Array<(...args: any[]) => any>>;
  timeouts: { fn: any; d: any }[];
  intervals: { fn: any; d: any }[];
  globals: Record<string, unknown>;
}

/** ~30-line fake page: just enough surface for the runtime's guarded paths. */
function fakePage(): FakePage {
  const timeouts: FakePage['timeouts'] = [];
  const intervals: FakePage['intervals'] = [];
  const listeners: Record<string, Array<(...args: any[]) => any>> = {};
  const store = new Map<string, string>();
  const memStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(String(k), String(v)),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i],
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
  };
  const nativeTimeout = (fn: any, d?: any) => (timeouts.push({ fn, d }), timeouts.length);
  const nativeInterval = (fn: any, d?: any) => (intervals.push({ fn, d }), intervals.length);
  const window: any = {
    setTimeout: nativeTimeout,
    setInterval: nativeInterval,
    open: (u: string) => ({ opened: u }),
    eval: (s: string) => 'evaled:' + s,
    fetch: (u: string) => Promise.resolve('real:' + u),
    localStorage: memStorage,
    sessionStorage: memStorage,
    location: { href: 'https://page.test/' },
    onerror: null,
    XMLHttpRequest: function (this: any) {},
    EventTarget: function (this: any) {},
    atob: (s: string) => Buffer.from(s, 'base64').toString(),
    URL,
    Response,
    MutationObserver: undefined,
  };
  window.EventTarget.prototype = {
    addEventListener: (t: string, fn: (...args: any[]) => any) => void (listeners[t] = listeners[t] ?? []).push(fn),
  };
  const document: any = {
    currentScript: null,
    documentElement: {},
    head: {
      appended: [] as any[],
      appendChild(el: any) {
        this.appended.push(el);
        return el;
      },
    },
    readyState: 'complete',
    location: window.location,
    addEventListener: (t: string, fn: (...args: any[]) => any) => void ((document._l[t] = document._l[t] ?? []).push(fn)),
    querySelectorAll: () => [],
    createElement: () => ({ textContent: '', setAttribute() {}, removeAttribute() {} }),
    _l: {} as Record<string, Array<(...args: any[]) => any>>,
  };
  const globals: Record<string, unknown> = {
    window, document, navigator: { userAgent: 'fake' },
    localStorage: memStorage, sessionStorage: memStorage,
    XMLHttpRequest: window.XMLHttpRequest, EventTarget: window.EventTarget,
    URL, Response, JSON, Promise, WeakMap, Error, Object, Array, Number, String,
    Math, RegExp, ArrayBuffer, parseInt, parseFloat, isFinite, isNaN,
    decodeURIComponent, Function,
    setTimeout: nativeTimeout, setInterval: nativeInterval,
    Event: function (this: any, t: string) { this.type = t; },
  };
  return { window, document, listeners, timeouts, intervals, globals };
}

/** Executes generated payload text inside the fake page's globals. */
function run(page: FakePage, code: string): void {
  const names = Object.keys(page.globals);
  new Function(...names, code)(...names.map((n) => page.globals[n]));
}

const runIn = (page: FakePage, invocations: CanonicalScriptlet[]) =>
  run(page, scriptletRuntimeSource() + '\n' + scriptletCallSource(invocations));

describe('emission correctness', () => {
  test('renderScriptletBlock returns undefined for empty lists', () => {
    expect(renderScriptletBlock([])).toBeUndefined();
    expect(renderScriptletBlock(undefined)).toBeUndefined();
    const block = renderScriptletBlock([{ name: 'set-constant', args: ['a', '1'] }]);
    expect(block).toContain('__bm_sc');
    expect(block).toContain('set-constant');
  });

  test('each invocation emits one try/catch-wrapped dispatcher call', () => {
    const src = scriptletCallSource([
      { name: 'set-constant', args: ['a', '1'] },
      { name: 'prevent-fetch', args: ['ads'] },
    ]);
    const calls = src.match(/try\{\(window\.__bm_sc\|\|function\(\)\{\}\)/g);
    expect(calls).toHaveLength(2);
    expect(src.match(/catch\(/g)).toHaveLength(2);
  });

  test('</script> breakout is escaped — the mandatory breakout case stays inert', () => {
    const evil = 'a</script><img src=x onerror=globalThis.__pwned=1>';
    const calls = scriptletCallSource([{ name: 'set-constant', args: ['x', evil] }]);
    expect(calls.toLowerCase()).not.toContain('</script');
    expect(calls).toContain('<\\/script');
    const page = fakePage();
    runIn(page, [{ name: 'set-constant', args: ['x', evil] }]);
    expect(page.window.x).toBe(evil);
    expect((globalThis as any).__pwned).toBeUndefined();
  });

  test('<!-- and U+2028/U+2029 are escaped; backslashes/quotes round-trip', () => {
    const arg = `<!--x "q" \\ end\u2028line\u2029`;
    const calls = scriptletCallSource([{ name: 'set-constant', args: ['y', arg] }]);
    expect(calls).not.toContain('<!--');
    expect(calls).toContain('\\x3C!--');
    expect(calls).toContain('\\u2028');
    expect(calls).toContain('\\u2029');
    const page = fakePage();
    runIn(page, [{ name: 'set-constant', args: ['y', arg] }]);
    expect(page.window.y).toBe(arg);
  });

  test('KNOWN_SCRIPTLETS equals the core canonical set', () => {
    expect(KNOWN_SCRIPTLETS.size).toBe(CANONICAL_SCRIPTLET_NAMES.size);
    for (const name of CANONICAL_SCRIPTLET_NAMES) {
      expect(KNOWN_SCRIPTLETS.has(name)).toBe(true);
    }
    for (const name of KNOWN_SCRIPTLETS) {
      expect(CANONICAL_SCRIPTLET_NAMES.has(name)).toBe(true);
    }
  });

  test('runtime text itself contains no breakout sequences', () => {
    const rt = scriptletRuntimeSource();
    expect(rt.toLowerCase()).not.toContain('</script');
    expect(rt).not.toContain('<!--');
    expect(rt).not.toContain('\u2028');
    expect(rt).not.toContain('\u2029');
    new Function(rt); // parses standalone
  });
});

describe('runtime behavior under a fake page', () => {
  test('installs __bm_sc non-enumerable, non-writable, non-configurable', () => {
    const page = fakePage();
    run(page, scriptletRuntimeSource());
    const d = Object.getOwnPropertyDescriptor(page.window, '__bm_sc');
    expect(typeof page.window.__bm_sc).toBe('function');
    expect(d?.enumerable).toBe(false);
    expect(d?.writable).toBe(false);
    expect(d?.configurable).toBe(false);
    expect(Object.keys(page.window)).not.toContain('__bm_sc');
  });

  test('second injection is a no-op', () => {
    const page = fakePage();
    const rt = scriptletRuntimeSource();
    run(page, rt);
    const first = page.window.__bm_sc;
    run(page, rt);
    expect(page.window.__bm_sc).toBe(first);
  });

  test('set-constant defines a dotted path, creating intermediates', () => {
    const page = fakePage();
    runIn(page, [{ name: 'set-constant', args: ['ads.blocked', 'false'] }]);
    expect(page.window.ads.blocked).toBe(false);
    page.window.ads.blocked = 'sentinel'; // type-mismatch write ends the trap (uBO mustAbort)
    expect(page.window.ads.blocked).toBe('sentinel');
  });

  test('set-constant resolves value tokens', () => {
    const page = fakePage();
    runIn(page, [
      { name: 'set-constant', args: ['t.n', '42'] },
      { name: 'set-constant', args: ['t.o', 'emptyObj'] },
      { name: 'set-constant', args: ['t.a', 'emptyArr'] },
      { name: 'set-constant', args: ['t.f', 'noopFunc'] },
      { name: 'set-constant', args: ['t.s', 'hello world'] },
    ]);
    expect(page.window.t.n).toBe(42);
    expect(page.window.t.o).toEqual({});
    expect(page.window.t.a).toEqual([]);
    expect(typeof page.window.t.f).toBe('function');
    expect(page.window.t.s).toBe('hello world');
  });

  test('abort-on-property-read throws ReferenceError on get', () => {
    const page = fakePage();
    page.window.tracker = { enabled: true };
    runIn(page, [{ name: 'abort-on-property-read', args: ['tracker.enabled'] }]);
    expect(() => page.window.tracker.enabled).toThrow(ReferenceError);
  });

  test('abort-on-property-write throws ReferenceError on set', () => {
    const page = fakePage();
    page.window.tracker = { count: 0 };
    runIn(page, [{ name: 'abort-on-property-write', args: ['tracker.count'] }]);
    expect(() => {
      page.window.tracker.count = 5;
    }).toThrow(ReferenceError);
    expect(page.window.tracker.count).toBe(0);
  });

  test('abort exception is swallowed by the token onerror', () => {
    const page = fakePage();
    page.window.tracker = { enabled: true };
    runIn(page, [{ name: 'abort-on-property-read', args: ['tracker.enabled'] }]);
    // The token is embedded in the ReferenceError message — page sees nothing.
    let message = '';
    try {
      message = String(page.window.tracker.enabled);
    } catch (e) {
      message = String(e);
    }
    const onerror = page.window.onerror as (...args: any[]) => any; // installed on first abort
    expect(typeof onerror).toBe('function');
    expect(onerror(message)).toBe(true);
    expect(onerror('unrelated error')).toBe(false);
  });

  test('prevent-setTimeout swallows the matching callback, keeps the id', () => {
    const page = fakePage();
    runIn(page, [{ name: 'prevent-setTimeout', args: ['badFn'] }]);
    function badFn() {
      page.window.ranBad = true;
    }
    function goodFn() {
      page.window.ranGood = true;
    }
    page.window.setTimeout(badFn, 10);
    page.window.setTimeout(goodFn, 10);
    expect(page.timeouts).toHaveLength(2); // real timer id still comes back
    page.timeouts[0].fn();
    page.timeouts[1].fn();
    expect(page.window.ranBad).toBeUndefined();
    expect(page.window.ranGood).toBe(true);
  });

  test('prevent-setTimeout delay range restricts matches', () => {
    const page = fakePage();
    runIn(page, [{ name: 'prevent-setTimeout', args: ['badFn', '1000-2000'] }]);
    const bad = function badFn() {};
    page.window.setTimeout(bad, 1500);
    page.window.setTimeout(bad, 50);
    expect(page.timeouts[0].fn).not.toBe(bad);
    expect(page.timeouts[1].fn).toBe(bad);
  });

  test('adjust-setTimeout scales matching delays', () => {
    const page = fakePage();
    runIn(page, [{ name: 'adjust-setTimeout', args: ['', '*', '0.1'] }]);
    page.window.setTimeout(() => {}, 1000);
    expect(page.timeouts[0].d).toBe(100);
  });

  test('prevent-addEventListener drops matching registrations only', () => {
    const page = fakePage();
    runIn(page, [{ name: 'prevent-addEventListener', args: ['click', 'spy'] }]);
    const spy = function spy() {};
    const ok = function ok() {};
    page.window.EventTarget.prototype.addEventListener('click', spy);
    page.window.EventTarget.prototype.addEventListener('click', ok);
    page.window.EventTarget.prototype.addEventListener('load', spy);
    expect(page.listeners.click).toEqual([ok]);
    expect(page.listeners.load).toEqual([spy]);
  });

  test('json-prune removes a matching path only when needle paths present', () => {
    const page = fakePage();
    const jsonObj = { parse: (s: string) => JSON.parse(s) };
    page.globals.JSON = jsonObj;
    runIn(page, [{ name: 'json-prune', args: ['a.b', 'keep'] }]);
    const out = jsonObj.parse('{"a":{"b":1,"c":2},"keep":{"b":9}}');
    expect(out).toEqual({ a: { c: 2 }, keep: { b: 9 } });
    expect(jsonObj.parse('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
  });

  test('json-prune wildcard tokens prune across containers', () => {
    const page = fakePage();
    runIn(page, [{ name: 'json-prune', args: ['x.items.[-].ad', 'x'] }]);
    const out = JSON.parse('{"x":{"items":[{"ad":1,"v":1},{"v":2}]},"items":[{"ad":1}]}');
    expect(out).toEqual({ x: { items: [{ v: 2 }] }, items: [{ ad: 1 }] });
  });

  test('prevent-window-open returns null on match, forwards others', () => {
    const page = fakePage();
    runIn(page, [{ name: 'prevent-window-open', args: ['ads'] }]);
    expect(page.window.open('https://ads.example/x')).toBeNull();
    expect(page.window.open('https://ok.example/')).toEqual({ opened: 'https://ok.example/' });
  });

  test('prevent-eval-if swallows matching sources', () => {
    const page = fakePage();
    runIn(page, [{ name: 'prevent-eval-if', args: ['evil'] }]);
    expect(page.window.eval('evil()')).toBeUndefined();
    expect(page.window.eval('good()')).toBe('evaled:good()');
  });

  test('set/remove-local-storage-item seed and delete', () => {
    const page = fakePage();
    runIn(page, [
      { name: 'set-local-storage-item', args: ['k1', 'emptyObj'] },
      { name: 'set-local-storage-item', args: ['k2', 'gone'] },
      { name: 'remove-local-storage-item', args: ['k2'] },
    ]);
    expect(page.window.localStorage.getItem('k1')).toBe('{}');
    expect(page.window.localStorage.getItem('k2')).toBeNull();
  });

  test('abort-on-stack-trace leaves non-matching reads alone', () => {
    const page = fakePage();
    page.window.Ya = { metric: 7 };
    runIn(page, [{ name: 'abort-on-stack-trace', args: ['Ya.metric', 'not-in-this-stack-xyz'] }]);
    expect(page.window.Ya.metric).toBe(7);
  });

  test('prevent-fetch resolves a Response-like for matches', async () => {
    const page = fakePage();
    let passthrough: any;
    page.window.fetch = (u: string) => {
      passthrough = u;
      return Promise.resolve('real');
    };
    runIn(page, [{ name: 'prevent-fetch', args: ['tracker'] }]);
    const res = await page.window.fetch('https://tracker.example/beacon');
    expect(res.status).toBe(200);
    expect(await res.text()).toBeDefined();
    expect(passthrough).toBeUndefined();
    await page.window.fetch('https://cdn.example/lib.js');
    expect(passthrough).toBe('https://cdn.example/lib.js');
  });

  test('nowebrtc stubs RTCPeerConnection', () => {
    const page = fakePage();
    page.window.RTCPeerConnection = function (this: any) {
      this.real = true;
    };
    runIn(page, [{ name: 'nowebrtc', args: [] }]);
    const pc = new page.window.RTCPeerConnection();
    expect(pc.real).toBeUndefined();
    expect(typeof pc.close).toBe('function');
    expect(String(pc)).toBe('[object RTCPeerConnection]');
  });

  test('unknown names never throw and increment misses silently', () => {
    const page = fakePage();
    runIn(page, [
      { name: 'definitely-not-a-scriptlet', args: ['x'] },
      { name: 'also-bogus', args: [] },
      { name: 'set-constant', args: ['ok', '1'] },
    ]);
    expect(page.window.__bm_sc.misses).toBe(2);
    expect(page.window.ok).toBe(1); // good call after bad ones still ran
    const d = Object.getOwnPropertyDescriptor(page.window.__bm_sc, 'misses');
    expect(d?.enumerable).toBe(false);
  });

  test('a malformed invocation cannot kill later ones', () => {
    const page = fakePage();
    run(page, scriptletRuntimeSource());
    // A handler that throws synchronously is contained by the call's own try.
    run(page, `try{(window.__bm_sc)('set-constant',[null])}catch(_e){}`);
    runIn(page, [{ name: 'set-constant', args: ['alive', '7'] }]);
    expect(page.window.alive).toBe(7);
  });
});
