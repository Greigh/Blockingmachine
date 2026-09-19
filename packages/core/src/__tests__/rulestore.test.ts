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
});
