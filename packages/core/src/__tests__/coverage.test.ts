import { describe, test, expect } from '@jest/globals';
import {
  COVERAGE_SHARES,
  analyzeRuleCoverage,
  blockingRuleScope,
  countNetworkRules,
  countRuleScopes,
  formatCoverageReport,
  formatHotList,
  isContextScopedRule,
  isNetworkRule,
  minimumRulesForShare,
  selectHotList,
} from '../coverage.js';

describe('network rule classification', () => {
  test('keeps the rules that can match a request', () => {
    for (const rule of [
      '||doubleclick.net^',
      '@@||safe.example.com^',
      '||ads.example.com^$important',
      '||tracker.io^$third-party',
      '|https://cdn.example.com/ads/banner.js|',
      '0.0.0.0 telemetry.example.com',
      '127.0.0.1 tracker.example.com',
    ]) {
      expect(isNetworkRule(rule)).toBe(true);
    }
  });

  test('drops comments, cosmetic rules, scriptlets, and DNS-only directives', () => {
    for (const rule of [
      '! Title: EasyList',
      '# hosts comment',
      '[Adblock Plus 2.0]',
      '   ',
      '',
      'example.com##.ad-banner',
      '##div[class*="ad-slot"]',
      'example.com#@#.sponsor',
      'example.com#?#div:has(> img.ad)',
      'example.com#%#//scriptlet("abort-on-property-read", "adblock")',
      'example.com##+js(set, ads, true)',
      // AdGuard CSS injection is cosmetic too: a content script applies it to the DOM.
      'example.com#$#body { overflow: auto !important; }',
      'example.com#@$#.mnd-cookie-modal { display: none; }',
      '||example.com^$dnsrewrite=1.2.3.4',
      '||example.com^$dnstype=AAAA',
      '||example.com^$client=192.168.1.10',
    ]) {
      expect(isNetworkRule(rule)).toBe(false);
    }
  });

  test('counts only the network rules in a mixed list', () => {
    const lines = [
      '! header comment',
      '||a.com^',
      'example.com##.ad',
      'b.com#@#.sponsor',
      '||b.com^',
      '@@||c.com^',
      '||d.com^$dnstype=A',
    ];
    expect(countNetworkRules(lines)).toBe(3);
  });
});

describe('context-scoped rule detection', () => {
  test('flags rules whose match depends on more than a hostname', () => {
    // A hostname-only replay reads each of these as a blanket zone block.
    expect(isContextScopedRule('||google.com^*/friendconnect.js')).toBe(true);
    expect(isContextScopedRule('||ads.example.com^$third-party')).toBe(true);
    expect(isContextScopedRule('||a.example^$script,domain=b.example')).toBe(true);
    expect(isContextScopedRule('/banner\\d+/')).toBe(true);
  });

  test('leaves pure hostname rules alone', () => {
    expect(isContextScopedRule('||doubleclick.net^')).toBe(false);
    expect(isContextScopedRule('@@||safe.example.com^')).toBe(false);
    // `$important` only changes precedence, so the rule is still a plain host block.
    expect(isContextScopedRule('||critical.example^$important')).toBe(false);
    expect(isContextScopedRule('*.amazon-adsystem.com')).toBe(false);
    expect(isContextScopedRule('0.0.0.0 telemetry.example.com')).toBe(false);
    expect(isContextScopedRule('')).toBe(false);
  });
});

