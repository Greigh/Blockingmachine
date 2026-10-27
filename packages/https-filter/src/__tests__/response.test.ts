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
  mergeCspAdditionsIntoHeaders,
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
  status: 200,
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
      verdict: verdict({ transforms: transforms({ csp: ["script-src 'none'"] }) }),
      ...BASE,
    });
    expect(plan.action).toBe('passthrough');
    expect(plan.cspAdditions).toEqual(["script-src 'none'"]);
  });

  test('$csp transform collected on an injectable page', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'text/html' },
      verdict: verdict({ transforms: transforms({ csp: ["frame-src 'none'"] }) }),
      ...BASE,
      cosmeticIndex: indexFor('example.com', payload({ hide: ['.ad'] })),
    });
    expect(plan.action).toBe('buffer-inject');
    expect(plan.cspAdditions).toEqual(["frame-src 'none'"]);
  });

  test('every collected $csp value rides through as its own addition', () => {
    const additions = ["script-src 'none'", "frame-src 'none'", "img-src https:"];
    const plan = decideResponse({
      headers: { 'content-type': 'application/octet-stream' },
      verdict: verdict({ transforms: transforms({ csp: additions }) }),
      ...BASE,
    });
    expect(plan.cspAdditions).toEqual(additions);
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

  test('payload of only unknown scriptlets is not injectable — but still accounted', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'text/html' },
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: indexFor(
        'example.com',
        payload({
          scriptlets: [
            { name: 'not-a-real-scriptlet', args: [] },
            { name: 'also-fake', args: [] },
          ],
          skippedScriptlets: 2,
        }),
      ),
    });
    // Nothing to emit — but the skipped count must ride the plan or the
    // stats/card reads unknown-scriptlet coverage as zero, not partial.
    expect(plan.action).toBe('passthrough');
    expect(plan.injectSkipped).toBe('no-known-content');
    expect(plan.skippedScriptlets).toBe(2);
  });

  test('a payload carrying only empty results (no scriptlets at all) stays silent', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'text/html' },
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: indexFor('example.com', payload()),
    });
    expect(plan.action).toBe('passthrough');
    expect(plan.injectSkipped).toBeUndefined();
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

describe('decideResponse — injection gating on status, method, declared context', () => {
  const index = indexFor('example.com', payload({ hide: ['.ad'] }));

  test('bodiless statuses never buffer-inject — 1xx/204/304 carry no body to splice', () => {
    for (const status of [101, 204, 304]) {
      const plan = decideResponse({
        headers: { 'content-type': 'text/html' },
        verdict: verdict(),
        ...BASE,
        status,
        cosmeticIndex: index,
      });
      // A synthesized body on a 304 is a protocol violation on h2 — and a
      // restamped content-length on a no-body status is a lie either way.
      expect(plan.action).toBe('passthrough');
    }
  });

  test('a HEAD request never buffer-injects — its answer carries no body', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'text/html' },
      verdict: verdict(),
      ...BASE,
      method: 'HEAD',
      cosmeticIndex: index,
    });
    expect(plan.action).toBe('passthrough');
  });

  test('a sec-fetch-dest-typed non-document context skips injection', () => {
    // image/script/other declared contexts fed text/html have no markup
    // consumer — injection is wasted CPU on bytes nothing renders.
    for (const requestContentType of ['image', 'script', 'stylesheet', 'other']) {
      const plan = decideResponse({
        headers: { 'content-type': 'text/html' },
        verdict: verdict(),
        ...BASE,
        requestContentType,
        cosmeticIndex: index,
      });
      expect(plan.action).toBe('passthrough');
    }
  });

  test('document/subdocument (and untyped) contexts stay injectable', () => {
    for (const requestContentType of ['document', 'subdocument', undefined]) {
      const plan = decideResponse({
        headers: { 'content-type': 'text/html' },
        verdict: verdict(),
        ...BASE,
        requestContentType,
        cosmeticIndex: index,
      });
      expect(plan.action).toBe('buffer-inject');
    }
  });
});

