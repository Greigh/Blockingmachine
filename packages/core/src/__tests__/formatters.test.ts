import { formatRuleForType } from "../export/formatters.js";
import { generateHeader } from "../export/headers.js";
import type { StoredRule } from "../RuleStore.js";
import type { FilterListMetadata } from "../types.js";

describe("formatters & headers", () => {
  const sampleBlockingRule: StoredRule = {
    raw: "||adtracker.net^",
    originalRule: "||adtracker.net^",
    hash: "abc1",
    type: "blocking",
    domain: "adtracker.net",
    isException: false,
    metadata: {
      sources: ["source-1"],
      dateAdded: new Date(),
      lastUpdated: new Date(),
      enabled: true,
      sourceInfo: { category: "ads", trusted: true, url: "", priority: 1 },
      tags: [],
      domain: "adtracker.net",
    },
  };

  const sampleExceptionRule: StoredRule = {
    raw: "@@||safe-tracker.com^",
    originalRule: "@@||safe-tracker.com^",
    hash: "abc2",
    type: "unblocking",
    domain: "safe-tracker.com",
    isException: true,
    metadata: {
      sources: ["source-2"],
      dateAdded: new Date(),
      lastUpdated: new Date(),
      enabled: true,
      sourceInfo: {
        category: "whitelist",
        trusted: true,
        url: "",
        priority: 1,
      },
      tags: [],
      domain: "safe-tracker.com",
    },
  };

  const metadata: FilterListMetadata = {
    title: "Test Blocklist",
    description: "Header test",
    homepage: "https://example.com",
    version: "1.0.0",
    lastUpdated: "2026-09-19T00:00:00.000Z",
    generatorVersion: "1.0.0",
    stats: {
      totalRules: 10,
      blockingRules: 8,
      exceptionRules: 2,
    },
  };

  test("formatRuleForType formats blocking rules correctly for all supported formats", () => {
    expect(formatRuleForType(sampleBlockingRule, "hosts")).toBe(
      "0.0.0.0 adtracker.net",
    );
    expect(formatRuleForType(sampleBlockingRule, "dnsmasq")).toBe(
      "address=/adtracker.net/0.0.0.0",
    );
    expect(formatRuleForType(sampleBlockingRule, "unbound")).toBe(
      '  local-zone: "adtracker.net" always_nxdomain',
    );
    // RPZ policy record: `CNAME .` is BIND's documented NXDOMAIN block. A per-domain
    // `zone { type master; … }` stanza cannot load at all — BIND refuses a primary zone with no SOA.
    expect(formatRuleForType(sampleBlockingRule, "bind")).toBe(
      "adtracker.net CNAME .",
    );
    // The leading dot is the mechanism: a bare host matches that host only in Privoxy.
    expect(formatRuleForType(sampleBlockingRule, "privoxy")).toBe(
      ".adtracker.net",
    );
    // DOMAIN-SUFFIX, not DOMAIN: the block covers the domain and everything under it, which is
    // what a domain block means in a Surge-style rule set.
    expect(formatRuleForType(sampleBlockingRule, "shadowrocket")).toBe(
      "DOMAIN-SUFFIX,adtracker.net,REJECT",
    );
    expect(formatRuleForType(sampleBlockingRule, "adguard")).toBe(
      "||adtracker.net^",
    );
    expect(formatRuleForType(sampleBlockingRule, "abp")).toBe(
      "||adtracker.net^",
    );
  });

  test("formatRuleForType does NOT invert exception rules to block entries", () => {
    expect(formatRuleForType(sampleExceptionRule, "hosts")).toBe(
      "# EXCEPTION: @@||safe-tracker.com^",
    );
    expect(formatRuleForType(sampleExceptionRule, "dnsmasq")).toBe(
      "# EXCEPTION: @@||safe-tracker.com^",
    );
    expect(formatRuleForType(sampleExceptionRule, "unbound")).toBe(
      "# EXCEPTION: @@||safe-tracker.com^",
    );
    // A BIND master file comments with `;` — `#` is a parse error there, not a comment.
    expect(formatRuleForType(sampleExceptionRule, "bind")).toBe(
      "; EXCEPTION: @@||safe-tracker.com^",
    );
    expect(formatRuleForType(sampleExceptionRule, "privoxy")).toBe(
      "# EXCEPTION: @@||safe-tracker.com^",
    );
    expect(formatRuleForType(sampleExceptionRule, "shadowrocket")).toBe(
      "# EXCEPTION: @@||safe-tracker.com^",
    );
    // AdGuard and ABP preserve exception syntax natively
    expect(formatRuleForType(sampleExceptionRule, "adguard")).toBe(
      "@@||safe-tracker.com^",
    );
    expect(formatRuleForType(sampleExceptionRule, "abp")).toBe(
      "@@||safe-tracker.com^",
    );
  });

  test("generateHeader uses # comment prefix for DNS/hosts/bind/privoxy/shadowrocket formats", () => {
    const hostsHeader = generateHeader(metadata, "hosts");
    expect(hostsHeader).toMatch(/^# Title: Test Blocklist/m);
    expect(hostsHeader).not.toMatch(/^! Title:/m);

    const dnsmasqHeader = generateHeader(metadata, "dnsmasq");
    expect(dnsmasqHeader).toMatch(/^# Title: Test Blocklist/m);

    const unboundHeader = generateHeader(metadata, "unbound");
    expect(unboundHeader).toMatch(/^# Title: Test Blocklist/m);

    const bindHeader = generateHeader(metadata, "bind");
    expect(bindHeader).toMatch(/^; Title: Test Blocklist/m);
    expect(bindHeader).not.toMatch(/^# Title:/m);
  });

  test("opens the format-specific section a bare list of rules would be rejected without", () => {
    // A Privoxy action file is section-based; patterns before the first action block belong to no
    // action. A BIND primary zone needs an SOA before any record. Both are part of the artifact,
    // not a step the user is left to discover from a load error.
    const privoxyHeader = generateHeader(metadata, "privoxy");
    expect(privoxyHeader).toContain("{+block{Blockingmachine Blocklist}}");

    const bindHeader = generateHeader(metadata, "bind");
    expect(bindHeader).toContain("$TTL 3600");
    expect(bindHeader).toContain("@ IN SOA localhost. root.localhost.");
    expect(bindHeader).toContain("response-policy");
    expect(bindHeader).toContain("rpz.blockingmachine");
  });

  test("generateHeader uses ! comment prefix for adguard and abp formats", () => {
    const adguardHeader = generateHeader(metadata, "adguard");
    expect(adguardHeader).toMatch(/^! Title: Test Blocklist/m);
    expect(adguardHeader).not.toMatch(/^# Title:/m);

    const abpHeader = generateHeader(metadata, "abp");
    expect(abpHeader).toMatch(/^! Title: Test Blocklist/m);
  });

  test("accurately formats rules according to their actual rule kind", () => {
    // 1. Cosmetic rules must NEVER be emitted as DNS domain blocks
    const cosmeticRule: StoredRule = {
      raw: "youtube.com##.ytd-ad-slot-renderer",
      originalRule: "youtube.com##.ytd-ad-slot-renderer",
      hash: "cos1",
      type: "cosmetic",
      domain: "youtube.com",
      isException: false,
      metadata: {
        sources: ["easylist"],
        dateAdded: new Date(),
        lastUpdated: new Date(),
        enabled: true,
        sourceInfo: { category: "cosmetic", trusted: true, url: "", priority: 1 },
        tags: [],
        domain: "youtube.com",
      },
    };

    expect(formatRuleForType(cosmeticRule, "hosts")).toBe("");
    expect(formatRuleForType(cosmeticRule, "dnsmasq")).toBe("");
    expect(formatRuleForType(cosmeticRule, "unbound")).toBe("");
    expect(formatRuleForType(cosmeticRule, "domains")).toBe("");
    // But preserved in browser formats
    expect(formatRuleForType(cosmeticRule, "adguard")).toBe(
      "youtube.com##.ytd-ad-slot-renderer",
    );
    expect(formatRuleForType(cosmeticRule, "abp")).toBe(
      "youtube.com##.ytd-ad-slot-renderer",
    );

    // 2. Browser path rules must NEVER be emitted as whole-domain DNS blocks
    const pathRule: StoredRule = {
      raw: "||example.com/ads/tracker.js$script",
      originalRule: "||example.com/ads/tracker.js$script",
      hash: "path1",
      type: "blocking",
      domain: "example.com",
      isException: false,
      metadata: {
        sources: ["easylist"],
        dateAdded: new Date(),
        lastUpdated: new Date(),
        enabled: true,
        sourceInfo: { category: "ads", trusted: true, url: "", priority: 1 },
        tags: [],
        domain: "example.com",
      },
    };

    expect(formatRuleForType(pathRule, "hosts")).toBe("");
    expect(formatRuleForType(pathRule, "dnsmasq")).toBe("");
    expect(formatRuleForType(pathRule, "unbound")).toBe("");
    expect(formatRuleForType(pathRule, "adguard")).toBe(
      "||example.com/ads/tracker.js$script",
    );

    // 3. Hosts file rules (0.0.0.0 domain) formatted into proper ABP/AdGuard syntax
    const hostsLineRule: StoredRule = {
      raw: "0.0.0.0 telemetry.tracker.com",
      originalRule: "0.0.0.0 telemetry.tracker.com",
      hash: "host1",
      type: "blocking",
      domain: "telemetry.tracker.com",
      isException: false,
      metadata: {
        sources: ["stevenblack"],
        dateAdded: new Date(),
        lastUpdated: new Date(),
        enabled: true,
        sourceInfo: { category: "malware", trusted: true, url: "", priority: 1 },
        tags: [],
        domain: "telemetry.tracker.com",
      },
    };

    expect(formatRuleForType(hostsLineRule, "hosts")).toBe(
      "0.0.0.0 telemetry.tracker.com",
    );
    expect(formatRuleForType(hostsLineRule, "adguard")).toBe(
      "||telemetry.tracker.com^",
    );
    expect(formatRuleForType(hostsLineRule, "abp")).toBe(
      "||telemetry.tracker.com^",
    );

    // 4. Scriptlet rules preserved in AdGuard and omitted from DNS
    const scriptletRule: StoredRule = {
      raw: "example.com#$#abort-current-inline-script",
      originalRule: "example.com#$#abort-current-inline-script",
      hash: "sc1",
      type: "scriptlet",
      domain: "example.com",
      isException: false,
      metadata: {
        sources: ["ubo"],
        dateAdded: new Date(),
        lastUpdated: new Date(),
        enabled: true,
        sourceInfo: { category: "scriptlet", trusted: true, url: "", priority: 1 },
        tags: [],
        domain: "example.com",
      },
    };

    expect(formatRuleForType(scriptletRule, "hosts")).toBe("");
    expect(formatRuleForType(scriptletRule, "dnsmasq")).toBe("");
    expect(formatRuleForType(scriptletRule, "adguard")).toBe(
      "example.com#$#abort-current-inline-script",
    );
  });
});
