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
import { captureStdout, parseJsonStdout } from "./captureStdout.js";
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
    // Written as an empty file, which is the state `tier_security` is legitimately in on a machine
    // that has never run the classifier. Omitting it would not model a missing verdict file; it
    // would model a corrupt bundle, and the command refuses one of those.
    tier_security: rules([]),
    // Same shape, same reason: the residual bucket is empty in a checkout that has never been
    // compiled, and it is compiled rather than curated for the same reason `tier_security` is.
    tier_unclassified: rules([]),
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
    const data = res.data as { files: Array<{ id: string; rules: number }>; plan: { totalRules: number; benefitSource: string } };
    // Not the catalogue's curated counts: a packaged build ships tens of thousands per tier, and
    // a plan computed from the baseline would be a plan about a different bundle.
    expect(data.files.map((f) => f.rules)).toEqual([2, 2, 1, 1, 0, 0]);
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
    // must take the same code path, and `broken` is how a differing path announces itself. Every
    // tier that has a curated baseline to lose is broken by an empty file — all of them but
    // `tier_security`, which has none and is allowed to ship nothing.
    expect(expected.broken.map((row) => row.id)).toEqual(
      STATIC_RULE_TIERS.filter((tier) => tier.curatedSeed).map((tier) => tier.id),
    );
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

  test("--json writes a JSON document to stdout with none of the human log wrapped around it", async () => {
    const dir = await makeRulesDir();
    dirs.push(dir);

    // The defect this pins: the payload used to be logged through the winston console transport,
    // which prefixes a timestamp and colourises the whole message, so `JSON.parse` of stdout failed
    // on the timestamp and a machine consumer had no way around it. Asserting on `res.data` alone
    // passes either way, which is why the earlier version of this test did not catch it — the
    // output has to be parsed where the caller reads it, on stdout.
    //
    // The capture itself now lives in `captureStdout.ts`, shared with the other `--json` commands,
    // so "what the caller sees" is defined once rather than re-implemented per suite.
    let res!: Awaited<ReturnType<typeof run>>;
    const output = await captureStdout(async () => {
      res = await run(dir, { json: true });
    });
    const parsed = parseJsonStdout<{
      files: Array<{ id: string }>;
      plan: { totalRules: number; benefitSource: string };
    }>(output);
    // Parseable is necessary but not sufficient: the document has to be *the same plan* the caller
    // receives, or a machine consumer and a person would be looking at different answers.
    expect(parsed).toMatchObject({ plan: { totalRules: 6, benefitSource: "coverage" } });
    expect(parsed.files.map((f) => f.id)).toEqual(res.data.files.map((f: { id: string }) => f.id));
    expect(res.success).toBe(true);
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
      files: Array<{ id: string; rules: number; redundant: { rules: number; typeLimited: number; complete: boolean } | null }>;
    };
    expect(data.redundantTiers).toEqual(["tier_privacy"]);
    expect(data.synced).toEqual({ hosts: 4, exceptions: 0, lines: 4, skipped: 0 });
    // Every tier is diffed, not only the finding, so the numbers beside them are readable.
    expect(data.files.find((f) => f.id === "tier_core")?.redundant).toEqual({
      rules: 1,
      hosts: 1,
      typeLimited: 0,
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
        { id: "tier_security", rules: [] },
      ],
      synced: { text: "||core.example.com^\n||shared.example.com^\n" },
      enabled: ["tier_core"],
    });
    expect(data.redundantTiers).toEqual(expected.redundantTiers);
    expect(data.redundantTiers).toEqual(["tier_core"]);
  });
});