describe('decideResponse — injection budget', () => {
  const index = indexFor('example.com', payload({ hide: ['.ad'] }));
  const html = { 'content-type': 'text/html' };

  test('a spent budget answers passthrough + inject-skip busy', () => {
    const plan = decideResponse({
      headers: html,
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: index,
      injectionBudget: { inflight: 1, max: 1 },
    });
    expect(plan.action).toBe('passthrough');
    expect(plan.injectSkipped).toBe('busy');
    // A refused slot must not look held.
  });

  test('a free slot is acquired on the buffer-inject decision', () => {
    const budget = { inflight: 0, max: 1 };
    const plan = decideResponse({
      headers: html,
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: index,
      injectionBudget: budget,
    });
    expect(plan.action).toBe('buffer-inject');
    expect(budget.inflight).toBe(1);
    // …and the next eligible response sees the budget spent.
    const second = decideResponse({
      headers: html,
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: index,
      injectionBudget: budget,
    });
    expect(second.action).toBe('passthrough');
    expect(second.injectSkipped).toBe('busy');
  });

  test('no budget configured stays unbounded', () => {
    const plan = decideResponse({
      headers: html,
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: index,
    });
    expect(plan.action).toBe('buffer-inject');
    expect(plan.injectSkipped).toBeUndefined();
  });

  test('an encoded body skips without consuming a slot', () => {
    const budget = { inflight: 0, max: 1 };
    const plan = decideResponse({
      headers: { ...html, 'content-encoding': 'gzip' },
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: index,
      injectionBudget: budget,
    });
    expect(plan.injectSkipped).toBe('encoded');
    expect(budget.inflight).toBe(0);
  });
});

