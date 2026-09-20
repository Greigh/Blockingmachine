import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import http from "http";
import { URL } from "url";
import fs from "fs/promises";
import path from "path";
import chalk from "chalk";
import { createPaths, cleanDomainPattern } from "@blockingmachine/core";

export interface ServeOptions {
  port?: number;
  host?: string;
  serverInstanceHolder?: { server?: http.Server };
}

export class ServeCommand extends BaseCommand<ServeOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options?: ServeOptions): Promise<CommandResult> {
    const port = options?.port || 8053;
    const host = options?.host || "127.0.0.1";

    const config = this.config;
    const baseDir = config.baseDir || process.cwd();
    const paths = createPaths(baseDir);

    const candidateFiles = [
      path.join(paths.output.dir, "imported-rules.txt"),
      path.join(paths.output.dir, "filter-list.txt"),
      path.join(paths.output.dir, "hosts.txt"),
    ];

    let rulesContent = "";
    let rulesSource = "";

    for (const f of candidateFiles) {
      try {
        rulesContent = await fs.readFile(f, "utf8");
        rulesSource = f;
        break;
      } catch {
        // try next
      }
    }

    const lines = rulesContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("!") && !l.startsWith("#"));

    const server = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = parsedUrl.pathname;

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");

      if (pathname === "/health") {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            status: "ok",
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            rulesLoaded: lines.length,
            ruleSource: rulesSource || "memory-only",
          }),
        );
        return;
      }

      if (pathname === "/v1/check") {
        const domain = parsedUrl.searchParams.get("domain")?.trim().toLowerCase();
        if (!domain) {
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              error: "Missing 'domain' query parameter. Example: /v1/check?domain=tracker.example.com",
            }),
          );
          return;
        }

        const target = domain.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "").split(/[/:]/)[0];

        // Match against loaded rules
        const matchedRules: string[] = [];
        let exceptionRule: string | null = null;

        for (const line of lines) {
          if (line.startsWith("@@")) {
            const pattern = cleanDomainPattern(line);
            if (pattern && (target === pattern || target.endsWith(`.${pattern}`))) {
              exceptionRule = line;
              break;
            }
          } else {
            const pattern = cleanDomainPattern(line);
            if (pattern && (target === pattern || target.endsWith(`.${pattern}`))) {
              matchedRules.push(line);
            }
          }
        }

        const isBlocked = exceptionRule ? false : matchedRules.length > 0;
        const verdict = exceptionRule
          ? "ALLOWED (Exception rule overrides block)"
          : isBlocked
            ? "BLOCKED"
            : "UNBLOCKED";

        res.statusCode = 200;
        res.end(
          JSON.stringify({
            domain: target,
            blocked: isBlocked,
            verdict,
            exceptionRule,
            matchedRules,
            totalMatches: matchedRules.length,
          }),
        );
        return;
      }

      if (pathname === "/v1/rules") {
        if (req.headers.accept?.includes("text/plain")) {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.statusCode = 200;
          res.end(rulesContent);
          return;
        }

        res.statusCode = 200;
        res.end(
          JSON.stringify({
            totalRules: lines.length,
            rules: lines.slice(0, 500),
            sampleTruncated: lines.length > 500,
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end(
        JSON.stringify({
          error: "Not Found",
          availableEndpoints: ["/health", "/v1/check?domain=<name>", "/v1/rules"],
        }),
      );
    });

    if (options?.serverInstanceHolder) {
      options.serverInstanceHolder.server = server;
    }

    return new Promise((resolve, reject) => {
      server.listen(port, host, () => {
        this.logger.info(
          chalk.bold.green(`\n🚀 Blockingmachine preview server listening at http://${host}:${port}`),
        );
        this.logger.info(chalk.dim(`  Loaded ${lines.length} rules from ${rulesSource || "cache"}`));
        this.logger.info(`  • Health:  ${chalk.cyan(`http://${host}:${port}/health`)}`);
        this.logger.info(`  • Check:   ${chalk.cyan(`http://${host}:${port}/v1/check?domain=example.com`)}`);
        this.logger.info(`  • Rules:   ${chalk.cyan(`http://${host}:${port}/v1/rules`)}\n`);

        resolve(
          this.success(
            { port, host, server },
            `Server started on http://${host}:${port}`,
          ),
        );
      });

      server.on("error", (err) => {
        reject(err);
      });
    });
  }
}
