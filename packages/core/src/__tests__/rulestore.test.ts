import { RuleStore } from "../RuleStore.js";
import { RuleProcessor } from "../RuleProcessor.js";

describe("RuleStore", () => {
  let processor: RuleProcessor;
  let store: RuleStore;

  beforeEach(() => {
    processor = new RuleProcessor();
    store = new RuleStore(processor);
  });

  test("stores clean domain for standard ABP network rules", () => {
    store.addRule("||example.com^", "test-source");
    const rules = store.getUniqueRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].domain).toBe("example.com");
    expect(rules[0].metadata.domain).toBe("example.com");
    expect(rules[0].type).toBe("blocking");
    expect(rules[0].isException).toBe(false);
  });

  test("stores clean domain for hosts file entries", () => {
    store.addRule("0.0.0.0 tracking.company.com", "hosts-source");
    const rules = store.getUniqueRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].domain).toBe("tracking.company.com");
    expect(rules[0].metadata.domain).toBe("tracking.company.com");
    expect(rules[0].isException).toBe(false);
  });

  test("marks standard exception rules with isException: true and extracts domain", () => {
    store.addRule("@@||allowed-service.com^", "whitelist-source");
    const rules = store.getUniqueRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].domain).toBe("allowed-service.com");
    expect(rules[0].isException).toBe(true);
    expect(rules[0].type).toBe("unblocking");
  });

  test("marks cosmetic exception rules with isException: true", () => {
    store.addRule("example.com#@#.promoted-post", "cosmetic-source");
    const rules = store.getUniqueRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].isException).toBe(true);
    expect(rules[0].type).toBe("cosmetic");
  });

  test("correctly deduplicates identical rules", () => {
    store.addRule("||doubleclick.net^", "source-1");
    store.addRule("||doubleclick.net^", "source-2");
    const rules = store.getUniqueRules();
    expect(rules).toHaveLength(1);
    expect(store.getStats().duplicates).toBe(1);
  });

  test("handles modifier rules with hash keys while preserving clean domain", () => {
    store.addRule("||adserver.org^$third-party,script", "filter-source");
    const rules = store.getUniqueRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].domain).toBe("adserver.org");
    expect(rules[0].metadata.domain).toBe("adserver.org");
  });

  test("preserves multiple distinct blocking rules for the same domain", () => {
    store.addRule("||example.com^", "source-1");
    store.addRule("||example.com/ads/*", "source-2");
    store.addRule("||example.com/tracker.js", "source-3");
    const rules = store.getUniqueRules();
    expect(rules).toHaveLength(3);
    const rawRules = rules.map((r) => r.raw);
    expect(rawRules).toContain("||example.com^");
    expect(rawRules).toContain("||example.com/ads/*");
    expect(rawRules).toContain("||example.com/tracker.js");
  });

  test("preserves cosmetic rules with identical selectors across different domains", () => {
    store.addRule("sitea.com##.ad-banner", "source-1");
    store.addRule("siteb.com##.ad-banner", "source-2");
    const rules = store.getUniqueRules();
    expect(rules).toHaveLength(2);
    const rawRules = rules.map((r) => r.raw);
    expect(rawRules).toContain("sitea.com##.ad-banner");
    expect(rawRules).toContain("siteb.com##.ad-banner");
  });

  test("merges sources for exact duplicate rules", () => {
    store.addRule("||doubleclick.net^", "source-alpha");
    store.addRule("||doubleclick.net^", "source-beta");
    const rules = store.getUniqueRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].metadata.sources).toEqual(
      expect.arrayContaining(["source-alpha", "source-beta"]),
    );
  });

  test("clears all stored rules and resets statistics", () => {
    store.addRule("||tracker.com^", "source-1");
    store.addRule("@@||safe.com^", "source-2");
    store.addRule("site.com##.ad", "source-3");
    expect(store.getUniqueRules().length).toBeGreaterThan(0);

    store.clear();
    expect(store.getUniqueRules()).toHaveLength(0);
    const stats = store.getStats();
    expect(stats.totalProcessed).toBe(0);
    expect(stats.blocking).toBe(0);
    expect(stats.unblocking).toBe(0);
    expect(stats.cosmetic).toBe(0);
  });
});
