import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import {
  DnrManager,
  customRulesAreInstalled,
  installedRuleKey,
  parseFilterRule,
  planListRules,
  planSiteControlRules,
  plannedRuleKey,
  ruleFamily,
  userDecisionsAreInstalled,
  type InstalledRuleFamilies,
  type PlannedRule,
} from '../background/dnrManager.js';
import { PRIORITY_SITE_PAUSE, PRIORITY_USER_ALLOW } from '../shared/constants.js';

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

// ── Reading the browser's rules instead of assuming them ───────────────────────────────────────

/** A dynamic rule as Chrome reports it, with only the fields the manager compares. */
function installedRule(
  id: number,
  options: {
    priority?: number;
    actionType?: string;
    urlFilter?: string;
    resourceTypes?: string[];
    initiatorDomains?: string[];
  } = {},
): any {
  return {
    id,
    priority: options.priority ?? 1,
    action: { type: options.actionType ?? 'block' },
    condition: {
      urlFilter: options.urlFilter ?? `||listed-${id}.example^`,
      resourceTypes: options.resourceTypes ?? ['script'],
      ...(options.initiatorDomains ? { initiatorDomains: options.initiatorDomains } : {}),
    },
  };
}

/** The browser's shape, built from a rule this extension planned. */
function asInstalled(rule: PlannedRule, id: number): any {
  return {
    id,
    priority: rule.priority,
    action: { type: rule.action },
    condition: { urlFilter: rule.pattern, resourceTypes: [...rule.resourceTypes] },
  };
}

/** Installs a stub whose dynamic rules are the ones the test says the browser holds. */
function installInstalledRules(rules: any[], maxDynamic = 30000) {
  const getDynamicRules = (jest.fn() as any).mockResolvedValue(rules);
  const updateDynamicRules = (jest.fn() as any).mockResolvedValue(undefined);
  (globalThis as any).chrome = {
    declarativeNetRequest: {
      MAX_NUMBER_OF_DYNAMIC_AND_MATCHED_RULES: maxDynamic,
      RuleActionType: { BLOCK: 'block', ALLOW: 'allow' },
      getDynamicRules,
      updateDynamicRules,
    },
  };
  return { getDynamicRules, updateDynamicRules };
}

describe('DnrManager reading the installed rules', () => {
  test('splits the browser’s rules by the family that installed them', async () => {
    installInstalledRules([
      installedRule(1, { priority: 1 }),
      installedRule(2, { priority: PRIORITY_USER_ALLOW, actionType: 'allow' }),
      installedRule(3, { priority: PRIORITY_SITE_PAUSE, actionType: 'allowAllRequests' }),
      // A rule with no priority at all cannot have come from the user's decisions, which always
      // carry one; reading it as list-derived keeps it out of the family the user's are replaced in.
      installedRule(4, { priority: undefined }),
    ]);

    const families = await new DnrManager().installedFamilies();
    expect(families).not.toBeNull();
    expect(families!.list.map((rule) => rule.id)).toEqual([1, 4]);
    expect(families!.user.map((rule) => rule.id)).toEqual([2, 3]);
  });

  test('returns no reading rather than an empty rule set when the browser will not answer', async () => {
    // "No rules" and "no reading" lead to opposite decisions, so they are not the same value.
    installInstalledRules([]);
    (globalThis as any).chrome.declarativeNetRequest.getDynamicRules = (jest.fn() as any).mockRejectedValue(
      new Error('boom'),
    );
    await expect(new DnrManager().installedFamilies()).resolves.toBeNull();
  });

  test('classifies a rule by priority, which is what the families are separated by', () => {
    expect(ruleFamily(undefined)).toBe('list');
    expect(ruleFamily(1)).toBe('list');
    expect(ruleFamily(PRIORITY_USER_ALLOW - 1)).toBe('list');
    expect(ruleFamily(PRIORITY_USER_ALLOW)).toBe('user');
    expect(ruleFamily(PRIORITY_SITE_PAUSE)).toBe('user');
  });
});

