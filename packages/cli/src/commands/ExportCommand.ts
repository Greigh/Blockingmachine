import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import type { ExportOptions } from "../types.js";
import {
  createPaths,
  cleanDomainPattern,
  parseFilterList,
  filterDNSRules,
  formatAdguardRule,
  resolveDnsPrecedence,
} from "@blockingmachine/core";
import type { FilterListMetadata } from "../types.js";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";

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

      const formats = options.formats || ["hosts", "dnsmasq", "adguard"];
      const outputPath =
        options.output || options.outputPath || path.join(paths.output.dir, "export");

      // Read rules from imported file or database
      const importedRulesPath = path.join(
        paths.output.dir,
        "imported-rules.txt",
      );
      let rules: string[] = [];

      try {
        const content = await fs.readFile(importedRulesPath, "utf-8");
        rules = content.split("\n").filter((line) => line.trim().length > 0);
        this.logger.info(`Loaded ${rules.length} rules from: ${importedRulesPath}`);
      } catch {
        this.logger.warn(
          "Could not read imported rules file, using empty rule set",
        );
      }

      const results = [];
      const parsedRules =
        rules.length > 0
          ? parseFilterList(rules.join("\n"), "imported-rules")
          : [];
      const dnsSafeRules = filterDNSRules(parsedRules);

      this.logger.info(`Exporting to: ${outputPath}`);

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
            case "adguard": {
              const formattedRules =
                parsedRules.length > 0
                  ? parsedRules.map((r) => formatAdguardRule(r)).filter(Boolean)
                  : rules;
              const adgHeader = [
                `! Title: ${meta.title}`,
                `! Description: ${meta.description}`,
                `! Homepage: ${meta.homepage}`,
                `! Version: ${meta.version}`,
                `! Last updated: ${meta.lastUpdated}`,
                `! Rules count: ${formattedRules.length}`,
                "",
              ].join("\n");
              output = adgHeader + formattedRules.join("\n");
              break;
            }
            case "hosts": {
              const precedence = resolveDnsPrecedence(dnsSafeRules);
              const formattedRules: string[] = [];
              for (const rule of precedence.activeBlocks) {
                const domain = cleanDomainPattern(rule.raw) || rule.domain;
                if (domain) {
                  formattedRules.push(`0.0.0.0 ${domain}`);
                }
              }
              for (const rule of precedence.effectiveExceptions) {
                formattedRules.push(`# EXCEPTION: ${rule.raw}`);
              }
              const hostsHeader = [
                `# Title: ${meta.title}`,
                `# Description: ${meta.description}`,
                `# Homepage: ${meta.homepage}`,
                `# Version: ${meta.version}`,
                `# Last updated: ${meta.lastUpdated}`,
                `# Rules count: ${formattedRules.length}`,
                "",
              ].join("\n");
              output = hostsHeader + formattedRules.join("\n");
              break;
            }
            case "dnsmasq": {
              const precedence = resolveDnsPrecedence(dnsSafeRules);
              const formattedRules: string[] = [];
              for (const rule of precedence.activeBlocks) {
                const domain = cleanDomainPattern(rule.raw) || rule.domain;
                if (domain) {
                  formattedRules.push(`address=/${domain}/0.0.0.0`);
                }
              }
              for (const sub of precedence.subdomainExceptions) {
                formattedRules.push(`server=/${sub.subdomain}/#`);
              }
              for (const rule of precedence.effectiveExceptions) {
                formattedRules.push(`# EXCEPTION: ${rule.raw}`);
              }
              const dnsmasqHeader = [
                `# Title: ${meta.title}`,
                `# Description: ${meta.description}`,
                `# Homepage: ${meta.homepage}`,
                `# Version: ${meta.version}`,
                `# Last updated: ${meta.lastUpdated}`,
                `# Rules count: ${formattedRules.length}`,
                "",
              ].join("\n");
              output = dnsmasqHeader + formattedRules.join("\n");
              break;
            }
            default:
              output = header + rules.join("\n");
          }

          const filename = `filter-list.${format === "adguard" ? "txt" : format}`;
          const filepath = path.join(outputPath, filename);

          await fs.mkdir(outputPath, { recursive: true });
          await fs.writeFile(filepath, output);
          this.logger.info(`✓ Generated ${format} format: ${filename}`);
          results.push({ format, filename, rules: rules.length });
        } catch (error) {
          this.logger.error(`✗ Error generating ${format} format:`, error);
        }
      }

      // Handle external sync hooks
      if (options.syncPihole) {
        try {
          let piholeUrl = options.syncPihole.trim();
          if (!piholeUrl.startsWith("http://") && !piholeUrl.startsWith("https://")) {
            piholeUrl = `http://${piholeUrl}`;
          }
          this.logger.info(`Syncing with Pi-hole at: ${piholeUrl}`);
          const res = await fetch(piholeUrl, {
            method: "GET",
            signal: AbortSignal.timeout(6000),
          });
          if (res.ok) {
            this.logger.info(
              `✓ Pi-hole sync triggered successfully (${res.status})`,
            );
          } else {
            this.logger.warn(`⚠️ Pi-hole responded with status ${res.status}`);
          }
        } catch (err: any) {
          this.logger.warn(
            `⚠️ Failed to sync with Pi-hole: ${err?.message || err}`,
          );
        }
      }

      if (options.webhook) {
        try {
          let webhookUrl = options.webhook.trim();
          if (!webhookUrl.startsWith("http://") && !webhookUrl.startsWith("https://")) {
            webhookUrl = `http://${webhookUrl}`;
          }
          this.logger.info(`Sending webhook notification to: ${webhookUrl}`);
          const res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: "filter_list_exported",
              timestamp: new Date().toISOString(),
              totalRules: rules.length,
              formats: results,
            }),
            signal: AbortSignal.timeout(6000),
          });
          if (res.ok) {
            this.logger.info(`✓ Webhook notified successfully (${res.status})`);
          } else {
            this.logger.warn(`⚠️ Webhook responded with status ${res.status}`);
          }
        } catch (err: any) {
          this.logger.warn(
            `⚠️ Failed to trigger webhook: ${err?.message || err}`,
          );
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
