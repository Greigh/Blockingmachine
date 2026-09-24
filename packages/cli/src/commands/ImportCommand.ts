import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import type { ImportOptions } from "./types.js";
import {
  createPaths,
  fetchWithConditionalCache,
  parseFilterList,
} from "@blockingmachine/core";
import fs from "fs/promises";
import path from "path";

interface CacheRecord {
  etag?: string | null;
  lastModified?: string | null;
  rules: string[];
}

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

      const cacheFile = path.join(paths.output.dir, ".cache.json");
      let cache: Record<string, CacheRecord> = {};
      if (!options.force) {
        try {
          const rawCache = await fs.readFile(cacheFile, "utf-8");
          cache = JSON.parse(rawCache);
        } catch {
          cache = {};
        }
      }

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
          // Download the filter list using robust core fetchWithConditionalCache
          this.logger.info(`Downloading from: ${source.url}`);
          const cached = !options.force ? cache[source.url] : undefined;
          const fetchRes = await fetchWithConditionalCache(source.url, {
            etag: cached?.etag || undefined,
            lastModified: cached?.lastModified || undefined,
          });

          let rules: string[] = [];
          if (fetchRes.notModified && cached?.rules) {
            this.logger.info(
              `✓ 304 Not Modified: ${source.name} (cached ${cached.rules.length} rules)`,
            );
            rules = cached.rules;
          } else if (fetchRes.content) {
            const parsedRules = parseFilterList(fetchRes.content, source.url);
            rules = parsedRules.map((r) => r.raw);
            cache[source.url] = {
              etag: fetchRes.etag,
              lastModified: fetchRes.lastModified,
              rules,
            };
          } else {
            this.logger.warn(`⚠ No content returned for: ${source.name}`);
            continue;
          }

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

      // Persist cache metadata
      try {
        await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2), "utf-8");
      } catch {
        // ignore cache write errors
      }

      // Save all rules to a combined file
      if (allRules.length > 0) {
        const outputFile = path.join(paths.output.dir, "imported-rules.txt");
        try {
          const raw = await fs.readFile(cacheFile, "utf-8");
          const cachedJson = JSON.parse(raw) as Record<string, CacheRecord>;
          const loadedRules: string[] = [];
          const seen = new Set<string>();
          for (const key of Object.keys(cachedJson)) {
            const entry = cachedJson[key];
            if (entry && Array.isArray(entry.rules)) {
              for (const r of entry.rules) {
                if (typeof r === "string" && !seen.has(r)) {
                  seen.add(r);
                  loadedRules.push(r);
                }
              }
            }
          }
          await fs.writeFile(outputFile, loadedRules.join("\n") + "\n", "utf-8");
          this.logger.info(
            `Saved ${loadedRules.length} unique rules to: ${outputFile}`,
          );
        } catch (writeErr) {
          this.logger.error("Failed to write imported rules:", writeErr);
        }
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
