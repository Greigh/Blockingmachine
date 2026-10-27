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
  window.XMLHttpRequest.prototype = {
    open: function (this: any, m: string, u: string) {
      this._opened = [m, u];
    },
    send: function (this: any) {
      this._sent = true;
    },
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
    decodeURIComponent, Function, Blob, FormData,
    setTimeout: nativeTimeout, setInterval: nativeInterval,
    Event: function (this: any, t: string) { this.type = t; },
  };
  return { window, document, listeners, timeouts, intervals, globals };
}

/**
 * Minimal element fake: `attributes` stays synced with the attr/class sets,
 * `classList` exposes live `length` + indexable tokens + `remove`, and every
 * `removeAttribute` call is recorded so tests can see an emptied `class`.
 */
function fakeEl(opts: { attrs?: string[]; classes?: string[] } = {}) {
  const attrs = [...(opts.attrs ?? [])];
  const classes = [...(opts.classes ?? [])];
  const el: any = { removed: [] as string[], attributes: [] as { name: string }[], classes };
  const sync = () => {
    el.attributes = attrs.concat(classes.length ? ['class'] : []).map((name) => ({ name }));
  };
  el.removeAttribute = (n: string) => {
    el.removed.push(n);
    if (n === 'class') {
      classes.length = 0;
    } else {
      const i = attrs.indexOf(n);
      if (i > -1) attrs.splice(i, 1);
    }
    sync();
  };
  Object.defineProperty(el, 'classList', {
    get() {
      const list: any = {
        get length() {
          return classes.length;
        },
        remove: (c: string) => {
          const i = classes.indexOf(c);
          if (i > -1) classes.splice(i, 1);
          sync();
        },
      };
      classes.forEach((c, i) => {
        list[i] = c;
      });
      return list;
    },
  });
  sync();
  return el;
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

  test('emitted regexes survive template-literal cooking', () => {
    // The runtime is a TS template literal — `\s`/`\d`/`\w` must be written
    // `\\s`/`\\d`/`\\w` or the emitted text reads `split(/s+/)` etc. Parsing
    // the payload proves syntax only; this pins the actual regex source.
    const rt = scriptletRuntimeSource();
    expect(rt).toContain('split(/\\s+/)');
    expect(rt).toContain('/^length:(\\d+)(?:-(\\d+))?$/');
    expect(rt).toContain('/[^$\\w -]/');
    expect(rt).not.toContain('split(/s+/)');
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

  test('__bm_sc carries a non-enumerable __bm marker', () => {
    const page = fakePage();
    run(page, scriptletRuntimeSource());
    expect(page.window.__bm_sc.__bm).toBe(1);
    const d = Object.getOwnPropertyDescriptor(page.window.__bm_sc, '__bm');
    expect(d?.enumerable).toBe(false);
    expect(Object.keys(page.window.__bm_sc)).not.toContain('__bm');
  });

  test('a foreign truthy __bm_sc is replaced, not obeyed', () => {
    const page = fakePage();
    const foreign = function () {
      page.window.foreignCalled = true;
    };
    page.window.__bm_sc = foreign; // plain assignment → configurable → replaceable
    runIn(page, [{ name: 'set-constant', args: ['ok2', '5'] }]);
    expect(page.window.__bm_sc).not.toBe(foreign);
    expect(page.window.__bm_sc.__bm).toBe(1);
    expect(page.window.ok2).toBe(5);
    expect(page.window.foreignCalled).toBeUndefined();
  });

  test('a foreign non-configurable __bm_sc is logged on its misses and bails', () => {
    const page = fakePage();
    const foreign: any = function () {};
    Object.defineProperty(page.window, '__bm_sc', { value: foreign, configurable: false });
    run(page, scriptletRuntimeSource());
    expect(page.window.__bm_sc).toBe(foreign); // unbeatable — cannot redefine
    expect(foreign.misses).toBe(1); // honest accounting of the blocked install
  });

  test('a non-extensible window never throws out of the IIFE — calls degrade to the fallback', () => {
    // `Object.preventExtensions(window)` is the hostile-page shape that makes
    // the `dp(w,'__bm_sc',…)` install throw; the guarded runtime must swallow
    // it, and each invocation's own `||function(){}` fallback keeps the rest
    // of the script block alive.
    const page = fakePage();
    Object.preventExtensions(page.window);
    expect(() => runIn(page, [{ name: 'set-constant', args: ['ok3', '7'] }])).not.toThrow();
    expect(page.window.__bm_sc).toBeUndefined();
  });

  test('set-constant lazily traps a leaf under a page-created intermediate', () => {
    const page = fakePage();
    runIn(page, [{ name: 'set-constant', args: ['ads.blocked', 'false'] }]);
    // uBO trapChain semantics: no eager {} — `typeof window.ads` must not flip.
    expect(page.window.ads).toBeUndefined();
    page.window.ads = {}; // the page's own assignment descends and traps the leaf
    expect(page.window.ads.blocked).toBe(false);
    page.window.ads.blocked = 'sentinel'; // type-mismatch write ends the trap (uBO mustAbort)
    expect(page.window.ads.blocked).toBe('sentinel');
  });

  test('set-constant leaves an existing type-mismatched leaf alone', () => {
    const page = fakePage();
    page.window.foo = 42;
    runIn(page, [{ name: 'set-constant', args: ['foo', 'false'] }]);
    expect(page.window.foo).toBe(42); // init mustAbort — an existing number isn't masked
    page.window.foo = 43;
    expect(page.window.foo).toBe(43); // still a plain data prop — no trap was installed
    page.window.flag = true;
    runIn(page, [{ name: 'set-constant', args: ['flag', 'false'] }]);
    expect(page.window.flag).toBe(false); // same-type existing value still gets trapped
  });

  test('set-constant resolves value tokens', () => {
    const page = fakePage();
    page.window.t = {}; // intermediate must exist or arrive via page assignment (lazy traps)
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

  test('prevent-fetch honors a two-token propsToMatch spec', async () => {
    // `'method:get url:tracker'` — this spec was dead when the runtime
    // split on the letter 's' (emitted `split(/s+/)` after template
    // cooking); it also proves key:value needles hit collated init props.
    const page = fakePage();
    const seen: string[] = [];
    page.window.fetch = (u: string) => {
      seen.push(u);
      return Promise.resolve('real');
    };
    runIn(page, [{ name: 'prevent-fetch', args: ['method:get url:tracker'] }]);
    const blocked = await page.window.fetch('https://tracker.example/beacon', { method: 'get' });
    expect(blocked.status).toBe(200);
    expect(seen).toHaveLength(0);
    await page.window.fetch('https://tracker.example/beacon', { method: 'post' });
    await page.window.fetch('https://cdn.example/lib', { method: 'get' });
    expect(seen).toEqual(['https://tracker.example/beacon', 'https://cdn.example/lib']);
  });

  test('prevent-fetch serves responseBody tokens through the fake Response', async () => {
    const page = fakePage();
    runIn(page, [{ name: 'prevent-fetch', args: ['trk', 'emptyObj'] }]);
    const res = await page.window.fetch('https://trk.example/');
    expect(await res.json()).toEqual({}); // emptyObj → body '{}'
    const page2 = fakePage();
    runIn(page2, [{ name: 'prevent-fetch', args: ['trk', 'length:5'] }]);
    const res2 = await page2.window.fetch('https://trk.example/');
    expect(await res2.text()).toHaveLength(5);
  });

  test('prevent-fetch negated needle passes matching urls and blocks the rest', async () => {
    const page = fakePage();
    const seen: string[] = [];
    page.window.fetch = (u: string) => {
      seen.push(u);
      return Promise.resolve('real');
    };
    runIn(page, [{ name: 'prevent-fetch', args: ['!good.com'] }]);
    await page.window.fetch('https://good.com/keep.js');
    expect(seen).toEqual(['https://good.com/keep.js']); // NOT-contains → passthrough
    const res = await page.window.fetch('https://ads.example/x');
    expect(res.status).toBe(200); // everything else is prevented
    expect(seen).toHaveLength(1);
  });

  test('prevent-fetch facade fallback carries blob/formData/redirected/type', async () => {
    const page = fakePage();
    page.globals.Response = undefined as any; // force the object-literal facade
    runIn(page, [{ name: 'prevent-fetch', args: ['trk', 'emptyObj'] }]);
    const res = await page.window.fetch('https://trk.example/');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(false);
    expect(res.type).toBe('default');
    expect(await res.text()).toBe('{}');
    expect(await res.json()).toEqual({});
    await expect(res.blob()).resolves.toBeDefined();
    await expect(res.formData()).resolves.toBeDefined();
    expect(res.clone()).not.toBe(res); // uBO parity: a real clone() is a new Response
    expect(res.clone().bodyUsed).toBe(false);
  });

  test('prevent-xhr honors a two-token spec and serves responseBody', () => {
    const page = fakePage();
    runIn(page, [{ name: 'prevent-xhr', args: ['method:get url:beacon', 'emptyObj'] }]);
    const x1: any = new page.window.XMLHttpRequest();
    x1.open('get', 'https://trk.test/beacon');
    x1.send();
    expect(x1._sent).toBeUndefined(); // real send never ran
    expect(x1.readyState).toBe(4);
    expect(x1.status).toBe(200);
    expect(x1.responseText).toBe('{}');
    const x2: any = new page.window.XMLHttpRequest();
    x2.open('post', 'https://trk.test/beacon');
    x2.send();
    expect(x2._sent).toBe(true); // method needle failed → passthrough
    const x3: any = new page.window.XMLHttpRequest();
    x3.open('get', 'https://cdn.test/lib');
    x3.send();
    expect(x3._sent).toBe(true); // url needle failed → passthrough
  });

  test('prevent-fetch key:value needles match arbitrary init props', async () => {
    const page = fakePage();
    const seen: string[] = [];
    page.window.fetch = (u: string) => {
      seen.push(u);
      return Promise.resolve('real');
    };
    runIn(page, [{ name: 'prevent-fetch', args: ['headers:x-tracker'] }]);
    const blocked = await page.window.fetch('https://api.example/', { headers: { 'x-tracker': '1' } });
    expect(blocked.status).toBe(200); // '{"x-tracker":"1"}' contains the needle
    await page.window.fetch('https://api.example/', { headers: { other: '1' } });
    await page.window.fetch('https://api.example/'); // absent prop → needle skipped → no match
    expect(seen).toEqual(['https://api.example/', 'https://api.example/']);
  });

  test('abort-on-stack-trace with no needle aborts every access', () => {
    // uBO parity: an empty stack needle matches all stacks (default-yes).
    const page = fakePage();
    page.window.Ya = { metric: 7 };
    runIn(page, [{ name: 'abort-on-stack-trace', args: ['Ya.metric'] }]);
    expect(() => page.window.Ya.metric).toThrow(ReferenceError);
  });

  test('remove-attr strips matching attribute names only', () => {
    const page = fakePage();
    const el = fakeEl({ attrs: ['data-ad', 'id', 'data-track'] });
    page.document.querySelectorAll = () => [el];
    runIn(page, [{ name: 'remove-attr', args: ['data-ad|data-track'] }]);
    // both literals removed — pins the eq() closure (a shared `var` would
    // have made every matcher test the last token only)
    expect(el.attributes.map((a: any) => a.name)).toEqual(['id']);
  });

  test('remove-attr regex tokens accept flags', () => {
    const page = fakePage();
    const el = fakeEl({ attrs: ['DATA-AD', 'id'] });
    page.document.querySelectorAll = () => [el];
    runIn(page, [{ name: 'remove-attr', args: ['/data-.*/i'] }]);
    expect(el.attributes.map((a: any) => a.name)).toEqual(['id']);
  });

  test('remove-class strips matching classes via classList', () => {
    const page = fakePage();
    const el = fakeEl({ attrs: ['id'], classes: ['ads', 'keep', 'promo'] });
    page.document.querySelectorAll = () => [el];
    runIn(page, [{ name: 'remove-class', args: ['ads|promo'] }]);
    expect(el.classes).toEqual(['keep']);
    expect(el.removed).toEqual([]); // 'keep' survives → class attr stays
  });

  test('remove-class drops the class attribute when emptied', () => {
    const page = fakePage();
    const el = fakeEl({ attrs: ['id'], classes: ['ads'] });
    page.document.querySelectorAll = () => [el];
    runIn(page, [{ name: 'remove-class', args: ['ads'] }]);
    expect(el.classes).toEqual([]);
    expect(el.removed).toEqual(['class']);
  });

  test('remove-local-storage-item regex keys accept flags', () => {
    const page = fakePage();
    page.window.localStorage.setItem('k1', 'x');
    page.window.localStorage.setItem('K2', 'x');
    page.window.localStorage.setItem('keep', 'x');
    runIn(page, [{ name: 'remove-local-storage-item', args: ['/k\\d/i'] }]);
    expect(page.window.localStorage.getItem('k1')).toBeNull();
    expect(page.window.localStorage.getItem('K2')).toBeNull();
    expect(page.window.localStorage.getItem('keep')).toBe('x');
  });

  test('no-protected-audience stubs existing PA methods with promise fakes', async () => {
    const page = fakePage();
    const nav: any = {
      createAuctionNonce: () => 'real-nonce',
      joinAdInterestGroup: () => 'real',
      updateAdInterestGroups: () => {},
    };
    // Browser shape: a Navigator constructor whose prototype carries the PA
    // surface — the runtime prefers `Navigator.prototype` over `navigator`.
    page.globals.Navigator = function Navigator() {};
    (page.globals.Navigator as any).prototype = nav;
    runIn(page, [{ name: 'no-protected-audience', args: [] }]);
    await expect(nav.createAuctionNonce()).resolves.toBe(''); // pv('') → Promise, not bare ''
    await expect(nav.joinAdInterestGroup()).resolves.toBeUndefined();
    await expect(nav.updateAdInterestGroups()).resolves.toBeUndefined(); // real PA surface is async
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
      { name: 'constructor', args: [] }, // Object slots can't dispatch — hasOwnProperty guard
      { name: '__proto__', args: [] },
      { name: 'set-constant', args: ['ok', '1'] },
    ]);
    expect(page.window.__bm_sc.misses).toBe(4);
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

describe('flag-105 upstream parity gaps', () => {
  test('prevent-fetch responseType JSON applies whitelisted response props', async () => {
    const page = fakePage();
    runIn(page, [
      {
        name: 'prevent-fetch',
        args: ['trk', 'emptyObj', '{"status":403,"statusText":"Not Found","ok":false,"type":"opaque"}'],
      },
    ]);
    const res = await page.window.fetch('https://trk.example/x');
    expect(res.status).toBe(403);
    expect(res.statusText).toBe('Not Found');
    expect(res.ok).toBe(false);
    expect(res.type).toBe('opaque');
    expect(res.url).toBe('https://trk.example/x'); // uBO sets url per-request
  });

  test('prevent-fetch responseType JSON drops out-of-range values and the trusted-only headers key', async () => {
    const page = fakePage();
    runIn(page, [
      {
        name: 'prevent-fetch',
        args: ['trk', 'emptyObj', '{"status":404,"statusText":"Gone","type":"basic","headers":{"x-evil":"1"},"bogus":1}'],
      },
    ]);
    const res = await page.window.fetch('https://trk.example/');
    expect(res.status).toBe(200); // 404 is outside uBO's [403] whitelist
    expect(res.statusText).toBe('OK'); // 'Gone' outside the ['','Not Found'] whitelist
    expect(res.type).toBe('basic'); // an in-whitelist type still applies
    expect(res.headers.get('x-evil')).toBeNull(); // headers is trusted-prevent-fetch only
  });

  test('prevent-fetch throttle vararg delays the resolved response', async () => {
    const page = fakePage();
    runIn(page, [{ name: 'prevent-fetch', args: ['trk', 'emptyObj', '', 'throttle', '250'] }]);
    let settled: any;
    const p = page.window.fetch('https://trk.example/').then((r: any) => (settled = r));
    await Promise.resolve();
    expect(settled).toBeUndefined(); // still parked — delayed, not dropped
    expect(page.timeouts).toHaveLength(1);
    expect(page.timeouts[0].d).toBe(250);
    page.timeouts[0].fn();
    await p;
    expect(settled.status).toBe(200);
  });

  test('prevent-fetch war: serves embedded noop bodies; unknown names resolve empty', async () => {
    const page = fakePage();
    runIn(page, [{ name: 'prevent-fetch', args: ['trk', 'war:noop-vast4.xml'] }]);
    const res = await page.window.fetch('https://trk.example/');
    expect(await res.text()).toBe('<VAST version="4.0"></VAST>');
    const page2 = fakePage();
    runIn(page2, [{ name: 'prevent-fetch', args: ['trk', 'war:not-a-real-resource.bin'] }]);
    const res2 = await page2.window.fetch('https://trk.example/');
    expect(await res2.text()).toBe(''); // uBO's fetch-failure answer
  });

  test('prevent-fetch join: directive concatenates generated parts', async () => {
    const page = fakePage();
    runIn(page, [{ name: 'prevent-fetch', args: ['trk', 'join:--emptyObj--emptyArr'] }]);
    const res = await page.window.fetch('https://trk.example/');
    expect(await res.text()).toBe('{}[]');
  });

  test('prevent-xhr switches the synthetic payload on the request responseType', () => {
    const page = fakePage();
    runIn(page, [{ name: 'prevent-xhr', args: ['trk', 'emptyObj'] }]);
    const xj: any = new page.window.XMLHttpRequest();
    xj.open('get', 'https://trk.test/');
    xj.responseType = 'json';
    xj.send();
    expect(xj.response).toEqual({}); // uBO: 'json' → {}, '{}'
    expect(xj.responseText).toBe('{}');
    const xa: any = new page.window.XMLHttpRequest();
    xa.open('get', 'https://trk.test/');
    xa.responseType = 'arraybuffer';
    xa.send();
    expect(xa.response).toBeInstanceOf(ArrayBuffer);
    expect(xa.responseText).toBe('');
    const xb: any = new page.window.XMLHttpRequest();
    xb.open('get', 'https://trk.test/');
    xb.responseType = 'blob';
    xb.send();
    expect(xb.response).toBeInstanceOf(Blob);
    const xd: any = new page.window.XMLHttpRequest();
    xd.open('get', 'https://trk.test/'); // no responseType → generated text
    xd.send();
    expect(xd.response).toBe('{}');
    expect(xd.responseText).toBe('{}');
    expect(xd.responseURL).toBe('https://trk.test/');
    expect(xd.statusText).toBe('OK');
  });

  test('prevent-xhr sync (async=false) applies props without event staging', () => {
    const page = fakePage();
    runIn(page, [{ name: 'prevent-xhr', args: ['trk', 'emptyObj'] }]);
    const x: any = new page.window.XMLHttpRequest();
    x.open('get', 'https://trk.test/', false);
    x.send();
    expect(x.readyState).toBe(4);
    expect(page.timeouts).toHaveLength(0); // defer=false → no staged readystatechange/load
  });

  test('set-constant honors throttle — the install is deferred, not dropped', () => {
    const page = fakePage();
    runIn(page, [{ name: 'set-constant', args: ['thc.v', '5', 'throttle', '50'] }]);
    expect(page.window.thc).toBeUndefined(); // still fires — later
    expect(page.timeouts).toHaveLength(1);
    expect(page.timeouts[0].d).toBe(50);
    page.timeouts[0].fn();
    page.window.thc = {}; // page object arrives → lazy leaf trap
    expect(page.window.thc.v).toBe(5);
  });

  test('set-constant as=function wraps the constant; unknown vararg keys no longer eat the stack slot', () => {
    const page = fakePage();
    page.window.host = {};
    runIn(page, [
      { name: 'set-constant', args: ['host.f', '5', 'as', 'function'] },
      { name: 'set-constant', args: ['host.g', 'true', 'bogus', '1'] },
    ]);
    expect(page.window.host.f()).toBe(5);
    expect(page.window.host.g).toBe(true); // 'bogus' pairs as a vararg key, not a stack needle
  });

  test('set-constant chains a pre-existing mid-chain setter', () => {
    const page = fakePage();
    const writes: any[] = [];
    let held: any;
    Object.defineProperty(page.window, 'mid', {
      configurable: true,
      get() {
        return held;
      },
      set(x) {
        writes.push(x);
        held = x;
      },
    });
    runIn(page, [{ name: 'set-constant', args: ['mid.flag', 'false'] }]);
    const real = { flag: true }; // same-type initial → leaf traps
    page.window.mid = real;
    expect(writes).toEqual([real]); // the previous setter still observed the write
    expect(held).toBe(real);
    expect(real.flag).toBe(false); // descend trapped the leaf on the page's object
    page.window.mid.flag = 'x';
    expect(real.flag).toBe('x'); // type-mismatch write still ends the trap
  });

  test('leaf traps chain a previous setter — writes reach it and dead logic still applies', () => {
    const page = fakePage();
    page.window.t = {};
    const writes: any[] = [];
    Object.defineProperty(page.window.t, 'acc', {
      configurable: true,
      get() {
        return true; // boolean — same type as the incoming false
      },
      set(x) {
        writes.push(x);
      },
    });
    runIn(page, [{ name: 'set-constant', args: ['t.acc', 'false'] }]);
    expect(page.window.t.acc).toBe(false);
    page.window.t.acc = 'bye';
    expect(writes).toEqual(['bye']); // uBO order: prevSetter fires before our bookkeeping
    expect(page.window.t.acc).toBe('bye'); // dead → write wins
  });

  test('abort-on-property-write still throws while reaching a previous setter', () => {
    const page = fakePage();
    const writes: any[] = [];
    Object.defineProperty(page.window, 'acc', {
      configurable: true,
      get() {
        return 1;
      },
      set(x) {
        writes.push(x);
      },
    });
    runIn(page, [{ name: 'abort-on-property-write', args: ['acc'] }]);
    expect(() => {
      page.window.acc = 3;
    }).toThrow(ReferenceError);
    expect(writes).toEqual([3]);
  });

  test('facade clone() returns an independent response', async () => {
    const page = fakePage();
    page.globals.Response = undefined as any;
    runIn(page, [{ name: 'prevent-fetch', args: ['trk', 'emptyObj'] }]);
    const res = await page.window.fetch('https://trk.example/');
    const clone = res.clone();
    expect(clone).not.toBe(res);
    await res.text();
    expect(res.bodyUsed).toBe(true);
    expect(clone.bodyUsed).toBe(false); // a real clone does not share bodyUsed state
    expect(await clone.text()).toBe('{}');
  });
});

describe('flag-106 native toString spoofing', () => {
  test('wrapped natives mirror the replaced function spelling', () => {
    const page = fakePage();
    const origTimeout = page.window.setTimeout;
    const origOpen = page.window.open;
    const origEval = page.window.eval;
    runIn(page, [
      { name: 'prevent-setTimeout', args: ['cbNeedle'] },
      { name: 'prevent-window-open', args: ['ads'] },
      { name: 'prevent-eval-if', args: ['evil'] },
    ]);
    expect(String(page.window.setTimeout)).toBe(String(origTimeout));
    expect(page.window.setTimeout.toString()).toBe(String(origTimeout));
    expect(String(page.window.open)).toBe(String(origOpen));
    expect(String(page.window.eval)).toBe(String(origEval));
    // and the wrappers still work
    expect(page.window.open('https://ads.example/')).toBeNull();
  });

  test('a wrapped real native reports the [native code] spelling', () => {
    const page = fakePage();
    // a detached JSON.parse is still a real native — and wrapping it on the
    // fake object leaves the realm's real JSON untouched
    page.globals.JSON = { parse: JSON.parse, stringify: JSON.stringify };
    runIn(page, [{ name: 'json-prune', args: ['a.b'] }]);
    // `globals` is `Record<string, unknown>` — narrow the JSON facade for its members.
    const pageJson = page.globals.JSON as typeof JSON;
    expect(String(pageJson.parse)).toBe('function parse() { [native code] }');
    expect(pageJson.parse('{"a":{"b":1,"c":2}}')).toEqual({ a: { c: 2 } });
  });

  test('xhr open/send and addEventListener wrappers mirror their originals', () => {
    const page = fakePage();
    const origXOpen = page.window.XMLHttpRequest.prototype.open;
    const origXSend = page.window.XMLHttpRequest.prototype.send;
    const origAEL = page.window.EventTarget.prototype.addEventListener;
    runIn(page, [
      { name: 'prevent-xhr', args: ['trk'] },
      { name: 'prevent-addEventListener', args: ['click'] },
    ]);
    expect(String(page.window.XMLHttpRequest.prototype.open)).toBe(String(origXOpen));
    expect(String(page.window.XMLHttpRequest.prototype.send)).toBe(String(origXSend));
    expect(String(page.window.EventTarget.prototype.addEventListener)).toBe(String(origAEL));
  });

  test('trap accessors, dispatcher, onerror and facade methods read [native code]', async () => {
    const page = fakePage();
    page.globals.Response = undefined as any; // exercise the facade path
    page.window.tracker = { enabled: true };
    runIn(page, [
      { name: 'set-constant', args: ['tc.v', '5'] },
      { name: 'abort-on-property-read', args: ['tracker.enabled'] },
      { name: 'prevent-fetch', args: ['trk'] },
    ]);
    const d = Object.getOwnPropertyDescriptor(page.window, 'tc');
    expect(String(d?.get)).toBe('function get tc() { [native code] }');
    expect(String(d?.set)).toBe('function set tc() { [native code] }');
    expect(String(page.window.__bm_sc)).toBe('function __bm_sc() { [native code] }');
    try {
      page.window.tracker.enabled;
    } catch {
      // abort token fires et() → installs onerror
    }
    expect(String(page.window.onerror)).toBe('function onerror() { [native code] }');
    const res = await page.window.fetch('https://trk.example/');
    expect(String(res.text)).toBe('function text() { [native code] }');
    expect(String(res.json)).toBe('function json() { [native code] }');
    expect(String(res.clone)).toBe('function clone() { [native code] }');
  });

  test('the hook lies about itself and stays invisible', () => {
    const page = fakePage();
    runIn(page, [{ name: 'set-constant', args: ['z', '1'] }]);
    expect(String(Function.prototype.toString)).toBe('function toString() { [native code] }');
    expect(Function.prototype.toString.name).toBe('toString');
    const d = Object.getOwnPropertyDescriptor(Function.prototype, 'toString');
    expect(d?.enumerable).toBe(false);
    expect(d?.writable).toBe(true);
    expect(Object.keys(Function.prototype)).toHaveLength(0);
  });

  test('unregistered functions keep their honest source', () => {
    const page = fakePage();
    runIn(page, [{ name: 'set-constant', args: ['z2', '1'] }]);
    function pageFn() {
      return 42;
    }
    expect(String(pageFn)).toContain('pageFn');
    expect(String(pageFn)).toContain('42');
    // even functions that look up toString late still hit the hook's fallback
    const late = { toString: Function.prototype.toString };
    expect(() => Function.prototype.toString.call(42)).toThrow(TypeError); // same as native
    expect(typeof late.toString).toBe('function');
  });
});
