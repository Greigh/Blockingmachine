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
    expect(hostsContent).not.toContain("generic-banner");
    expect(hostsContent).not.toContain("browser-only.com");

    const dnsmasqContent = await fs.readFile(path.join(outputDir, "filter-list.dnsmasq"), "utf-8");
    expect(dnsmasqContent).toContain("address=/ads.example.com/0.0.0.0");
    expect(dnsmasqContent).toContain("address=/tracker.net/0.0.0.0");
    expect(dnsmasqContent).toContain("# EXCEPTION: @@||allowed.example.com^");
    expect(dnsmasqContent).not.toContain("generic-banner");
    expect(dnsmasqContent).not.toContain("browser-only.com");

    const adguardContent = await fs.readFile(path.join(outputDir, "filter-list.txt"), "utf-8");
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

    const importedFile = path.join(tmpDir, "filters", "output", "imported-rules.txt");
    const saved = await fs.readFile(importedFile, "utf-8");
    expect(saved).toContain("||banner.com^");
    expect(saved).toContain("||analytics.com^");
    expect(saved).toContain("##.cosmetic-ad");
    expect(saved).toContain("#?#.extended-promo");
    expect(saved).not.toContain("[Adblock Plus 2.0]");
    expect(saved).not.toContain("! Header comment");
  });
});
