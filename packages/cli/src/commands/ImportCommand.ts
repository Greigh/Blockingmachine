import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import type { ImportOptions } from "./types.js";
import { createPaths } from "@blockingmachine/core";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

export class ImportCommand extends BaseCommand<ImportOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options: ImportOptions = {}): Promise<CommandResult> {
    try {
      this.logger.info("Starting import process...");

      const config = this.config;
      const baseDir = config.baseDir || process.cwd();
      const paths = createPaths(baseDir);

      // Create output directory if it doesn't exist
      await fs.mkdir(path.dirname(paths.output.dir), { recursive: true });

      // Process each enabled source
      let totalProcessed = 0;
      let totalSources = 0;
      const allRules: string[] = [];

      for (const source of config.sources) {
        if (!source.enabled) {
          this.logger.info(`Skipping disabled source: ${source.name}`);
          continue;
        }

        totalSources++;
        this.logger.info(`Processing source: ${source.name}`);

        try {
          // Download the filter list
          this.logger.info(`Downloading from: ${source.url}`);
          const response = await fetch(source.url);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const content = await response.text();

          // Simple parsing - just extract non-comment lines
          const rules = content
            .split("\n")
            .map((line) => line.trim())
            .filter(
              (line) => line && !line.startsWith("!") && !line.startsWith("#"),
            )
            .filter((line) => line.length > 0);

          if (rules && rules.length > 0) {
            allRules.push(...rules);
            totalProcessed++;
            this.logger.info(
              `✓ Successfully processed: ${source.name} (${rules.length} rules)`,
            );
          } else {
            this.logger.warn(`⚠ No rules found for: ${source.name}`);
          }
        } catch (error) {
          this.logger.error(`✗ Error processing ${source.name}:`, error);
        }
      }

      // Save all rules to a combined file
      if (allRules.length > 0) {
        const outputFile = path.join(paths.output.dir, "imported-rules.txt");
        await fs.writeFile(outputFile, allRules.join("\n"));
        this.logger.info(`Saved ${allRules.length} rules to: ${outputFile}`);
      }

      this.logger.info(
        `Import completed: ${totalProcessed}/${totalSources} sources processed successfully`,
      );

      return this.success(
        {
          totalSources,
          processedSources: totalProcessed,
          failedSources: totalSources - totalProcessed,
          totalRules: allRules.length,
        },
        `Successfully processed ${totalProcessed} out of ${totalSources} sources (${allRules.length} total rules)`,
      );
    } catch (error) {
      return this.failure(error as Error);
    }
  }
}
