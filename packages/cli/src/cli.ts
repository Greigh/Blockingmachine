#!/usr/bin/env node

import dotenv from "dotenv";
dotenv.config();

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Command } from "commander";
import { createLogger } from "./lib/logger.js";
import { loadConfig as loadConfigFromLib } from "./lib/config.js";
import { CATEGORIES, type AppConfig, type RawConfig } from "./types.js";
import { defaultMetaConfig } from "./lib/constants.js";
import { ImportCommand } from "./commands/ImportCommand.js";
import { ExportCommand } from "./commands/ExportCommand.js";
import { ValidateCommand } from "./commands/ValidateCommand.js";
import { TestCommand } from "./commands/TestCommand.js";
import { DiffCommand } from "./commands/DiffCommand.js";
import { DoctorCommand } from "./commands/DoctorCommand.js";
import { ShellCommand } from "./commands/ShellCommand.js";
import { ServeCommand } from "./commands/ServeCommand.js";
import { AiScanCommand } from "./commands/AiScanCommand.js";
import { AiCrawlCommand } from "./commands/AiCrawlCommand.js";
import { listRuleSnapshots, rollbackSnapshot } from "./lib/db.js";
import type { MetaConfig } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf8"),
);

const logger = createLogger();

process.on("unhandledRejection", (reason) => {
  logger.error(
    `Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`,
  );
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.error(`Uncaught exception: ${error.stack || error.message}`);
  process.exit(1);
});

const program = new Command();

async function loadConfig(): Promise<AppConfig> {
  const rawConfig = (await loadConfigFromLib()) as RawConfig;

  // Create a properly typed meta object by merging default with any provided values
  const meta: MetaConfig = {
    ...defaultMetaConfig,
    ...rawConfig.meta,
  };

  return {
    ...rawConfig,
    baseDir: rawConfig.baseDir || process.cwd(),
    meta, // Now correctly typed
    debug: rawConfig.debug || false,
    mongodb: rawConfig.mongodb || {
      uri: "mongodb://localhost:27017/blockingmachine",
      options: { maxPoolSize: 10 },
    },
    output: rawConfig.output || {
      directory: "./filters/output",
    },
    sources: rawConfig.sources
      .filter((source) => source.name && source.url && source.category)
      .map((source) => ({
        name: source.name!,
        url: source.url!,
        category: source.category!,
        enabled: source.enabled ?? true,
        priority:
          source.priority ?? CATEGORIES[source.category!]?.priority ?? 50,
      })),
  };
}

program
  .name("blockingmachine")
  .description("Filter list manager and compiler")
  .version(pkg.version);

