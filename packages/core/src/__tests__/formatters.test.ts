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
      'local-zone: "adtracker.net" static',
    );
    expect(formatRuleForType(sampleBlockingRule, "bind")).toBe(
      'zone "adtracker.net" { type master; file "null.zone.file"; };',
    );
    expect(formatRuleForType(sampleBlockingRule, "privoxy")).toBe(
      "{ +block { adtracker.net } }",
    );
    expect(formatRuleForType(sampleBlockingRule, "shadowrocket")).toBe(
      "DOMAIN,adtracker.net,REJECT",
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
    expect(formatRuleForType(sampleExceptionRule, "bind")).toBe(
      "# EXCEPTION: @@||safe-tracker.com^",
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
    expect(bindHeader).toMatch(/^# Title: Test Blocklist/m);
  });

  test("generateHeader uses ! comment prefix for adguard and abp formats", () => {
    const adguardHeader = generateHeader(metadata, "adguard");
    expect(adguardHeader).toMatch(/^! Title: Test Blocklist/m);
    expect(adguardHeader).not.toMatch(/^# Title:/m);

    const abpHeader = generateHeader(metadata, "abp");
    expect(abpHeader).toMatch(/^! Title: Test Blocklist/m);
  });
});
