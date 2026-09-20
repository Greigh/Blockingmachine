import mongoose from "mongoose";
import type { StoredRule, MongoConfig } from "../types.js";

let dbConnected = false;
let offlineMode = false;

export function isDBConnected(): boolean {
  return dbConnected;
}

export function isOfflineMode(): boolean {
  return offlineMode;
}

export async function connectDB(
  config?: MongoConfig,
  optional = true,
): Promise<boolean> {
  if (!config || !config.uri) {
    offlineMode = true;
    dbConnected = false;
    return false;
  }
  try {
    await mongoose.connect(config.uri, {
      serverSelectionTimeoutMS: 2500,
      ...config.options,
    });
    dbConnected = true;
    offlineMode = false;
    return true;
  } catch (err: any) {
    if (optional) {
      offlineMode = true;
      dbConnected = false;
      console.warn(
        `⚠️ MongoDB connection failed (${err?.message || err}). Falling back to offline file mode.`,
      );
      return false;
    }
    throw err;
  }
}

export async function disconnectDB(): Promise<void> {
  if (dbConnected) {
    await mongoose.disconnect();
    dbConnected = false;
  }
}

export interface RuleAuditEntry {
  timestamp: string;
  action: "import" | "export" | "prune" | "delete" | "test";
  count?: number;
  details?: string;
  metadata?: Record<string, any>;
}

const auditLogSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  action: { type: String, required: true },
  count: Number,
  details: String,
  metadata: mongoose.Schema.Types.Mixed,
});

export const AuditLogModel = mongoose.model("AuditLog", auditLogSchema);

export async function logRuleAudit(
  entry: RuleAuditEntry,
  baseDir?: string,
): Promise<void> {
  if (dbConnected) {
    try {
      await AuditLogModel.create(entry);
      return;
    } catch {
      // fallback to offline file
    }
  }

  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const dir = baseDir || process.cwd();
    const logDir = path.join(dir, "logs");
    await fs.mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, "audit-log.jsonl");
    await fs.appendFile(logFile, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // ignore
  }
}

const ruleSchema = new mongoose.Schema({
  raw: { type: String, required: true },
  type: { type: String, required: true },
  domain: String,
  hash: { type: String, required: true, unique: true },
  metadata: {
    sources: [String],
    dateAdded: { type: Date, default: Date.now },
    lastUpdated: { type: Date, default: Date.now },
    enabled: { type: Boolean, default: true },
    sourceInfo: {
      category: { type: String, required: true },
      trusted: { type: Boolean, default: false },
      url: String,
    },
    tags: [String],
  },
  variants: [
    {
      rule: String,
      source: String, // Changed from sourceId to source
      dateAdded: Date,
      modifiers: [String], // Changed from objects to simple strings
      tags: [String],
    },
  ],
});

export const StoredRuleModel = mongoose.model<StoredRule>("Rule", ruleSchema);
