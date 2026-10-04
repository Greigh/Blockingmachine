import { describe, expect, test } from '@jest/globals';
import { CompiledDomainRuleSet } from '../ai/domainEvaluator.js';
import { replayRuleHits } from '../ruleReplay.js';

describe('rule replay', () => {
  test('decides a path-scoped rule from the URL, and lets it outrank the zone block', () => {
    // The case this whole capability exists for. Read from a hostname, `||cdn.example.com^` and
    // `||cdn.example.com^*/ads.js` are the same statement — both read as "block the zone" — and
    // the zone block wins, so the path rule is credited with every request to the host. It only
    // blocks one of them, and only the URL says which.
    const ruleSet = new CompiledDomainRuleSet(['||cdn.example.com^', '||cdn.example.com^*/ads.js']);
    const requests = [
      { host: 'cdn.example.com', url: 'https://cdn.example.com/assets/ads.js', count: 3 },
      { host: 'cdn.example.com', url: 'https://cdn.example.com/app.css', count: 4 },
    ];

    const decided = replayRuleHits(ruleSet, requests);
    // The path rule took the three it matches...
    expect(decided.urlHits).toEqual([{ rule: '||cdn.example.com^*/ads.js', count: 3 }]);
    expect(decided.urlDecidedRequests).toBe(3);
    expect(decided.urlDecidedRules).toBe(1);
    // ...and the zone block took only the four it actually covers, which is the correction.
    expect(decided.hits).toEqual([{ rule: '||cdn.example.com^', count: 4 }]);
    // Nothing is left undecidable, so nothing is left out of the accounting.
    expect(decided.scopedHits).toEqual([]);
    expect(decided.blockedRequests).toBe(7);

    // The same trace with the paths removed: the zone block swallows all seven, and the path
    // rule is reported rather than decided. This is the fallback, and it has to still work.
    const hostOnly = replayRuleHits(ruleSet, requests.map(({ host, count }) => ({ host, count })));
    expect(hostOnly.hits).toEqual([{ rule: '||cdn.example.com^', count: 7 }]);
    expect(hostOnly.urlHits).toEqual([]);
    expect(hostOnly.urlDecidedRequests).toBe(0);
    expect(hostOnly.scopedHits).toEqual([]);
  });

  test('keeps a rule that needs the requesting page undecidable even with a URL', () => {
    // A URL settles a path. It settles nothing about whether a request was third-party, which is
    // a fact about the page that made it — so this rule must not be promoted into `urlHits` on
    // the strength of having one.
    const ruleSet = new CompiledDomainRuleSet(['||third.example.org^$third-party']);
    const outcome = replayRuleHits(ruleSet, [
      { host: 'third.example.org', url: 'https://third.example.org/beacon', count: 6 },
    ]);
    expect(outcome.urlHits).toEqual([]);
    expect(outcome.urlDecidedRequests).toBe(0);
    // It is not in the list either: the domain evaluator drops request-scoped rules outright.
    expect(outcome.hits).toEqual([]);
    expect(outcome.blockedRequests).toBe(0);
  });

  test('lets a host allowlist stand over a path rule for the same request', () => {
    // An exception is a deliberate decision to let a request through, and a replay cannot see
    // whether a narrower exception carried the same path as the rule. Where the two disagree the
    // allowlist wins: that is the conservative direction, and it is the only one that cannot
    // invent a block the browser skipped.
    const ruleSet = new CompiledDomainRuleSet(['||safe.example.com^', '||safe.example.com^*/ads.js', '@@||safe.example.com^']);
    const outcome = replayRuleHits(ruleSet, [
      { host: 'safe.example.com', url: 'https://safe.example.com/assets/ads.js', count: 3 },
    ]);
    expect(outcome.exceptions).toEqual([{ rule: '@@||safe.example.com^', count: 3 }]);
    expect(outcome.urlHits).toEqual([]);
    // The path rule matched the URL perfectly well and was still not the winner.
    expect(outcome.urlDecidedRequests).toBe(0);
    expect(outcome.blockedRequests).toBe(0);
  });

  describe('path-preserving exceptions', () => {
    test('@@||host/path is indexed, and allowlists only the URLs it names', () => {
      // The rule used to drop at compile time: the host extraction has no pattern it can
      // express once a path follows it. Now it keeps a URL matcher, so it decides the one
      // request it describes and stays silent on every other path of the same host.
      const ruleSet = new CompiledDomainRuleSet([
        '||cdn.example.com^',
        '@@||cdn.example.com/keep.js',
      ]);
      const outcome = replayRuleHits(ruleSet, [
        { host: 'cdn.example.com', url: 'https://cdn.example.com/keep.js', count: 4 },
        { host: 'cdn.example.com', url: 'https://cdn.example.com/ads.js', count: 6 },
      ]);
      expect(outcome.exceptions).toEqual([{ rule: '@@||cdn.example.com/keep.js', count: 4 }]);
      expect(outcome.blockedRequests).toBe(6);
      expect(outcome.hits).toEqual([{ rule: '||cdn.example.com^', count: 6 }]);
    });

    test('@@||host^*/path no longer widens into a zone allowlist', () => {
      // The worse of the two old behaviours: the host half matched the zone index and the
      // path was silently discarded, so `@@||host^*/adverts.js` let the *whole zone* through.
      // The exception now covers exactly the path it names.
      const ruleSet = new CompiledDomainRuleSet([
        '||news.example.co.uk^',
        '@@||news.example.co.uk^*/adverts.js',
      ]);
      const outcome = replayRuleHits(ruleSet, [
        { host: 'news.example.co.uk', url: 'https://news.example.co.uk/x/adverts.js', count: 2 },
        { host: 'news.example.co.uk', url: 'https://news.example.co.uk/pixel.gif', count: 5 },
      ]);
      expect(outcome.exceptions).toEqual([
        { rule: '@@||news.example.co.uk^*/adverts.js', count: 2 },
      ]);
      expect(outcome.hits).toEqual([{ rule: '||news.example.co.uk^', count: 5 }]);
      expect(outcome.blockedRequests).toBe(5);
    });

    test('a path exception beats a matching path block on the same request', () => {
      const ruleSet = new CompiledDomainRuleSet([
        '||cdn.example.com^*/ads.js',
        '@@||cdn.example.com^*/ads.js',
      ]);
      const outcome = replayRuleHits(ruleSet, [
        { host: 'cdn.example.com', url: 'https://cdn.example.com/v/ads.js', count: 3 },
      ]);
      expect(outcome.exceptions).toEqual([{ rule: '@@||cdn.example.com^*/ads.js', count: 3 }]);
      expect(outcome.urlHits).toEqual([]);
      expect(outcome.blockedRequests).toBe(0);
    });

    test('an $important zone block still outranks a regular path exception', () => {
      // Same precedence evaluate() documents: $important block > regular exception.
      const ruleSet = new CompiledDomainRuleSet([
        '||cdn.example.com^$important',
        '@@||cdn.example.com/keep.js',
      ]);
      const outcome = replayRuleHits(ruleSet, [
        { host: 'cdn.example.com', url: 'https://cdn.example.com/keep.js', count: 2 },
      ]);
      expect(outcome.exceptions).toEqual([]);
      expect(outcome.hits).toEqual([{ rule: '||cdn.example.com^$important', count: 2 }]);
    });

    test('an $important path exception outranks an $important zone block', () => {
      const ruleSet = new CompiledDomainRuleSet([
        '||cdn.example.com^$important',
        '@@||cdn.example.com/keep.js$important',
      ]);
      const outcome = replayRuleHits(ruleSet, [
        { host: 'cdn.example.com', url: 'https://cdn.example.com/keep.js', count: 2 },
        { host: 'cdn.example.com', url: 'https://cdn.example.com/other.js', count: 4 },
      ]);
      expect(outcome.exceptions).toEqual([
        { rule: '@@||cdn.example.com/keep.js$important', count: 2 },
      ]);
      expect(outcome.hits).toEqual([{ rule: '||cdn.example.com^$important', count: 4 }]);
    });

    test('a hostname-only trace cannot fire a path exception, and the block stands', () => {
      // No URL means the exception cannot decide — the same honest limit a path block has on
      // a hostname trace. The zone block is read at face value, exactly as it always was.
      const ruleSet = new CompiledDomainRuleSet([
        '||cdn.example.com^',
        '@@||cdn.example.com/keep.js',
      ]);
      const outcome = replayRuleHits(ruleSet, [
        { host: 'cdn.example.com', count: 4 },
      ]);
      expect(outcome.exceptions).toEqual([]);
      expect(outcome.hits).toEqual([{ rule: '||cdn.example.com^', count: 4 }]);
    });

    test('a bare @@host is not widened into a URL-substring allowlist', () => {
      // Widening an exception is the unsafe direction: `@@cdn` stays the exact-host exception
      // it always was rather than allowing any URL containing the token.
      const ruleSet = new CompiledDomainRuleSet(['@@cdn']);
      const outcome = replayRuleHits(ruleSet, [
        { host: 'cdn.example.com', url: 'https://cdn.example.com/cdn/app.js', count: 3 },
      ]);
      expect(outcome.exceptions).toEqual([]);
    });
  });

  test('splits winners by whether a hostname can decide them', () => {
    const ruleSet = new CompiledDomainRuleSet([
      '||doubleclick.net^',
      '||cdn.example.com^*/ads.js',
      '@@||safe.doubleclick.net^',
    ]);

    const outcome = replayRuleHits(ruleSet, [
      { host: 'doubleclick.net', count: 3 },
      { host: 'cdn.example.com', count: 2 },
      { host: 'safe.doubleclick.net', count: 5 },
      { host: 'unrelated.example', count: 9 },
    ]);

    // A hostname decided this one, so it is in the rate.
    expect(outcome.hits).toEqual([{ rule: '||doubleclick.net^', count: 3 }]);
    // This one keeps a path: a replay cannot validate it, so it is reported rather than folded in.
    expect(outcome.scopedHits).toEqual([
      { scope: 'path', rule: '||cdn.example.com^*/ads.js', count: 2 },
    ]);
    expect(outcome.exceptions).toEqual([{ rule: '@@||safe.doubleclick.net^', count: 5 }]);

    // Blocking counts include the scoped winner — the request really was blocked by the list.
    expect(outcome.blockedRequests).toBe(5);
    expect(outcome.blockedHosts).toBe(2);
    expect(outcome.allowlistedHosts).toBe(1);
    expect(outcome.scopedHosts).toBe(1);
    expect(outcome.scopedRequests).toBe(2);
  });

  test('counts a request once, by the rule that won it', () => {
    const ruleSet = new CompiledDomainRuleSet(['||doubleclick.net^', '*.doubleclick.net']);
    const outcome = replayRuleHits(ruleSet, [{ host: 'ads.doubleclick.net', count: 4 }]);

    expect(outcome.blockedRequests).toBe(4);
    expect(outcome.hits.length).toBe(1);
    expect(outcome.hits[0].count).toBe(4);
  });

  test('ignores non-positive and malformed counts rather than crediting them', () => {
    const ruleSet = new CompiledDomainRuleSet(['||doubleclick.net^']);
    const outcome = replayRuleHits(ruleSet, [
      { host: 'doubleclick.net', count: 0 },
      { host: 'doubleclick.net', count: -4 },
      { host: 'doubleclick.net', count: Number.NaN },
    ]);

    expect(outcome.hits).toEqual([]);
    expect(outcome.blockedHosts).toBe(0);
    expect(outcome.blockedRequests).toBe(0);
  });

  test('reports nothing for traffic no rule matched', () => {
    const ruleSet = new CompiledDomainRuleSet(['||doubleclick.net^']);
    const outcome = replayRuleHits(ruleSet, [
      { host: 'en.wikipedia.org', count: 120 },
      { host: 'cdn.example.com', count: 8 },
    ]);

    expect(outcome).toEqual({
      hits: [],
      urlHits: [],
      scopedHits: [],
      exceptions: [],
      blockedRequests: 0,
      blockedHosts: 0,
      allowlistedHosts: 0,
      scopedHosts: 0,
      scopedRequests: 0,
      urlDecidedRequests: 0,
      urlDecidedRules: 0,
    });
  });
});
