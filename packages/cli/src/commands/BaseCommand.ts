import type { AppConfig } from "../types.js";
import type { Logger } from "../lib/logger.js";

export interface CommandOptions {
  config: AppConfig;
  logger: Logger;
}

export interface CommandResult {
  success: boolean;
  message: string;
  data?: any;
}

export abstract class BaseCommand<T = any> {
  protected config: AppConfig;
  protected logger: Logger;
  protected context: { config: AppConfig; logger: Logger };

  constructor(options: CommandOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.context = { config: options.config, logger: options.logger };
  }

  abstract execute(options?: T): Promise<CommandResult>;

  protected success(
    data?: any,
    message = "Operation completed successfully",
  ): CommandResult {
    return {
      success: true,
      message,
      data,
    };
  }

  protected failure(error: Error | string): CommandResult {
    const message = error instanceof Error ? error.message : error;
    this.logger.error(message);
    return {
      success: false,
      message,
    };
  }

  protected handleError(error: unknown): CommandResult {
    if (error instanceof Error) {
      return this.failure(error);
    } else if (typeof error === "string") {
      return this.failure(error);
    } else {
      return this.failure("An unknown error occurred");
    }
  }
}
