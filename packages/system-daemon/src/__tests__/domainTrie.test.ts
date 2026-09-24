import { DomainTrie } from '../engine/domainTrie.js';

describe('DomainTrie engine', () => {
  let trie: DomainTrie;

  beforeEach(() => {
    trie = new DomainTrie();
  });

  test('blocks exact match domains', () => {
    trie.addRule('ads.example.com');
    expect(trie.evaluate('ads.example.com').verdict).toBe('BLOCKED');
    expect(trie.evaluate('example.com').verdict).toBe('ALLOWED');
    expect(trie.evaluate('sub.ads.example.com').verdict).toBe('ALLOWED');
  });

  test('blocks wildcard suffix rules (||domain^)', () => {
    trie.addRule('||doubleclick.net^');
    expect(trie.evaluate('doubleclick.net').verdict).toBe('BLOCKED');
    expect(trie.evaluate('ad.doubleclick.net').verdict).toBe('BLOCKED');
    expect(trie.evaluate('tracker.sub.doubleclick.net').verdict).toBe('BLOCKED');
    expect(trie.evaluate('notdoubleclick.net').verdict).toBe('ALLOWED');
  });

  test('respects exceptions (@@)', () => {
    trie.addRule('||tracker.com^');
    trie.addRule('@@||safe.tracker.com^');

    expect(trie.evaluate('tracker.com').verdict).toBe('BLOCKED');
    expect(trie.evaluate('bad.tracker.com').verdict).toBe('BLOCKED');
    expect(trie.evaluate('safe.tracker.com').verdict).toBe('EXCEPTION');
  });

  test('respects $important precedence over standard exceptions', () => {
    trie.addRule('||evil.com^$important');
    trie.addRule('@@||evil.com^');

    // $important block overrides regular exception
    expect(trie.evaluate('evil.com').verdict).toBe('BLOCKED');
  });

  test('respects $important exception over $important block', () => {
    trie.addRule('||critical.com^$important');
    trie.addRule('@@||critical.com^$important');

    // $important exception overrides $important block
    expect(trie.evaluate('critical.com').verdict).toBe('EXCEPTION');
  });

  test('handles trailing periods and mixed case correctly', () => {
    trie.addRule('||Analytics.Io^');
    expect(trie.evaluate('ANALYTICS.IO.').verdict).toBe('BLOCKED');
    expect(trie.evaluate('telemetry.analytics.io').verdict).toBe('BLOCKED');
  });

  test('strictly rejects browser-only rules to prevent DNS breakage', () => {
    // 1. Cosmetic rules should NOT block the website at DNS level
    trie.addRule('example.com##.ad-banner');
    trie.addRule('##div[id^="google_ad"]');
    trie.addRule('example.com#@#.whitelist-banner');
    expect(trie.evaluate('example.com').verdict).toBe('ALLOWED');

    // 2. Path-specific rules must NOT block the parent domain at DNS level
    trie.addRule('||news-portal.com/ads/tracker.js^');
    expect(trie.evaluate('news-portal.com').verdict).toBe('ALLOWED');

    // 3. Resource modifier rules ($image, $script) must NOT block at DNS level
    trie.addRule('||content-site.org^$image');
    trie.addRule('||media-site.net^$script,stylesheet');
    expect(trie.evaluate('content-site.org').verdict).toBe('ALLOWED');
    expect(trie.evaluate('media-site.net').verdict).toBe('ALLOWED');

    // 4. Scriptlets must NOT block at DNS level
    trie.addRule('site.com##+js(set, adblock, true)');
    expect(trie.evaluate('site.com').verdict).toBe('ALLOWED');

    // 5. Bare public suffixes and reverse DNS must NOT be sinkholed
    trie.addRule('||co.uk^');
    trie.addRule('||pages.dev^');
    trie.addRule('||1.0.0.127.in-addr.arpa^');
    expect(trie.evaluate('co.uk').verdict).toBe('ALLOWED');
    expect(trie.evaluate('bbc.co.uk').verdict).toBe('ALLOWED');
    expect(trie.evaluate('pages.dev').verdict).toBe('ALLOWED');
    expect(trie.evaluate('my-site.pages.dev').verdict).toBe('ALLOWED');
    expect(trie.evaluate('1.0.0.127.in-addr.arpa').verdict).toBe('ALLOWED');

    // 6. Pure domain and hosts rules should be blocked
    trie.addRule('0.0.0.0 tele-tracker.com');
    trie.addRule('||pure-adserver.com^');
    expect(trie.evaluate('tele-tracker.com').verdict).toBe('BLOCKED');
    expect(trie.evaluate('pure-adserver.com').verdict).toBe('BLOCKED');
  });

  test('evaluates dynamically injected quarantined domains', () => {
    const domain = 'malicious-dga-q1w2e3r4t5y6.biz';
    trie.addRule(`||${domain}^`);
    expect(trie.evaluate(domain).verdict).toBe('BLOCKED');
    expect(trie.evaluate(`sub.${domain}`).verdict).toBe('BLOCKED');
  });
});
