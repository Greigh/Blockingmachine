import { jest } from "@jest/globals";
import { ExportCommand } from "../commands/ExportCommand.js";
import { ImportCommand } from "../commands/ImportCommand.js";
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

  test("ExportCommand formats hosts and dnsmasq correctly with exception and comment handling", async () => {
    const outputDir = path.join(tmpDir, "filters", "output");
    await fs.mkdir(outputDir, { recursive: true });

    const rawRules = [
      "! A comment line",
      "||ads.example.com^",
      "@@||allowed.example.com^",
      "tracker.net",
    ].join("\n");

    await fs.writeFile(path.join(outputDir, "imported-rules.txt"), rawRules, "utf-8");

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

    const hostsContent = await fs.readFile(path.join(outputDir, "filter-list.hosts"), "utf-8");
    expect(hostsContent).toContain("0.0.0.0 ads.example.com");
    expect(hostsContent).toContain("0.0.0.0 tracker.net");
    expect(hostsContent).toContain("# EXCEPTION: @@||allowed.example.com^");
    expect(hostsContent).not.toContain("0.0.0.0 !");

    const dnsmasqContent = await fs.readFile(path.join(outputDir, "filter-list.dnsmasq"), "utf-8");
    expect(dnsmasqContent).toContain("address=/ads.example.com/0.0.0.0");
    expect(dnsmasqContent).toContain("address=/tracker.net/0.0.0.0");
    expect(dnsmasqContent).toContain("# EXCEPTION: @@||allowed.example.com^");

    const adguardContent = await fs.readFile(path.join(outputDir, "filter-list.txt"), "utf-8");
    expect(adguardContent).toContain("||ads.example.com^");
    expect(adguardContent).toContain("@@||allowed.example.com^");
  });

  test("ImportCommand imports and deduplicates rules from local file source", async () => {
    const sourceFile = path.join(tmpDir, "sample-source.txt");
    const sourceContent = [
      "[Adblock Plus 2.0]",
      "! Header comment",
      "||banner.com^",
      "||banner.com^",
      "||analytics.com^",
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
    expect(result.data.totalRules).toBe(2); // banner.com and analytics.com (deduplicated)

    const importedFile = path.join(tmpDir, "filters", "output", "imported-rules.txt");
    const saved = await fs.readFile(importedFile, "utf-8");
    expect(saved).toContain("||banner.com^");
    expect(saved).toContain("||analytics.com^");
    expect(saved).not.toContain("[Adblock Plus 2.0]");
  });
});
