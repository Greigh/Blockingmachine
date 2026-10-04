/**
 * Deciding a path-scoped rule from a request URL.
 *
 * A compiled list carries three kinds of blocking rule a *hostname* cannot settle: one scoped to
 * the requesting page, one that needs the request's path, and one that needs the request type.
 * The first and third stay undecidable however good the capture is — whether a request was
 * third-party is a fact about the page that made it, and no URL carries one. The second is
 * decidable, and this module is what decides it.
 *
 * The failure it exists to prevent is silent and runs in the flattering direction: read from a
 * hostname, `||cdn.example.com` plus a path is a block of the whole zone, so the list is credited
 * with blocking every request to that host rather than the one path it names. Coverage then
 * reports a rule as "cannot decide" and the count of what *did* fire stays flattering. Getting
 * this right means being right about what it refuses as well.
 */

import { describe, expect, test } from '@jest/globals';
import { blockingRuleScope, isUrlDecidableRule, requestUrlMatcher } from '../coverage.js';

const matches = (rule: string, url: string): boolean => {
  const test_url = requestUrlMatcher(rule);
  if (!test_url) throw new Error(`expected ${rule} to be decidable from a URL`);
  return test_url(url);
};

describe('requestUrlMatcher', () => {
  test('decides a host anchor followed by a path', () => {
    expect(matches('||cdn.example.com/ads.js', 'https://cdn.example.com/ads.js')).toBe(true);
    expect(matches('||cdn.example.com/ads.js', 'https://cdn.example.com/other.js')).toBe(false);
    // The pattern after the host is matched anywhere in the remainder, not only at the root.
    expect(matches('||cdn.example.com/ads.js', 'https://cdn.example.com/a/b/ads.js')).toBe(true);
    // A trailing wildcard is ABP's "anything, including nothing".
    expect(matches('||cdn.example.com/banner/*', 'https://cdn.example.com/banner/a.png')).toBe(true);
  });

  test('covers subdomains of the anchored host, and nothing else', () => {
    // `||example.com^` covers subdomains in a real browser, so it must here too.
    expect(matches('||cdn.example.com/ads.js', 'https://sub.cdn.example.com/ads.js')).toBe(true);
    // ...and a different registrable domain is still a different domain.
    expect(matches('||cdn.example.com/ads.js', 'https://cdn.example.com.evil.test/ads.js')).toBe(false);
    expect(matches('||cdn.example.com/ads.js', 'https://other.example/ads.js')).toBe(false);
  });

  test('treats the ABP separator as strict, because Chrome does', () => {
    // A host anchor, a separator, a wildcard, then `/ads.js`. The separator consumes the slash
    // after the host, so the rule needs one more path segment before its own `/ads.js` — and
    // the wildcard can supply it. This is exactly what Chrome's urlFilter does with the same
    // string, because the extension hands path-preserving rules to Chrome verbatim. Being
    // lenient here would count a block the browser never performs.
    expect(matches('||cdn.example.com^*/ads.js', 'https://cdn.example.com/x/ads.js')).toBe(true);
    expect(matches('||cdn.example.com^*/ads.js', 'https://cdn.example.com/deep/er/ads.js')).toBe(true);
    expect(matches('||cdn.example.com^*/ads.js', 'https://cdn.example.com/ads.js')).toBe(false);
  });

  test('applies Chrome\u2019s full separator class, not just / ? #', () => {
    // Chrome's `^` is a negated class — anything but a letter, digit, or `_,-.%`, plus end of
    // URL — so `=`, `+`, `@`, `~`, `;`, `:` separate exactly as `/` does. Inside a path or query
    // this is where the narrower class was wrong: `/foo=bar` is a separator followed by `bar`
    // the same way `/foo/bar` is.
    for (const sep of ['=', '+', '@', '~', ';', ':']) {
      expect(matches('||cdn.example.com/foo^bar', `https://cdn.example.com/foo${sep}bar`)).toBe(true);
    }
    // The protected set still fails: letters, digits, `_`, `,`, `-`, `.`, `%` continue the
    // token rather than ending it.
    for (const sep of ['x', '9', '_', ',', '-', '.', '%']) {
      expect(matches('||cdn.example.com/foo^bar', `https://cdn.example.com/foo${sep}bar`)).toBe(false);
    }
    // End-of-URL is still a separator.
    expect(matches('||cdn.example.com/foo^', 'https://cdn.example.com/foo')).toBe(true);
    // And a bare pattern sees the wider class anywhere in the URL.
    expect(matches('/foo^bar', 'https://cdn.example.com/x/foo=bar')).toBe(true);
    expect(matches('/foo^bar', 'https://cdn.example.com/x/fooxbar')).toBe(false);
  });

  test('matches a scheme-bearing rule against the same URL', () => {
    expect(matches('||https://cdn.example.com/ads.js', 'https://cdn.example.com/ads.js')).toBe(true);
    expect(matches('||https://cdn.example.com/ads.js', 'http://cdn.example.com/ads.js')).toBe(true);
    expect(matches('||https://cdn.example.com/ads.js', 'https://other.example/ads.js')).toBe(false);
  });

  test('matches a slashed regex against the whole URL, and a bare pattern anywhere in it', () => {
    expect(matches('/ads/banner\\.js/', 'https://cdn.example.com/ads/banner.js')).toBe(true);
    expect(matches('/ads/banner\\.js/', 'https://cdn.example.com/other/banner.js')).toBe(false);
    expect(matches('/banner.js', 'https://cdn.example.com/deep/banner.js')).toBe(true);
  });

  test('treats a backslash as a literal outside a regex rule', () => {
    // `*` is the only wildcard ABP defines, so every other metacharacter is literal text — which
    // means `\.` in a bare pattern is a backslash followed by a dot, not an escaped dot. Recorded
    // because it is the sort of thing a matcher "fixes" into being wrong.
    expect(matches('/banner.js', 'https://cdn.example.com/banner.js')).toBe(true);
    expect(matches('/banner\\.js', 'https://cdn.example.com/banner.js')).toBe(false);
  });

  test('refuses every form a URL cannot settle, rather than guessing', () => {
    // The point of returning null. A matcher that treated an unknown pattern as "matches" would
    // reintroduce the very over-count this exists to remove, one level down.
    expect(requestUrlMatcher('||cdn.example.com^$third-party')).toBeNull();
    expect(requestUrlMatcher('||cdn.example.com^$domain=shop.example')).toBeNull();
    expect(requestUrlMatcher('||cdn.example.com^$script')).toBeNull();
    // An exception is not a blocking rule, and a host-only rule needs no URL.
    expect(requestUrlMatcher('@@||cdn.example.com/ads.js')).toBeNull();
    expect(requestUrlMatcher('||cdn.example.com^')).toBeNull();
    // A syntactically broken regex in a downloaded list must not stop the replay.
    expect(requestUrlMatcher('/ads/[unclosed/')).toBeNull();
  });

  test('is decidable exactly for the path bucket, and nothing else', () => {
    // The two tests agree by construction, which is the point: a rule the matcher declines keeps
    // the honest "a replay cannot decide this" label rather than being silently dropped.
    for (const rule of ['||cdn.example.com/ads.js', '/ads/banner\\.js/', '||cdn.example.com^*/ads.js']) {
      expect(isUrlDecidableRule(rule)).toBe(true);
      expect(blockingRuleScope(rule)).toBe('path');
      expect(requestUrlMatcher(rule)).not.toBeNull();
    }
    for (const rule of ['||cdn.example.com^', '||cdn.example.com^$third-party', '||a.com^$script']) {
      expect(isUrlDecidableRule(rule)).toBe(false);
      expect(requestUrlMatcher(rule)).toBeNull();
    }
  });
});
