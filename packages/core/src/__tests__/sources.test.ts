import {
  filterLists,
  sourceCategories,
  getSourceProfile,
  detectSourceClassification,
  displayFilterLabel,
  CURATED_SOURCE_PROFILES,
} from "../index.js";

describe("Source Classification Taxonomy & Intelligence", () => {
  describe("Curated Sources Registry", () => {
    test("every curated source profile has valid scope, category, description, and targets", () => {
      expect(CURATED_SOURCE_PROFILES.length).toBeGreaterThanOrEqual(18);

      for (const profile of CURATED_SOURCE_PROFILES) {
        expect(profile.name).toBeTruthy();
        expect(profile.url).toBeTruthy();
        expect(["dns", "browser", "hybrid"]).toContain(profile.scope);
        expect([
          "ads",
          "privacy",
          "security",
          "annoyances",
          "social",
          "mobile",
          "unbreak",
          "anti-circumvention",
          "custom",
        ]).toContain(profile.category);
        expect(profile.description.length).toBeGreaterThan(10);
        expect(Array.isArray(profile.features)).toBe(true);
        expect(profile.features.length).toBeGreaterThan(0);
        expect(Array.isArray(profile.targets)).toBe(true);
        expect(profile.targets.length).toBeGreaterThan(0);
        expect(typeof profile.trusted).toBe("boolean");
        expect(typeof profile.priority).toBe("number");
        expect(profile.recommendedFor).toBeTruthy();
      }
    });

    test("filterLists reflects curated profiles with scope and category", () => {
      expect(filterLists.length).toBe(CURATED_SOURCE_PROFILES.length);
      for (const list of filterLists) {
        expect(list.scope).toBeDefined();
        expect(list.category).toBeDefined();
        expect(list.description).toBeDefined();
      }
    });

    test("sourceCategories has registered metadata for every curated source", () => {
      for (const profile of CURATED_SOURCE_PROFILES) {
        const info = sourceCategories[profile.name];
        expect(info).toBeDefined();
        expect(info.category).toBe(profile.category);
        expect(info.trusted).toBe(profile.trusted);
        expect(info.priority).toBe(profile.priority);
      }
    });
  });

  describe("getSourceProfile", () => {
    test("keeps legacy defense module names resolvable and strips them for display", () => {
      expect(displayFilterLabel("Blockingmachine Base Ad Shield [Beta]")).toBe(
        "Base Ad Shield [Beta]",
      );
      expect(displayFilterLabel("Blockingmachine Defense Suite [Beta]")).toBe(
        "Defense Suite [Beta]",
      );
      expect(displayFilterLabel("Blockingmachine Rules")).toBe("Blockingmachine Rules");
      expect(displayFilterLabel("AdGuard DNS Filter")).toBe("AdGuard DNS Filter");

      const legacy = getSourceProfile("Blockingmachine Privacy Engine [Beta]");
      expect(legacy.name).toBe("Privacy Engine [Beta]");
      expect(legacy.url).toContain("blockingmachine-privacy.txt");
      expect(sourceCategories["Blockingmachine Privacy Engine [Beta]"]).toEqual(
        sourceCategories["Privacy Engine [Beta]"],
      );
    });

    test("resolves known sources by exact name", () => {
      const profile = getSourceProfile("AdGuard DNS Filter");
      expect(profile.name).toBe("AdGuard DNS Filter");
      expect(profile.scope).toBe("dns");
      expect(profile.category).toBe("ads");
      expect(profile.targets).toEqual(["dns"]);
    });

    test("resolves known sources case-insensitively", () => {
      const profile = getSourceProfile("adguard annoyances filter");
      expect(profile.name).toBe("AdGuard Annoyances Filter");
      expect(profile.scope).toBe("browser");
      expect(profile.category).toBe("annoyances");
      expect(profile.warning).toBeDefined();
    });

    test("resolves known sources by URL", () => {
      const profile = getSourceProfile(
        "https://easylist.to/easylist/easylist.txt"
      );
      expect(profile.name).toBe("EasyList");
      expect(profile.scope).toBe("hybrid");
      expect(profile.category).toBe("ads");
    });

    test("resolves security & privacy specific sources correctly", () => {
      const oisd = getSourceProfile("OISD Blocklist Small");
      expect(oisd.category).toBe("security");
      expect(oisd.scope).toBe("dns");

      const hagezi = getSourceProfile(
        "HaGeZi's Windows/Office Tracker Blocklist"
      );
      expect(hagezi.category).toBe("privacy");
      expect(hagezi.scope).toBe("dns");

      const unbreak = getSourceProfile("uBlock Unbreak Filter");
      expect(unbreak.category).toBe("unbreak");
      expect(unbreak.priority).toBe(0);
    });
  });

  describe("detectSourceClassification", () => {
    test("infers annoyances category and browser scope from URL keywords", () => {
      const detected = detectSourceClassification(
        "https://example.com/cookie-consent-rules.txt"
      );
      expect(detected.category).toBe("annoyances");
      expect(detected.scope).toBe("browser");
      expect(detected.targets).toEqual(["browser"]);
    });

    test("infers security category and dns scope from malware keywords", () => {
      const detected = detectSourceClassification(
        "https://threat-intel.org/feeds/malware-domains.txt"
      );
      expect(detected.category).toBe("security");
      expect(detected.scope).toBe("dns");
      expect(detected.targets).toEqual(["dns"]);
    });

    test("infers privacy category from telemetry keywords", () => {
      const detected = detectSourceClassification(
        "https://privacy-block.org/telemetry-trackers.txt"
      );
      expect(detected.category).toBe("privacy");
    });

    test("inspects sample rules: purely cosmetic rules become browser scope", () => {
      const sampleRules = [
        "! Description: Cosmetic blocklist",
        "example.com##.ad-banner",
        "news.com###cookie-notice",
        "shop.com#@#.sponsored-card",
      ];
      const detected = detectSourceClassification(
        "https://example.com/custom-rules.txt",
        sampleRules
      );
      expect(detected.scope).toBe("browser");
      expect(detected.targets).toEqual(["browser"]);
      expect(detected.warning).toBeDefined();
    });

    test("inspects sample rules: purely hosts rules become dns scope", () => {
      const sampleRules = [
        "# Hosts file",
        "0.0.0.0 adserver1.com",
        "0.0.0.0 tracking2.net",
        "127.0.0.1 telemetry3.org",
      ];
      const detected = detectSourceClassification(
        "https://example.com/custom-hosts.txt",
        sampleRules
      );
      expect(detected.scope).toBe("dns");
      expect(detected.targets).toEqual(["dns"]);
    });

    test("inspects sample rules: combination of network and cosmetic rules becomes hybrid scope", () => {
      const sampleRules = [
        "||adserver.com^",
        "example.com##.banner",
        "||tracker.io^$third-party",
      ];
      const detected = detectSourceClassification(
        "https://example.com/mixed-list.txt",
        sampleRules
      );
      expect(detected.scope).toBe("hybrid");
      expect(detected.targets).toContain("browser");
      expect(detected.targets).toContain("dns");
    });
  });
});
