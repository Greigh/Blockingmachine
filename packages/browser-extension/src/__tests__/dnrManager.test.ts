import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { DnrManager, parseFilterRule, planListRules } from '../background/dnrManager.js';

describe('DnrManager', () => {
  let mockGetDynamicRules: any;
  let mockUpdateDynamicRules: any;

  beforeEach(() => {
    mockGetDynamicRules = (jest.fn() as any).mockResolvedValue([{ id: 101 }]);
    mockUpdateDynamicRules = (jest.fn() as any).mockResolvedValue(undefined);

    (globalThis as any).chrome = {
      declarativeNetRequest: {
        MAX_NUMBER_OF_DYNAMIC_AND_MATCHED_RULES: 30000,
        RuleActionType: {
          BLOCK: 'block',
          ALLOW: 'allow'
        },
        ResourceType: {
          SCRIPT: 'script',
          IMAGE: 'image',
          XMLHTTPREQUEST: 'xmlhttprequest',
          SUB_FRAME: 'sub_frame',
          MEDIA: 'media',
          PING: 'ping'
        },
        getDynamicRules: mockGetDynamicRules,
        updateDynamicRules: mockUpdateDynamicRules
      }
    };
  });

  test('compiles domain rules into Chrome dynamic declarativeNetRequest rules', async () => {
    const dnr = new DnrManager();
    const rules = [
      '||tracker.com^',
      '||ads.example.com^',
      '! Comment line',
      '# Another comment',
      '   ',
      '||doubleclick.net^'
    ];

    const count = await dnr.updateDynamicRules(rules);

    expect(count).toBe(3);
    expect(mockGetDynamicRules).toHaveBeenCalledTimes(1);
    expect(mockUpdateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [101],
      addRules: expect.arrayContaining([
        expect.objectContaining({
          action: { type: 'block' },
          priority: 1,
          condition: expect.objectContaining({
            urlFilter: '||tracker.com^'
          })
        }),
        expect.objectContaining({
          action: { type: 'block' },
          priority: 1,
          condition: expect.objectContaining({
            urlFilter: '||ads.example.com^'
          })
        }),
        expect.objectContaining({
          action: { type: 'block' },
          priority: 1,
          condition: expect.objectContaining({
            urlFilter: '||doubleclick.net^'
          })
        })
      ])
    });
  });

  test('compiles exception rules (@@) with ALLOW action and higher priority', async () => {
    const dnr = new DnrManager();
    const rules = [
      '||tracker.com^',
      '@@||safe.tracker.com^',
      '||critical.com^$important',
      '@@||override.com^$important'
    ];

    const count = await dnr.updateDynamicRules(rules);
    expect(count).toBe(4);

    const callArgs = mockUpdateDynamicRules.mock.calls[0][0] as { addRules: any[] };
    const added: any[] = callArgs.addRules;

    const exceptionRule = added.find((r) => r.condition.urlFilter === '||safe.tracker.com^');
    expect(exceptionRule).toBeDefined();
    expect(exceptionRule.action.type).toBe('allow');
    expect(exceptionRule.priority).toBe(2);

    const normalBlock = added.find((r) => r.condition.urlFilter === '||tracker.com^');
    expect(normalBlock.action.type).toBe('block');
    expect(normalBlock.priority).toBe(1);

    const importantBlock = added.find((r) => r.condition.urlFilter === '||critical.com^');
    expect(importantBlock.action.type).toBe('block');
    expect(importantBlock.priority).toBe(3);

    const importantException = added.find((r) => r.condition.urlFilter === '||override.com^');
    expect(importantException.action.type).toBe('allow');
    expect(importantException.priority).toBe(4);
  });

  test('deduplicates identical patterns and ignores comments', () => {
    const dnr = new DnrManager();
    expect(dnr.parseRule('! Comment')).toBeNull();
    expect(dnr.parseRule('# Comment')).toBeNull();
    expect(dnr.parseRule('   ')).toBeNull();

    const parsed = dnr.parseRule('||doubleclick.net^$important');
    expect(parsed).toEqual({
      rawRule: '||doubleclick.net^$important',
      pattern: 'doubleclick.net',
      isException: false,
      isImportant: true,
      priority: 3
    });
  });

  test('parses hosts format and plain domains while rejecting invalid domains', () => {
    const dnr = new DnrManager();

    expect(dnr.parseRule('0.0.0.0 telemetry.ads.com')?.pattern).toBe('telemetry.ads.com');
    expect(dnr.parseRule('127.0.0.1 tracker.io')?.pattern).toBe('tracker.io');
    expect(dnr.parseRule('plain-adserver.com')?.pattern).toBe('plain-adserver.com');

    // Reject malformed domains with invalid characters
    expect(dnr.parseRule('||invalid domain.com^')).toBeNull();
    expect(dnr.parseRule('||<script>.com^')).toBeNull();
    expect(dnr.parseRule('||not-a-domain^')).toBeNull();
  });

  test('strictly rejects DNS-only directives from entering DNR rules', () => {
    const dnr = new DnrManager();

    // DNS server rewrite/query-type directives must never be treated as browser rules
    expect(dnr.parseRule('||example.com^$dnsrewrite=1.2.3.4')).toBeNull();
    expect(dnr.parseRule('||example.com^$dnstype=AAAA')).toBeNull();
    expect(dnr.parseRule('||example.com^$client=192.168.1.10')).toBeNull();
    expect(dnr.parseRule('||example.com^$ctag=safe')).toBeNull();
    expect(dnr.parseRule('||1.0.0.127.in-addr.arpa^')).toBeNull();

    // Loopback hosts entries must not pollute dynamic quotas
    expect(dnr.parseRule('127.0.0.1 localhost')).toBeNull();
    expect(dnr.parseRule('0.0.0.0 broadcasthost')).toBeNull();
  });

  test('strictly rejects cosmetic and scriptlet rules from entering DNR rules', () => {
    const dnr = new DnrManager();

    // Cosmetic element hiding must be handled in content scripts, not DNR
    expect(dnr.parseRule('example.com##.ad-banner')).toBeNull();
    expect(dnr.parseRule('example.com#@#.sponsor')).toBeNull();
    expect(dnr.parseRule('##div[class*="ad-slot"]')).toBeNull();
    expect(dnr.parseRule('example.com#?#div:has(> img.ad)')).toBeNull();
    expect(dnr.parseRule('example.com#%#//scriptlet("abort-on-property-read", "adblock")')).toBeNull();
    expect(dnr.parseRule('example.com##+js(set, ads, true)')).toBeNull();

    // AdGuard CSS injection and its exception, and the `$@$` redirect form. Measured before these
    // guards were added: every line below was already refused here, because a body like
    // `example.com#$#.ad` fails domain validation further down. The guards exist so the refusal is
    // the *reason* rather than a side effect of a check that answers a different question.
    for (const line of [
      'example.com#$#.ad { display: none !important; }',
      'example.com#$#.ad{display:none}',
      'example.com#@$#.ad{display:block}',
      'example.com$@$document',
      '||example.com^$@$redirect=noop.js',
    ]) {
      expect(dnr.parseRule(line)).toBeNull();
    }
  });

  test('rejects a list header, which is not a rule', () => {
    const dnr = new DnrManager();

    // `[Adblock Plus 2.0]` is the first line of the lists this extension parses. It used to be
    // refused downstream as an invalid domain, which is true but incidental — a header is not a
    // rule, and saying so here is what keeps a future header shape out of the rule planner.
    expect(dnr.parseRule('[Adblock Plus 2.0]')).toBeNull();
    expect(dnr.parseRule('[uBlock Origin]')).toBeNull();
  });

  test('keeps absolute-URL rules intact instead of discarding them', async () => {
    const dnr = new DnrManager();

    // Regression: the domain pipeline stripped everything after the first `/`,
    // so a rule like this one was silently dropped and never blocked anything.
    const parsed = dnr.parseRule('|https://cdn.example.com/ads/banner.js?v=2|');
    expect(parsed).not.toBeNull();
    expect(parsed?.isUrlFilter).toBe(true);
    expect(parsed?.pattern).toBe('|https://cdn.example.com/ads/banner.js?v=2|');
    expect(parsed?.priority).toBe(1);

    await dnr.updateDynamicRules(['|https://cdn.example.com/ads/banner.js|']);
    const added = (mockUpdateDynamicRules.mock.calls[0][0] as { addRules: any[] }).addRules;
    const urlRule = added.find((r) => String(r.condition.urlFilter).startsWith('|https://'));
    expect(urlRule).toBeDefined();
    // Not wrapped in the domain form `||…^`, which would also block the host.
    expect(urlRule.condition.urlFilter).toBe('|https://cdn.example.com/ads/banner.js|');
    expect(urlRule.action.type).toBe('block');
  });

  test('rejects malformed absolute-URL rules', () => {
    const dnr = new DnrManager();
    expect(dnr.parseRule('|file:///etc/hosts|')).toBeNull();
    expect(dnr.parseRule('|https://example.com/ has space|')).toBeNull();
    expect(dnr.parseRule(`|https://example.com/${'a'.repeat(400)}|`)).toBeNull();
  });

  test('an allowed domain also exempts exact-URL rules pointed at it', async () => {
    const dnr = new DnrManager();
    await dnr.updateDynamicRules(['|https://tracker.example.com/beacon.js|'], {
      allowedDomains: ['tracker.example.com'],
    });

    const added = (mockUpdateDynamicRules.mock.calls[0][0] as { addRules: any[] }).addRules;
    expect(added.some((r) => String(r.condition.urlFilter).includes('beacon.js'))).toBe(false);
  });

  test('strictly rejects bare public suffixes and reserved hostnames', () => {
    const dnr = new DnrManager();

    // Prevent collateral damage from wildcards on cloud roots or ccTLDs
    expect(dnr.parseRule('||co.uk^')).toBeNull();
    expect(dnr.parseRule('||pages.dev^')).toBeNull();
    expect(dnr.parseRule('||github.io^')).toBeNull();
    expect(dnr.parseRule('||cloudfront.net^')).toBeNull();
    expect(dnr.parseRule('||localhost^')).toBeNull();
  });

  // ── Per-site (initiator) scoping ─────────────────────────────────────────────

  test('expresses $domain= as an initiator scope instead of a whole-zone block', async () => {
    const dnr = new DnrManager();

    const parsed = dnr.parseRule('||ubembed.com^$domain=bulbapedia.bulbagarden.net|brokerdeal.de');
    expect(parsed).not.toBeNull();
    expect(parsed?.pattern).toBe('ubembed.com');
    expect(parsed?.initiatorDomains).toEqual(['brokerdeal.de', 'bulbapedia.bulbagarden.net']);

    await dnr.updateDynamicRules(['||ubembed.com^$domain=brokerdeal.de|bulbapedia.bulbagarden.net']);
    const added = (mockUpdateDynamicRules.mock.calls[0][0] as { addRules: any[] }).addRules;

    // Exactly one rule, scoped to its sites — not a blanket block of the whole zone.
    expect(added).toHaveLength(1);
    expect(added[0].condition.urlFilter).toBe('||ubembed.com^');
    expect(added[0].condition.initiatorDomains).toEqual([
      'brokerdeal.de',
      'bulbapedia.bulbagarden.net',
    ]);
    expect(added[0].action.type).toBe('block');
  });

  test('carries $domain=~ entries as excluded initiator domains', () => {
    const dnr = new DnrManager();
    const parsed = dnr.parseRule('||tracker.example^$domain=news.example|~partner.example');
    expect(parsed?.initiatorDomains).toEqual(['news.example']);
    expect(parsed?.excludedInitiatorDomains).toEqual(['partner.example']);
  });

  test('keeps the path of a path-scoped rule instead of collapsing it to a zone block', async () => {
    const dnr = new DnrManager();

    // Regression: everything after the first `/` used to be discarded, so this became a blanket
    // `||cdn.example.com^` block that would break the site's own resources.
    const parsed = dnr.parseRule('||cdn.example.com/ads/banner.js');
    expect(parsed?.isUrlFilter).toBe(true);
    expect(parsed?.pattern).toBe('||cdn.example.com/ads/banner.js');

    await dnr.updateDynamicRules(['||cdn.example.com/ads/banner.js']);
    const added = (mockUpdateDynamicRules.mock.calls[0][0] as { addRules: any[] }).addRules;
    expect(added[0].condition.urlFilter).toBe('||cdn.example.com/ads/banner.js');
    expect(added[0].condition.initiatorDomains).toBeUndefined();
  });

  test('ships a path-only rule only with the per-site scope that makes it safe', async () => {
    const dnr = new DnrManager();

    // A bare `/pop.js` matches that path on every site, so without a scope it is refused.
    expect(dnr.parseRule('/pop.js')).toBeNull();

    // With its own per-site scope the same rule is safe and is kept.
    expect(dnr.parseRule('/pop.js$domain=booru.example')?.initiatorDomains).toEqual(['booru.example']);

    const parsed = dnr.parseRule('/pop.js$domain=rule34.top|hardsex.cc');
    expect(parsed?.isUrlFilter).toBe(true);
    expect(parsed?.pattern).toBe('/pop.js');
    expect(parsed?.initiatorDomains).toEqual(['hardsex.cc', 'rule34.top']);

    await dnr.updateDynamicRules(['/pop.js$domain=rule34.top|hardsex.cc']);
    const added = (mockUpdateDynamicRules.mock.calls[0][0] as { addRules: any[] }).addRules;
    expect(added[0].condition).toEqual({
      urlFilter: '/pop.js',
      resourceTypes: ['script', 'image', 'xmlhttprequest', 'sub_frame', 'media', 'ping'],
      initiatorDomains: ['hardsex.cc', 'rule34.top'],
    });
  });

  test('refuses a rule whose declared initiator scope cannot be expressed', () => {
    const dnr = new DnrManager();

    // `gmx.*` has no DNR domain equivalent. Applying the rule anyway would carry exactly the
    // global over-block the scope existed to prevent, so it must be dropped, not widened.
    expect(dnr.parseRule('||cdn.staticmoly.me/*.php$domain=vidmoly.*')).toBeNull();
    expect(dnr.parseRule('||x.example^$domain=')).toBeNull();

    // A scope whose only entry cannot be named (an underscore is not a DNR domain) would leave the
    // rule global if the entry were merely dropped.
    expect(dnr.parseRule('||manifest.auditude.com^$domain=~not_for_sdn_filter.com')).toBeNull();

    // A wildcard that *can* be expressed becomes its base domain.
    expect(dnr.parseRule('||x.example^$domain=*.news.example')?.initiatorDomains).toEqual([
      'news.example',
    ]);
  });

  test('folds scoped variants of the same filter into one rule', () => {
    const plan = planListRules([
      '||ubembed.com^$domain=brokerdeal.de',
      '||ubembed.com^$domain=pctipp.ch',
      '||ubembed.com^$domain=computerworld.ch',
    ]);

    // One rule naming three sites, rather than three rules — this is the point of the scope.
    expect(plan.rules).toHaveLength(1);
    expect(plan.rules[0].initiatorDomains).toEqual([
      'brokerdeal.de',
      'computerworld.ch',
      'pctipp.ch',
    ]);
    expect(plan.scoped).toBe(1);
  });

  test('never turns a request- or response-reshaping rule into a plain block', () => {
    expect(parseFilterRule('||tracker.example^$removeparam=utm_source')).toBeNull();
    expect(parseFilterRule('|https://telemetry.example/beacon.js|$redirect=noopjs')).toBeNull();
    expect(parseFilterRule("||ads.example^$csp=script-src 'none'")).toBeNull();
    expect(parseFilterRule('||ads.example^$replace=/ads//')).toBeNull();
  });

  test('scoping raises coverage without raising the rule count', () => {
    const lines = [
      '||ubembed.com^$domain=brokerdeal.de|pctipp.ch',
      '||hprofits.com^$domain=gogaytube.tv',
      '||paywall.folha.uol.com.br/wall.jsonp$domain=folha.uol.com.br',
      '/pop.js$domain=rule34.top',
      '||plain-adserver.com^',
    ];

    const plan = planListRules(lines);

    // One filter line is at most one DNR rule: the scope names many sites without multiplying.
    expect(plan.rules.length).toBe(5);
    expect(plan.scoped).toBe(4);
    expect(plan.overflow).toBe(0);

    // Every scoped rule keeps its own sites, and nothing is emitted globally by accident.
    for (const rule of plan.rules) {
      if (rule.pattern.includes('ubembed')) {
        expect(rule.initiatorDomains).toEqual(['brokerdeal.de', 'pctipp.ch']);
      }
    }
  });

  test('a user allowance still wins over a per-site scoped rule', async () => {
    const dnr = new DnrManager();
    const count = await dnr.updateDynamicRules(
      ['||tracker.example^$domain=news.example', '||ads.example^'],
      { allowedDomains: ['tracker.example'] },
    );

    // The user's allowance itself is emitted as a priority-500 allow rule, and the list's block
    // for that domain is dropped — so only that allow rule and the unrelated block remain.
    expect(count).toBe(2);
    const added = (mockUpdateDynamicRules.mock.calls[0][0] as { addRules: any[] }).addRules;
    expect(added.some((r) => r.action.type === 'block' && String(r.condition.urlFilter).includes('tracker.example'))).toBe(false);
    const allow = added.find((r) => String(r.condition.urlFilter).includes('tracker.example'));
    expect(allow?.action.type).toBe('allow');
    expect(allow?.priority).toBe(500);
  });
});
