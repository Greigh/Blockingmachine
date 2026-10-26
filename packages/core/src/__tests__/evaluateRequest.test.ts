import { describe, expect, test } from '@jest/globals';
import { createRequestEvaluator } from '../evaluateRequest.js';

describe('createRequestEvaluator', () => {
  test('||domain^ blocks the host and every subdomain, but not a sibling domain', () => {
    const evaluator = createRequestEvaluator(['||tracker.example^']);
    expect(evaluator.evaluate('https://tracker.example/x').action).toBe('blocked');
    expect(evaluator.evaluate('https://a.b.tracker.example/').action).toBe('blocked');
    expect(evaluator.evaluate('https://nottracker.example/').action).toBe('allowed');
    expect(evaluator.evaluate('https://tracker.example/x').coveringRule).toBe('||tracker.example^');
  });

  test('@@||host^ excepts that host and its subdomains — not the parent zone', () => {
    const evaluator = createRequestEvaluator(['||tracker.example^', '@@||cdn.tracker.example^']);
    const verdict = evaluator.evaluate('https://cdn.tracker.example/x');
    expect(verdict.action).toBe('exception');
    expect(verdict.coveringRule).toBe('@@||cdn.tracker.example^');
    expect(evaluator.evaluate('https://www.cdn.tracker.example/').action).toBe('exception');
    expect(evaluator.evaluate('https://tracker.example/').action).toBe('blocked');
    expect(evaluator.evaluate('https://other.tracker.example/').action).toBe('blocked');
  });

  test('a $important blocking rule outranks a plain exception', () => {
    const evaluator = createRequestEvaluator(['@@||ads.example^', '||ads.example^$important']);
    const verdict = evaluator.evaluate('https://ads.example/');
    expect(verdict.action).toBe('blocked');
    expect(verdict.coveringRule).toBe('||ads.example^$important');
  });

  test('a $important exception still outranks a $important block', () => {
    const evaluator = createRequestEvaluator([
      '||ads.example^$important',
      '@@||ads.example^$important',
    ]);
    expect(evaluator.evaluate('https://ads.example/').action).toBe('exception');
  });

  test('||x.com/ads/* blocks only matching paths under that domain', () => {
    const evaluator = createRequestEvaluator(['||x.com/ads/*']);
    expect(evaluator.evaluate('https://x.com/ads/banner.js').action).toBe('blocked');
    expect(evaluator.evaluate('https://x.com/index.html').action).toBe('allowed');
    expect(evaluator.evaluate('https://other.example/ads/banner.js').action).toBe('allowed');
  });

  test('|http://exact.example/p matches only that exact prefix', () => {
    const evaluator = createRequestEvaluator(['|http://exact.example/p']);
    expect(evaluator.evaluate('http://exact.example/p').action).toBe('blocked');
    expect(evaluator.evaluate('http://exact.example/other').action).toBe('allowed');
    expect(evaluator.evaluate('https://exact.example/p').action).toBe('allowed');
  });

  test('||x.com^$removeparam=name yields transforms.removeParams on a blocked verdict', () => {
    const evaluator = createRequestEvaluator(['||x.com^$removeparam=utm_source']);
    const verdict = evaluator.evaluate('https://x.com/?utm_source=a&keep=1');
    expect(verdict.action).toBe('blocked');
    expect(verdict.transforms.removeParams).toEqual(['utm_source']);
    expect(verdict.transforms.removeHeaders).toEqual([]);
  });

  test('bare $removeparam means removeParams "all"', () => {
    const evaluator = createRequestEvaluator(['||x.com^$removeparam']);
    expect(evaluator.evaluate('https://x.com/?a=1').transforms.removeParams).toBe('all');
  });

  test('||x.com^$removeheader=referer yields transforms.removeHeaders', () => {
    const evaluator = createRequestEvaluator(['||x.com^$removeheader=referer']);
    const verdict = evaluator.evaluate('https://x.com/');
    expect(verdict.transforms.removeHeaders).toEqual(['referer']);
  });

  test('||x.com^$csp=... yields transforms.csp', () => {
    const evaluator = createRequestEvaluator(["||x.com^$csp=script-src 'none'"]);
    const verdict = evaluator.evaluate('https://x.com/');
    expect(verdict.transforms.csp).toBe("script-src 'none'");
  });

  test('||x.com^$third-party only matches third-party requests', () => {
    const evaluator = createRequestEvaluator(['||x.com^$third-party']);
    expect(evaluator.evaluate('https://x.com/', { thirdParty: true }).action).toBe('blocked');
    expect(evaluator.evaluate('https://x.com/', { thirdParty: false }).action).toBe('allowed');
    // Without a context the condition cannot be verified, so the rule does not fire.
    expect(evaluator.evaluate('https://x.com/').action).toBe('allowed');
  });

  test('@@||x.com^$removeparam=token excepts and still carries the transform', () => {
    const evaluator = createRequestEvaluator(['||x.com^', '@@||x.com^$removeparam=token']);
    const verdict = evaluator.evaluate('https://x.com/?token=t');
    expect(verdict.action).toBe('exception');
    expect(verdict.coveringRule).toBe('@@||x.com^$removeparam=token');
    expect(verdict.transforms.removeParams).toEqual(['token']);
  });

  test('transforms are collected from every matching rule, not just the winner', () => {
    const evaluator = createRequestEvaluator([
      '||x.com^',
      '||x.com^$removeparam=utm_source',
      '@@||x.com^$removeheader=referer',
    ]);
    const verdict = evaluator.evaluate('https://x.com/?utm_source=a');
    expect(verdict.action).toBe('exception');
    expect(verdict.transforms.removeParams).toEqual(['utm_source']);
    expect(verdict.transforms.removeHeaders).toEqual(['referer']);
  });

  test('no match returns allowed with a null coveringRule and empty transforms', () => {
    const evaluator = createRequestEvaluator(['||tracker.example^']);
    const verdict = evaluator.evaluate('https://clean.example/page');
    expect(verdict).toEqual({
      action: 'allowed',
      coveringRule: null,
      transforms: { removeParams: [], removeHeaders: [] },
    });
  });

  test('an unparseable URL fails open to allowed', () => {
    const evaluator = createRequestEvaluator(['||tracker.example^']);
    expect(evaluator.evaluate('not a url').action).toBe('allowed');
    expect(evaluator.evaluate('').action).toBe('allowed');
  });

  test('size counts the indexed request rules, not comments or cosmetic rules', () => {
    const evaluator = createRequestEvaluator([
      '||a.example^',
      '! a comment',
      '@@||b.example^',
      'x.example##.ad',
      '||c.example/ads/*$third-party',
      '[Adblock Plus 2.0]',
    ]);
    expect(evaluator.size).toBe(3);
  });
});
