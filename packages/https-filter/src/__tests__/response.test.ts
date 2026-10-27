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
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import type {
  CosmeticIndex,
  CosmeticPayload,
  RequestVerdict,
} from '@blockingmachine/core';
import {
  applyCspAdditions,
  buildInjectionText,
  decideResponse,
  decodeBody,
  encodeBody,
  hasInjectableContent,
  injectHtml,
  looksLikeHtml,
  MAX_HTML_BUFFER,
  mergeCspAdditionsIntoHeaders,
  parseContentEncoding,
  rewriteCspForInjection,
  type BodyCodec,
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

  test('html on an injectable host under a supported codec still buffers', () => {
    // `gzip` is decodable now (flag 108) — the plan carries the codec so the
    // relay can decompress → splice → recompress instead of skipping.
    const plan = decideResponse({
      headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: indexFor('example.com', payload({ hide: ['.ad'] })),
    });
    expect(plan.action).toBe('buffer-inject');
    expect(plan.contentEncoding).toBe('gzip');
  });

  test('html on an injectable host but unsupported-encoded stays a stream (skip)', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'text/html', 'content-encoding': 'zstd' },
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

  test('an undecodable body skips without consuming a slot', () => {
    const budget = { inflight: 0, max: 1 };
    const plan = decideResponse({
      headers: { ...html, 'content-encoding': 'zstd' },
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: index,
      injectionBudget: budget,
    });
    expect(plan.injectSkipped).toBe('encoded');
    expect(budget.inflight).toBe(0);
  });
});

