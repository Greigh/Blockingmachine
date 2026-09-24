import { exportWithOptions } from "../export/index.js";
import { RuleStore } from "../RuleStore.js";
import { RuleProcessor } from "../RuleProcessor.js";
import type { FilterListMetadata } from "../types.js";
import { promises as fs } from "fs";
import { join } from "path";
import os from "os";

describe("exportWithOptions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(os.tmpdir(), "bm-export-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const metadata: FilterListMetadata = {
    title: "Export Test List",
    description: "Testing exportWithOptions",
    homepage: "https://example.com",
    version: "1.0.0",
    lastUpdated: "2026-09-19T00:00:00.000Z",
  };

  test("exports rules when passed a populated RuleStore", async () => {
    const processor = new RuleProcessor();
    const store = new RuleStore(processor);
    store.addRule("||adserver.com^", "test-source");
    store.addRule("0.0.0.0 telemetry.io", "test-source");

    const exported = await exportWithOptions(
      tmpDir,
      metadata,
      { formats: ["hosts", "adguard"] },
      store,
    );

    expect(exported).toHaveLength(2);

    const hostsContent = await fs.readFile(join(tmpDir, "hosts.txt"), "utf8");
    expect(hostsContent).toContain("0.0.0.0 adserver.com");
    expect(hostsContent).toContain("0.0.0.0 telemetry.io");

    const adguardContent = await fs.readFile(
      join(tmpDir, "adguard.txt"),
      "utf8",
    );
    expect(adguardContent).toContain("||adserver.com^");
  });

  test("exports rules when passed rules array in options", async () => {
    const processor = new RuleProcessor();
    const store = new RuleStore(processor);
    store.addRule("||tracker.org^", "test-source");
    const rules = store.getUniqueRules();

    const exported = await exportWithOptions(tmpDir, metadata, {
      formats: ["dnsmasq"],
      rules,
    });

    expect(exported).toHaveLength(1);

    const dnsmasqContent = await fs.readFile(
      join(tmpDir, "dnsmasq.txt"),
      "utf8",
    );
    expect(dnsmasqContent).toContain("address=/tracker.org/0.0.0.0");
  });

  test("multi-format export preserves browser/cosmetic rules in adguard when exported alongside hosts", async () => {
    const processor = new RuleProcessor();
    const store = new RuleStore(processor);
    store.addRule("||tracker.com^", "source-1");
    store.addRule("example.com##.ad-banner", "source-2");

    await exportWithOptions(
      tmpDir,
      metadata,
      { formats: ["hosts", "adguard"] },
      store,
    );

    const hostsContent = await fs.readFile(join(tmpDir, "hosts.txt"), "utf8");
    // Hosts should NOT include the cosmetic rule
    expect(hostsContent).toContain("0.0.0.0 tracker.com");
    expect(hostsContent).not.toContain("##.ad-banner");

    const adguardContent = await fs.readFile(
      join(tmpDir, "adguard.txt"),
      "utf8",
    );
    // AdGuard MUST include both the network rule AND the cosmetic rule
    expect(adguardContent).toContain("||tracker.com^");
    expect(adguardContent).toContain("example.com##.ad-banner");
  });

  test("filterDNSRules strips rules with secondary browser modifiers like $third-party,script", async () => {
    const processor = new RuleProcessor();
    const store = new RuleStore(processor);
    store.addRule("||adnetwork.com^$third-party,script", "source-1");
    store.addRule("||plain-block.com^", "source-2");

    await exportWithOptions(tmpDir, metadata, { formats: ["hosts"] }, store);

    const hostsContent = await fs.readFile(join(tmpDir, "hosts.txt"), "utf8");
    expect(hostsContent).toContain("0.0.0.0 plain-block.com");
    expect(hostsContent).not.toContain("adnetwork.com");
  });

  test("enforces strict boundary: DNS excludes bare public suffixes, arpa, and path rules", async () => {
    const processor = new RuleProcessor();
    const store = new RuleStore(processor);
    store.addRule("||co.uk^", "source-1");
    store.addRule("||pages.dev^", "source-1");
    store.addRule("||1.0.0.127.in-addr.arpa^", "source-1");
    store.addRule("||site.com/ad/banner.png^", "source-1");
    store.addRule("site.com##.sponsor-banner", "source-1");
    store.addRule("||legit-domain.com^", "source-2");

    await exportWithOptions(tmpDir, metadata, { formats: ["hosts"] }, store);

    const hostsContent = await fs.readFile(join(tmpDir, "hosts.txt"), "utf8");
    expect(hostsContent).toContain("0.0.0.0 legit-domain.com");
    // DNS must never contain public suffixes, arpa, paths, or cosmetics
    expect(hostsContent).not.toContain("co.uk");
    expect(hostsContent).not.toContain("pages.dev");
    expect(hostsContent).not.toContain("in-addr.arpa");
    expect(hostsContent).not.toContain("site.com");
  });

  test("enforces strict boundary: Browser format excludes DNS-only directives ($dnsrewrite, $dnstype)", async () => {
    const processor = new RuleProcessor();
    const store = new RuleStore(processor);
    store.addRule("||dns-only.com^$dnsrewrite=1.2.3.4", "source-1");
    store.addRule("||dns-type.com^$dnstype=AAAA", "source-1");
    store.addRule("||browser-track.com^$script", "source-2");

    await exportWithOptions(tmpDir, metadata, { formats: ["adguard"] }, store);

    const adguardContent = await fs.readFile(join(tmpDir, "adguard.txt"), "utf8");
    expect(adguardContent).toContain("||browser-track.com^$script");
    expect(adguardContent).not.toContain("dns-only.com");
    expect(adguardContent).not.toContain("dns-type.com");
  });
});
