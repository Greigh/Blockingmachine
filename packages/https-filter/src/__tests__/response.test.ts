/**
 * Response-pipeline unit tests (design spec §5.5, plan P2 Task 3).
 *
 * `decideResponse` is the pure verdict half — the relay's sockets stay out
 * of it — so the whole action matrix (passthrough / typed-block tighten /
 * buffer-inject / csp-only) is exercised here. The two CSP helpers cover the
 * injection widening (only ever `'unsafe-inline'`, only ever on an existing
 * header) and the `$csp` merge (which may create policy), and `injectHtml`
 * covers the byte-level splice anchors and the `</script` breakout escape.
 */

import { describe, expect, test } from '@jest/globals';
import type {
  CosmeticIndex,
  CosmeticPayload,
  RequestVerdict,
} from '@blockingmachine/core';
import {
  applyCspAdditions,
  buildInjectionText,
  decideResponse,
  hasInjectableContent,
  injectHtml,
  rewriteCspForInjection,
  type TypedEvalContext,
} from '../pipeline/response.js';

type Transforms = RequestVerdict['transforms'];

function transforms(over: Partial<Transforms> = {}): Transforms {
  return { removeParams: [], keepParams: [], removeHeaders: [], ...over };
}

function verdict(over: Partial<RequestVerdict> = {}): RequestVerdict {
  return { action: 'allowed', coveringRule: null, transforms: transforms(), ...over };
}

function payload(over: Partial<CosmeticPayload> = {}): CosmeticPayload {
  return { hide: [], styles: [], scriptlets: [], skippedScriptlets: 0, ...over };
}

/** A cosmetic index that answers `payload` for `host` and nothing elsewhere. */
function indexFor(host: string, found: CosmeticPayload | undefined): CosmeticIndex {
  return {
    forHost: (h) => (h === host ? found : undefined),
    size: () => ({ selectors: 0, exceptions: 0, scriptlets: 0, scriptletExceptions: 0, styles: 0 }),
    stats: {} as CosmeticIndex['stats'],
  };
}

const BASE = {
  url: 'https://example.com/',
  host: 'example.com',
  method: 'GET',
};

describe('decideResponse — passthrough', () => {
  test('non-html response with no cosmetics streams', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'application/octet-stream' },
      verdict: verdict(),
      ...BASE,
    });
    expect(plan.action).toBe('passthrough');
    expect(plan.cspAdditions).toEqual([]);
  });

  test('html response without a cosmetic index streams', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'text/html' },
      verdict: verdict(),
      ...BASE,
    });
    expect(plan.action).toBe('passthrough');
  });

  test('html on an injectable host but content-encoded stays a stream (skip)', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: indexFor('example.com', payload({ hide: ['.ad'] })),
    });
    expect(plan.action).toBe('passthrough');
    expect(plan.injectSkipped).toBe('encoded');
  });
});

describe('decideResponse — csp additions ride every action', () => {
  test('$csp transform collected on a passthrough', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'application/octet-stream' },
      verdict: verdict({ transforms: transforms({ csp: "script-src 'none'" }) }),
      ...BASE,
    });
    expect(plan.action).toBe('passthrough');
    expect(plan.cspAdditions).toEqual(["script-src 'none'"]);
  });

  test('$csp transform collected on an injectable page', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'text/html' },
      verdict: verdict({ transforms: transforms({ csp: "frame-src 'none'" }) }),
      ...BASE,
      cosmeticIndex: indexFor('example.com', payload({ hide: ['.ad'] })),
    });
    expect(plan.action).toBe('buffer-inject');
    expect(plan.cspAdditions).toEqual(["frame-src 'none'"]);
  });
});

describe('decideResponse — request-side block stays blocked', () => {
  test('a blocked verdict never re-evaluates (typed exception cannot relax)', () => {
    let evaluated = 0;
    const plan = decideResponse({
      headers: { 'content-type': 'image/png' },
      verdict: verdict({ action: 'blocked', coveringRule: '||x^' }),
      ...BASE,
      evaluateTyped: () => {
        evaluated++;
        return verdict({ action: 'exception' });
      },
    });
    expect(plan.action).toBe('block');
    expect(plan.blockRule).toBe('||x^');
    expect(evaluated).toBe(0);
  });
});