describe('decideResponse — content-encoding gate (flag 108)', () => {
  const index = indexFor('example.com', payload({ hide: ['.ad'] }));
  const html = { 'content-type': 'text/html' };

  test('a single supported codec stays injectable and names it on the plan', () => {
    const encodings: Array<[string | string[], string]> = [
      ['gzip', 'gzip'],
      ['GZip', 'gzip'],
      ['deflate', 'deflate'],
      ['br', 'br'],
      // A bare `identity` alongside a real coding folds to the coding.
      ['gzip, identity', 'gzip'],
      ['identity, br', 'br'],
      [['gzip', 'identity'], 'gzip'],
      [['identity', 'deflate'], 'deflate'],
    ];
    for (const [encoding, codec] of encodings) {
      const plan = decideResponse({
        // The Node type spells it `string`, but h2 compat and raw header
        // arrays really do produce string[] values — the cast is honest.
        headers: { ...html, 'content-encoding': encoding as string },
        verdict: verdict(),
        ...BASE,
        cosmeticIndex: index,
      });
      expect(plan.action).toBe('buffer-inject');
      expect(plan.contentEncoding).toBe(codec);
    }
  });

  test('unsupported codings and layered chains still skip encoded', () => {
    const encodings: Array<string | string[]> = [
      'zstd',
      'compress',
      'x-custom',
      'gzip, br', // layered chains are intentionally not unrolled
      'br, gzip',
      ['gzip', 'deflate'],
      ['gzip', 'zstd'],
    ];
    for (const encoding of encodings) {
      const plan = decideResponse({
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

  test("a 'strict-dynamic' default-src still synthesizes script-src — and style-src (flag 110)", () => {
    // The synthesized script-src carries 'strict-dynamic' along — under
    // CSP3 that keyword makes the engine ignore the 'unsafe-inline' it was
    // cloned to carry, so the token is inert noise there; under CSP2 (which
    // knows 'unsafe-inline' but not 'strict-dynamic') it is the ONLY admit
    // the widen can offer. The style chain's clone is unaffected:
    // 'strict-dynamic' is a script concept, inert on style-src.
    const out = rewriteCspForInjection("default-src 'self' 'strict-dynamic'");
    expect(out.value).toBe(
      "default-src 'self' 'strict-dynamic'; " +
        "script-src 'self' 'strict-dynamic' 'unsafe-inline'; " +
        "style-src 'self' 'strict-dynamic' 'unsafe-inline'",
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

describe('parseContentEncoding / decodeBody / encodeBody (flag 108)', () => {
  test('absent and identity-only headers classify identity', () => {
    expect(parseContentEncoding(undefined)).toBe('identity');
    expect(parseContentEncoding('')).toBe('identity');
    expect(parseContentEncoding('identity')).toBe('identity');
    expect(parseContentEncoding(' Identity , ')).toBe('identity');
    expect(parseContentEncoding(['identity', 'identity'])).toBe('identity');
  });

  test('each supported codec round-trips decode(encode(x)) === x', () => {
    const page = Buffer.from('<html><head></head><body>round-trip</body></html>');
    const cases: Array<[BodyCodec, Buffer]> = [
      ['gzip', gzipSync(page)],
      ['deflate', deflateSync(page)],
      ['br', brotliCompressSync(page)],
    ];
    for (const [codec, wire] of cases) {
      const decoded = decodeBody(codec, wire);
      expect(decoded.equals(page)).toBe(true);
      expect(decodeBody(codec, encodeBody(codec, decoded)).equals(page)).toBe(true);
    }
  });

  test('decode past the buffer cap throws ERR_BUFFER_TOO_LARGE', () => {
    // A compressed body under the wire cap can expand past it — the decode
    // must carry the same bound the accumulator does.
    const big = Buffer.alloc(MAX_HTML_BUFFER + 1, 0x61); // 'a' — compresses tiny
    const wire = gzipSync(big);
    expect(wire.length).toBeLessThan(MAX_HTML_BUFFER);
    expect(() => decodeBody('gzip', wire)).toThrow(/ERR_BUFFER_TOO_LARGE|larger than/i);
  });

  test('corrupt wire bytes throw — the caller flushes them verbatim', () => {
    expect(() => decodeBody('gzip', Buffer.from('not-gzip-bytes'))).toThrow();
    expect(() => decodeBody('br', Buffer.from('not-brotli'))).toThrow();
    expect(() => decodeBody('deflate', Buffer.from('not-deflate'))).toThrow();
  });
});

describe('decideResponse — HTML sniff gate (flag 109)', () => {
  const index = indexFor('example.com', payload({ hide: ['.ad'] }));

  test('absent and text/plain content-types stay injectable but carry the sniff flag', () => {
    for (const headers of [
      {},
      { 'content-type': 'text/plain' },
      { 'content-type': 'text/plain; charset=utf-8' },
    ]) {
      const plan = decideResponse({
        headers,
        verdict: verdict(),
        ...BASE,
        cosmeticIndex: index,
      });
      expect(plan.action).toBe('buffer-inject');
      expect(plan.sniffHtml).toBe(true);
    }
  });

  test('text/html does not sniff — the label already declares markup', () => {
    const plan = decideResponse({
      headers: { 'content-type': 'text/html' },
      verdict: verdict(),
      ...BASE,
      cosmeticIndex: index,
    });
    expect(plan.action).toBe('buffer-inject');
    expect(plan.sniffHtml).toBe(false);
  });

  test('declared binary types are never sniffed', () => {
    for (const ct of [
      'application/octet-stream',
      'image/png',
      'application/pdf',
      'font/woff2',
    ]) {
      const plan = decideResponse({
        headers: { 'content-type': ct },
        verdict: verdict(),
        ...BASE,
        cosmeticIndex: index,
      });
      expect(plan.action).toBe('passthrough');
      expect(plan.sniffHtml).toBeUndefined();
    }
  });
});

describe('looksLikeHtml (flag 109)', () => {
  test('the markup openers are recognized — case-insensitive, name-bounded', () => {
    expect(looksLikeHtml(Buffer.from('<!doctype html><html>…'))).toBe(true);
    expect(looksLikeHtml(Buffer.from('<!DOCTYPE HTML PUBLIC "-//x">'))).toBe(true);
    expect(looksLikeHtml(Buffer.from('<html><body>x</body></html>'))).toBe(true);
    expect(looksLikeHtml(Buffer.from('<HEAD><title>t</title>'))).toBe(true);
    expect(looksLikeHtml(Buffer.from('  <body>text</body>'))).toBe(true);
    expect(looksLikeHtml(Buffer.from('\t\r\n<Html lang=en>'))).toBe(true);
    // Name boundary: <header is not <head, <bodyguard is not <body.
    expect(looksLikeHtml(Buffer.from('<header>site</header>'))).toBe(false);
    expect(looksLikeHtml(Buffer.from('<bodyguard>'))).toBe(false);
    expect(looksLikeHtml(Buffer.from('<htmlish>'))).toBe(false);
  });

  test('leading comments are skipped — the token after them decides', () => {
    expect(looksLikeHtml(Buffer.from('<!-- gen -->\n<html>x</html>'))).toBe(true);
    expect(looksLikeHtml(Buffer.from('<!-- a --><!-- b --><body>x</body>'))).toBe(true);
    expect(looksLikeHtml(Buffer.from('<!-- never closed <html>'))).toBe(false);
    expect(looksLikeHtml(Buffer.from('<!-- gen -->plain text'))).toBe(false);
  });

  test('a NUL byte anywhere in the window means binary — rejected', () => {
    const bin = Buffer.concat([
      Buffer.from('\x00\x01\x02<html>', 'latin1'),
      Buffer.from('<body>x</body>'),
    ]);
    expect(looksLikeHtml(bin)).toBe(false);
    // Even when the prefix LOOKS like markup, a NUL inside the window vetoes.
    const sneaky = Buffer.concat([
      Buffer.from('<html><head>'),
      Buffer.from([0]),
      Buffer.from('</head><body>x</body>'),
    ]);
    expect(looksLikeHtml(sneaky)).toBe(false);
  });

  test('plain text, JSON, and arbitrary binary stay non-markup', () => {
    expect(looksLikeHtml(Buffer.from('hello world this is a log line'))).toBe(false);
    expect(looksLikeHtml(Buffer.from('{"a": 1, "b": [2, 3]}'))).toBe(false);
    expect(looksLikeHtml(Buffer.from('PK\x03\x04zip-bytes', 'latin1'))).toBe(false);
    expect(looksLikeHtml(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(false);
  });
});

describe('injectHtml — context-aware anchors (flag 111)', () => {
  test('a "</head" inside a <script> string does not steal the anchor', () => {
    // Regression: the first literal `</head` used to be the splice point —
    // inside this script's string literal it would land markup inside JS.
    const raw = Buffer.from(
      '<html><head><script>console.log("</head")</script><title>t</title></head><body>x</body></html>',
    );
    const { body } = injectHtml(raw, { styleText: '.a{}' });
    const text = body.toString('latin1');
    const styleAt = text.indexOf('<style id="bm-c">');
    const realClose = text.lastIndexOf('</head>');
    // Lands immediately before the REAL closing head tag, not inside the
    // script string — the inserted markup's own length separates them.
    expect(styleAt).toBeGreaterThan(-1);
    expect(styleAt).toBe(realClose - '<style id="bm-c">.a{}</style>'.length);
    expect(text.indexOf('console.log("')).toBeLessThan(styleAt);
  });

  test('a "</head" inside an HTML comment does not steal the anchor', () => {
    const raw = Buffer.from(
      '<html><head><!-- </head leftover --><title>t</title></head><body>x</body></html>',
    );
    const { body } = injectHtml(raw, { styleText: '.a{}' });
    const text = body.toString('latin1');
    expect(text.indexOf('<style id="bm-c">')).toBe(
      text.lastIndexOf('</head>') - '<style id="bm-c">.a{}</style>'.length,
    );
  });

  test('a "</head" inside a quoted attribute does not steal the anchor', () => {
    const raw = Buffer.from(
      '<html><head><meta data-note="</head"><title>t</title></head><body>x</body></html>',
    );
    const { body } = injectHtml(raw, { styleText: '.a{}' });
    const text = body.toString('latin1');
    expect(text.indexOf('<style id="bm-c">')).toBe(
      text.lastIndexOf('</head>') - '<style id="bm-c">.a{}</style>'.length,
    );
  });

  test('an unterminated script falls back to the first literal match', () => {
    // Ambiguous tail — the scanner refuses to guess, so the pre-flag
    // first-literal search is the answer: still injects, never worse. The
    // `</head>` inside the string is name-bounded (the `>` ends the name),
    // so the literal search DOES match it — the old code spliced exactly here.
    const raw = Buffer.from('<html><head><script>var s="</head>"');
    const { body, injected } = injectHtml(raw, { styleText: '.a{}' });
    expect(injected.style).toBe(true);
    const text = body.toString('latin1');
    // The splice landed immediately before the literal `</head>` inside the
    // script string — exactly where the first-literal search always put it.
    expect(text).toContain('</style></head>"');
    expect(text.indexOf('var s="')).toBeLessThan(text.indexOf('<style id="bm-c">'));
  });

  test('the script anchor skips a fake "<head>" inside script text', () => {
    const raw = Buffer.from(
      '<body><script>var t="<head>"</script></body><html><head></head></html>',
    );
    const { body } = injectHtml(raw, { scriptText: 'x=1' });
    const text = body.toString('latin1');
    // SCRIPT_ANCHORS prefer afterOpen <head — the real one late in the
    // body, not the string inside the early script.
    const scriptAt = text.indexOf('<script>x=1</script>');
    const realHead = text.lastIndexOf('<head>');
    expect(scriptAt).toBeGreaterThan(realHead);
  });
});