describe('decideResponse — content-encoding gate', () => {
  const index = indexFor('example.com', payload({ hide: ['.ad'] }));
  const html = { 'content-type': 'text/html' };

  test('any non-identity token counts as encoded — including inside lists', () => {
    const encodings: Array<string | string[]> = [
      'gzip',
      'GZip',
      'gzip, identity',
      'identity, br',
      ['gzip', 'identity'],
      ['identity', 'gzip'],
    ];
    for (const encoding of encodings) {
      const plan = decideResponse({
        // The Node type spells it `string`, but h2 compat and raw header
        // arrays really do produce string[] values — the cast is honest.
        headers: { ...html, 'content-encoding': encoding as string },
        verdict: verdict(),
        ...BASE,
        cosmeticIndex: index,
      });
      expect(plan.action).toBe('passthrough');
      expect(plan.injectSkipped).toBe('encoded');
    }
  });

  test('absent, empty, and identity-only encodings stay injectable', () => {
    const encodings: Array<string | string[] | undefined> = [
      undefined,
      '',
      'identity',
      ' identity , ',
      ['identity', 'identity'],
      ['identity', ''],
    ];
    for (const encoding of encodings) {
      const headers: Record<string, string> = { ...html };
      if (encoding !== undefined) {
        // `content-encoding` really can arrive as string[] (h2 compat /
        // rawHeaders) — the Node type just doesn't say so.
        headers['content-encoding'] = encoding as string;
      }
      const plan = decideResponse({
        headers,
        verdict: verdict(),
        ...BASE,
        cosmeticIndex: index,
      });
      expect(plan.action).toBe('buffer-inject');
    }
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
    // Two policies preserved as a comma list; the first's script-src +
    // style-src synthesize under its default-src; the second's own
    // script-src widens ('unsafe-inline' on a 'strict-dynamic' directive is
    // inert under CSP3 but is the only admit CSP2 engines can be offered —
    // they don't know the keyword).
    expect(out.value).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline', " +
        "script-src 'strict-dynamic' 'unsafe-inline'",
    );
  });

  test("a 'strict-dynamic' default-src does not synthesize script-src — style-src still does", () => {
    // Cloning 'strict-dynamic' into a fresh script-src produces a directive
    // whose own keyword makes CSP3 ignore the 'unsafe-inline' it was built
    // to carry — a widen that only pretends to work, skipped. The style
    // chain's clone is unaffected: 'strict-dynamic' is a script concept,
    // inert on style-src, so its 'unsafe-inline' still admits <style>.
    const out = rewriteCspForInjection("default-src 'self' 'strict-dynamic'");
    expect(out.value).toBe(
      "default-src 'self' 'strict-dynamic'; style-src 'self' 'strict-dynamic' 'unsafe-inline'",
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
  test('creates the header when none exists — the addition verbatim', () => {
    expect(applyCspAdditions(undefined, ["script-src 'none'"])).toBe("script-src 'none'");
  });

  test('additions land as their OWN co-equal policy — never token-merged', () => {
    // `script-src 'self'` + `$csp=script-src 'none'`: the `,`-joined list
    // ANDs the policies, so 'none' still refuses all scripts. A token-merge
    // would produce `script-src 'self' 'none'` — where CSP defines 'none'
    // as VOID alongside other sources, silently neutralizing the rule.
    const out = applyCspAdditions("script-src 'self'", ["script-src 'none'"]);
    expect(out).toBe("script-src 'self', script-src 'none'");
  });

  test("the reverse direction holds — a 'none' policy is never weakened", () => {
    // `script-src 'none'` + `$csp=script-src https:`: token-merging would
    // produce `script-src 'none' https:` — 'none' spec-voided, the live
    // source admitted, the stricter policy WIDENED. As co-equal policies
    // the 'none' half still blocks every script.
    const out = applyCspAdditions("script-src 'none'", ['script-src https:']);
    expect(out).toBe("script-src 'none', script-src https:");
  });

  test('a comma-bearing addition still serializes as separate co-equal policies', () => {
    // The contract is one-policy-per-addition (splitRule can never leave a
    // `,` inside a `$csp` value) — but a stray comma still joins identically.
    const out = applyCspAdditions("default-src 'self'", [
      "script-src 'none', img-src 'none'",
    ]);
    expect(out).toBe("default-src 'self', script-src 'none', img-src 'none'");
  });

  test('multiple existing policies are preserved, additions appended', () => {
    const out = applyCspAdditions(["default-src 'self'", "img-src 'none'"], [
      "script-src 'none'",
    ]);
    expect(out).toBe("default-src 'self', img-src 'none', script-src 'none'");
  });

  test('empty additions are a no-op', () => {
    expect(applyCspAdditions("script-src 'self'", [])).toBe("script-src 'self'");
    expect(applyCspAdditions(undefined, [])).toBe('');
  });
});

describe('mergeCspAdditionsIntoHeaders', () => {
  test('enforcing header created when absent; report-only untouched', () => {
    const headers: Record<string, string> = {
      'content-security-policy-report-only': "default-src 'self'",
    };
    const changed = mergeCspAdditionsIntoHeaders(headers, ["script-src 'none'"]);
    expect(changed).toBe(1);
    expect(headers['content-security-policy']).toBe("script-src 'none'");
    // `$csp` is enforcement-intended — a report-only policy holding it would
    // log violations the page never enforced (uBO's posture likewise).
    expect(headers['content-security-policy-report-only']).toBe("default-src 'self'");
  });

  test('existing enforcing header gains a co-equal policy; report-only untouched', () => {
    const headers: Record<string, string> = {
      'content-security-policy': "script-src 'self'",
      'content-security-policy-report-only': "script-src 'self'",
    };
    const changed = mergeCspAdditionsIntoHeaders(headers, ["script-src 'none'"]);
    expect(changed).toBe(1);
    expect(headers['content-security-policy']).toBe(
      "script-src 'self', script-src 'none'",
    );
    expect(headers['content-security-policy-report-only']).toBe("script-src 'self'");
  });

  test('empty additions change nothing', () => {
    const headers: Record<string, string> = {};
    expect(mergeCspAdditionsIntoHeaders(headers, [])).toBe(0);
    expect(headers['content-security-policy']).toBeUndefined();
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

  test('non-ASCII payload text is emitted UTF-8, not latin1-mojibake', () => {
    // Selectors and scriptlet args can carry non-ASCII text — a latin1
    // `Buffer.from` would encode 'é' as a single 0xE9 byte the browser
    // then decodes per the page charset (UTF-8 → U+FFFD mojibake).
    const raw = Buffer.from('<html><head></head><body></body></html>');
    const { body, injected } = injectHtml(raw, {
      styleText: '.café{display:none}',
    });
    expect(injected.style).toBe(true);
    expect(body.includes(Buffer.from('.café', 'utf8'))).toBe(true);
    expect(body.includes(Buffer.from([0xe9]))).toBe(false); // no latin1 byte
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