describe('blocking rule scopes', () => {
  test('reads a blanket host rule as hostname-decidable', () => {
    for (const rule of [
      '||doubleclick.net^',
      // `$important` only changes precedence, and `$denyallow` narrows rather than contextualises.
      '||critical.example^$important',
      '||host.example^$denyallow=cdn.example',
      '*.amazon-adsystem.com',
      '0.0.0.0 telemetry.example.com',
      '127.0.0.1 tracker.example.com',
      'https://plain.example',
    ]) {
      expect(`${rule}:${blockingRuleScope(rule)}`).toBe(`${rule}:hostname`);
    }
  });

  test('reads an initiator scope as needing the requesting page', () => {
    for (const rule of [
      '||ubembed.com^$domain=brokerdeal.de|pctipp.ch',
      '||ads.example.com^$third-party',
      '||x.example^$from=news.example',
      '||x.example^$to=cdn.example',
      '||x.example^$~first-party',
      // Hostless and initiator-scoped at once: the site decides it before the URL is consulted.
      '/pop.js$domain=booru.example',
    ]) {
      expect(`${rule}:${blockingRuleScope(rule)}`).toBe(`${rule}:initiator`);
    }
  });

  test('reads a kept path as path-scoped', () => {
    for (const rule of [
      '||cdn.example.com^*/ads.js',
      '||cdn.example.com/ads/banner.js',
      '||x.example^$path=/ads/',
      '/banner\\d+/',
    ]) {
      expect(`${rule}:${blockingRuleScope(rule)}`).toBe(`${rule}:path`);
    }
  });

  test('reads a request type or a response rewrite as request-scoped', () => {
    for (const rule of [
      '||popups.example^$popup',
      '||pushpad.xyz^$3p',
      '||x.example^$script,important',
      '||x.example^$replace=/"adSlots"/"no_ads"/',
    ]) {
      expect(`${rule}:${blockingRuleScope(rule)}`).toBe(`${rule}:request`);
    }
  });

  test('returns null for anything that is not a blocking network rule', () => {
    for (const rule of [
      '',
      '! a comment',
      'example.com##.ad-banner',
      'example.com#$#body { overflow: auto !important; }',
      'example.com#@$#.sponsor { display: none; }',
      'example.com#%#//scriptlet("abort-on-property-read", "adblock")',
      '@@||safe.example.com^',
      // An exception that keeps a path is still not a block, so it has no blocking scope.
      '@@||safe.example.com^*/path.js',
      '||example.com^$dnsrewrite=1.2.3.4',
      '||example.com^$badfilter',
    ]) {
      expect(`${rule}:${blockingRuleScope(rule)}`).toBe(`${rule}:null`);
    }
  });

  test('counts a list by scope, exceptions and cosmetics excluded', () => {
    const lines = [
      '! header',
      '||a.com^',
      '||b.com^$important',
      '||c.com^$domain=x.example',
      '||d.com^*/ads.js',
      '||e.com^$popup',
      'example.com##.ad',
      '@@||f.com^',
      '||g.com^$dnstype=A',
    ];
    expect(countRuleScopes(lines)).toEqual({
      hostname: 2,
      initiator: 1,
      path: 1,
      request: 1,
      total: 5,
    });
  });
});

