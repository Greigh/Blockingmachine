import mongoose, { type ObjectId } from "mongoose";
import { StoredRuleModel } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";

interface DBVersion {
  _id: ObjectId;
  version: number;
  updatedAt: Date;
}

interface MigrationOptions {
  debug?: boolean;
}

export async function migrateDatabase(
  options: MigrationOptions = {},
): Promise<void> {
  const logger = createLogger(options.debug);

  try {
    const version = await getDBVersion();

    if (version < 1) {
      logger.info("Running migration: Adding indexes");
      await addIndexesToRules();
    }

    await updateDBVersion(1);
    logger.info("Migration complete");
  } catch (error) {
    logger.error("Migration failed:", error);
    throw error;
  }
}

async function getDBVersion(): Promise<number> {
  try {
    if (!mongoose.connection.db) {
      throw new Error("Database not connected");
    }
    const versionDoc = await mongoose.connection.db
      .collection("dbinfo")
      .findOne<DBVersion>({ _id: new mongoose.Types.ObjectId("version") });
    return versionDoc?.version || 0;
  } catch {
    return 0;
  }
}

async function updateDBVersion(version: number): Promise<void> {
  if (!mongoose.connection.db) {
    throw new Error("Database not connected");
  }
  await mongoose.connection.db
    .collection("dbinfo")
    .updateOne(
      { _id: new mongoose.Types.ObjectId("version") },
      { $set: { version, updatedAt: new Date() } },
      { upsert: true },
    );
}

async function addIndexesToRules(): Promise<void> {
  await StoredRuleModel.collection.createIndex({ domain: 1 });
  await StoredRuleModel.collection.createIndex({ type: 1 });
  await StoredRuleModel.collection.createIndex({ hash: 1 }, { unique: true });
}
