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
import { ExportOptions } from "./types.js";
import type { MetaConfig } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf8"),
);

const logger = createLogger();
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
  .action(async (cmdOptions) => {
    try {
      const config = await loadConfig();
      const cmd = new ExportCommand({ config, logger });
      await cmd.execute({
        outputPath: cmdOptions.outputPath,
      });
    } catch (error) {
      logger.error(
        "Export failed:",
        error instanceof Error ? error.message : String(error),
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
      await cmd.execute({ force: Boolean(cmdOptions.force) });
    } catch (error) {
      logger.error("Import failed:", error);
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
      await cmd.execute({
        verbose: Boolean(cmdOptions.verbose),
      });
    } catch (error) {
      logger.error(
        "Validation failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  });

program.parse();
