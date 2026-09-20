import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import { connectDB, disconnectDB } from "../lib/db.js";
import chalk from "chalk";
import os from "os";

export interface DoctorOptions {
  timeout?: number;
}

export interface SourceHealthCheck {
  name: string;
  url: string;
  category: string;
  status: "ok" | "unreachable" | "slow" | "error";
  statusCode?: number;
  latencyMs?: number;
  error?: string;
}

export interface DoctorReport {
  nodeVersion: string;
  platform: string;
  mongoStatus: "connected" | "offline" | "failed";
  mongoUri: string;
  sourcesChecked: number;
  sourcesHealthy: number;
  averageLatencyMs: number;
  sourceResults: SourceHealthCheck[];
  recommendations: string[];
}

export class DoctorCommand extends BaseCommand<DoctorOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options?: DoctorOptions): Promise<CommandResult> {
    const timeout = options?.timeout ?? 5000;
    const recommendations: string[] = [];

    this.logger.info(chalk.bold.cyan("\n🩺 Running Blockingmachine System Doctor...\n"));

    // 1. Environment info
    const nodeVersion = process.version;
    const platform = `${os.platform()} ${os.arch()} (${os.release()})`;
    this.logger.info(chalk.dim(`  Node:     ${nodeVersion}`));
    this.logger.info(chalk.dim(`  OS:       ${platform}`));

    // 2. Database check
    let mongoStatus: "connected" | "offline" | "failed" = "offline";
    const mongoUri = this.config.mongodb?.uri || "mongodb://localhost:27017/blockingmachine";
    try {
      const connected = await connectDB(this.config.mongodb, true);
      if (connected) {
        mongoStatus = "connected";
        this.logger.info(chalk.green(`  MongoDB:  Connected (${mongoUri})`));
        await disconnectDB();
      } else {
        mongoStatus = "offline";
        this.logger.info(chalk.yellow(`  MongoDB:  Offline / fallback file mode (${mongoUri})`));
        recommendations.push("MongoDB is not running. Filter lists will operate in offline JSON/text mode.");
      }
    } catch {
      mongoStatus = "failed";
      this.logger.info(chalk.red(`  MongoDB:  Connection failed (${mongoUri})`));
      recommendations.push("Verify MongoDB host and credentials in your config.");
    }

    // 3. Check sources
    const sources = this.config.sources || [];
    this.logger.info(chalk.bold(`\n📡 Probing ${sources.length} Configured Filter Sources:`));

    const sourceResults: SourceHealthCheck[] = [];
    let totalLatency = 0;
    let healthyCount = 0;

