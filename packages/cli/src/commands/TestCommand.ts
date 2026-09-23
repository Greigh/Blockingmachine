import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import {
  createPaths,
  evaluateDomainRules,
} from "@blockingmachine/core";
import fs from "fs/promises";
import path from "path";
import chalk from "chalk";

export interface TestOptions {
  domain: string;
  file?: string;
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

    const targetDomain = rawTarget.replace(/^(?:https?:\/\/)?(?:www\.)?/, "").split("/")[0].split("?")[0];

    const config = this.config;
    const baseDir = config?.baseDir || process.cwd();
    const paths = createPaths(baseDir);
    const candidateFiles: string[] = [];

    if (options.file) {
      candidateFiles.push(path.resolve(process.cwd(), options.file));
    } else {
      candidateFiles.push(
        path.join(paths.output.dir, "imported-rules.txt"),
        path.join(paths.output.dir, "filter-list.txt"),
        path.join(paths.output.dir, "adguard.txt"),
        path.join(paths.output.dir, "hosts.txt"),
        path.join(paths.input.dir, "custom-rules.txt"),
        path.join(
          process.cwd(),
          "packages",
          "electron-app",
          "filters",
          "output",
          "hosts.txt",
        ),
      );
    }

    let rules: string[] = [];
    let foundFile = "";

    for (const file of candidateFiles) {
      try {
        const content = await fs.readFile(file, "utf8");
        const lines = content
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("!") && !l.startsWith("#"));
        if (lines.length > 0) {
          rules = lines;
          foundFile = file;
          break;
        }
      } catch {
        // Continue to next candidate
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

    const evalResult = evaluateDomainRules(targetDomain, rules);

    console.log(
      "\n" + chalk.bold.underline("Domain Inspection Analysis:") + "\n",
    );
    console.log(`  Target Domain:     ${chalk.bold.white(targetDomain)}`);
    if (foundFile) {
      console.log(`  Rule Source:       ${chalk.dim(foundFile)}`);
    }

    if (evalResult.verdict === "exception") {
      console.log(
        `  Final Verdict:     ${chalk.bold.green("ALLOWED")} (Explicit exception rule overrides block)`,
      );
      console.log(
        `  Exception Rule:    ${chalk.green(evalResult.exceptionRule || evalResult.matchingRule || "")}`,
      );
      if (evalResult.overriddenRules.length > 0) {
        console.log(
          `  Overridden Blocks: ${evalResult.overriddenRules.join(", ")}`,
        );
      }
    } else if (evalResult.verdict === "blocked") {
      console.log(`  Final Verdict:     ${chalk.bold.red("BLOCKED")}`);
      console.log(
        `  Matching Rules:    ${chalk.red(evalResult.matchingRules.length.toString())}`,
      );
      evalResult.matchingRules.slice(0, 5).forEach((match, idx) => {
        const typeDesc = match.isWildcard
          ? "(wildcard parent block)"
          : "(exact match)";
        console.log(
          `    ${idx + 1}. ${chalk.yellow(match.rule)} ${chalk.dim(typeDesc)}`,
        );
      });
      if (evalResult.matchingRules.length > 5) {
        console.log(
          `    ... and ${evalResult.matchingRules.length - 5} more matching rules`,
        );
      }
      if (evalResult.overriddenRules.length > 0) {
        console.log(
          `  Overridden Exceptions: ${evalResult.overriddenRules.join(", ")}`,
        );
      }
    } else {
      console.log(
        `  Final Verdict:     ${chalk.bold.cyan("UNBLOCKED")} (No matching blocking rules found)`,
      );
    }
    console.log("");

    const verdictStr =
      evalResult.verdict === "exception"
        ? "ALLOWED"
        : evalResult.verdict === "blocked"
          ? "BLOCKED"
          : "UNBLOCKED";

    const matchingBlocks =
      evalResult.verdict === "blocked"
        ? evalResult.matchingRules.map((b) => b.rule)
        : evalResult.overriddenRules;

    const matchingExceptions =
      evalResult.verdict === "exception"
        ? evalResult.matchingRules.map((e) => e.rule)
        : evalResult.overriddenRules;

    return this.success(
      {
        domain: targetDomain,
        verdict: verdictStr,
        matchingBlocks,
        matchingExceptions,
      },
      `Inspection for ${targetDomain} complete: ${verdictStr}`,
    );
  }
}