describe('DnrManager against the user’s own decisions', () => {
  const control = { pausedSites: ['news.example'], allowedDomains: ['cdn.example'] };
  const familiesOf = (rules: any[]): InstalledRuleFamilies => {
    const families: InstalledRuleFamilies = { user: [], list: [] };
    for (const rule of rules) families[ruleFamily(rule.priority)].push(rule);
    return families;
  };

  test('recognises its own decisions once the browser is holding them', () => {
    // The round trip, taken through both directions of the comparison: what the extension would
    // install, encoded the way Chrome reports it, has to read back as installed.
    const planned = planSiteControlRules(control);
    expect(planned.length).toBe(2);

    const installed = familiesOf(planned.map((rule, index) => asInstalled(rule, index + 1)));
    expect(userDecisionsAreInstalled(installed, control)).toBe(true);
  });

  test('sees a decision that never reached the browser', () => {
    // A pause whose apply threw: storage holds it, the browser does not. This is the case the
    // startup reconcile exists for, and it has to be a difference in this direction or the popup
    // keeps reporting a pause that is not pausing.
    const planned = planSiteControlRules(control);
    const installed = familiesOf(planned.slice(0, 1).map((rule, index) => asInstalled(rule, index + 1)));

    expect(userDecisionsAreInstalled(installed, control)).toBe(false);
    expect(userDecisionsAreInstalled(familiesOf([]), control)).toBe(false);
  });

  test('sees a rule the user has since withdrawn', () => {
    // The other direction, which is the more expensive one to be wrong in: a rule still installed
    // that no decision asks for is blocking something the user allowed.
    const stale = planSiteControlRules({ allowedDomains: ['old.example'] }).map((rule) => asInstalled(rule, 1));
    expect(userDecisionsAreInstalled(familiesOf(stale), control)).toBe(false);
    expect(userDecisionsAreInstalled(familiesOf(stale), { allowedDomains: ['old.example'] })).toBe(true);
  });

  test('treats a global pause as the absence of rules, which is what it installs', () => {
    expect(userDecisionsAreInstalled(familiesOf([]), { globalPaused: true })).toBe(true);
    const stillPausing = planSiteControlRules({ pausedSites: ['news.example'] }).map((rule) => asInstalled(rule, 1));
    expect(userDecisionsAreInstalled(familiesOf(stillPausing), { globalPaused: true })).toBe(false);
  });

  test('compares rules rather than counts, so a swap is not mistaken for agreement', () => {
    const one = planSiteControlRules({ allowedDomains: ['a.example'] }).map((rule) => asInstalled(rule, 1));
    expect(userDecisionsAreInstalled(familiesOf(one), { allowedDomains: ['b.example'] })).toBe(false);
  });
});

