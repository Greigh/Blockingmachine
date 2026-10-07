import { compileRuleSet } from '@blockingmachine/core/domain-evaluator';
import { compileMatcher } from '../filter/matcher';
import { parseFeedRules } from '../filter/ruleset';

describe('parseFeedRules', () => {
  it('keeps ABP host rules and exceptions, drops comments/headers', () => {
    const body = [
      '[Adblock Plus 2.0]',
      '! Title: Blockingmachine Generated Filter List',
      '',
      '||doubleclick.net^',
      '@@||safe.example.com^',
      '||ads.example^$third-party',
    ].join('\n');
    expect(parseFeedRules(body)).toEqual([
      '||doubleclick.net^',
      '@@||safe.example.com^',
      '||ads.example^$third-party',
    ]);
  });

  it('normalizes hosts-style lines into ABP form and skips localhost', () => {
    const body = [
      '0.0.0.0 bad.host',
      '127.0.0.1 tracker.example',
      '0.0.0.0 localhost',
      '127.0.0.1 printer.local',
      '# a comment',
    ].join('\n');
    expect(parseFeedRules(body)).toEqual([
      '||bad.host^',
      '||tracker.example^',
    ]);
  });

  it('returns [] for an empty or comment-only body', () => {
    expect(parseFeedRules('')).toEqual([]);
    expect(parseFeedRules('! nothing\n[header]\n\n')).toEqual([]);
  });
});

describe('compileMatcher parity with core compileRuleSet', () => {
  // The feed publishes ||domain^ / @@|| exceptions — the cases where the lean
  // matcher and the hub's evaluator must agree.
  const rules = [
    '||doubleclick.net^',
    '||ads.example.com^',
    '@@||safe.doubleclick.net^',
    '@@||allowed.example.org^',
    '||ads.example^$third-party',
  ];
  const domains = [
    'doubleclick.net',
    'ads.doubleclick.net',
    'deep.ads.doubleclick.net',
    'safe.doubleclick.net',
    'allowed.example.org',
    'sub.allowed.example.org',
    'example.com',
    'notdoubleclick.net',
  ];

  const core = compileRuleSet(rules);
  const local = compileMatcher(rules);

  for (const d of domains) {
    it(`agrees on ${d}`, () => {
      expect(local.evaluate(d).verdict === 'blocked').toBe(
        core.evaluate(d).verdict === 'blocked',
      );
    });
  }

  it('reports the covering rule like the hub does', () => {
    expect(local.evaluate('ads.doubleclick.net').coveringRule).toBe('||doubleclick.net^');
    expect(local.evaluate('safe.doubleclick.net').verdict).toBe('exception');
  });
});
