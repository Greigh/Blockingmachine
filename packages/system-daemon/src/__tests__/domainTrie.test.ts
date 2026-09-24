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
});
