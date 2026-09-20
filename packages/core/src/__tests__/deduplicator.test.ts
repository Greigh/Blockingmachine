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
});
