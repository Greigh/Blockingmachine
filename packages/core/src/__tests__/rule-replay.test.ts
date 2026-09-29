import { describe, test, expect } from '@jest/globals';
import { CompiledDomainRuleSet } from '../ai/domainEvaluator.js';
import { replayRuleHits } from '../ruleReplay.js';

describe('rule replay', () => {
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
      scopedHits: [],
      exceptions: [],
      blockedRequests: 0,
      blockedHosts: 0,
      allowlistedHosts: 0,
      scopedHosts: 0,
      scopedRequests: 0,
    });
  });
});