describe('DnrManager against the user’s custom rules', () => {
  // A custom rule is compiled by the list planner, so it lands in the *list* family where nothing
  // looks at priorities. It still has to be checked against the browser, because a rule the user
  // saved by hand and an apply that threw is a decision that silently never happened.
  const familiesWith = (filters: string[]): InstalledRuleFamilies => ({
    user: [],
    list: filters.map((filter, index) => ({ ...installedRule(index + 1, { urlFilter: filter }) })),
  });

  test('recognises a saved rule that is installed', () => {
    expect(customRulesAreInstalled(familiesWith(['||saved.example^']), ['||saved.example^'])).toBe(true);
  });

  test('sees a saved rule the browser never got', () => {
    expect(customRulesAreInstalled(familiesWith(['||other.example^']), ['||saved.example^'])).toBe(false);
    expect(customRulesAreInstalled(familiesWith([]), ['||saved.example^'])).toBe(false);
  });

  test('asks for nothing when the user has saved nothing', () => {
    expect(customRulesAreInstalled(familiesWith([]), [])).toBe(true);
  });

  test('does not demand a rule the planner refuses, which could never be installed', () => {
    // A check that can never be satisfied is a repair loop, not a reconcile.
    expect(customRulesAreInstalled(familiesWith([]), ['||co.uk^', '! a comment'])).toBe(true);
  });

  test('matches on the filter, so a merged or bounded install still counts', () => {
    // Two saved lines that the planner folds into one rule still leave their filter installed.
    const saved = ['||same.example^$domain=a.example', '||same.example^$domain=b.example'];
    expect(customRulesAreInstalled(familiesWith(['||same.example^']), saved)).toBe(true);
  });

  test('does not ask for a saved rule the user has since allowed the domain of', () => {
    // The planner suppresses it on purpose, so its absence is the decision working. Reading that as
    // a missing rule would be a repair that runs on every worker start and never converges.
    const saved = ['||tracker.example^'];
    expect(customRulesAreInstalled(familiesWith([]), saved, { allowedDomains: ['tracker.example'] })).toBe(true);
    // Without the allowance the same absence is a rule that never landed.
    expect(customRulesAreInstalled(familiesWith([]), saved)).toBe(false);
  });

  test('asks for nothing at all while blocking is paused everywhere', () => {
    expect(customRulesAreInstalled(familiesWith([]), ['||saved.example^'], { globalPaused: true })).toBe(true);
  });
});

