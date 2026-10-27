/**
 * Request-transform unit tests (design spec §5.5, plan Task 6).
 *
 * `applyRequestTransforms` reshapes the request between verdict and upstream
 * dial: `$removeparam` names drop out of the query (with `"all"` keeping only
 * `keepParams`), `$removeheader` names drop out of the forwarded headers
 * case-insensitively. Surviving query bytes are preserved verbatim — kept
 * params are never decoded/re-encoded, which is what keeps signed URLs alive.
 * `csp` verdicts are collected here but stay unapplied — the response side is
 * P2, so a transform carrying only `csp` is a pass-through.
 */

import { describe, expect, test } from '@jest/globals';
import type { RequestVerdict } from '@blockingmachine/core';
import { applyRequestTransforms } from '../pipeline/transforms.js';

type Transforms = RequestVerdict['transforms'];

/** A verdict's transform block with the caller's overrides applied. */
function transforms(over: Partial<Transforms> = {}): Transforms {
  return { removeParams: [], keepParams: [], removeHeaders: [], ...over };
}

describe('applyRequestTransforms — removeparam', () => {
  test('strips only the named params, preserving the rest verbatim', () => {
    const out = applyRequestTransforms(
      'https://x.test/p?utm_source=x&keep=1',
      {},
      transforms({ removeParams: ['utm_source'] }),
    );
    expect(out.url).toBe('https://x.test/p?keep=1');
  });

  test('"all" strips every param — the bare path remains', () => {
    const out = applyRequestTransforms(
      'https://x.test/p?utm=1&k=2',
      {},
      transforms({ removeParams: 'all' }),
    );
    expect(out.url).toBe('https://x.test/p');
  });

  test('"all" + keepParams keeps only the named survivors', () => {
    const out = applyRequestTransforms(
      'https://x.test/p?utm=1&keep=2&k=3',
      {},
      transforms({ removeParams: 'all', keepParams: ['keep'] }),
    );
    expect(out.url).toBe('https://x.test/p?keep=2');
  });

  test('origin-form targets keep their form', () => {
    const out = applyRequestTransforms(
      '/x?utm=1&keep=2',
      {},
      transforms({ removeParams: ['utm'] }),
    );
    expect(out.url).toBe('/x?keep=2');
  });

  test('surviving params are byte-preserved — kept values are never re-encoded', () => {
    const out = applyRequestTransforms(
      'https://x.test/p?utm=1&sig=a%20b%2Fc&empty=&flag',
      {},
      transforms({ removeParams: ['utm'] }),
    );
    expect(out.url).toBe('https://x.test/p?sig=a%20b%2Fc&empty=&flag');
  });

  test('a URL with no query passes through unchanged', () => {
    const out = applyRequestTransforms(
      'https://x.test/p',
      {},
      transforms({ removeParams: ['utm'], removeHeaders: [] }),
    );
    expect(out.url).toBe('https://x.test/p');
  });

  test('a fragment survives the strip', () => {
    const out = applyRequestTransforms(
      'https://x.test/p?utm=1&k=2#frag',
      {},
      transforms({ removeParams: 'all', keepParams: ['k'] }),
    );
    expect(out.url).toBe('https://x.test/p?k=2#frag');
  });
});

describe('applyRequestTransforms — removeheader', () => {
  test('strips only the named header, case-insensitive on both sides', () => {
    const out = applyRequestTransforms(
      'https://x.test/',
      { Referer: 'https://a/', 'X-Keep': '1', host: 'x.test' },
      transforms({ removeHeaders: ['REFERER'] }),
    );
    expect(out.headers).toEqual({ 'X-Keep': '1', host: 'x.test' });
  });

  test('a header the request does not carry strips nothing', () => {
    const headers = { 'x-keep': '1' };
    const out = applyRequestTransforms(
      'https://x.test/',
      headers,
      transforms({ removeHeaders: ['referer'] }),
    );
    expect(out.headers).toEqual({ 'x-keep': '1' });
  });
});

describe('applyRequestTransforms — pass-through', () => {
  test('empty transforms return the url and headers untouched', () => {
    const headers = { referer: 'https://a/', 'x-keep': '1' };
    const out = applyRequestTransforms('https://x.test/?a=1', headers, transforms());
    expect(out.url).toBe('https://x.test/?a=1');
    expect(out.headers).toBe(headers);
  });

  test('a csp-only verdict is a request-side pass-through (response side is P2)', () => {
    const headers = { referer: 'https://a/' };
    const out = applyRequestTransforms(
      'https://x.test/?a=1',
      headers,
      transforms({ csp: "script-src 'none'" }),
    );
    expect(out.url).toBe('https://x.test/?a=1');
    expect(out.headers).toBe(headers);
  });
});
