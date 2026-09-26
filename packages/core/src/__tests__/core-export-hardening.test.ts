import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredRule } from "../RuleStore.js";
import type { FilterListMetadata, SupportedFormat } from "../types.js";
import { exportFormat, exportWithOptions } from "../export/index.js";
import { formatRuleForType, isException } from "../export/formatters.js";
import { generateHeader } from "../export/headers.js";
import { formatRule, generateFilterList, generateHeader as advancedHeader } from "../export/advanced-formatter.js";
import { filterDNSRules, filterBrowserRules, filterBrowserOnlyRules, resolveDnsPrecedence } from "../export/ruleFilters.js";

const metadata: FilterListMetadata = {
  title: "Export hardening", description: "Regression fixtures", homepage: "https://example.com",
  version: "1", lastUpdated: "2026-09-25",
};
function rule(raw: string, enabled = true): StoredRule {
  return {
    raw, originalRule: raw, hash: raw, type: raw.startsWith("@@") ? "unblocking" : "blocking",
    metadata: {
      sources: ["test"], dateAdded: new Date(0), lastUpdated: new Date(0), enabled,
      sourceInfo: { category: "test", trusted: true, url: "test", priority: 0 }, tags: [],
    },
  };
}
const dnsFormats = ["hosts", "dnsmasq", "unbound", "bind", "privoxy", "shadowrocket", "domains"] as const;

