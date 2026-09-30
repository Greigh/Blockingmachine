/**
 * `blockingmachine tier-plan` against real tier files.
 *
 * The command exists because the popup's answer is only available in a browser, against a live
 * grant the hub and the command line cannot see. So what is worth pinning is that it reports the
 * files it was pointed at, refuses a file it cannot trust, and produces the same plan core would
 * — because the hub's card and this output come from one function and a disagreement between them
 * would be invisible.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { TierPlanCommand } from "../commands/TierPlanCommand.js";
import { createLogger } from "../lib/logger.js";
import { STATIC_RULE_TIERS, computeTierPlan } from "@blockingmachine/core";

const logger = createLogger();

const rules = (hosts: string[]) =>
  hosts.map((host, index) => ({
    id: index + 1,
    priority: 1,
    action: { type: "block" },
    condition: { urlFilter: `||${host}^` },
  }));

async function makeRulesDir(
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-tier-plan-"));
  const defaults: Record<string, unknown> = {
    tier_core: rules(["core.example.com", "shared.example.com"]),
    tier_ads: rules(["ads.example.com", "shared.example.com"]),
    tier_privacy: rules(["privacy.example.com"]),
    tier_annoyances: rules(["consent.example.com"]),
  };
  for (const [tier, body] of Object.entries({ ...defaults, ...overrides })) {
    if (body === null) continue;
    await fs.writeFile(path.join(dir, `${tier}.json`), JSON.stringify(body), "utf8");
  }
  return dir;
}

const run = (dir: string, options: Record<string, unknown> = {}) =>
  new TierPlanCommand({
    config: {} as never,
    logger,
  }).execute({ rulesDir: dir, ...options });

describe("tier-plan", () => {
  let dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    dirs = [];
  });

  test("reports the tier sizes the files actually hold", async () => {
    const dir = await makeRulesDir();
    dirs.push(dir);

    const res = await run(dir);
    expect(res.success).toBe(true);
    const data = res.data as { files: Array<{ id: string; rules: number }>; plan: { totalRules: number } };
    // Not the catalogue's curated counts: a packaged build ships tens of thousands per tier, and
    // a plan computed from the baseline would be a plan about a different bundle.
    expect(data.files.map((f) => f.rules)).toEqual([2, 2, 1, 1]);
    expect(data.plan.totalRules).toBe(6);
    expect(data.plan.benefitSource).toBe("coverage");
  });

  test("agrees with core, which is what the hub's card also runs", async () => {
    const dir = await makeRulesDir();
    dirs.push(dir);

    const res = await run(dir, { capacity: 3 });
    const data = res.data as { plan: { enabled: string[]; enabledRules: number } };

    const expected = computeTierPlan({
      files: STATIC_RULE_TIERS.map((tier) => ({ id: tier.id, rules: [] })),
      enabled: STATIC_RULE_TIERS.filter((t) => t.defaultEnabled).map((t) => t.id),
      capacity: 3,
    });
    // The core call above is over empty files, so only the *rule* is compared: the hub and the CLI
    // must take the same code path, and `broken` is how a differing path announces itself.
    expect(expected.broken).toHaveLength(STATIC_RULE_TIERS.length);
    expect(data.plan.enabledRules).toBeLessThanOrEqual(3);
  });

  test("a congested capacity is planned against rather than the guaranteed floor", async () => {
    const dir = await makeRulesDir({
      tier_ads: rules(Array.from({ length: 40 }, (_, i) => `a${i}.example.com`)),
    });
    dirs.push(dir);

    const res = await run(dir, { capacity: 10 });
    const data = res.data as {
      capacity: number;
      plan: { enabledRules: number; explanation: string[] };
    };
    expect(data.capacity).toBe(10);
    expect(data.plan.enabledRules).toBeLessThanOrEqual(10);
    // The explanation attributes the shortfall to the number supplied, not to the 30,000 floor.
    expect(data.plan.explanation.join(" ")).toContain("10 static slots");
    expect(data.plan.explanation.join(" ")).not.toContain("30,000 static slots right now");
  });

  test("refuses a tier file that fails validation, and names it", async () => {
    const dir = await makeRulesDir({
      tier_ads: [
        // priority 5 — a tier may only ship bottom-priority block rules, or it could outrank a
        // user's own pause or exception.
        { id: 1, priority: 5, action: { type: "block" }, condition: { urlFilter: "||x.example.com^" } },
      ],
    });
    dirs.push(dir);

    const res = await run(dir);
    expect(res.success).toBe(false);
    expect(res.message).toContain("Ad networks");
    expect(res.message).toContain("priority must be 1");
  });

  test("reports a missing file rather than planning an empty tier", async () => {
    const dir = await makeRulesDir({ tier_privacy: null });
    dirs.push(dir);

    const res = await run(dir);
    expect(res.success).toBe(false);
    expect(res.message).toContain("cannot read");
  });

  test("weights the plan by a ledger, and says so", async () => {
    const dir = await makeRulesDir();
    dirs.push(dir);
    const ledger = path.join(dir, "ledger.txt");
    await fs.writeFile(
      ledger,
      ["500 ||core.example.com^", "900 ||ads.example.com^", "8 ||privacy.example.com^", "4 ||consent.example.com^"].join("\n"),
      "utf8",
    );

    const res = await run(dir, { hits: ledger });
    const data = res.data as {
      files: Array<{ id: string; hits: number | null }>;
      plan: { benefitSource: string };
      basis: { source: string; reason: string };
      ledger: { lines: number; skipped: number; shared: number };
    };

    expect(data.files.find((f) => f.id === "tier_core")?.hits).toBe(500);
    expect(data.files.find((f) => f.id === "tier_ads")?.hits).toBe(900);
    // Above the 50-match sample, so the tiers that fired nothing are measured zeros and the plan
    // is weighted by evidence.
    expect(data.basis.source).toBe("evidence");
    expect(data.plan.benefitSource).toBe("evidence");
    expect(data.basis.reason).toContain("1,412 attributed blocks");
    // `shared.example.com` is in two tier files, so it would be credited to both.
    expect(data.ledger.shared).toBe(0);
  });

  test("an exception in the ledger is never credited to a tier", async () => {
    const dir = await makeRulesDir();
    dirs.push(dir);
    const ledger = path.join(dir, "ledger.txt");
    await fs.writeFile(ledger, "@@||core.example.com^\n42\n", "utf8");

    const res = await run(dir, { hits: ledger });
    const data = res.data as {
      files: Array<{ id: string; hits: number | null }>;
      ledger: { lines: number; skipped: number };
    };
    expect(data.files.find((f) => f.id === "tier_core")?.hits).toBe(0);
    expect(data.ledger.lines).toBe(0);
    expect(data.ledger.skipped).toBe(2);
  });

  test("json output is machine-readable and carries the same plan", async () => {
    const dir = await makeRulesDir();
    dirs.push(dir);

    const res = await run(dir, { json: true });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ plan: { totalRules: 6, benefitSource: "coverage" } });
  });

  test("defaults to the tiers the manifest enables on a fresh install", async () => {
    const dir = await makeRulesDir();
    dirs.push(dir);

    const res = await run(dir);
    const data = res.data as { enabled: string[] };
    expect(data.enabled).toEqual(["tier_core"]);
  });

  test("--enabled overrides the manifest default and ignores names that are not tiers", async () => {
    const dir = await makeRulesDir();
    dirs.push(dir);

    const res = await run(dir, { enabled: "tier_core,tier_ads,not_a_tier" });
    const data = res.data as { enabled: string[] };
    expect(data.enabled).toEqual(["tier_core", "tier_ads"]);
  });

  test("--synced reports which tiers the dynamic rules already cover", async () => {
    const dir = await makeRulesDir({
      // tier_privacy ships one host and the synced list blocks it, so it adds nothing. The other
      // three each ship a host the list does not cover.
      tier_ads: rules(["ads.example.com", "shared.example.com", "extra-ads.example.com"]),
      tier_privacy: rules(["privacy.example.com"]),
      tier_annoyances: rules(["consent.example.com", "nag.example.com"]),
    });
    dirs.push(dir);
    const synced = path.join(dir, "browser.txt");
    await fs.writeFile(
      synced,
      ["! title", "||shared.example.com^", "||ads.example.com^", "||privacy.example.com^", "||consent.example.com^"].join("\n"),
      "utf8",
    );

    const res = await run(dir, { synced });
    expect(res.success).toBe(true);
    const data = res.data as {
      redundantTiers: string[];
      synced: { hosts: number; exceptions: number; lines: number; skipped: number };
      files: Array<{ id: string; rules: number; redundant: { rules: number; complete: boolean } | null }>;
    };
    expect(data.redundantTiers).toEqual(["tier_privacy"]);
    expect(data.synced).toEqual({ hosts: 4, exceptions: 0, lines: 4, skipped: 0 });
    // Every tier is diffed, not only the finding, so the numbers beside them are readable.
    expect(data.files.find((f) => f.id === "tier_core")?.redundant).toEqual({
      rules: 1,
      hosts: 1,
      complete: false,
    });
    expect(data.files.find((f) => f.id === "tier_ads")?.redundant?.rules).toBe(2);
  });

  test("redundancy is unknown rather than zero when no synced list is given", async () => {
    // The distinction the flag exists to preserve: a table of zeroes would claim every tier adds
    // something, which is a statement about a comparison nobody ran.
    const dir = await makeRulesDir();
    dirs.push(dir);

    const res = await run(dir);
    const data = res.data as {
      redundantTiers: string[];
      synced: unknown;
      files: Array<{ redundant: unknown }>;
    };
    expect(data.synced).toBeNull();
    expect(data.redundantTiers).toEqual([]);
    expect(data.files.every((f) => f.redundant === null)).toBe(true);
  });

  test("an exception in the synced list keeps a tier out of the finding", async () => {
    // The tier would be entirely duplicated by host match alone. The exception is what makes it
    // the only thing still blocking that host, so it is not redundant after all.
    const dir = await makeRulesDir({
      tier_privacy: rules(["excepted.example.com"]),
    });
    dirs.push(dir);
    const synced = path.join(dir, "browser.txt");
    await fs.writeFile(synced, "||excepted.example.com^\n@@||excepted.example.com^\n", "utf8");

    const res = await run(dir, { synced });
    const data = res.data as { redundantTiers: string[]; synced: { exceptions: number } };
    expect(data.synced.exceptions).toBe(1);
    expect(data.redundantTiers).not.toContain("tier_privacy");
  });

  test("the same files produce the same redundancy in core", async () => {
    // The CLI and the hub's card render one computation, so a disagreement about the same bytes
    // would be invisible to both.
    const dir = await makeRulesDir();
    dirs.push(dir);
    const syncedPath = path.join(dir, "browser.txt");
    await fs.writeFile(syncedPath, "||core.example.com^\n||shared.example.com^\n", "utf8");

    const res = await run(dir, { synced: syncedPath });
    const data = res.data as { redundantTiers: string[] };

    const expected = computeTierPlan({
      files: [
        { id: "tier_core", rules: rules(["core.example.com", "shared.example.com"]) },
        { id: "tier_ads", rules: rules(["ads.example.com", "shared.example.com"]) },
        { id: "tier_privacy", rules: rules(["privacy.example.com"]) },
        { id: "tier_annoyances", rules: rules(["consent.example.com"]) },
      ],
      synced: { text: "||core.example.com^\n||shared.example.com^\n" },
      enabled: ["tier_core"],
    });
    expect(data.redundantTiers).toEqual(expected.redundantTiers);
    expect(data.redundantTiers).toEqual(["tier_core"]);
  });
});