describe('hot list selection', () => {
  const lines = [
    '! a comment',
    '||doubleclick.net^',
    '||adnxs.com^',
    '||cdn.example.com^*/ads.js',
    '||tail.example^',
    '||unfired.example^',
    '@@||safe.example.com^',
    'example.com##.ad',
  ];
  const hits = [
    { rule: '||doubleclick.net^', count: 60 },
    { rule: '||adnxs.com^', count: 30 },
    { rule: '||cdn.example.com^*/ads.js', count: 10 },
    { rule: '||tail.example^', count: 1 },
  ];

  test('keeps the rules that carry the measured blocks, hottest first', () => {
    const selection = selectHotList({ lines, hits });
    expect(selection.lines).toEqual([
      '||doubleclick.net^',
      '||adnxs.com^',
      '||cdn.example.com^*/ads.js',
      '||tail.example^',
    ]);
    expect(selection.coverage).toBe(1);
    expect(selection.coveredRequests).toBe(101);
    expect(selection.totalRequests).toBe(101);
    expect(selection.dropped).toEqual([]);
    // What is given up: the blocking rules the measurement never exercised.
    expect(selection.unfiredRules).toBe(1);
    expect(selection.sourceLines).toBe(8);
    // And what the head is made of, by the scope each rule needs.
    expect(selection.scopes).toEqual({ hostname: 3, initiator: 0, path: 1, request: 0, total: 4 });
  });

  test('drops the smallest carrier when the share allows it, and names it', () => {
    const selection = selectHotList({ lines, hits, share: 0.99 });
    // 60 + 30 + 10 = 100 of 101 reaches 99%, so the one-request tail is the rule to cut.
    expect(selection.lines).toEqual([
      '||doubleclick.net^',
      '||adnxs.com^',
      '||cdn.example.com^*/ads.js',
    ]);
    expect(selection.coverage).toBe(0.9901);
    expect(selection.dropped).toEqual([{ rule: '||tail.example^', count: 1, share: 0.0099 }]);
  });

  test('keeps fired exceptions, so the trimmed list makes the same allow decisions', () => {
    const selection = selectHotList({
      lines,
      hits,
      exceptions: ['@@||safe.example.com^', '@@||not-in-the-list^'],
    });
    // Only lines the source list carries can be shipped; a stale ledger cannot invent one.
    expect(selection.keptExceptions).toEqual(['@@||safe.example.com^']);
    expect(selection.lines).toContain('@@||safe.example.com^');
  });

  test('cannot ship a rule the source list does not carry', () => {
    const selection = selectHotList({
      lines,
      hits: [...hits, { rule: '||absent.example^', count: 50 }],
    });
    expect(selection.lines).not.toContain('||absent.example^');
    // And the requests it claimed do not count as covered, so the coverage it reports stays honest.
    expect(selection.coveredRequests).toBe(101);
    expect(selection.totalRequests).toBe(151);
    expect(selection.coverage).toBe(0.6689);
  });

  test('renders a header that states the trade and reads back as a plain list', () => {
    const build = () =>
      formatHotList(selectHotList({ lines, hits, exceptions: ['@@||safe.example.com^'] }), {
        source: 'list.txt',
        measuredOn: 'trace.txt (232 requests)',
      });
    const text = build();

    expect(text.startsWith('! Blockingmachine hot set')).toBe(true);
    expect(text).toContain('! Source:          list.txt (8 lines)');
    expect(text).toContain('! Measured on:     trace.txt (232 requests)');
    expect(text).toContain('! Coverage:        101 of 101 measured blocks (100.0%)');
    expect(text).toContain('! Exceptions kept: 1,');
    expect(text).toContain('! Left behind:     1 blocking rule');
    // The header has to say what the measurement is, not just what it cost: a sample whose count is
    // a floor, taken over attempted requests.
    expect(text).toContain('Read the rule count as a floor, not a fixed size');
    expect(text).toContain('records requests as *attempted*');
    // The header is inert: what a consumer reads back is exactly the selected rules.
    const shipped = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('!'));
    expect(shipped).toEqual([
      '||doubleclick.net^',
      '||adnxs.com^',
      '||cdn.example.com^*/ads.js',
      '||tail.example^',
      '@@||safe.example.com^',
    ]);
    expect(countRuleScopes(shipped)).toEqual({ hostname: 3, initiator: 0, path: 1, request: 0, total: 4 });
    // Deterministic, so `--check` can diff it.
    expect(build()).toBe(text);
  });
});

describe('minimum rules for a share', () => {
  test('is zero for an empty or all-zero trace', () => {
    expect(minimumRulesForShare([], 0.99)).toBe(0);
    expect(minimumRulesForShare([0, 0], 0.99)).toBe(0);
    expect(minimumRulesForShare([5, 5], 0)).toBe(0);
  });

  test('needs every rule when the counts are uniform', () => {
    const counts = Array.from({ length: 100 }, () => 1);
    // 50 of 100 is exactly 50%, so the boundary sits on the share itself.
    expect(minimumRulesForShare(counts, 0.5)).toBe(50);
    expect(minimumRulesForShare(counts, 0.99)).toBe(99);
    expect(minimumRulesForShare(counts, 1)).toBe(100);
  });

  test('collapses to a single rule when one rule holds the share', () => {
    // 990 of 999 matched requests come from one rule.
    expect(minimumRulesForShare([990, ...Array(9).fill(1)], 0.99)).toBe(1);
    // Add one more tail rule and 990/1000 is exactly 99%, so one rule still suffices.
    expect(minimumRulesForShare([990, ...Array(10).fill(1)], 0.99)).toBe(1);
  });

  test('counts the rule that crosses the threshold in full', () => {
    // Total 100: 60 + 39 = 99% only at the second rule; the first alone is 60%.
    expect(minimumRulesForShare([60, 39, 1], 0.99)).toBe(2);
    expect(minimumRulesForShare([60, 39, 1], 0.6)).toBe(1);
  });
});

