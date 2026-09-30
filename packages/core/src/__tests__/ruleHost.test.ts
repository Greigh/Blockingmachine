/**
 * The host extractor and the category attribution the hub now writes.
 *
 * Two failures are worth a test each, and they are opposite in direction:
 *
 *  - **Attribution that is too coarse.** A host listed by three publishers must come back with
 *    three categories. Reducing it to one here would throw away the only information that makes
 *    the attribution worth having, and the consumer could not tell a host that was *only* filed
 *    as an ad from one that was filed as an ad and two tracking lists.
 *  - **Attribution that is too confident.** A line the extractor cannot turn into a host — an
 *    `@@` allowlist entry, a cosmetic rule, a `##.` selector, a public suffix — must contribute
 *    nothing at all. The project's own `unbreak` module is entirely allowlist rules, so a
 *    regression that let exceptions through would attribute an entire category to a tier on the
 *    strength of rules that *permit* traffic.
 */

import { describe, expect, test } from '@jest/globals';
import {
  extractHostFromRule,
  buildCategoryAttribution,
  toCategoryBlocklist,
  toAttributionManifest,
} from '../ruleHost.js';

describe('extractHostFromRule', () => {
  test('reads every shape the hub emits', () => {
    expect(extractHostFromRule('||ads.example.com^')).toBe('ads.example.com');
    expect(extractHostFromRule('0.0.0.0 ads.example.com')).toBe('ads.example.com');
    expect(extractHostFromRule('address=/ads.example.com/0.0.0.0')).toBe('ads.example.com');
    expect(extractHostFromRule('local-zone: "ads.example.com"')).toBe('ads.example.com');
    expect(extractHostFromRule('||ads.example.com^$third-party')).toBe('ads.example.com');
    expect(extractHostFromRule('  ||Ads.Example.COM^  ')).toBe('ads.example.com');
  });

  test('refuses everything a static tier rule cannot express', () => {
    // An exception permits traffic; shipping it as a block rule would invert it.
    expect(extractHostFromRule('@@||ads.example.com^')).toBeNull();
    expect(extractHostFromRule('example.com##.ad')).toBeNull();
    expect(extractHostFromRule('example.com#@#.ad')).toBeNull();
    expect(extractHostFromRule('! Title: a list')).toBeNull();
    expect(extractHostFromRule('[Adblock Plus 2.0]')).toBeNull();
    // A wildcard cannot be written as a domain-form zone block.
    expect(extractHostFromRule('||*.example.com^')).toBeNull();
    // Request-type and DNS-rewriting directives describe something a zone block is not.
    expect(extractHostFromRule('||a.example.com^$dnsrewrite=1.2.3.4')).toBeNull();
    expect(extractHostFromRule('||a.example.com^$badfilter')).toBeNull();
    // Not hosts a user would want blocked.
    expect(extractHostFromRule('127.0.0.1 localhost')).toBeNull();
    expect(extractHostFromRule('0.0.0.0 localhost')).toBeNull();
    expect(extractHostFromRule('1.2.3.4')).toBeNull();
    expect(extractHostFromRule('com')).toBeNull();
    expect(extractHostFromRule('')).toBeNull();
    expect(extractHostFromRule(null)).toBeNull();
  });

  test('is total on junk without throwing', () => {
    for (const junk of ['||^', '||...^', '||..^', '|||', '@@', '#', '||' + 'a'.repeat(300) + '.com^']) {
      expect(() => extractHostFromRule(junk)).not.toThrow();
    }
  });
});

