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

  test('||x.com^$removeparam=name modifies, it does not block — transforms on an allowed verdict', () => {
    const evaluator = createRequestEvaluator(['||x.com^$removeparam=utm_source']);
    const verdict = evaluator.evaluate('https://x.com/?utm_source=a&keep=1');
    // A modify-only rule matches and transforms; nothing intercepted the request itself.
    expect(verdict.action).toBe('allowed');
    expect(verdict.coveringRule).toBeNull();
    expect(verdict.transforms.removeParams).toEqual(['utm_source']);
    expect(verdict.transforms.keepParams).toEqual([]);
    expect(verdict.transforms.removeHeaders).toEqual([]);
  });

  test('a pattern-less *$removeparam rule matches every URL without blocking anything', () => {
    const evaluator = createRequestEvaluator(['*$removeparam=fbclid']);
    const verdict = evaluator.evaluate('https://anything.example/?fbclid=1&keep=2');
    expect(verdict.action).toBe('allowed');
    expect(verdict.transforms.removeParams).toEqual(['fbclid']);
    // The rule still applies (and still does not block) on a URL with no query at all.
    expect(evaluator.evaluate('https://anything.example/').action).toBe('allowed');
  });

  test('bare $removeparam means removeParams "all"', () => {
    const evaluator = createRequestEvaluator(['||x.com^$removeparam']);
    const verdict = evaluator.evaluate('https://x.com/?a=1');
    expect(verdict.action).toBe('allowed');
    expect(verdict.transforms.removeParams).toBe('all');
    expect(verdict.transforms.keepParams).toEqual([]);
  });

  test('$removeparam=~name strips everything except the named parameters', () => {
    const evaluator = createRequestEvaluator(['||x.com^$removeparam=~keep']);
    const verdict = evaluator.evaluate('https://x.com/?keep=1&drop=1');
    expect(verdict.action).toBe('allowed');
    expect(verdict.transforms.removeParams).toBe('all');
    expect(verdict.transforms.keepParams).toEqual(['keep']);
  });

  test('||x.com^$removeheader=referer modifies, it does not block', () => {
    const evaluator = createRequestEvaluator(['||x.com^$removeheader=referer']);
    const verdict = evaluator.evaluate('https://x.com/');
    expect(verdict.action).toBe('allowed');
    expect(verdict.transforms.removeHeaders).toEqual(['referer']);
  });

  test('||x.com^$csp=... modifies, it does not block', () => {
    const evaluator = createRequestEvaluator(["||x.com^$csp=script-src 'none'"]);
    const verdict = evaluator.evaluate('https://x.com/');
    expect(verdict.action).toBe('allowed');
    expect(verdict.transforms.csp).toEqual(["script-src 'none'"]);
  });

  test('every matching $csp rule contributes its own policy — not first-wins', () => {
    const evaluator = createRequestEvaluator([
      "||x.com^$csp=script-src 'none'",
      "||x.com^$csp=frame-src 'none'",
      '*$csp=img-src https:',
    ]);
    const verdict = evaluator.evaluate('https://x.com/');
    expect(verdict.action).toBe('allowed');
    expect(verdict.transforms.csp).toEqual([
      "script-src 'none'",
      "frame-src 'none'",
      'img-src https:',
    ]);
  });

  test('a bare @@$csp exception clears the type; a valued one clears only its own policy', () => {
    const bare = createRequestEvaluator([
      "||x.com^$csp=script-src 'none'",
      '@@||x.com^$csp',
    ]);
    expect(bare.evaluate('https://x.com/').transforms.csp).toBeUndefined();
    const valued = createRequestEvaluator([
      "||x.com^$csp=script-src 'none'",
      "||x.com^$csp=frame-src 'none'",
      "@@||x.com^$csp=frame-src 'none'",
    ]);
    expect(valued.evaluate('https://x.com/').transforms.csp).toEqual(["script-src 'none'"]);
  });

  test('modifier names are case-insensitive; modifier VALUES keep their case', () => {
    // `$CSP` parses as `$csp`, but a hash/nonce/report-URI value is
    // case-sensitive — a whole-tail lowercase would corrupt the policy.
    const evaluator = createRequestEvaluator([
      "||x.com^$CSP=script-src 'sha256-AbCdEf1234='",
      '||x.com^$RemoveParam=FBCLID',
      '||x.com^$RemoveHeader=X-Custom-Token',
    ]);
    const verdict = evaluator.evaluate('https://x.com/?FBCLID=1&fbclid=2');
    expect(verdict.transforms.csp).toEqual(["script-src 'sha256-AbCdEf1234='"]);
    expect(verdict.transforms.removeParams).toEqual(['FBCLID']);
    expect(verdict.transforms.removeHeaders).toEqual(['X-Custom-Token']);
  });

  test('interception modifiers still block: $redirect', () => {
    const evaluator = createRequestEvaluator(['||x.com^$redirect=noop.js']);
    expect(evaluator.evaluate('https://x.com/lib.js').action).toBe('blocked');
  });

  test('||x.com^$third-party only matches third-party requests', () => {
    const evaluator = createRequestEvaluator(['||x.com^$third-party']);
    expect(evaluator.evaluate('https://x.com/', { thirdParty: true }).action).toBe('blocked');
    expect(evaluator.evaluate('https://x.com/', { thirdParty: false }).action).toBe('allowed');
    // Without a context the condition cannot be verified, so the rule does not fire.
    expect(evaluator.evaluate('https://x.com/').action).toBe('allowed');
  });

  test('a $denyallow rule never matches — the context carries no initiator', () => {
    const evaluator = createRequestEvaluator(['||x.com^$denyallow=y.x.com']);
    expect(evaluator.evaluate('https://x.com/').action).toBe('allowed');
    expect(evaluator.evaluate('https://y.x.com/').action).toBe('allowed');
  });

  test('@@||x.com^$removeparam=token excepts AND cancels the token strip', () => {
    const evaluator = createRequestEvaluator([
      '*$removeparam=token',
      '@@||x.com^$removeparam=token',
    ]);
    // On x.com the exception suppresses the generic strip — the AUTP cancellation pattern.
    const exempted = evaluator.evaluate('https://x.com/?token=t');
    expect(exempted.action).toBe('exception');
    expect(exempted.coveringRule).toBe('@@||x.com^$removeparam=token');
    expect(exempted.transforms.removeParams).toEqual([]);
    // Everywhere else the generic rule still strips.
    const stripped = evaluator.evaluate('https://y.com/?token=t');
    expect(stripped.action).toBe('allowed');
    expect(stripped.transforms.removeParams).toEqual(['token']);
  });

  test('a bare @@||x.com^$removeparam exception clears the whole removeparam transform', () => {
    const evaluator = createRequestEvaluator([
      '||x.com^$removeparam=utm_source',
      '@@||x.com^$removeparam',
    ]);
    const verdict = evaluator.evaluate('https://x.com/?utm_source=a');
    expect(verdict.action).toBe('exception');
    expect(verdict.transforms.removeParams).toEqual([]);
    expect(verdict.transforms.keepParams).toEqual([]);
  });

  test('transforms come from every matching non-exception rule, not just the winner', () => {
    const evaluator = createRequestEvaluator([
      '||x.com^',
      '||x.com^$removeparam=a',
      '||x.com^$removeparam=b',
      '||x.com^$removeheader=referer',
      '@@||x.com^$removeheader=referer',
    ]);
    const verdict = evaluator.evaluate('https://x.com/?a=1&b=2');
    // The exception wins the action and suppresses its own transform type — the
    // removeparam contributions it does not name are still collected.
    expect(verdict.action).toBe('exception');
    expect(verdict.transforms.removeParams).toEqual(['a', 'b']);
    expect(verdict.transforms.removeHeaders).toEqual([]);
  });

  test('no match returns allowed with a null coveringRule and empty transforms', () => {
    const evaluator = createRequestEvaluator(['||tracker.example^']);
    const verdict = evaluator.evaluate('https://clean.example/page');
    expect(verdict).toEqual({
      action: 'allowed',
      coveringRule: null,
      transforms: { removeParams: [], keepParams: [], removeHeaders: [] },
    });
  });

  test('an unparseable URL fails open to allowed', () => {
    const evaluator = createRequestEvaluator(['||tracker.example^']);
    expect(evaluator.evaluate('not a url').action).toBe('allowed');
    expect(evaluator.evaluate('').action).toBe('allowed');
  });

  test('URLs are clamped at 4096 chars before matching', () => {
    const evaluator = createRequestEvaluator(['||x.com^']);
    const verdict = evaluator.evaluate(`https://x.com/${'a'.repeat(5000)}`);
    expect(verdict.action).toBe('blocked');
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