describe('DnrManager preserving the installed list', () => {
  test('leaves the blocklist alone when the caller has no list to replace it with', async () => {
    // The failure this guards: a worker that has not fetched yet holds no lines, and rebuilding the
    // dynamic rules from an empty list clears every blocking rule the extension has. A site pause
    // must never cost the blocklist.
    const stub = installInstalledRules([installedRule(3, { priority: 1, urlFilter: '||blocked.example^' })]);

    const count = await new DnrManager().updateDynamicRules(
      [],
      { pausedSites: ['news.example'] },
      { replaceInstalledList: false },
    );

    const call = stub.updateDynamicRules.mock.calls[0][0] as { removeRuleIds: number[]; addRules: any[] };
    expect(call.removeRuleIds).toEqual([]);
    expect(call.addRules.map((rule) => rule.condition.urlFilter)).toEqual(['||news.example^']);
    // The installed rule is still there, so the count reports the browser's total rather than what
    // this call added.
    expect(count).toBe(2);
  });

  test('still replaces the rules its own lines produce, so a custom rule is not installed twice', async () => {
    const stub = installInstalledRules([
      installedRule(3, { priority: 1, urlFilter: '||tracker.example^' }),
      installedRule(4, { priority: 1, urlFilter: '||other.example^' }),
    ]);

    const count = await new DnrManager().updateDynamicRules(
      ['||tracker.example^'],
      {},
      { replaceInstalledList: false },
    );

    const call = stub.updateDynamicRules.mock.calls[0][0] as { removeRuleIds: number[]; addRules: any[] };
    // Only the rule this call's own line produced is retired; the rest of the list family stays.
    expect(call.removeRuleIds).toEqual([3]);
    expect(call.addRules.map((rule) => rule.condition.urlFilter)).toEqual(['||tracker.example^']);
    expect(count).toBe(2);
  });

  test('replaces the user’s decisions in both directions, and only those', async () => {
    const stub = installInstalledRules([
      installedRule(2, { priority: 1, urlFilter: '||blocked.example^' }),
      installedRule(9, { priority: PRIORITY_SITE_PAUSE, actionType: 'allowAllRequests', urlFilter: '||old.example^' }),
    ]);

    await new DnrManager().updateDynamicRules(
      [],
      { pausedSites: ['new.example'] },
      { replaceInstalledList: false },
    );

    const call = stub.updateDynamicRules.mock.calls[0][0] as { removeRuleIds: number[]; addRules: any[] };
    // The stale pause goes, the blocklist does not, and the new pause arrives.
    expect(call.removeRuleIds).toEqual([9]);
    expect(call.addRules.map((rule) => rule.condition.urlFilter)).toEqual(['||new.example^']);
  });

  test('allocates new ids above whatever it kept, so a preserved rule cannot be overwritten', async () => {
    const stub = installInstalledRules([
      installedRule(7, { priority: 1, urlFilter: '||blocked.example^' }),
      installedRule(9, { priority: PRIORITY_USER_ALLOW, actionType: 'allow', urlFilter: '||old.example^' }),
    ]);

    await new DnrManager().updateDynamicRules(
      [],
      { allowedDomains: ['new.example'] },
      { replaceInstalledList: false },
    );

    const call = stub.updateDynamicRules.mock.calls[0][0] as { addRules: any[] };
    expect(call.addRules.map((rule) => rule.id)).toEqual([8]);
  });

  test('keeps the rule set inside the watermark it preserved rules against', async () => {
    // The kept rules are counted against the budget, not on top of it: preserving 400 rules and
    // planning a full budget of new ones would be how the extension exceeds a quota it thought it
    // was inside.
    const kept = Array.from({ length: 400 }, (_, index) =>
      installedRule(index + 1, { priority: 1, urlFilter: `||kept-${index}.example^` }),
    );
    installInstalledRules(kept, 1000);
    const lines = Array.from({ length: 1000 }, (_, index) => `||host-${index}.example^`);

    const count = await new DnrManager().updateDynamicRules(lines, {}, { replaceInstalledList: false });

    // quotaCap is 1,000 here (the floor of the available quota), so 400 kept leaves 600 to install.
    expect(count).toBeLessThanOrEqual(1000);
    expect(count).toBe(kept.length + 600);
  });

  test('clears both families when the user pauses everywhere, even while preserving', async () => {
    // The pause promises that nothing is blocked, and it has to be able to say so for the list rules
    // too — a preserving call that kept them would leave the browser blocking under a "Paused" UI.
    const stub = installInstalledRules([
      installedRule(3, { priority: 1 }),
      installedRule(9, { priority: PRIORITY_SITE_PAUSE, actionType: 'allowAllRequests' }),
    ]);

    const count = await new DnrManager().updateDynamicRules([], { globalPaused: true }, { replaceInstalledList: false });

    const call = stub.updateDynamicRules.mock.calls[0][0] as { removeRuleIds: number[]; addRules: any[] };
    expect([...call.removeRuleIds].sort()).toEqual([3, 9]);
    expect(call.addRules).toEqual([]);
    expect(count).toBe(0);
  });

  test('replaces both families by default, which is what a sync asks for', async () => {
    const stub = installInstalledRules([
      installedRule(3, { priority: 1 }),
      installedRule(9, { priority: PRIORITY_SITE_PAUSE, actionType: 'allowAllRequests' }),
    ]);

    await new DnrManager().updateDynamicRules(['||fresh.example^'], { pausedSites: ['news.example'] });

    const call = stub.updateDynamicRules.mock.calls[0][0] as { removeRuleIds: number[] };
    expect([...call.removeRuleIds].sort()).toEqual([3, 9]);
  });

  test('agrees with itself about a rule after a round trip through the browser', async () => {
    // A rule the extension installs and then reads back has to key the same, or the startup
    // reconcile would re-install a working decision on every worker start.
    const stub = installInstalledRules([]);
    const planned = planSiteControlRules({ pausedSites: ['news.example'] })[0];

    await new DnrManager().updateDynamicRules([], { pausedSites: ['news.example'] }, { replaceInstalledList: false });
    const added = (stub.updateDynamicRules.mock.calls[0][0] as { addRules: any[] }).addRules[0];

    expect(installedRuleKey(added)).toBe(plannedRuleKey(planned));
  });
});