describe("export hardening", () => {
  let outputDir: string;
  beforeEach(async () => { outputDir = await mkdtemp(join(tmpdir(), "bm-export-hardening-")); });
  afterEach(async () => { await rm(outputDir, { recursive: true, force: true }); });

  test.each(["third-party", "~third-party", "domain=news.example", "~image", "denyallow=safe.example.com", "client=10.0.0.1", "dnstype=AAAA", "dnsrewrite=1.2.3.4", "unknown-option"])("does not broaden $%s into a DNS block or exception", (modifier) => {
    for (const prefix of ["", "@@"]) {
      const scoped = rule(`${prefix}||example.com^$${modifier}`);
      expect(filterDNSRules([scoped])).toEqual([]);
      for (const format of dnsFormats) expect(formatRuleForType(scoped, format)).toBe("");
      expect(formatRule(scoped, "hosts")).toBe("");
    }
  });

  test("DNS cancellation honors badfilter without removing independent child blocks", () => {
    const rules = [rule("||example.com^"), rule("||example.com^$badfilter"), rule("||child.example.com^")];
    expect(resolveDnsPrecedence(rules).activeBlocks.map(r => r.raw)).toEqual(["||child.example.com^"]);
    expect(formatRuleForType(rules[1], "hosts")).toBe("");
  });

  test("badfilter can cancel important blocks and exceptions regardless of modifier position", () => {
    const rules = [rule("||example.com^$important"), rule("||example.com^$badfilter,important"), rule("||safe.example.com^"), rule("@@||safe.example.com^"), rule("@@||safe.example.com^$badfilter")];
    const result = resolveDnsPrecedence(rules);
    expect(result.activeBlocks.map(r => r.raw)).toEqual(["||safe.example.com^"]);
    expect(result.effectiveExceptions).toEqual([]);
  });

  test("disabled badfilter directives do not cancel enabled rules", () => {
    const rules = [rule("||example.com^"), rule("||example.com^$badfilter", false)];
    expect(resolveDnsPrecedence(rules).activeBlocks.map(r => r.raw)).toEqual(["||example.com^"]);
  });

  test("important parent blocks cannot be bypassed by ordinary child exceptions", () => {
    const rules = [rule("||example.com^$important"), rule("@@||safe.example.com^")];
    const output = generateFilterList(rules, metadata, "dnsmasq");
    expect(output).toContain("address=/example.com/0.0.0.0");
    expect(output).not.toContain("server=/safe.example.com/#");
    expect(resolveDnsPrecedence(rules).overriddenExceptions.map(r => r.raw)).toEqual(["@@||safe.example.com^"]);
  });

  test("an important child exception still bypasses an important parent", () => {
    const output = generateFilterList([rule("||example.com^$important"), rule("@@||safe.example.com^$important")], metadata, "dnsmasq");
    expect(output).toContain("server=/safe.example.com/#");
  });

  test("disabled rules never appear through direct formatters or any export entry point", async () => {
    const disabled = rule("||disabled.example.com^", false);
    const cosmetic = { ...rule("example.com##.advert", false), type: "cosmetic" as const };
    expect(filterDNSRules([disabled])).toEqual([]);
    expect(filterBrowserRules([disabled])).toEqual([]);
    expect(filterBrowserOnlyRules([cosmetic])).toEqual([]);
    for (const format of [...dnsFormats, "adguard", "abp", "plain", "all"] as SupportedFormat[]) {
      expect(formatRuleForType(disabled, format)).toBe("");
      const path = join(outputDir, `${format}.txt`);
      await exportFormat(format, path, [disabled], metadata);
      expect(await readFile(path, "utf8")).not.toContain("disabled.example.com");
    }
    expect(generateFilterList([disabled], metadata, "plain")).not.toContain("disabled.example.com");
    expect(await exportWithOptions(outputDir, metadata, { formats: ["hosts"] }, [disabled])).toEqual([]);
  });

  test("browser output boundaries match for direct and advanced entry points", async () => {
    const rules = [rule("||rewrite.example.com^$dnsrewrite=1.2.3.4"), rule("||track.example.com^$third-party")];
    expect(generateFilterList(rules, metadata, "adguard")).not.toContain("rewrite.example.com");
    const path = join(outputDir, "direct.txt");
    await exportFormat("adguard", path, rules, metadata);
    expect(await readFile(path, "utf8")).not.toContain("rewrite.example.com");
    expect(generateFilterList(rules, metadata, "adguard")).toContain("||track.example.com^$third-party");
  });

  test("cosmetic selector dollar signs do not become network modifiers", () => {
    const cosmetic = { ...rule('example.com##[data-id$="x,dnsrewrite=value"]'), type: "cosmetic" as const };
    expect(filterBrowserRules([cosmetic])).toEqual([cosmetic]);
  });

  test("extended CSS blocking syntax is not classified as an exception", () => {
    expect(isException({ ...rule("example.com#$?#.banner { display: none; }"), type: "extended-css" })).toBe(false);
    expect(isException({ ...rule("example.com#@?#.banner:has(.ad)"), type: "extended-css" })).toBe(true);
  });

  test.each([undefined, ["all"] as SupportedFormat[], ["hosts", "all", "hosts"] as SupportedFormat[]])("all/default exports create concrete format files in a new directory (%s)", async formats => {
    const nested = join(outputDir, "nested", "exports");
    await exportWithOptions(nested, metadata, { formats }, [rule("||tracker.example.com^")]);
    expect((await readdir(nested)).sort()).toEqual(["abp.txt", "adguard.txt", "bind.txt", "dnsmasq.txt", "domains.txt", "hosts.txt", "plain.txt", "privoxy.txt", "shadowrocket.txt", "unbound.txt"]);
    expect(await readFile(join(nested, "hosts.txt"), "utf8")).toContain("0.0.0.0 tracker.example.com");
  });

  test("a zero minimum priority is applied", async () => {
    const lowPriority = rule("||low.example.com^");
    lowPriority.metadata.sourceInfo.priority = -1;
    expect(await exportWithOptions(outputDir, metadata, { formats: [], minPriority: 0 }, [lowPriority])).toEqual([]);
  });

  test("invalid runtime formats are rejected before creating files", async () => {
    await expect(exportWithOptions(outputDir, metadata, { formats: ["unsupported" as SupportedFormat] }, [rule("||example.com^")])).rejects.toThrow(/format/i);
  });

  test.each(["title", "description", "homepage", "version", "lastUpdated", "expires", "author", "license", "generatorVersion"] as const)("metadata %s cannot inject executable lines into either header", field => {
    const injected = { ...metadata, [field]: "value\r\nINJECTED\u2028SECOND" };
    for (const header of [generateHeader(injected, "adguard"), generateHeader(injected, "hosts"), advancedHeader(injected, "adguard"), advancedHeader(injected, "hosts")]) {
      expect(header).not.toMatch(/^INJECTED/m);
      expect(header).not.toContain("\u2028");
    }
    expect(injected[field]).toBe("value\r\nINJECTED\u2028SECOND");
  });

  test("zero rule statistics remain zero in headers", () => {
    const header = generateHeader({ ...metadata, stats: { totalRules: 0, blockingRules: 0, exceptionRules: 0 } }, "hosts");
    expect(header).toContain("# Total Rules: 0");
    expect(header).toContain("# Blocking Rules: 0");
    expect(header).toContain("# Exception Rules: 0");
  });

  test("unbound renderers use the same blocking semantics and direct export includes a server block", async () => {
    const block = rule("||example.com^");
    expect(formatRuleForType(block, "unbound")).toBe(formatRule(block, "unbound"));
    const path = join(outputDir, "unbound.txt");
    await exportFormat("unbound", path, [block], metadata);
    const output = await readFile(path, "utf8");
    expect(output).toMatch(/^server:$/m);
    expect(output).toContain('  local-zone: "example.com" always_nxdomain');
  });
});
