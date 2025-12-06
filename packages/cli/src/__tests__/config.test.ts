import { loadConfig } from "../lib/config.ts";

describe("loadConfig", () => {
  it("should load and validate config", async () => {
    const config = await loadConfig();
    expect(config).toBeDefined();
    expect(config.sources).toBeInstanceOf(Array);
    expect(config.sources.length).toBeGreaterThan(0);
    expect(config.output.directory).toBe("./filters/output");
  });

  it("should validate source properties", async () => {
    const config = await loadConfig();
    config.sources.forEach((source) => {
      expect(source.name).toBeDefined();
      expect(source.url).toMatch(/^https?:\/\//);
      expect(source.category).toBeDefined();
      expect(typeof source.enabled).toBe("boolean");
      expect(typeof source.priority).toBe("number");
    });
  });
});
