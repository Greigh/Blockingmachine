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

export const StoredRuleModel =
  mongoose.models.Rule || mongoose.model<StoredRule>("Rule", ruleSchema);

export interface RuleSnapshotEntry {
  snapshotId: string;
  timestamp: string;
  description: string;
  ruleCount: number;
  rules: StoredRule[];
}

const snapshotSchema = new mongoose.Schema({
  snapshotId: { type: String, required: true, unique: true },
  timestamp: { type: Date, default: Date.now },
  description: { type: String, required: true },
  ruleCount: { type: Number, required: true },
  rules: { type: Array, required: true },
});

export const RuleSnapshotModel =
  mongoose.models.RuleSnapshot ||
  mongoose.model("RuleSnapshot", snapshotSchema);

export async function saveRuleSnapshot(
  description: string,
  rules: StoredRule[],
  baseDir?: string,
): Promise<RuleSnapshotEntry> {
  const snapshotId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const timestamp = new Date().toISOString();
  const entry: RuleSnapshotEntry = {
    snapshotId,
    timestamp,
    description,
    ruleCount: rules.length,
    rules,
  };

  if (dbConnected) {
    try {
      await RuleSnapshotModel.create({
        snapshotId,
        timestamp: new Date(timestamp),
        description,
        ruleCount: rules.length,
        rules,
      });
      await logRuleAudit(
        {
          timestamp,
          action: "import",
          count: rules.length,
          details: `Snapshot created: ${description} (${snapshotId})`,
        },
        baseDir,
      );
      return entry;
    } catch {
      // fallback to offline file
    }
  }

  const fs = await import("fs/promises");
  const path = await import("path");
  const dir = baseDir || process.cwd();
  const snapDir = path.join(dir, "snapshots");
  await fs.mkdir(snapDir, { recursive: true });
  const snapFile = path.join(snapDir, `${snapshotId}.json`);
  await fs.writeFile(snapFile, JSON.stringify(entry, null, 2), "utf8");

  await logRuleAudit(
    {
      timestamp,
      action: "import",
      count: rules.length,
      details: `Snapshot created offline: ${description} (${snapshotId})`,
    },
    baseDir,
  );

  return entry;
}

export async function listRuleSnapshots(
  baseDir?: string,
): Promise<Array<Omit<RuleSnapshotEntry, "rules">>> {
  if (dbConnected) {
    try {
      const docs = await RuleSnapshotModel.find(
        {},
        { snapshotId: 1, timestamp: 1, description: 1, ruleCount: 1 },
      )
        .sort({ timestamp: -1 })
        .lean();
      return docs.map((d: any) => ({
        snapshotId: d.snapshotId,
        timestamp: new Date(d.timestamp).toISOString(),
        description: d.description,
        ruleCount: d.ruleCount,
      }));
    } catch {
      // fallback to offline file
    }
  }

  const fs = await import("fs/promises");
  const path = await import("path");
  const dir = baseDir || process.cwd();
  const snapDir = path.join(dir, "snapshots");

  try {
    const files = await fs.readdir(snapDir);
    const results: Array<Omit<RuleSnapshotEntry, "rules">> = [];
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      try {
        const content = await fs.readFile(path.join(snapDir, file), "utf8");
        const parsed = JSON.parse(content);
        results.push({
          snapshotId: parsed.snapshotId || file.replace(".json", ""),
          timestamp: parsed.timestamp,
          description: parsed.description,
          ruleCount: parsed.ruleCount,
        });
      } catch {
        // ignore malformed snapshot
      }
    }
    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  } catch {
    return [];
  }
}

export function isValidSnapshotId(snapshotId: string): boolean {
  return (
    typeof snapshotId === "string" &&
    snapshotId.trim().length > 0 &&
    /^[a-zA-Z0-9_-]+$/.test(snapshotId)
  );
}

export async function loadRuleSnapshot(
  snapshotId: string,
  baseDir?: string,
): Promise<RuleSnapshotEntry | null> {
  if (!isValidSnapshotId(snapshotId)) {
    console.warn(`[Snapshot] Invalid snapshot ID rejected: ${snapshotId}`);
    return null;
  }

  if (dbConnected) {
    try {
      const doc = await RuleSnapshotModel.findOne({ snapshotId }).lean();
      if (doc) {
        return {
          snapshotId: (doc as any).snapshotId,
          timestamp: new Date((doc as any).timestamp).toISOString(),
          description: (doc as any).description,
          ruleCount: (doc as any).ruleCount,
          rules: (doc as any).rules,
        };
      }
    } catch {
      // fallback to offline file
    }
  }

  const fs = await import("fs/promises");
  const path = await import("path");
  const dir = baseDir || process.cwd();
  const safeId = path.basename(snapshotId);
  const snapFile = path.join(dir, "snapshots", `${safeId}.json`);

  try {
    const content = await fs.readFile(snapFile, "utf8");
    return JSON.parse(content) as RuleSnapshotEntry;
  } catch {
    return null;
  }
}

export async function rollbackSnapshot(
  snapshotId: string,
  baseDir?: string,
): Promise<{ success: boolean; ruleCount: number; message: string }> {
  if (!isValidSnapshotId(snapshotId)) {
    return {
      success: false,
      ruleCount: 0,
      message: `Invalid snapshot ID: '${snapshotId}'. Must contain only letters, numbers, hyphens, and underscores.`,
    };
  }

  const snapshot = await loadRuleSnapshot(snapshotId, baseDir);
  if (!snapshot) {
    return {
      success: false,
      ruleCount: 0,
      message: `Snapshot '${snapshotId}' not found`,
    };
  }

  if (dbConnected) {
    try {
      await StoredRuleModel.deleteMany({});
      if (snapshot.rules.length > 0) {
        await StoredRuleModel.insertMany(snapshot.rules);
      }
    } catch (err: any) {
      return {
        success: false,
        ruleCount: 0,
        message: `Database rollback error: ${err?.message || err}`,
      };
    }
  } else {
    // Offline mode: restore snapshot rules back to output text files
    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const dir = baseDir || process.cwd();
      const outDir = path.join(dir, "filters", "output");
      await fs.mkdir(outDir, { recursive: true });

      const ruleLines = snapshot.rules
        .map((r) => r.raw || (r as any).originalRule)
        .filter(Boolean)
        .join("\n");
      const content = ruleLines ? ruleLines + "\n" : "";

      await fs.writeFile(path.join(outDir, "imported-rules.txt"), content, "utf8");
      await fs.writeFile(path.join(outDir, "filter-list.txt"), content, "utf8");
    } catch (fsErr: any) {
      console.warn(`[Snapshot] Failed to write offline restored files: ${fsErr?.message || fsErr}`);
    }
  }

  await logRuleAudit(
    {
      timestamp: new Date().toISOString(),
      action: "delete",
      count: snapshot.ruleCount,
      details: `Rolled back to snapshot ${snapshotId}: ${snapshot.description}`,
    },
    baseDir,
  );

  return {
    success: true,
    ruleCount: snapshot.ruleCount,
    message: `Successfully rolled back to snapshot '${snapshotId}' (${snapshot.ruleCount} rules restored)`,
  };
}
