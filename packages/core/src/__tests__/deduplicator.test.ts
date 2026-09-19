import { RuleDeduplicator } from "../RuleDeduplicator.js";
import { parseFilterList } from "../RuleProcessor.js";

describe("RuleDeduplicator", () => {
  let deduplicator: RuleDeduplicator;

  beforeEach(() => {
    deduplicator = new RuleDeduplicator();
  });

  test("stripRule normalizes hosts file rules and ABP rules to the same canonical key", () => {
    const hostsKey1 = deduplicator.stripRule("0.0.0.0 telemetry.example.com");
    const hostsKey2 = deduplicator.stripRule("127.0.0.1 telemetry.example.com # comment");
    const abpKey = deduplicator.stripRule("||telemetry.example.com^");
    const plainKey = deduplicator.stripRule("telemetry.example.com");

    expect(hostsKey1).toBe("telemetry.example.com");
    expect(hostsKey2).toBe("telemetry.example.com");
    expect(abpKey).toBe("telemetry.example.com");
    expect(plainKey).toBe("telemetry.example.com");
  });

  test("stripRule preserves modifiers in normalized key", () => {
    const keyWithMod = deduplicator.stripRule("||tracker.org^$third-party,script");
    expect(keyWithMod).toBe("tracker.org|mods=script,third-party");
  });

  test("stripRule preserves exception marker @@", () => {
    const exceptionKey = deduplicator.stripRule("@@||safe-site.com^");
    expect(exceptionKey).toBe("@@safe-site.com");
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
  });
});