describe('decideResponse — content-type re-verdict', () => {
  const blockingEval = (rule: string) => (): RequestVerdict =>
    verdict({ action: 'blocked', coveringRule: rule });

  test('image/png on an untyped request gets a typed verdict that blocks', () => {
    const seen: TypedEvalContext[] = [];
    const plan = decideResponse({
      headers: { 'content-type': 'image/png' },
      verdict: verdict(),
      ...BASE,
      evaluateTyped: (ctx) => {
        seen.push(ctx);
        return blockingEval('||x^$image')();
      },
    });
    expect(plan.action).toBe('block');
    expect(plan.blockRule).toBe('||x^$image');
    expect(seen).toEqual([
      { url: BASE.url, host: BASE.host, method: BASE.method, contentType: 'image' },
    ]);
  });

  test('a typed pass that allows leaves the response streaming', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'image/png' },
      verdict: verdict(),
      ...BASE,
      evaluateTyped: () => verdict(),
    });
    expect(plan.action).toBe('passthrough');
  });

  test('content types map to their honest tokens', () => {
    const seen: string[] = [];
    const evalThatRecords = (ctx: TypedEvalContext): RequestVerdict => {
      seen.push(ctx.contentType);
      return verdict();
    };
    const cases: Array<[string, string | undefined]> = [
      ['image/png', 'image'],
      ['application/javascript', 'script'],
      ['text/ecmascript', 'script'],
      ['video/mp4', 'media'],
      ['audio/ogg', 'media'],
      ['font/woff2', 'font'],
      ['text/css', 'stylesheet'],
      ['text/html', 'document'],
      ['application/json', 'other'],
      ['application/xml', 'other'],
      ['text/plain', 'other'],
      ['application/pdf', undefined],
      ['application/octet-stream', undefined],
    ];
    for (const [ct, expected] of cases) {
      seen.length = 0;
      decideResponse({
        headers: { 'content-type': ct },
        verdict: verdict(),
        ...BASE,
        evaluateTyped: evalThatRecords,
      });
      expect(seen).toEqual(expected === undefined ? [] : [expected]);
    }
  });

  test('text/html maps to subdocument only when the request side declared it', () => {
    const seen: string[] = [];
    const record = (ctx: TypedEvalContext): RequestVerdict => {
      seen.push(ctx.contentType);
      return verdict();
    };
    decideResponse({
      headers: { 'content-type': 'text/html' },
      verdict: verdict(),
      ...BASE,
      requestContentType: 'subdocument',
      evaluateTyped: record,
    });
    expect(seen).toEqual(['subdocument']);
  });

  test('no evaluateTyped seam → no re-verdict, response streams', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'image/png' },
      verdict: verdict(),
      ...BASE,
    });
    expect(plan.action).toBe('passthrough');
  });
});

describe('decideResponse — buffer-inject gating', () => {
  const index = indexFor(
    'example.com',
    payload({ hide: ['.ad'], scriptlets: [{ name: 'set-constant', args: ['x', '1'] }] }),
  );

  test('text/html + injectable payload → buffer-inject with the payload', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'text/html; charset=utf-8' },
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: index,
    });
    expect(plan.action).toBe('buffer-inject');
    expect(plan.payload?.hide).toEqual(['.ad']);
  });

  test('payload of only unknown scriptlets is not injectable', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'text/html' },
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: indexFor(
        'example.com',
        payload({ scriptlets: [{ name: 'not-a-real-scriptlet', args: [] }], skippedScriptlets: 1 }),
      ),
    });
    expect(plan.action).toBe('passthrough');
  });

  test('content-type case and parameters do not fool the html check', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'Text/HTML; Charset=UTF-8' },
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: index,
    });
    expect(plan.action).toBe('buffer-inject');
  });
});

