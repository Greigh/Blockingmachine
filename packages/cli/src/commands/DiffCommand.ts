import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import fs from "fs/promises";
import chalk from "chalk";

export interface DiffOptions {
  fileA: string;
  fileB: string;
}

export class DiffCommand extends BaseCommand<DiffOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options: DiffOptions): Promise<CommandResult> {
    const { fileA, fileB } = options;
    if (!fileA || !fileB) {
      return this.failure(
        "Please specify two files to diff. Example: blockingmachine diff fileA.txt fileB.txt",
      );
    }

    let contentA = "";
    let contentB = "";
    try {
      contentA = await fs.readFile(fileA, "utf8");
    } catch (err: any) {
      return this.failure(`Failed to read file A (${fileA}): ${err.message}`);
    }

    try {
      contentB = await fs.readFile(fileB, "utf8");
    } catch (err: any) {
      return this.failure(`Failed to read file B (${fileB}): ${err.message}`);
    }

    const parseLines = (text: string) =>
      new Set(
        text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("!") && !l.startsWith("#")),
      );

    const setA = parseLines(contentA);
    const setB = parseLines(contentB);

    const added: string[] = [];
    const removed: string[] = [];
    let common = 0;

    for (const rule of setB) {
      if (!setA.has(rule)) {
        added.push(rule);
      } else {
        common++;
      }
    }

    for (const rule of setA) {
      if (!setB.has(rule)) {
        removed.push(rule);
      }
    }

    console.log(
      "\n" + chalk.bold.underline("Blocklist Delta Diff Summary:") + "\n",
    );
    console.log(
      `  File A (Baseline): ${chalk.cyan(fileA)} (${setA.size} effective rules)`,
    );
    console.log(
      `  File B (Target):   ${chalk.cyan(fileB)} (${setB.size} effective rules)`,
    );
    console.log("");
    console.log(
      `  ${chalk.green("+ Added:")}       ${chalk.bold.green(added.length.toString())}`,
    );
    console.log(
      `  ${chalk.red("- Removed:")}     ${chalk.bold.red(removed.length.toString())}`,
    );
    console.log(
      `  ${chalk.gray("= Unchanged:")}   ${chalk.bold.gray(common.toString())}`,
    );

    if (added.length > 0) {
      console.log("\n" + chalk.bold.green("Sample Added Rules (+):"));
      added.slice(0, 5).forEach((r) => console.log(`  + ${chalk.green(r)}`));
      if (added.length > 5) {
        console.log(`  ... and ${added.length - 5} more added rules`);
      }
    }

    if (removed.length > 0) {
      console.log("\n" + chalk.bold.red("Sample Removed Rules (-):"));
      removed.slice(0, 5).forEach((r) => console.log(`  - ${chalk.red(r)}`));
      if (removed.length > 5) {
        console.log(`  ... and ${removed.length - 5} more removed rules`);
      }
    }
    console.log("");

    return this.success(
      {
        addedCount: added.length,
        removedCount: removed.length,
        unchangedCount: common,
        addedSample: added.slice(0, 10),
        removedSample: removed.slice(0, 10),
      },
      `Diff complete: +${added.length} / -${removed.length} / =${common}`,
    );
  }
}
