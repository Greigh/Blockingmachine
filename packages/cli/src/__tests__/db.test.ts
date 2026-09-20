import {
  isDBConnected,
  isOfflineMode,
  connectDB,
  disconnectDB,
  logRuleAudit,
  saveRuleSnapshot,
  listRuleSnapshots,
  loadRuleSnapshot,
  rollbackSnapshot,
  type RuleAuditEntry,
} from "../lib/db.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

describe("Database Layer & Offline Audit Logging", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-db-test-"));
  });

  afterEach(async () => {
    await disconnectDB();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("initial connection state reflects disconnected", () => {
    expect(isDBConnected()).toBe(false);
  });

  test("connectDB without URI enables offlineMode and returns false", async () => {
    const connected = await connectDB(undefined, true);
    expect(connected).toBe(false);
    expect(isOfflineMode()).toBe(true);
    expect(isDBConnected()).toBe(false);
  });

  test("connectDB with unreachable URI falls back to offlineMode gracefully when optional", async () => {
    const unreachableConfig = {
      uri: "mongodb://127.0.0.1:59999/unreachable_db_test",
      options: { serverSelectionTimeoutMS: 500 },
    };

    const connected = await connectDB(unreachableConfig, true);
    expect(connected).toBe(false);
    expect(isOfflineMode()).toBe(true);
    expect(isDBConnected()).toBe(false);
  });

  test("logRuleAudit creates logs directory and writes JSONL file in offline mode", async () => {
    const entry: RuleAuditEntry = {
      timestamp: new Date().toISOString(),
      action: "import",
      count: 42,
      details: "Imported 42 rules from test feeds",
      metadata: { sources: 3 },
    };

    await logRuleAudit(entry, tmpDir);

    const logFilePath = path.join(tmpDir, "logs", "audit-log.jsonl");
    const content = await fs.readFile(logFilePath, "utf8");
    const parsed = JSON.parse(content.trim());

    expect(parsed.action).toBe("import");
    expect(parsed.count).toBe(42);
    expect(parsed.details).toBe("Imported 42 rules from test feeds");
    expect(parsed.metadata.sources).toBe(3);
  });

  test("logRuleAudit appends multiple JSONL audit records accurately", async () => {
    const entry1: RuleAuditEntry = {
      timestamp: new Date().toISOString(),
      action: "export",
      count: 100,
      details: "Exported rules to adguard format",
    };

    const entry2: RuleAuditEntry = {
      timestamp: new Date().toISOString(),
      action: "prune",
      count: 15,
      details: "Pruned redundant subdomains",
    };

    await logRuleAudit(entry1, tmpDir);
    await logRuleAudit(entry2, tmpDir);

    const logFilePath = path.join(tmpDir, "logs", "audit-log.jsonl");
    const content = await fs.readFile(logFilePath, "utf8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));

    expect(lines).toHaveLength(2);
    expect(lines[0].action).toBe("export");
    expect(lines[0].count).toBe(100);
    expect(lines[1].action).toBe("prune");
    expect(lines[1].count).toBe(15);
  });

  test("saveRuleSnapshot and listRuleSnapshots persist snapshots in offline mode", async () => {
    const mockRules: any = [
      { raw: "||tracker.com^", type: "blocking", domain: "tracker.com" },
      { raw: "0.0.0.0 bad.org", type: "blocking", domain: "bad.org" },
    ];

    const saved = await saveRuleSnapshot("Test Snapshot Alpha", mockRules, tmpDir);
    expect(saved.snapshotId).toBeDefined();
    expect(saved.ruleCount).toBe(2);
    expect(saved.description).toBe("Test Snapshot Alpha");

    const snapshots = await listRuleSnapshots(tmpDir);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots[0].snapshotId).toBe(saved.snapshotId);
    expect(snapshots[0].description).toBe("Test Snapshot Alpha");
    expect(snapshots[0].ruleCount).toBe(2);
  });

  test("loadRuleSnapshot retrieves snapshot rules and rollbackSnapshot performs rollback", async () => {
    const mockRules: any = [
      { raw: "||telemetry.io^", type: "blocking", domain: "telemetry.io" },
    ];

    const saved = await saveRuleSnapshot("Rollback Target", mockRules, tmpDir);
    const loaded = await loadRuleSnapshot(saved.snapshotId, tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.rules).toHaveLength(1);
    expect(loaded?.rules[0].raw).toBe("||telemetry.io^");

    const rollbackResult = await rollbackSnapshot(saved.snapshotId, tmpDir);
    expect(rollbackResult.success).toBe(true);
    expect(rollbackResult.ruleCount).toBe(1);

    // Verify offline mode restores rule files to output directory
    const outputDir = path.join(tmpDir, "filters", "output");
    const importedFile = await fs.readFile(path.join(outputDir, "imported-rules.txt"), "utf8");
    expect(importedFile).toContain("||telemetry.io^");

    const nonExistent = await rollbackSnapshot("non-existent-snap-id", tmpDir);
    expect(nonExistent.success).toBe(false);
  });

  test("rejects path traversal and invalid snapshot IDs securely", async () => {
    const traversalAttempts = [
      "../evil",
      "../../etc/passwd",
      "snap/shot",
      "snap\\shot",
      "snap;rm -rf",
      "",
      "   ",
    ];

    for (const badId of traversalAttempts) {
      const loaded = await loadRuleSnapshot(badId, tmpDir);
      expect(loaded).toBeNull();

      const rollback = await rollbackSnapshot(badId, tmpDir);
      expect(rollback.success).toBe(false);
      expect(rollback.message).toContain("Invalid snapshot ID");
    }
  });
});