describe('rewriteCspForInjection', () => {
  test("script-src 'self' gains 'unsafe-inline'", () => {
    const out = rewriteCspForInjection("script-src 'self'");
    expect(out.changed).toBe(true);
    expect(out.value).toBe("script-src 'self' 'unsafe-inline'");
  });

  test('default-src-only policy synthesizes script-src and style-src', () => {
    const out = rewriteCspForInjection("default-src 'self'");
    expect(out.changed).toBe(true);
    expect(out.value).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
  });

  test("existing 'unsafe-inline' is not duplicated", () => {
    const out = rewriteCspForInjection("script-src 'self' 'unsafe-inline'; style-src *");
    expect(out.changed).toBe(true); // style-src still widened
    expect(out.value).toBe("script-src 'self' 'unsafe-inline'; style-src * 'unsafe-inline'");
  });

  test('untouchable directives pass through verbatim', () => {
    const out = rewriteCspForInjection(
      "sandbox allow-scripts; frame-ancestors 'none'; default-src 'self'; report-uri /r",
    );
    expect(out.value).toBe(
      "sandbox allow-scripts; frame-ancestors 'none'; default-src 'self'; report-uri /r; " +
        "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
  });

  test('script-src-elem also widens (CSP3 element level)', () => {
    const out = rewriteCspForInjection("script-src-elem 'self'; style-src-elem 'none'");
    expect(out.value).toBe(
      "script-src-elem 'self' 'unsafe-inline'; style-src-elem 'none' 'unsafe-inline'",
    );
  });

  test('multiple header values merge into one serialized header', () => {
    const out = rewriteCspForInjection([
      "default-src 'self'",
      "script-src 'strict-dynamic'",
    ]);
    expect(out.changed).toBe(true);
    // Two policies preserved as a comma list; the second's own script-src
    // widens and style-src synthesizes under its default-src… which the
    // second policy lacks — so only its script-src changes.
    expect(out.value).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline', " +
        "script-src 'strict-dynamic' 'unsafe-inline'",
    );
  });

  test('absent header produces no value and no change', () => {
    expect(rewriteCspForInjection(undefined)).toEqual({ value: undefined, changed: false });
  });

  test('a policy with no relevant directives is unchanged', () => {
    const out = rewriteCspForInjection("frame-ancestors 'none'");
    expect(out).toEqual({ value: "frame-ancestors 'none'", changed: false });
  });
});

describe('applyCspAdditions', () => {
  test('creates the header when none exists', () => {
    expect(applyCspAdditions(undefined, ["script-src 'none'"])).toBe("script-src 'none'");
  });

  test('merges additions token-wise by directive, deduplicated', () => {
    const out = applyCspAdditions("script-src 'self'; img-src *", [
      "script-src 'self' https://cdn.example; connect-src 'none'",
    ]);
    expect(out).toBe("script-src 'self' https://cdn.example; img-src *; connect-src 'none'");
  });

  test('comma-separated addition policies each merge', () => {
    const out = applyCspAdditions("default-src 'self'", [
      "script-src 'none', img-src 'none'",
    ]);
    expect(out).toBe("default-src 'self'; script-src 'none'; img-src 'none'");
  });

  test('empty additions are a no-op', () => {
    expect(applyCspAdditions("script-src 'self'", [])).toBe("script-src 'self'");
    expect(applyCspAdditions(undefined, [])).toBe('');
  });
});