program
  .command("export")
  .description("Export filter lists")
  .option("-o, --output-path <path>", "Output path")
  .option("--sync-pihole <url>", "Pi-hole reload/update endpoint URL")
  .option("--webhook <url>", "Webhook URL to notify upon completion")
  .action(async (cmdOptions) => {
    try {
      const config = await loadConfig();
      const cmd = new ExportCommand({ config, logger });
      const result = await cmd.execute({
        outputPath: cmdOptions.outputPath,
        syncPihole: cmdOptions.syncPihole,
        webhook: cmdOptions.webhook,
      });
      if (!result.success) {
        process.exit(1);
      }
    } catch (error) {
      logger.error(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

program
  .command("import")
  .description("Import filter lists")
  .option("-f, --force", "Force import even if unchanged")
  .action(async (cmdOptions: { force?: boolean }) => {
    try {
      const config = await loadConfig();
      const cmd = new ImportCommand({ config, logger });
      const result = await cmd.execute({ force: Boolean(cmdOptions.force) });
      if (!result.success) {
        process.exit(1);
      }
    } catch (error) {
      logger.error(
        `Import failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

program
  .command("validate")
  .description("Validate configuration")
  .option("-v, --verbose", "Show detailed validation info")
  .action(async (cmdOptions) => {
    try {
      const config = await loadConfig();
      const cmd = new ValidateCommand({ config, logger });
      const result = await cmd.execute({
        verbose: Boolean(cmdOptions.verbose),
      });
      if (result.success) {
        logger.info(result.message);
        if (cmdOptions.verbose && result.data) {
          logger.info(JSON.stringify(result.data, null, 2));
        }
      } else {
        logger.error(result.message);
        process.exit(1);
      }
    } catch (error) {
      logger.error(
        `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

program
  .command("test <domain>")
  .description(
    "Test and inspect how a domain or URL is handled by compiled rules",
  )
  .option("-f, --file <path>", "Specific rule file to test against")
  .action(async (domain: string, cmdOptions: { file?: string }) => {
    try {
      const config = await loadConfig();
      const cmd = new TestCommand({ config, logger });
      const result = await cmd.execute({ domain, file: cmdOptions.file });
      if (!result.success) {
        process.exit(1);
      }
    } catch (error) {
      logger.error(
        `Test failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

program
  .command("diff <fileA> <fileB>")
  .description("Compare two filter list files and inspect added/removed rules")
  .action(async (fileA: string, fileB: string) => {
    try {
      const config = await loadConfig();
      const cmd = new DiffCommand({ config, logger });
      const result = await cmd.execute({ fileA, fileB });
      if (!result.success) {
        process.exit(1);
      }
    } catch (error) {
      logger.error(
        `Diff failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Perform system, database, and source feed connectivity health checks")
  .option("-t, --timeout <ms>", "Per-source request timeout in milliseconds", "5000")
  .action(async (cmdOptions: { timeout: string }) => {
    try {
      const config = await loadConfig();
      const cmd = new DoctorCommand({ config, logger });
      const result = await cmd.execute({
        timeout: parseInt(cmdOptions.timeout, 10) || 5000,
      });
      if (!result.success) {
        process.exit(1);
      }
    } catch (error) {
      logger.error(
        `Doctor check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

program
  .command("shell")
  .description("Launch interactive REPL for testing and inspecting rules in real-time")
  .action(async () => {
    try {
      const config = await loadConfig();
      const cmd = new ShellCommand({ config, logger });
      await cmd.execute();
    } catch (error) {
      logger.error(
        `Shell failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

program
  .command("serve")
  .description("Start local HTTP server with real-time domain inspection API endpoints")
  .option("-p, --port <number>", "HTTP port to bind", "8053")
  .option("-h, --host <host>", "Host interface to bind", "127.0.0.1")
  .action(async (cmdOptions: { port: string; host: string }) => {
    try {
      const config = await loadConfig();
      const cmd = new ServeCommand({ config, logger });
      await cmd.execute({
        port: parseInt(cmdOptions.port, 10) || 8053,
        host: cmdOptions.host || "127.0.0.1",
      });
    } catch (error) {
      logger.error(
        `Server failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

program
  .command("ai-scan [target]")
  .description("[Beta] Scan domain, URL, or sinkhole query logs using AI Radar")
  .option("--provider <type>", "AI provider: ollama, gemini, openai, local-heuristics", "local-heuristics")
  .option("--ollama-url <url>", "Ollama server URL", "http://127.0.0.1:11434")
  .option("--model <name>", "Model name (e.g. llama3.2, gemini-2.0-flash, gpt-4o-mini)")
  .option("--api-key <key>", "API key for Gemini or OpenAI")
  .option("--querylog <service>", "Pull and scan live query logs from 'adguard' or 'pihole'")
  .option("--adguard-url <url>", "AdGuard Home base URL", "http://127.0.0.1:3000")
  .option("--adguard-user <user>", "AdGuard Home username")
  .option("--adguard-pass <pass>", "AdGuard Home password")
  .option("--pihole-url <url>", "Pi-hole base URL", "http://127.0.0.1")
  .option("--pihole-token <token>", "Pi-hole web API token")
  .option("--limit <number>", "Number of queries to analyze", "50")
  .option("--json", "Output machine-readable JSON result")
  .action(async (target, cmdOptions) => {
    try {
      const config = await loadConfig();
      const cmd = new AiScanCommand({ config, logger });
      const res = await cmd.execute({
        target,
        provider: cmdOptions.provider,
        ollamaUrl: cmdOptions.ollamaUrl,
        model: cmdOptions.model,
        apiKey: cmdOptions.apiKey,
        querylog: cmdOptions.querylog,
        adguardUrl: cmdOptions.adguardUrl,
        adguardUser: cmdOptions.adguardUser,
        adguardPass: cmdOptions.adguardPass,
        piholeUrl: cmdOptions.piholeUrl,
        piholeToken: cmdOptions.piholeToken,
        limit: cmdOptions.limit ? parseInt(cmdOptions.limit, 10) : 50,
        json: cmdOptions.json,
      });
      if (!res.success && !cmdOptions.json) {
        process.exit(1);
      }
    } catch (error) {
      logger.error(
        `AI Scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

program
  .command("ai-crawl <url>")
  .description("[Beta] Crawl web page, extract third-party origins, and detect ad servers")
  .option("--provider <type>", "AI provider: ollama, gemini, openai, local-heuristics", "local-heuristics")
  .option("--ollama-url <url>", "Ollama server URL", "http://127.0.0.1:11434")
  .option("--model <name>", "Model name")
  .option("--api-key <key>", "API key for Gemini or OpenAI")
  .option("--json", "Output machine-readable JSON result")
  .action(async (url, cmdOptions) => {
    try {
      const config = await loadConfig();
      const cmd = new AiCrawlCommand({ config, logger });
      const res = await cmd.execute({
        url,
        provider: cmdOptions.provider,
        ollamaUrl: cmdOptions.ollamaUrl,
        model: cmdOptions.model,
        apiKey: cmdOptions.apiKey,
        json: cmdOptions.json,
      });
      if (!res.success) {
        process.exit(1);
      }
    } catch (error) {
      logger.error(`AI Crawl failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

const snapshotProgram = program
  .command("snapshot")
  .description("Manage database snapshots and rollbacks");

snapshotProgram
  .command("list")
  .description("List all available rule snapshots")
  .action(async () => {
    try {
      const config = await loadConfig();
      const snapshots = await listRuleSnapshots(config.baseDir);
      if (snapshots.length === 0) {
        logger.info("No snapshots found.");
      } else {
        logger.info(`Available Snapshots (${snapshots.length}):`);
        for (const s of snapshots) {
          logger.info(`  • ${s.snapshotId} [${s.ruleCount} rules] - ${s.description} (${s.timestamp})`);
        }
      }
    } catch (error) {
      logger.error(`Failed to list snapshots: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

snapshotProgram
  .command("rollback <snapshotId>")
  .description("Rollback rule database to a previous snapshot")
  .action(async (snapshotId: string) => {
    try {
      const config = await loadConfig();
      const res = await rollbackSnapshot(snapshotId, config.baseDir);
      if (res.success) {
        logger.info(`✓ ${res.message}`);
      } else {
        logger.error(`✗ ${res.message}`);
        process.exit(1);
      }
    } catch (error) {
      logger.error(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program.parse();

