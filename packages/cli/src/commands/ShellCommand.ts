import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import { RuleProcessor } from "@blockingmachine/core";
import { TestCommand } from "./TestCommand.js";
import { listRuleSnapshots } from "../lib/db.js";
import readline from "readline";
import chalk from "chalk";

export interface ShellOptions {
  interactive?: boolean;
}

export class ShellCommand extends BaseCommand<ShellOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(_options?: ShellOptions): Promise<CommandResult> {
    const processor = new RuleProcessor();
    const testCmd = new TestCommand(this.context);

    this.logger.info(
      chalk.bold.cyan("\n🐚 Entering Blockingmachine Interactive Shell"),
    );
    this.logger.info(
      chalk.dim("Type 'help' for available commands or 'exit' to quit.\n"),
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.magenta("bm> "),
    });

    const printHelp = () => {
      console.log(chalk.bold("\nAvailable Commands:"));
      console.log(`  ${chalk.cyan("test <domain>")}      Inspect how a domain is resolved by rules`);
      console.log(`  ${chalk.cyan("classify <rule>")}    Classify an Adblock/Hosts rule syntax`);
      console.log(`  ${chalk.cyan("stats")}              Show configured sources and category counts`);
      console.log(`  ${chalk.cyan("snapshots")}          List saved rule database snapshots`);
      console.log(`  ${chalk.cyan("clear")}              Clear console screen`);
      console.log(`  ${chalk.cyan("help")}               Display this help message`);
      console.log(`  ${chalk.cyan("exit, quit")}         Exit interactive shell\n`);
    };

    return new Promise((resolve) => {
      rl.prompt();

      rl.on("line", async (line) => {
        const input = line.trim();
        if (!input) {
          rl.prompt();
          return;
        }

        const [cmd, ...args] = input.split(/\s+/);
        const argStr = args.join(" ");

        try {
          switch (cmd.toLowerCase()) {
            case "exit":
            case "quit":
              rl.close();
              return;

            case "help":
              printHelp();
              break;

            case "clear":
              console.clear();
              break;

            case "stats": {
              console.log(chalk.bold.cyan("\nConfiguration Stats:"));
              console.log(`  Base Dir:   ${this.config.baseDir}`);
              console.log(`  Sources:    ${this.config.sources.length}`);
              console.log(`  Output Dir: ${this.config.output?.directory}`);
              break;
            }

            case "snapshots": {
              const snapshots = await listRuleSnapshots(this.config.baseDir);
              if (snapshots.length === 0) {
                console.log(chalk.yellow("No snapshots found."));
              } else {
                console.log(chalk.bold(`\nRule Snapshots (${snapshots.length}):`));
                for (const s of snapshots) {
                  console.log(`  • ${chalk.cyan(s.snapshotId)} - ${s.description} (${s.ruleCount} rules, ${s.timestamp})`);
                }
              }
              break;
            }

            case "classify": {
              if (!argStr) {
                console.log(chalk.yellow("Usage: classify <rule> (e.g. classify ||example.com^$script)"));
              } else {
                const type = processor.classifyRule(argStr);
                console.log(`  Rule:   ${chalk.bold(argStr)}`);
                console.log(`  Type:   ${chalk.green(type || "unknown")}`);
              }
              break;
            }

            case "test": {
              if (!argStr) {
                console.log(chalk.yellow("Usage: test <domain> (e.g. test tracker.com)"));
              } else {
                await testCmd.execute({ domain: argStr });
              }
              break;
            }

            default:
              console.log(chalk.red(`Unknown command: '${cmd}'. Type 'help' for instructions.`));
              break;
          }
        } catch (err: any) {
          console.error(chalk.red(`Error: ${err?.message || err}`));
        }

        rl.prompt();
      });

      rl.on("close", () => {
        console.log(chalk.dim("\nExiting Blockingmachine Shell. Bye!"));
        resolve(this.success(null, "Shell closed"));
      });
    });
  }
}
