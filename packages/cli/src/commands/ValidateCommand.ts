import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import type { ValidateOptions } from "./types.js";

export class ValidateCommand extends BaseCommand<ValidateOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options: ValidateOptions = {}): Promise<CommandResult> {
    try {
      // Config is already validated by loadConfig()
      const sourceCount = this.config.sources.length;
      const enabledCount = this.config.sources.filter((s) => s.enabled).length;

      return this.success(
        {
          sourceCount,
          enabledCount,
          mongodb: this.config.mongodb.uri,
          outputDir: this.config.output.directory,
        },
        "Configuration is valid",
      );
    } catch (error) {
      return this.failure(error as Error);
    }
  }
}
