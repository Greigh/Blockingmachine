import { unlink, readdir, access } from "fs/promises";
import path from "path";
import { connectDB, disconnectDB } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import type { AppConfig } from "../types.js";

interface CleanupOptions {
  dropCollections?: boolean;
  config: AppConfig;
}

export async function cleanup(options: CleanupOptions): Promise<void> {
  const logger = createLogger(options.config.debug ?? false);
  let dbConnected = false;

  try {
    // Database cleanup
    if (process.env.NODE_ENV === "development" && options.dropCollections) {
      await connectDB(options.config.mongodb);
      dbConnected = true;
      await disconnectDB();
      logger.info("🧹 Database dropped (Development Mode)");
    }

    // Clean output directory
    logger.info("🧹 Cleaning output directory...");
    const outputDir = options.config.output?.directory || "./filters/output";

    await cleanOutputDirectory(outputDir, logger);
  } catch (error) {
    logger.error("❌ Cleanup failed:", error);
    throw error;
  } finally {
    if (dbConnected) {
      await disconnectDB();
      logger.info("Disconnected from MongoDB.");
    }
  }
}

async function cleanOutputDirectory(
  outputDir: string,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    await access(outputDir);
    const files = await readdir(outputDir);
    let cleanedCount = 0;

    for (const file of files) {
      if (file.match(/\.(txt|conf|action)$/)) {
        await unlink(path.join(outputDir, file));
        cleanedCount++;
      }
    }

    logger.info(`Cleaned ${cleanedCount} file(s) from ${outputDir}`);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      logger.warn(
        `Output directory ${outputDir} does not exist. Skipping file cleanup.`,
      );
    } else {
      throw error;
    }
  }
}
