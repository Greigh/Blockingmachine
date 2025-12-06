import { defaultFilterMeta } from "../config/meta.ts";

describe("defaultFilterMeta", () => {
  test("exports required fields", () => {
    expect(defaultFilterMeta).toBeDefined();
    expect(typeof defaultFilterMeta.title).toBe("string");
    expect(typeof defaultFilterMeta.description).toBe("string");
    expect(typeof defaultFilterMeta.homepage).toBe("string");
    expect(typeof defaultFilterMeta.license).toBe("string");
    expect(defaultFilterMeta.stats).toBeDefined();
    expect(typeof defaultFilterMeta.stats.totalRules).toBe("number");
    expect(typeof defaultFilterMeta.stats.blockingRules).toBe("number");
    expect(typeof defaultFilterMeta.stats.unblockingRules).toBe("number");
  });
});