describe('buildCategoryAttribution', () => {
  const rules = (lines: string[]) => lines.map((raw) => ({ raw }));

  test('attributes a host to every category that claimed it', () => {
    const attribution = buildCategoryAttribution([
      { category: 'ads', rules: rules(['||tracker.example^', '||only-ads.example^']) },
      { category: 'privacy', rules: rules(['||tracker.example^', '||only-privacy.example^']) },
    ]);

    // The whole point: two publishers, one host, both answers kept.
    expect([...(attribution.hosts.get('tracker.example') ?? [])].sort()).toEqual([
      'ads',
      'privacy',
    ]);
    expect([...(attribution.hosts.get('only-ads.example') ?? [])]).toEqual(['ads']);
    expect(attribution.hosts.size).toBe(3);
    expect(attribution.contested).toBe(1);

    // The inverse is the file layout, and it must agree with the forward map.
    expect(attribution.byCategory.get('ads')).toEqual(new Set(['tracker.example', 'only-ads.example']));
    expect(attribution.byCategory.get('privacy')).toEqual(
      new Set(['tracker.example', 'only-privacy.example']),
    );
  });

  test('counts a host six lists claimed once, not six times', () => {
    const attribution = buildCategoryAttribution(
      ['ads', 'privacy', 'social', 'annoyances', 'ads', 'privacy'].map((category) => ({
        category,
        rules: rules(['||popular.example^']),
      })),
    );
    expect(attribution.hosts.size).toBe(1);
    expect(attribution.byCategory.get('ads')?.size).toBe(1);
    // Four distinct categories, so the host is contested exactly once.
    expect(attribution.contested).toBe(1);
    expect([...(attribution.hosts.get('popular.example') ?? [])].sort()).toEqual([
      'ads',
      'annoyances',
      'privacy',
      'social',
    ]);
  });

  test('a category of pure allowlist rules attributes nothing', () => {
    // The project's own unbreak module: 41 rules, every one an exception or a cosmetic.
    const attribution = buildCategoryAttribution([
      { category: 'unbreak', rules: rules(['@@||a.example^', '@@||b.example^', 'x.com##.ad']) },
      { category: 'ads', rules: rules(['||c.example^']) },
    ]);

    expect(attribution.byCategory.get('unbreak')?.size ?? 0).toBe(0);
    expect(attribution.unusableRules).toBe(3);
    expect(attribution.hosts.size).toBe(1);
    // A category with nothing blockable is reported as empty rather than as a missing file.
    expect(toAttributionManifest(attribution).categories).toEqual(['ads']);
    expect(toAttributionManifest(attribution).empty).toEqual(['unbreak']);
  });

  test('an uncategorised source is named rather than dropped', () => {
    const attribution = buildCategoryAttribution([
      { category: '   ', rules: rules(['||a.example^']) },
      { category: 'ads', rules: rules([]) },
    ]);
    expect(attribution.categories).toEqual(['uncategorised', 'ads']);
  });

  test('is deterministic, so the written files are byte-identical', () => {
    const build = () =>
      buildCategoryAttribution([
        { category: 'ads', rules: rules(['||z.example^', '||a.example^', '||m.example^']) },
        { category: 'privacy', rules: rules(['||a.example^']) },
      ]);
    expect([...build().hosts.keys()]).toEqual([...build().hosts.keys()]);
    expect(toCategoryBlocklist(build().byCategory.get('ads')!)).toBe(
      toCategoryBlocklist(build().byCategory.get('ads')!),
    );
  });

  test('renders a category as the blocklist the compiler already reads', () => {
    expect(toCategoryBlocklist(new Set(['b.example', 'a.example']))).toBe(
      '||a.example^\n||b.example^\n',
    );
    expect(toCategoryBlocklist(new Set())).toBe('');
  });

  test('a manifest is self-describing and refuses nothing silently', () => {
    const manifest = toAttributionManifest(
      buildCategoryAttribution([
        { category: 'ads', rules: rules(['||a.example^', '||a.example^']) },
        { category: 'social', rules: rules(['||a.example^', '||b.example^']) },
      ]),
    );
    expect(manifest.format).toBe('blockingmachine-category-attribution');
    expect(manifest.version).toBe(1);
    // Deduplicated: the same rule twice is one host.
    expect(manifest.counts).toEqual({ ads: 1, social: 2 });
    expect(manifest.hosts).toBe(2);
    expect(manifest.contested).toBe(1);
  });
});
