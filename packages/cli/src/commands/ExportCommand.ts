import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import type { ExportOptions } from "../types.js";
import { createPaths } from "@blockingmachine/core";
import type { FilterListMetadata } from "../types.js";
import fs from "fs/promises";
import path from "path";

export class ExportCommand extends BaseCommand<ExportOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options: ExportOptions = {}): Promise<CommandResult> {
    try {
      this.logger.info("Starting export process...");

      const config = this.config;
      const baseDir = config.baseDir || process.cwd();
      const paths = createPaths(baseDir);

      // Create metadata for the filter list
      const meta: FilterListMetadata = {
        title: config.meta?.title || "Blockingmachine Filter List",
        description:
          config.meta?.description ||
          "Combined filter list from multiple sources",
        homepage:
          config.meta?.homepage || "https://github.com/greigh/blockingmachine",
        version: config.meta?.version || "1.0.0",
        lastUpdated: new Date().toISOString(),
      };

      // Read the imported rules
      const inputFile = path.join(paths.output.dir, "imported-rules.txt");
      let rules: string[] = [];

      try {
        const content = await fs.readFile(inputFile, "utf-8");
        rules = content.split("\n").filter((rule) => rule.trim());
        this.logger.info(`Loaded ${rules.length} rules from: ${inputFile}`);
      } catch (error) {
        this.logger.warn(
          `Could not read rules from ${inputFile}, creating empty filter lists`,
        );
      }

      // Generate filter lists in different formats
      const outputPath = options.outputPath || paths.output.dir;
      const formats = options.formats || ["adguard"];

      this.logger.info(`Exporting to: ${outputPath}`);

      const results = [];

      for (const format of formats) {
        try {
          let output = "";

          // Generate header
          const header = [
            `! Title: ${meta.title}`,
            `! Description: ${meta.description}`,
            `! Homepage: ${meta.homepage}`,
            `! Version: ${meta.version}`,
            `! Last updated: ${meta.lastUpdated}`,
            `! Rules count: ${rules.length}`,
            "",
          ].join("\n");

          // Format rules based on output format
          switch (format) {
            case "adguard":
              output = header + rules.join("\n");
              break;
            case "hosts":
              output =
                header.replace(/!/g, "#") +
                rules
                  .map(
                    (rule) =>
                      `0.0.0.0 ${rule.replace(/^\|\|/, "").replace(/\^.*$/, "")}`,
                  )
                  .join("\n");
              break;
            case "dnsmasq":
              output = rules
                .map(
                  (rule) =>
                    `address=/${rule.replace(/^\|\|/, "").replace(/\^.*$/, "")}/0.0.0.0`,
                )
                .join("\n");
              break;
            default:
              output = header + rules.join("\n");
          }

          const filename = `filter-list.${format === "adguard" ? "txt" : format}`;
          const filepath = path.join(outputPath, filename);

          await fs.writeFile(filepath, output);
          this.logger.info(`✓ Generated ${format} format: ${filename}`);
          results.push({ format, filename, rules: rules.length });
        } catch (error) {
          this.logger.error(`✗ Error generating ${format} format:`, error);
        }
      }

      this.logger.info("Export completed successfully");

      return this.success(
        {
          formats: results,
          totalRules: rules.length,
        },
        `Successfully exported ${results.length} filter list formats`,
      );
    } catch (error) {
      return this.failure(error as Error);
    }
  }
}
