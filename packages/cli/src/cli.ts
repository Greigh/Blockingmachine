#!/usr/bin/env node

import dotenv from "dotenv";
// `quiet` because the loader's own banner goes to stdout, and stdout is where `--json` writes its
// payload: a banner line above the document makes the document unparseable in exactly the way the
// colourised logger does, and it is printed before any command gets a chance to decide whether the
// run is machine-readable.
dotenv.config({ quiet: true });

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Command } from "commander";
import { createLogger, writeJson } from "./lib/logger.js";
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
import { CoverageCommand } from "./commands/CoverageCommand.js";
import { TierPlanCommand } from "./commands/TierPlanCommand.js";
import { listRuleSnapshots, rollbackSnapshot } from "./lib/db.js";
import { EXPORT_FORMATS, type SupportedFormat } from "@blockingmachine/core";
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

/**
 * Parse `--format privoxy,bind` into the typed format list.
 *
 * An unknown name is an error rather than something skipped. Before this option existed there was
 * no way to choose a format from the CLI at all, which left `privoxy` and `bind` — both of which the
 * README advertises — unreachable from the command line; quietly ignoring a typo would put the
 * caller back in exactly that position while appearing to succeed.
 */
function parseExportFormats(raw: unknown): SupportedFormat[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const requested = raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const unknown = requested.filter(
    (name) => !(EXPORT_FORMATS as readonly string[]).includes(name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown export format: ${unknown.join(", ")}. Valid formats: ${EXPORT_FORMATS.join(", ")}.`,
    );
  }
  return requested as SupportedFormat[];
}

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
  .option(
    "-f, --format <formats>",
    `Comma-separated formats to write (${EXPORT_FORMATS.join(", ")}). Defaults to hosts,dnsmasq,adguard.`,
  )
  .option("--sync-pihole <url>", "Pi-hole reload/update endpoint URL")
  .option("--webhook <url>", "Webhook URL to notify upon completion")
  .action(async (cmdOptions) => {
    try {
      const config = await loadConfig();
      const cmd = new ExportCommand({ config, logger });
      const result = await cmd.execute({
        outputPath: cmdOptions.outputPath,
        formats: parseExportFormats(cmdOptions.format),
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
          // `--verbose` asks for the detail, and the detail is a payload: printed raw so a caller
          // can pipe it into `jq`, like every other command's `--json`.
          writeJson(result.data);
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
  .option("--provider <type>", "AI provider: mini-ai, local-heuristics, ollama, gemini, openai", "mini-ai")
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
  .option(
    "--cascade",
    "Screen every candidate with the embedded classifier and escalate only undecided ones to the provider",
  )
  .option("--escalate-clean", "In cascade mode, also escalate uncertain *clean* verdicts (discovery mode)")
  .option("--max-escalations <number>", "Model calls the cascade may spend per scan", "25")
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
        cascade: cmdOptions.cascade === true,
        escalateClean: cmdOptions.escalateClean === true,
        maxEscalations: cmdOptions.maxEscalations
          ? parseInt(cmdOptions.maxEscalations, 10)
          : undefined,
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
  .option("--provider <type>", "AI provider: mini-ai, local-heuristics, ollama, gemini, openai", "mini-ai")
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

program
  .command("coverage")
  .description("[Beta] Measure how much of the compiled list real browsing actually matched")
  .option("-r, --rules <file>", "Compiled rule list to measure against")
  .option("-t, --trace <file>", "Request trace: one host or URL per line, optional trailing count")
  .option("--hits <file>", "Rule-hit ledger: count<TAB>rule per line, as exported by the extension")
  .option("--hot", "Measure the coverage-derived hot set instead of the full compiled export")
  .option("--top <number>", "How many hottest rules to list", "10")
  .option("--json", "Output machine-readable JSON result")
  .action(async (cmdOptions: { rules?: string; trace?: string; hits?: string; hot?: boolean; top?: string; json?: boolean }) => {
    try {
      const config = await loadConfig();
      const cmd = new CoverageCommand({ config, logger });
      const res = await cmd.execute({
        rules: cmdOptions.rules,
        trace: cmdOptions.trace,
        hits: cmdOptions.hits,
        hot: cmdOptions.hot,
        top: cmdOptions.top ? parseInt(cmdOptions.top, 10) : 10,
        json: cmdOptions.json,
      });
      if (!res.success && !cmdOptions.json) {
        process.exit(1);
      }
    } catch (error) {
      logger.error(
        `Coverage analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

program
  .command("tier-plan")
  .description("[Beta] Report which static tiers are worth keeping on, and at what capacity")
  .option("-d, --rules-dir <dir>", "Directory holding the tier_*.json rulesets", "rules")
  .option("--hits <file>", "Rule-hit ledger, as exported by the extension, to weight the plan by what blocked")
  .option("--synced <file>", "The synced list the dynamic rules are built from, to report tiers it already covers")
  .option("-c, --capacity <number>", "Static slots to plan against", "30000")
  .option("-e, --enabled <ids>", "Comma-separated tiers to treat as currently on")
  .option("--json", "Output machine-readable JSON result")
  .action(async (cmdOptions: { rulesDir?: string; hits?: string; synced?: string; capacity?: string; enabled?: string; json?: boolean }) => {
    try {
      const config = await loadConfig();
      const cmd = new TierPlanCommand({ config, logger });
      const capacity = cmdOptions.capacity ? parseInt(cmdOptions.capacity, 10) : undefined;
      const res = await cmd.execute({
        rulesDir: cmdOptions.rulesDir,
        hits: cmdOptions.hits,
        synced: cmdOptions.synced,
        capacity: Number.isFinite(capacity) ? capacity : undefined,
        enabled: cmdOptions.enabled,
        json: cmdOptions.json,
      });
      if (!res.success && !cmdOptions.json) {
        process.exit(1);
      }
    } catch (error) {
      logger.error(
        `Tier plan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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

