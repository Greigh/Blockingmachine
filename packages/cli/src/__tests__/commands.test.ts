import { jest } from "@jest/globals";
import { ExportCommand } from "../commands/ExportCommand.js";
import { ImportCommand } from "../commands/ImportCommand.js";
import { TestCommand } from "../commands/TestCommand.js";
import { DiffCommand } from "../commands/DiffCommand.js";
import { ValidateCommand } from "../commands/ValidateCommand.js";
import { DoctorCommand } from "../commands/DoctorCommand.js";
import { ServeCommand } from "../commands/ServeCommand.js";
import http from "http";
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

  test("ValidateCommand validates and reports source counts and output paths", async () => {
    const config: any = {
      baseDir: tmpDir,
      mongodb: { uri: "mongodb://localhost:27017/blockingmachine" },
      output: { directory: path.join(tmpDir, "filters", "output") },
      sources: [
        { name: "Source 1", url: "https://example.com/1", enabled: true },
        { name: "Source 2", url: "https://example.com/2", enabled: false },
      ],
    };

    const validateCmd = new ValidateCommand({ config, logger: mockLogger });
    const result = await validateCmd.execute({});

    expect(result.success).toBe(true);
    expect(result.data.sourceCount).toBe(2);
    expect(result.data.enabledCount).toBe(1);
    expect(result.data.mongodb).toBe("mongodb://localhost:27017/blockingmachine");
  });

  test("ExportCommand handles unreachable sinkhole URL gracefully without crashing", async () => {
    const outputDir = path.join(tmpDir, "filters", "output");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      path.join(outputDir, "imported-rules.txt"),
      "||ads.test^\n",
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
      formats: ["hosts"],
      syncPihole: "http://127.0.0.1:59999/admin/api.php",
      webhook: "http://127.0.0.1:59999/webhook",
    });

    expect(result.success).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  test("DoctorCommand performs connectivity checks and produces scorecard report", async () => {
    const config: any = {
      baseDir: tmpDir,
      mongodb: { uri: "mongodb://127.0.0.1:59999/unreachable" },
      sources: [
        {
          name: "Test Source Offline",
          url: "http://127.0.0.1:59999/test-feed.txt",
          category: "ads",
        },
      ],
    };

    const doctorCmd = new DoctorCommand({ config, logger: mockLogger });
    const result = await doctorCmd.execute({ timeout: 200 });

    expect(result.success).toBe(true);
    expect(result.data.sourcesChecked).toBe(1);
    expect(result.data.sourcesHealthy).toBe(0);
    expect(result.data.mongoStatus).toBe("offline");
    expect(result.data.recommendations.length).toBeGreaterThan(0);
  });

  test("ServeCommand starts HTTP server and handles /health, /v1/check and /v1/rules", async () => {
    const outputDir = path.join(tmpDir, "filters", "output");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      path.join(outputDir, "imported-rules.txt"),
      "||tracker.io^\n@@||safe.tracker.io^\n",
      "utf-8",
    );

    const config: any = {
      baseDir: tmpDir,
      output: { directory: outputDir },
      sources: [],
    };

    const holder: { server?: http.Server } = {};
    const serveCmd = new ServeCommand({ config, logger: mockLogger });
    const port = 18053;

    const result = await serveCmd.execute({
      port,
      host: "127.0.0.1",
      serverInstanceHolder: holder,
    });

    expect(result.success).toBe(true);

    try {
      // 1. Check /health
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
      const healthData = (await healthRes.json()) as any;
      expect(healthData.status).toBe("ok");
      expect(healthData.rulesLoaded).toBe(2);

      // 2. Check /v1/check blocked
      const checkRes = await fetch(`http://127.0.0.1:${port}/v1/check?domain=sub.tracker.io`);
      expect(checkRes.status).toBe(200);
      const checkData = (await checkRes.json()) as any;
      expect(checkData.blocked).toBe(true);
      expect(checkData.matchedRules).toContain("||tracker.io^");

      // 3. Check /v1/check exception
      const exceptionRes = await fetch(`http://127.0.0.1:${port}/v1/check?domain=safe.tracker.io`);
      expect(exceptionRes.status).toBe(200);
      const exceptionData = (await exceptionRes.json()) as any;
      expect(exceptionData.blocked).toBe(false);
      expect(exceptionData.exceptionRule).toBe("@@||safe.tracker.io^");

      // 4. Check /v1/rules
      const rulesRes = await fetch(`http://127.0.0.1:${port}/v1/rules`);
      expect(rulesRes.status).toBe(200);
      const rulesData = (await rulesRes.json()) as any;
      expect(rulesData.totalRules).toBe(2);

      // 5. Check /v1/check rejects domain > 253 chars with 400
      const longDomain = "a".repeat(254) + ".com";
      const longDomainRes = await fetch(`http://127.0.0.1:${port}/v1/check?domain=${longDomain}`);
      expect(longDomainRes.status).toBe(400);

      // 6. Check unsupported POST method returns 405
      const postRes = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
      expect(postRes.status).toBe(405);
    } finally {
      if (holder.server) {
        await new Promise((r) => holder.server!.close(r));
      }
    }
  });
});