    for (const source of sources) {
      const startTime = Date.now();

      // Check local files directly without network fetch
      if (!source.url.startsWith("http://") && !source.url.startsWith("https://")) {
        try {
          const fs = await import("fs/promises");
          const { fileURLToPath } = await import("url");
          const filePath = source.url.startsWith("file://")
            ? fileURLToPath(source.url)
            : source.url;
          const stat = await fs.stat(filePath);
          const latencyMs = Date.now() - startTime;
          totalLatency += latencyMs;

          if (stat.isFile()) {
            healthyCount++;
            sourceResults.push({
              name: source.name,
              url: source.url,
              category: source.category,
              status: "ok",
              statusCode: 200,
              latencyMs,
            });
            this.logger.info(
              `  ${chalk.green("✓")} ${chalk.bold(source.name)} [${source.category}] - ${chalk.cyan("Local File")} - ${chalk.green(`${latencyMs}ms`)}`,
            );
          } else {
            sourceResults.push({
              name: source.name,
              url: source.url,
              category: source.category,
              status: "error",
              statusCode: 404,
              latencyMs,
            });
            this.logger.info(
              `  ${chalk.red("✗")} ${chalk.bold(source.name)} - Local path is not a regular file`,
            );
            recommendations.push(`Local source '${source.name}' is not a regular file.`);
          }
        } catch (localErr: any) {
          const latencyMs = Date.now() - startTime;
          const errMsg = localErr?.message || String(localErr);
          sourceResults.push({
            name: source.name,
            url: source.url,
            category: source.category,
            status: "unreachable",
            latencyMs,
            error: errMsg,
          });
          this.logger.info(
            `  ${chalk.red("✗")} ${chalk.bold(source.name)} - ${chalk.red(errMsg)}`,
          );
          recommendations.push(`Local source '${source.name}' cannot be accessed: ${errMsg}`);
        }
        continue;
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        let response: globalThis.Response;
        try {
          response = await fetch(source.url, {
            method: "HEAD",
            signal: controller.signal,
          });

          // Fallback to lightweight ranged GET if HEAD is forbidden or not allowed by CDN
          if ((response.status === 405 || response.status === 403) && !controller.signal.aborted) {
            response = await fetch(source.url, {
              method: "GET",
              headers: { Range: "bytes=0-50" },
              signal: controller.signal,
            });
          }
        } finally {
          clearTimeout(timer);
        }

        const latencyMs = Date.now() - startTime;
        totalLatency += latencyMs;

        if (response.ok || response.status === 206) {
          healthyCount++;
          const status = latencyMs > 2000 ? "slow" : "ok";
          sourceResults.push({
            name: source.name,
            url: source.url,
            category: source.category,
            status,
            statusCode: response.status,
            latencyMs,
          });

          const latencyLabel =
            latencyMs > 2000 ? chalk.yellow(`${latencyMs}ms (slow)`) : chalk.green(`${latencyMs}ms`);
          this.logger.info(
            `  ${chalk.green("✓")} ${chalk.bold(source.name)} [${source.category}] - ${chalk.cyan(response.status)} - ${latencyLabel}`,
          );
        } else {
          sourceResults.push({
            name: source.name,
            url: source.url,
            category: source.category,
            status: "error",
            statusCode: response.status,
            latencyMs,
          });
          this.logger.info(
            `  ${chalk.red("✗")} ${chalk.bold(source.name)} - HTTP ${response.status} (${response.statusText})`,
          );
          recommendations.push(`Source '${source.name}' returned HTTP status ${response.status}. Check feed URL.`);
        }
      } catch (err: any) {
        const latencyMs = Date.now() - startTime;
        const errMsg = err?.name === "AbortError" ? `Timeout after ${timeout}ms` : err?.message || String(err);
        sourceResults.push({
          name: source.name,
          url: source.url,
          category: source.category,
          status: "unreachable",
          latencyMs,
          error: errMsg,
        });
        this.logger.info(
          `  ${chalk.red("✗")} ${chalk.bold(source.name)} - ${chalk.red(errMsg)}`,
        );
        recommendations.push(`Source '${source.name}' is unreachable (${errMsg}).`);
      }
    }

    const avgLatency = healthyCount > 0 ? Math.round(totalLatency / healthyCount) : 0;

    // 4. Summary Scorecard
    this.logger.info(chalk.bold.cyan("\n📊 Health Scorecard Summary:"));
    this.logger.info(`  Total Sources:    ${sources.length}`);
    this.logger.info(
      `  Reachable:        ${healthyCount === sources.length ? chalk.green(`${healthyCount}/${sources.length}`) : chalk.yellow(`${healthyCount}/${sources.length}`)}`,
    );
    this.logger.info(`  Average Latency:  ${avgLatency}ms`);

    if (recommendations.length > 0) {
      this.logger.info(chalk.bold.yellow("\n💡 Recommendations:"));
      for (const rec of recommendations) {
        this.logger.info(chalk.yellow(`  • ${rec}`));
      }
    } else {
      this.logger.info(chalk.green("\n✨ All systems and filter feeds are operating nominally!"));
    }

    const report: DoctorReport = {
      nodeVersion,
      platform,
      mongoStatus,
      mongoUri,
      sourcesChecked: sources.length,
      sourcesHealthy: healthyCount,
      averageLatencyMs: avgLatency,
      sourceResults,
      recommendations,
    };

    return this.success(report, "Doctor inspection finished successfully");
  }
}
