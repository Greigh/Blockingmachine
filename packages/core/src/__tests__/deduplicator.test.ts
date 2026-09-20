import { RuleDeduplicator } from "../RuleDeduplicator.js";
import { parseFilterList } from "../RuleProcessor.js";

describe("RuleDeduplicator", () => {
  let deduplicator: RuleDeduplicator;

  beforeEach(() => {
    deduplicator = new RuleDeduplicator();
  });

  test("stripRule normalizes hosts file rules and ABP rules to the same canonical key", () => {
    const hostsKey1 = deduplicator.stripRule("0.0.0.0 telemetry.example.com");
    const hostsKey2 = deduplicator.stripRule(
      "127.0.0.1 telemetry.example.com # comment",
    );
    const abpKey = deduplicator.stripRule("||telemetry.example.com^");
    const plainKey = deduplicator.stripRule("telemetry.example.com");

    expect(hostsKey1).toBe("telemetry.example.com");
    expect(hostsKey2).toBe("telemetry.example.com");
    expect(abpKey).toBe("telemetry.example.com");
    expect(plainKey).toBe("telemetry.example.com");
  });

  test("stripRule preserves modifiers in normalized key", () => {
    const keyWithMod = deduplicator.stripRule(
      "||tracker.org^$third-party,script",
    );
    expect(keyWithMod).toBe("tracker.org|mods=script,third-party");
  });

  test("stripRule preserves exception marker @@ and #@#", () => {
    const networkException = deduplicator.stripRule("@@||safe-site.com^");
    expect(networkException).toBe("@@safe-site.com");

    const cosmeticException = deduplicator.stripRule(
      "example.com#@#.ad-banner",
    );
    const cosmeticHide = deduplicator.stripRule("example.com##.ad-banner");
    expect(cosmeticException).toBe("@@example.com|sel=.ad-banner");
    expect(cosmeticHide).toBe("example.com|sel=.ad-banner");
    expect(cosmeticException).not.toBe(cosmeticHide);
  });

  test("stripRule preserves distinct scriptlets on the same domain", () => {
    const s1 = deduplicator.stripRule(
      "example.com#$#abort-current-inline-script",
    );
    const s2 = deduplicator.stripRule("example.com#$#set-constant ad true");
    expect(s1).toBe("example.com|scriptlet=abort-current-inline-script");
    expect(s2).toBe("example.com|scriptlet=set-constant ad true");
    expect(s1).not.toBe(s2);
  });

  test("processRules deduplicates rules across different source formats", async () => {
    const rawSources = `
0.0.0.0 doubleclick.net
127.0.0.1 doubleclick.net
||doubleclick.net^
doubleclick.net
||analytics.google.com^
    `.trim();

    const rules = parseFilterList(rawSources, "test");
    expect(rules.length).toBe(5);

    const deduped = await deduplicator.processRules(rules);
    // doubleclick.net (4 copies in different formats) should collapse into 1 rule, plus analytics.google.com = 2 total
    expect(deduped).toHaveLength(2);
    const domains = deduped.map((r) => r.domain);
    expect(domains).toContain("doubleclick.net");
    expect(domains).toContain("analytics.google.com");

    deduplicator.clear();
    expect(deduplicator.getStats().total).toBe(0);
  });

  test("pruneRedundantSubdomains eliminates subdomains when parent wildcard block is active", async () => {
    const rawSources = `
||example.com^
||sub.example.com^
0.0.0.0 deep.sub.example.com
@@||safe.example.com^
||unrelated.org^
    `.trim();

    const rules = parseFilterList(rawSources, "test");
    const deduped = await deduplicator.processRules(rules);

    const ruleStrings = deduped.map((r) => r.originalRule);
    // ||example.com^ is parent wildcard
    expect(ruleStrings).toContain("||example.com^");
    // @@||safe.example.com^ is exception and must NEVER be pruned
    expect(ruleStrings).toContain("@@||safe.example.com^");
    // ||unrelated.org^ is preserved
    expect(ruleStrings).toContain("||unrelated.org^");
    // ||sub.example.com^ and 0.0.0.0 deep.sub.example.com should be pruned
    expect(ruleStrings).not.toContain("||sub.example.com^");
    expect(ruleStrings).not.toContain("0.0.0.0 deep.sub.example.com");

    expect(deduplicator.getStats().subdomainsPruned).toBe(2);
  });

  test("getRuleScore accurately calculates bonus weights for important, trusted, domain modifiers and attribution", () => {
    const baseRule: any = {
      originalRule: "||tracker.com^",
      metadata: {
        sources: ["source1"],
        dateAdded: new Date(),
      },
    };

    const importantRule: any = {
      originalRule: "||tracker.com^$important",
      metadata: {
        sources: ["source1"],
        dateAdded: new Date(),
      },
    };

    const trustedRule: any = {
      originalRule: "||tracker.com^",
      metadata: {
        sources: ["source1"],
        dateAdded: new Date(),
        sourceInfo: { trusted: true },
      },
    };

    const attributedRule: any = {
      originalRule: "||tracker.com^",
      metadata: {
        sources: ["source1"],
        dateAdded: new Date(),
        attribution: "Curated by Daniel Hipskind",
      },
    };

    const baseScore = deduplicator.getRuleScore(baseRule);
    const importantScore = deduplicator.getRuleScore(importantRule);
    const trustedScore = deduplicator.getRuleScore(trustedRule);
    const attributedScore = deduplicator.getRuleScore(attributedRule);

    expect(importantScore).toBeGreaterThan(baseScore);
    expect(trustedScore).toBeGreaterThan(baseScore);
    expect(attributedScore).toBeGreaterThan(baseScore);
    expect(deduplicator.getRuleScore(null)).toBe(0);
  });

  test("selectBestRule chooses highest scored rule and breaks ties by length", () => {
    const ruleA: any = {
      originalRule: "||adserver.com^",
      metadata: { sources: ["src1"], dateAdded: new Date() },
    };
    const ruleB: any = {
      originalRule: "||adserver.com^$important",
      metadata: { sources: ["src1"], dateAdded: new Date() },
    };

    expect(deduplicator.selectBestRule([ruleA, ruleB])).toBe(ruleB);

    // Tie-breaker prefers shorter rule
    const tieShort: any = {
      originalRule: "adserver.com",
      metadata: { sources: ["src1"], dateAdded: new Date() },
    };
    const tieLong: any = {
      originalRule: "0.0.0.0 adserver.com",
      metadata: { sources: ["src1"], dateAdded: new Date() },
    };
    const selected = deduplicator.selectBestRule([tieLong, tieShort]);
    expect(selected.originalRule.length).toBeLessThanOrEqual(tieLong.originalRule.length);
  });

  test("mergeMetadata combines sources, modifiers, dates, and alternatives", () => {
    const earlyDate = new Date("2023-01-01");
    const lateDate = new Date("2024-01-01");

    const rule1: any = {
      originalRule: "||analytics.net^",
      metadata: {
        sources: ["feed-alpha"],
        dateAdded: lateDate,
        modifiers: ["third-party"],
      },
    };

    const rule2: any = {
      originalRule: "0.0.0.0 analytics.net",
      metadata: {
        sources: ["feed-beta"],
        dateAdded: earlyDate,
        modifiers: ["script"],
      },
    };

    const merged = deduplicator.mergeMetadata([rule1, rule2], rule1);
    expect(merged.sources).toContain("feed-alpha");
    expect(merged.sources).toContain("feed-beta");
    expect(merged.dateAdded).toEqual(earlyDate);
    expect(merged.modifiers).toContain("third-party");
    expect(merged.modifiers).toContain("script");
    expect(merged.alternatives).toContain("0.0.0.0 analytics.net");
  });

  test("pruneRedundantSubdomains handles multi-level deep subdomains", () => {
    const rules: any = [
      { type: "blocking", originalRule: "||master-domain.org^" },
      { type: "blocking", originalRule: "||a.b.c.master-domain.org^" },
      { type: "blocking", originalRule: "0.0.0.0 x.y.z.master-domain.org" },
      { type: "blocking", originalRule: "||independent-domain.org^" },
    ];

    const pruned = deduplicator.pruneRedundantSubdomains(rules);
    expect(pruned).toHaveLength(2);
    const remaining = pruned.map((r) => r.originalRule);
    expect(remaining).toContain("||master-domain.org^");
    expect(remaining).toContain("||independent-domain.org^");
    expect(remaining).not.toContain("||a.b.c.master-domain.org^");
    expect(remaining).not.toContain("0.0.0.0 x.y.z.master-domain.org");
  });

  test("collapseIpRules removes duplicate IP rules and formats properly", () => {
    const rules: any = [
      { type: "blocking", originalRule: "0.0.0.0 192.168.1.100" },
      { type: "blocking", originalRule: "127.0.0.1 192.168.1.100" },
      { type: "blocking", originalRule: "10.0.0.1/24" },
      { type: "blocking", originalRule: "0.0.0.0 10.0.0.1/24" },
      { type: "blocking", originalRule: "||normal-domain.com^" },
    ];

    const collapsed = deduplicator.collapseIpRules(rules);
    expect(collapsed).toHaveLength(3);
    const rulesText = collapsed.map((r) => r.originalRule);
    expect(rulesText).toContain("0.0.0.0 192.168.1.100");
    expect(rulesText).toContain("10.0.0.1/24");
    expect(rulesText).toContain("||normal-domain.com^");
  });

  test("stripRule handles cosmetic selectors with $ attribute matching without cutoffs", () => {
    const key1 = deduplicator.stripRule('example.com##div[id$="-ad"]');
    expect(key1).toContain('sel=div[id$="-ad"]');
    expect(key1).not.toContain("mods=");

    const key2 = deduplicator.stripRule('##a[href$=".apk"]');
    expect(key2).toContain('sel=a[href$=".apk"]');
    expect(key2).not.toContain("mods=");
  });
});