describe('rule coverage analysis', () => {
  const hits = [
    { rule: '||doubleclick.net^', count: 400 },
    { rule: '||googlesyndication.com^', count: 300 },
    { rule: '||scorecardresearch.com^', count: 200 },
    ...Array.from({ length: 97 }, (_, i) => ({ rule: `||long-tail-${i}.example^`, count: 1 })),
  ];

  test('measures how much of the list ever fires', () => {
    const report = analyzeRuleCoverage({ totalRules: 100000, hits });
    expect(report.matchedRules).toBe(100);
    expect(report.neverMatchedRules).toBe(99900);
    expect(report.listHitRatePercent).toBeCloseTo(0.1, 4);
    expect(report.deadWeightPercent).toBeCloseTo(99.9, 4);
    expect(report.blockedRequests).toBe(400 + 300 + 200 + 97);
  });

  test('reports the small head that carries almost all the blocking', () => {
    const report = analyzeRuleCoverage({ totalRules: 100000, hits });
    // 900 of 997 come from three rules — 90% for three rules out of a hundred thousand.
    const head90 = report.minimumRules.find((point) => point.share === 0.9)!;
    expect(head90.rules).toBe(3);
    expect(head90.rulesPercent).toBeCloseTo(0.003, 4);

    // 997 matched requests, so 99% is 987.03: the three big rules give 900, and it takes 88 of
    // the tail to cross 987 — 91 rules, not the 100 that fired.
    const head99 = report.minimumRules.find((point) => point.share === 0.99)!;
    expect(head99.rules).toBe(91);
  });

  test('covering 100% of blocks needs only the rules that fired, not the whole list', () => {
    const report = analyzeRuleCoverage({ totalRules: 100000, hits });
    const all = report.curve.find((point) => point.share === 1)!;
    expect(all.rules).toBe(100);
    expect(all.rulesPercent).toBeCloseTo(0.1, 4);
  });

  test('reports every share in ascending order', () => {
    const report = analyzeRuleCoverage({ totalRules: 1000, hits });
    expect(report.curve.map((point) => point.share)).toEqual([...COVERAGE_SHARES]);
    expect(report.minimumRules.every((point) => point.share < 1)).toBe(true);
  });

  test('merges duplicate hits and ignores non-positive counts', () => {
    const report = analyzeRuleCoverage({
      totalRules: 10,
      hits: [
        { rule: '||a.com^', count: 2 },
        { rule: '||a.com^', count: 3 },
        { rule: '||b.com^', count: 0 },
        { rule: '||c.com^', count: -5 },
        { rule: '||d.com^', count: 1 },
      ],
    });
    expect(report.matchedRules).toBe(2);
    expect(report.blockedRequests).toBe(6);
    expect(report.topRules[0]).toMatchObject({ rule: '||a.com^', count: 5 });
  });

  test('never reports a hit rate above 100% when the list size is stale', () => {
    // A caller passing a truncated list size must not be able to claim 100%+ coverage.
    const report = analyzeRuleCoverage({
      totalRules: 2,
      hits: [
        { rule: '||a.com^', count: 1 },
        { rule: '||b.com^', count: 1 },
        { rule: '||c.com^', count: 1 },
      ],
    });
    expect(report.totalRules).toBe(3);
    expect(report.listHitRatePercent).toBe(100);
    expect(report.neverMatchedRules).toBe(0);
  });

  test('handles an empty trace without dividing by zero', () => {
    const report = analyzeRuleCoverage({ totalRules: 500, hits: [] });
    expect(report.matchedRules).toBe(0);
    expect(report.blockedRequests).toBe(0);
    expect(report.listHitRatePercent).toBe(0);
    expect(report.deadWeightPercent).toBe(100);
    expect(report.topRules).toEqual([]);
    expect(report.curve.every((point) => point.rules === 0)).toBe(true);
  });

  test('tops the list with cumulative shares that reach 100%', () => {
    const report = analyzeRuleCoverage({ totalRules: 100, hits, topLimit: 3 });
    expect(report.topRules).toHaveLength(3);
    expect(report.topRules[0].share).toBeCloseTo(400 / 997, 4);
    expect(report.topRules[2].cumulativeShare).toBeCloseTo(900 / 997, 4);
  });
});

describe('coverage report formatting', () => {
  test('states the hit rate, the dead weight, and the 95%/99% heads', () => {
    const report = analyzeRuleCoverage({
      totalRules: 250000,
      hits: [
        { rule: '||doubleclick.net^', count: 5000 },
        ...Array.from({ length: 500 }, (_, i) => ({ rule: `||r-${i}.example^`, count: 10 })),
      ],
    });
    const text = formatCoverageReport(report).join('\n');

    expect(text).toContain('501 of 250,000 network rules matched');
    expect(text).toContain('never fired');
    expect(text).toMatch(/rules cover 95% of blocks/);
    expect(text).toMatch(/cover 99%/);
    expect(text).toContain('Coverage curve');
    expect(text).toContain('Hottest rules');
    expect(text).toContain('||doubleclick.net^');
  });
});
