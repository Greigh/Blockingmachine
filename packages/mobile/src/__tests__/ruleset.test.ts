import { compileRuleSet } from '@blockingmachine/core/domain-evaluator';
import { compileMatcher } from '../filter/matcher';
import { parseFeedRules, syncRuleset } from '../filter/ruleset';

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

describe('syncRuleset', () => {
  const FEED = '||doubleclick.net^\n@@||safe.example.com^\n';
  const okResponse = () =>
    ({ ok: true, status: 200, text: () => Promise.resolve(FEED) }) as unknown as Response;

  it('sends the server token as Bearer auth when one is configured', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      seen.push(init);
      return Promise.resolve(okResponse());
    }) as unknown as typeof fetch;
    const meta = await syncRuleset('http://hub.local:9191', fetchImpl, 'secret-token');
    expect(meta.ruleCount).toBe(2);
    expect((seen[0]?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });

  it('omits the header when no token is configured', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      seen.push(init);
      return Promise.resolve(okResponse());
    }) as unknown as typeof fetch;
    await syncRuleset('http://hub.local:9191/', fetchImpl);
    expect((seen[0]?.headers as Record<string, string>)?.Authorization).toBeUndefined();
  });

  it('explains a 401 as a token problem, not a generic HTTP error', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('') } as Response);
    await expect(syncRuleset('http://hub.local:9191', fetchImpl)).rejects.toThrow('feed token');
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
