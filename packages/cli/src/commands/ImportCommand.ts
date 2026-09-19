import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import type { ImportOptions } from "./types.js";
import { createPaths, fetchContent } from "@blockingmachine/core";
import fs from "fs/promises";
import path from "path";

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
      await fs.mkdir(paths.output.dir, { recursive: true });

      // Process each enabled source
      let totalProcessed = 0;
      let totalSources = 0;
      const allRules: string[] = [];
      const seenRules = new Set<string>();

      for (const source of config.sources) {
        if (!source.enabled) {
          this.logger.info(`Skipping disabled source: ${source.name}`);
          continue;
        }

        totalSources++;
        this.logger.info(`Processing source: ${source.name}`);

        try {
          // Download the filter list using robust core fetchContent
          this.logger.info(`Downloading from: ${source.url}`);
          const content = await fetchContent(source.url);

          if (!content) {
            this.logger.warn(`⚠ No content returned for: ${source.name}`);
            continue;
          }

          // Extract non-comment lines
          const rules = content
            .split("\n")
            .map((line: string) => line.trim())
            .filter(
              (line: string) =>
                line &&
                !line.startsWith("!") &&
                !line.startsWith("#") &&
                !line.startsWith("["),
            );

          if (rules && rules.length > 0) {
            let newlyAdded = 0;
            for (const rule of rules) {
              if (!seenRules.has(rule)) {
                seenRules.add(rule);
                allRules.push(rule);
                newlyAdded++;
              }
            }
            totalProcessed++;
            this.logger.info(
              `✓ Successfully processed: ${source.name} (${rules.length} rules, ${newlyAdded} unique added)`,
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
        this.logger.info(`Saved ${allRules.length} unique rules to: ${outputFile}`);
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