describe('injectHtml — anchors', () => {
  const page = (inner: string) => Buffer.from(`<html><head>${inner}</head><body>x</body></html>`);

  test('style lands before </head', () => {
    const { body, injected } = injectHtml(page('<title>t</title>'), { styleText: '.a{display:none}' });
    const text = body.toString('latin1');
    expect(injected.style).toBe(true);
    expect(text.indexOf('<style id="bm-c">')).toBeLessThan(text.indexOf('</head>'));
    expect(text).toContain('.a{display:none}');
  });

  test('style falls back to after <head> open when no </head> exists', () => {
    const raw = Buffer.from('<html><head><body>x</html>');
    const { body } = injectHtml(raw, { styleText: '.a{}' });
    const text = body.toString('latin1');
    const open = text.indexOf('<head>');
    expect(text.indexOf('<style id="bm-c">')).toBe(open + '<head>'.length);
  });

  test('no head at all → style lands before </body>', () => {
    const raw = Buffer.from('<html><body>q</body></html>');
    const { body } = injectHtml(raw, { styleText: '.a{}' });
    const text = body.toString('latin1');
    expect(text.indexOf('<style id="bm-c">')).toBeLessThan(text.indexOf('</body>'));
  });

  test('script prefers inside the head (runs before page scripts)', () => {
    const { body, injected } = injectHtml(page('<title>t</title>'), { scriptText: 'x=1' });
    const text = body.toString('latin1');
    expect(injected.script).toBe(true);
    const scriptAt = text.indexOf('<script>x=1</script>');
    const headOpen = text.indexOf('<head>');
    const headClose = text.indexOf('</head>');
    expect(scriptAt).toBeGreaterThan(headOpen);
    expect(scriptAt).toBeLessThan(headClose);
  });

  test('no anchors at all → appended at the tail', () => {
    const raw = Buffer.from('plain-text-body');
    const { body } = injectHtml(raw, { styleText: '.a{}', scriptText: 'y()' });
    const text = body.toString('latin1');
    expect(text.startsWith('plain-text-body')).toBe(true);
    expect(text).toContain('<style id="bm-c">');
    expect(text.indexOf('<script>')).toBeGreaterThan(text.indexOf('</style>'));
  });

  test('<head match requires a name boundary (<header is not <head)', () => {
    const raw = Buffer.from('<html><header>h</header><body>q</body></html>');
    const { body } = injectHtml(raw, { styleText: '.a{}' });
    // No real <head>/<body-end pair usable before </body> — style lands there.
    const text = body.toString('latin1');
    expect(text.indexOf('<style id="bm-c">')).toBeLessThan(text.indexOf('</body>'));
  });
});

describe('injectHtml — escaping and no-op', () => {
  test("'</' and '<!--' in style text are escaped", () => {
    const raw = Buffer.from('<html><head></head><body></body></html>');
    const { body } = injectHtml(raw, {
      styleText: '.a{content:"</"}/* <!-- */',
    });
    const text = body.toString('latin1');
    // `</style` can never appear inside the injected element's own body.
    const inner = text.slice(text.indexOf('<style id="bm-c">'), text.indexOf('</style>'));
    expect(inner).not.toContain('</');
    expect(inner).toContain('<\\/');
    expect(inner).toContain('<\\!--');
  });

  test('scriptText containing </script is escaped (defense in depth)', () => {
    const raw = Buffer.from('<html><head></head><body></body></html>');
    const { body } = injectHtml(raw, { scriptText: 'a="</script>"' });
    const text = body.toString('latin1');
    const inner = text.slice(text.indexOf('<script>'), text.lastIndexOf('</script>'));
    expect(inner).toContain('<\\/script');
    expect(inner).not.toContain('"</script');
  });

  test('empty payload is a byte-identical no-op', () => {
    const raw = Buffer.from('<html><head></head><body>x</body></html>');
    const { body, injected } = injectHtml(raw, {});
    expect(body.equals(raw)).toBe(true);
    expect(injected).toEqual({ style: false, script: false });
  });
});

describe('buildInjectionText', () => {
  test('hide selectors fold into one display:none rule; styles append', () => {
    const text = buildInjectionText(
      payload({ hide: ['.a', '#b'], styles: ['.x{outline:0}'] }),
    );
    expect(text.styleText).toBe('.a,#b{display:none!important}.x{outline:0}');
    expect(text.scriptletCount).toBe(0);
  });

  test('unknown scriptlet names are filtered and counted, never emitted', () => {
    const text = buildInjectionText(
      payload({
        scriptlets: [
          { name: 'set-constant', args: ['a', '1'] },
          { name: 'evil-scriptlet', args: [] },
        ],
        skippedScriptlets: 1,
      }),
    );
    expect(text.scriptletCount).toBe(1);
    expect(text.skippedScriptlets).toBe(1);
    expect(text.scriptText).toBeDefined();
    expect(text.scriptText).not.toContain('evil-scriptlet');
  });

  test('hasInjectableContent gates on supported scriptlets only', () => {
    expect(hasInjectableContent(payload())).toBe(false);
    expect(
      hasInjectableContent(payload({ scriptlets: [{ name: 'nope', args: [] }] })),
    ).toBe(false);
    expect(
      hasInjectableContent(
        payload({ scriptlets: [{ name: 'set-constant', args: ['a', '1'] }] }),
      ),
    ).toBe(true);
  });
});
