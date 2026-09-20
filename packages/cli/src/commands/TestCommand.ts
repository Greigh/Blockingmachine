import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import { createPaths, cleanDomainPattern } from "@blockingmachine/core";
import fs from "fs/promises";
import path from "path";
import chalk from "chalk";

export interface TestOptions {
  domain: string;
}

export class TestCommand extends BaseCommand<TestOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options: TestOptions): Promise<CommandResult> {
    const rawTarget = options?.domain?.trim().toLowerCase();
    if (!rawTarget) {
      return this.failure(
        "Please provide a domain to test. Example: blockingmachine test ads.google.com",
      );
    }

    // Strip protocol, port, or leading slashes
    const targetDomain = rawTarget
      .replace(/^(?:https?:\/\/)?(?:www\.)?/i, "")
      .split(/[/:]/)[0];

    const config = this.config;
    const baseDir = config.baseDir || process.cwd();
    const paths = createPaths(baseDir);
    const candidateFiles = [
      path.join(paths.output.dir, "imported-rules.txt"),
      path.join(paths.output.dir, "filter-list.txt"),
      path.join(paths.output.dir, "adguard.txt"),
      path.join(paths.output.dir, "hosts.txt"),
      path.join(
        process.cwd(),
        "packages",
        "electron-app",
        "filters",
        "output",
        "hosts.txt",
      ),
    ];

    let rules: string[] = [];
    let foundFile = "";
    for (const candidate of candidateFiles) {
      try {
        const content = await fs.readFile(candidate, "utf-8");
        rules = content
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        foundFile = candidate;
        break;
      } catch {
        // try next
      }
    }

    if (rules.length === 0) {
      return this.failure(
        `Could not read rules from ${candidateFiles[0]}. Please run 'blockingmachine import' first.`,
      );
    }

    this.logger.info(
      `Analyzing domain ${chalk.bold.cyan(targetDomain)} across ${rules.length} loaded rules...`,
    );

    const matchingExceptions: string[] = [];
    const matchingBlocks: {
      rule: string;
      matchedPattern: string;
      isWildcard: boolean;
    }[] = [];

    for (const rule of rules) {
      if (rule.startsWith("!") || rule.startsWith("#")) continue;

      if (rule.startsWith("@@")) {
        const pattern = cleanDomainPattern(rule);
        if (
          pattern &&
          (targetDomain === pattern || targetDomain.endsWith("." + pattern))
        ) {
          matchingExceptions.push(rule);
        }
      } else {
        const pattern = cleanDomainPattern(rule);
        if (pattern) {
          if (targetDomain === pattern) {
            matchingBlocks.push({
              rule,
              matchedPattern: pattern,
              isWildcard: false,
            });
          } else if (
            rule.startsWith("||") &&
            targetDomain.endsWith("." + pattern)
          ) {
            matchingBlocks.push({
              rule,
              matchedPattern: pattern,
              isWildcard: true,
            });
          }
        }
      }
    }

    const isException = matchingExceptions.length > 0;
    const isBlocked = matchingBlocks.length > 0 && !isException;

    console.log(
      "\n" + chalk.bold.underline("Domain Inspection Analysis:") + "\n",
    );
    console.log(`  Target Domain:     ${chalk.bold.white(targetDomain)}`);

    if (isException) {
      console.log(
        `  Final Verdict:     ${chalk.bold.green("ALLOWED")} (Explicit exception rule overrides block)`,
      );
      console.log(
        `  Exception Rule:    ${chalk.green(matchingExceptions.join(", "))}`,
      );
      if (matchingBlocks.length > 0) {
        console.log(
          `  Overridden Blocks: ${matchingBlocks.map((b) => b.rule).join(", ")}`,
        );
      }
    } else if (isBlocked) {
      console.log(`  Final Verdict:     ${chalk.bold.red("BLOCKED")}`);
      console.log(
        `  Matching Rules:    ${chalk.red(matchingBlocks.length.toString())}`,
      );
      matchingBlocks.slice(0, 5).forEach((match, idx) => {
        const typeDesc = match.isWildcard
          ? "(wildcard parent block)"
          : "(exact match)";
        console.log(
          `    ${idx + 1}. ${chalk.yellow(match.rule)} ${chalk.dim(typeDesc)}`,
        );
      });
      if (matchingBlocks.length > 5) {
        console.log(
          `    ... and ${matchingBlocks.length - 5} more matching rules`,
        );
      }
    } else {
      console.log(
        `  Final Verdict:     ${chalk.bold.gray("UNBLOCKED")} (No matching blocking rules found)`,
      );
    }
    console.log("");

    return this.success(
      {
        domain: targetDomain,
        verdict: isException ? "ALLOWED" : isBlocked ? "BLOCKED" : "UNBLOCKED",
        matchingBlocks: matchingBlocks.map((b) => b.rule),
        matchingExceptions,
      },
      `Inspection for ${targetDomain} complete: ${isException ? "ALLOWED" : isBlocked ? "BLOCKED" : "UNBLOCKED"}`,
    );
  }
}
