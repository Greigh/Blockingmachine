import { jest } from "@jest/globals";
import { ExportCommand } from "../commands/ExportCommand.js";
import { ImportCommand } from "../commands/ImportCommand.js";
import { TestCommand } from "../commands/TestCommand.js";
import { DiffCommand } from "../commands/DiffCommand.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

describe("CLI Commands", () => {
  let tmpDir: string;
  let mockLogger: any;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-cli-test-"));
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("ExportCommand formats hosts and dnsmasq correctly with exception, modifier and cosmetic handling", async () => {
    const outputDir = path.join(tmpDir, "filters", "output");
    await fs.mkdir(outputDir, { recursive: true });

    const rawRules = [
      "! A comment line",
      "||ads.example.com^",
      "@@||allowed.example.com^",
      "tracker.net",
      "##.generic-banner",
      "||browser-only.com^$script",
    ].join("\n");

    await fs.writeFile(
      path.join(outputDir, "imported-rules.txt"),
      rawRules,
      "utf-8",
    );

    const config: any = {
      baseDir: tmpDir,
      output: { directory: outputDir },
      sources: [],
    };

    const exportCmd = new ExportCommand({ config, logger: mockLogger });
    const result = await exportCmd.execute({
      outputPath: outputDir,
      formats: ["hosts", "dnsmasq", "adguard"],
    });

    expect(result.success).toBe(true);

    const hostsContent = await fs.readFile(
      path.join(outputDir, "filter-list.hosts"),
      "utf-8",
    );
    expect(hostsContent).toContain("0.0.0.0 ads.example.com");
    expect(hostsContent).toContain("0.0.0.0 tracker.net");
    expect(hostsContent).toContain("# EXCEPTION: @@||allowed.example.com^");
    expect(hostsContent).not.toContain("0.0.0.0 !");
    expect(hostsContent).not.toContain("generic-banner");
    expect(hostsContent).not.toContain("browser-only.com");

    const dnsmasqContent = await fs.readFile(
      path.join(outputDir, "filter-list.dnsmasq"),
      "utf-8",
    );
    expect(dnsmasqContent).toContain("address=/ads.example.com/0.0.0.0");
    expect(dnsmasqContent).toContain("address=/tracker.net/0.0.0.0");
    expect(dnsmasqContent).toContain("# EXCEPTION: @@||allowed.example.com^");
    expect(dnsmasqContent).not.toContain("generic-banner");
    expect(dnsmasqContent).not.toContain("browser-only.com");

    const adguardContent = await fs.readFile(
      path.join(outputDir, "filter-list.txt"),
      "utf-8",
    );
    expect(adguardContent).toContain("||ads.example.com^");
    expect(adguardContent).toContain("@@||allowed.example.com^");
    expect(adguardContent).toContain("##.generic-banner");
    expect(adguardContent).toContain("||browser-only.com^$script");
  });

  test("ImportCommand imports, preserves cosmetic rules and deduplicates rules from local file source", async () => {
    const sourceFile = path.join(tmpDir, "sample-source.txt");
    const sourceContent = [
      "[Adblock Plus 2.0]",
      "! Header comment",
      "||banner.com^",
      "||banner.com^",
      "||analytics.com^",
      "##.cosmetic-ad",
      "#?#.extended-promo",
    ].join("\n");

    await fs.writeFile(sourceFile, sourceContent, "utf-8");

    const outputDir = path.join(tmpDir, "output");
    const config: any = {
      baseDir: tmpDir,
      output: { directory: outputDir },
      sources: [
        {
          name: "Local Source",
          url: `file://${sourceFile}`,
          enabled: true,
          category: "ads",
          priority: 1,
        },
      ],
    };

    const importCmd = new ImportCommand({ config, logger: mockLogger });
    const result = await importCmd.execute({});

    expect(result.success).toBe(true);
    expect(result.data.totalRules).toBe(4); // banner.com, analytics.com, ##.cosmetic-ad, #?#.extended-promo

    const importedFile = path.join(
      tmpDir,
      "filters",
      "output",
      "imported-rules.txt",
    );
    const saved = await fs.readFile(importedFile, "utf-8");
    expect(saved).toContain("||banner.com^");
    expect(saved).toContain("||analytics.com^");
    expect(saved).toContain("##.cosmetic-ad");
    expect(saved).toContain("#?#.extended-promo");
    expect(saved).not.toContain("[Adblock Plus 2.0]");
    expect(saved).not.toContain("! Header comment");
  });

  test("TestCommand correctly inspects blocked, allowed exceptions, and unblocked domains", async () => {
    const outputDir = path.join(tmpDir, "filters", "output");
    await fs.mkdir(outputDir, { recursive: true });

    const rawRules = [
      "||tracker.io^",
      "@@||safe.tracker.io^",
      "0.0.0.0 malware.org",
    ].join("\n");

    await fs.writeFile(
      path.join(outputDir, "imported-rules.txt"),
      rawRules,
      "utf-8",
    );

    const config: any = {
      baseDir: tmpDir,
      output: { directory: outputDir },
      sources: [],
    };

    const testCmd = new TestCommand({ config, logger: mockLogger });

    // Test wildcard block match
    const subMatch = await testCmd.execute({ domain: "api.tracker.io" });
    expect(subMatch.success).toBe(true);
    expect(subMatch.data.verdict).toBe("BLOCKED");

    // Test exception match
    const excMatch = await testCmd.execute({ domain: "safe.tracker.io" });
    expect(excMatch.success).toBe(true);
    expect(excMatch.data.verdict).toBe("ALLOWED");

    // Test exact match
    const exactMatch = await testCmd.execute({ domain: "malware.org" });
    expect(exactMatch.success).toBe(true);
    expect(exactMatch.data.verdict).toBe("BLOCKED");

    // Test unblocked
    const unblocked = await testCmd.execute({ domain: "wikipedia.org" });
    expect(unblocked.success).toBe(true);
    expect(unblocked.data.verdict).toBe("UNBLOCKED");
  });

  test("DiffCommand accurately calculates additions, removals, and unchanged counts", async () => {
    const fileA = path.join(tmpDir, "fileA.txt");
    const fileB = path.join(tmpDir, "fileB.txt");

    await fs.writeFile(fileA, "||common.com^\n||old.com^\n", "utf-8");
    await fs.writeFile(
      fileB,
      "||common.com^\n||new.com^\n||another-new.com^\n",
      "utf-8",
    );

    const config: any = { baseDir: tmpDir, sources: [] };
    const diffCmd = new DiffCommand({ config, logger: mockLogger });

    const result = await diffCmd.execute({ fileA, fileB });
    expect(result.success).toBe(true);
    expect(result.data.addedCount).toBe(2);
    expect(result.data.removedCount).toBe(1);
    expect(result.data.unchangedCount).toBe(1);
  });

  test("TestCommand supports custom rule file via file option", async () => {
    const customRuleFile = path.join(tmpDir, "custom-rules.txt");
    await fs.writeFile(
      customRuleFile,
      "||custom-blocked.com^\n@@||custom-blocked.com/allowed^\n",
      "utf-8",
    );

    const config: any = { baseDir: tmpDir, sources: [] };
    const testCmd = new TestCommand({ config, logger: mockLogger });

    const result = await testCmd.execute({
      domain: "sub.custom-blocked.com",
      file: customRuleFile,
    });
    expect(result.success).toBe(true);
    expect(result.data.verdict).toBe("BLOCKED");
  });

  test("ImportCommand creates and leverages cache on subsequent runs", async () => {
    const sourceFile = path.join(tmpDir, "cached-source.txt");
    await fs.writeFile(sourceFile, "||cached-domain.com^\n", "utf-8");

    const outputDir = path.join(tmpDir, "filters", "output");
    await fs.mkdir(outputDir, { recursive: true });

    const config: any = {
      baseDir: tmpDir,
      output: { directory: outputDir },
      sources: [
        {
          name: "Cached Source",
          url: `file://${sourceFile}`,
          enabled: true,
          category: "ads",
          priority: 1,
        },
      ],
    };

    const importCmd = new ImportCommand({ config, logger: mockLogger });
    const firstRun = await importCmd.execute({});
    expect(firstRun.success).toBe(true);

    const cacheFile = path.join(outputDir, ".cache.json");
    const cacheExists = await fs
      .stat(cacheFile)
      .then(() => true)
      .catch(() => false);
    expect(cacheExists).toBe(true);

    // Second run without force should hit cache / 304
    const secondRun = await importCmd.execute({});
    expect(secondRun.success).toBe(true);
    expect(secondRun.data.totalRules).toBe(1);
  });
});
