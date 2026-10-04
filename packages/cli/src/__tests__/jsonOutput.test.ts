/**
 * Every `--json` command in the CLI, pinned against the stream a machine consumer reads.
 *
 * `tier-plan --json` had this test and the other four paths did not, which is exactly why one of
 * them had shipped a payload through the colourised winston transport: the output was a timestamp
 * and an escape-wrapped blob, `JSON.parse` failed on the timestamp rather than on the payload,
 * and nothing in the suite looked at stdout. All four now leave through `writeJson` — one writer,
 * no ANSI, no timestamp — and this suite holds the line:
 *
 *   - **A source scan across every command and every script**, so a `--json` branch written by
 *     hand tomorrow fails here rather than in a user's pipe. It is also the only check that
 *     reaches `ai-crawl`, whose `--json` branch cannot run in a test: `crawlAndScanUrl` applies
 *     an SSRF guard that refuses loopback, so there is no offline target to point it at.
 *   - **A real capture for the two CLI paths that run offline** — `coverage` against fixture
 *     files and `ai-scan` against the embedded classifier — each parsed where it was written,
 *     with the parsed document checked against the `data` the same call returned.
 *   - **The same parse, end to end, for `compile-tier-rulesets.mjs`** — the one script with a
 *     `--json`. It cannot import the CLI's writer (it is a plain `.mjs` that must run before
 *     `dist/` exists), so `scripts/stdout.mjs` carries the identical contract across the
 *     boundary, and this suite reads its stdout the way a pipe does — including `--check --json`,
 *     which used to answer a document request with the human line.
 *
 * The last point is the one that makes parseability insufficient: a command can emit valid JSON
 * that is not the answer it gave the caller, and the caller reading the pipe and the caller
 * reading the return value are two consumers that must agree.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFileSync } from "node:child_process";
import { createLogger } from "../lib/logger.js";
import { CoverageCommand } from "../commands/CoverageCommand.js";
import { AiScanCommand } from "../commands/AiScanCommand.js";
import { TierPlanCommand } from "../commands/TierPlanCommand.js";
import { captureStdout, parseJsonStdout } from "./captureStdout.js";

const logger = createLogger();
const commandsDir = path.join(process.cwd(), "src", "commands");

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

const repoRoot = path.join(process.cwd(), "..", "..");
const scriptsDir = path.join(repoRoot, "scripts");

describe("no command writes a --json payload by hand", () => {
  it("routes every payload through writeJson, in every command file and every script", async () => {
    // The regression this guards is a single `console.log(JSON.stringify(payload))` in a command
    // or script added or edited later. It parses fine on a machine with no colour support and
    // fails on the one that has it, which is why it reached production as a working command.
    // The contract does not stop at the package boundary: `compile-tier-rulesets.mjs --json` is
    // the same pipe a `coverage --json` is, and its writer is `scripts/stdout.mjs`.
    const files = (await fs.readdir(commandsDir)).filter((f) => f.endsWith(".ts"));
    const scriptFiles = (await fs.readdir(scriptsDir)).filter((f) => f.endsWith(".mjs"));
    expect(files.length).toBeGreaterThan(0);
    expect(scriptFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(path.join(commandsDir, file), "utf8");
      if (/console\.(log|info)\(\s*JSON\.stringify/.test(source)) {
        offenders.push(`commands/${file}`);
      }
    }
    for (const file of scriptFiles) {
      const source = await fs.readFile(path.join(scriptsDir, file), "utf8");
      if (/console\.(log|info)\(\s*JSON\.stringify/.test(source)) {
        offenders.push(`scripts/${file}`);
      }
    }
    // Named rather than counted, so a failure says which command regressed.
    expect(offenders).toEqual([]);
  });

  it("still has a writer to route through on both sides, so the scan cannot pass by accident", async () => {
    // A test that asserts a ban with nothing on the other side of it is satisfied by deleting the
    // feature. These are the other side: the CLI's `writeJson` writes a newline-terminated
    // document and is what `cli.ts` itself uses for a command result; the scripts' `writeJson`
    // is the identical contract in a module a build-less script can import, and the compiler —
    // the one script with a `--json` today — emits through it.
    const writer = await fs.readFile(path.join(process.cwd(), "src", "lib", "logger.ts"), "utf8");
    expect(writer).toContain("export function writeJson");
    expect(writer).toContain("process.stdout.write");
    expect(await fs.readFile(path.join(process.cwd(), "src", "cli.ts"), "utf8")).toContain(
      "writeJson(",
    );

    const scriptWriter = await fs.readFile(path.join(scriptsDir, "stdout.mjs"), "utf8");
    expect(scriptWriter).toContain("export function writeJson");
    expect(scriptWriter).toContain("process.stdout.write");
    expect(
      await fs.readFile(path.join(scriptsDir, "compile-tier-rulesets.mjs"), "utf8"),
    ).toContain("writeJson(");
  });

  it("names each --json command that has no writer call, rather than trusting the scan alone", async () => {
    // The scan proves nobody writes JSON by hand; this proves each command that claims `--json`
    // actually emits through the writer. It is also what reaches `ai-crawl`, whose `--json` branch
    // cannot run here — `crawlAndScanUrl` applies an SSRF guard that refuses loopback, so there is
    // no offline target to point it at and only the source can be checked.
    //
    // The list is derived from the directory, not written down here — a command added tomorrow
    // with a `json?: boolean` option and no writer call fails this test without the test having
    // to be told the command exists.
    const files = (await fs.readdir(commandsDir)).filter((f) => f.endsWith(".ts"));
    const missing: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(path.join(commandsDir, file), "utf8");
      const declaresJson = /\bjson\??:\s*boolean/.test(source);
      const writesThrough = /writeJson\(/.test(source);
      if (declaresJson && !writesThrough) missing.push(file);
    }
    expect(missing).toEqual([]);
  });
});

describe("coverage --json", () => {
  let dir: string;
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes a document a caller can parse, and it is the answer the caller also received", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-json-coverage-"));
    const rules = path.join(dir, "rules.txt");
    const trace = path.join(dir, "trace.txt");
    await fs.writeFile(rules, ["||ads.example.com^", "||tracker.example.com^"].join("\n"), "utf8");
    await fs.writeFile(trace, "ads.example.com\nbenign.example.org\n", "utf8");

    const cmd = new CoverageCommand({ config: { baseDir: dir } as never, logger });
    const output = await captureStdout(() =>
      cmd.execute({ rules, trace, json: true }),
    );
    const parsed = parseJsonStdout<{
      source: string;
      coverage: { matchedRules: number };
      ledger: { matchedRules: number };
    }>(output);
    const result = await cmd.execute({ rules, trace, json: true });

    expect(parsed.source).toBe("trace");
    // The parsed stream and the returned `data` are the same document: a consumer reading the pipe
    // and one reading the return value must not get two different answers to one command.
    expect(parsed).toEqual(result.data);
    expect(parsed.ledger.matchedRules).toBe(1);
  });

  it("carries the report's own numbers rather than a summary of them", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-json-coverage-"));
    const rules = path.join(dir, "rules.txt");
    const trace = path.join(dir, "trace.txt");
    await fs.writeFile(rules, ["||ads.example.com^", "||tracker.example.com^"].join("\n"), "utf8");
    await fs.writeFile(trace, "ads.example.com\nbenign.example.org\n", "utf8");

    const cmd = new CoverageCommand({ config: { baseDir: dir } as never, logger });
    const output = await captureStdout(() => cmd.execute({ rules, trace, json: true }));
    const parsed = parseJsonStdout<{ coverage: { totalRules: number; curve: unknown[] } }>(output);

    // Not a re-summary: the curve is what makes the report usable by a person deciding where to
    // cut a list, and a `--json` path that dropped it would still pass every assertion above.
    expect(parsed.coverage.totalRules).toBe(2);
    expect(parsed.coverage.curve.length).toBeGreaterThan(0);
  });
});

describe("ai-scan --json", () => {
  it("writes the scan it performed, with no colour and nothing wrapped around it", async () => {
    // `local-heuristics` is the embedded classifier, so this runs with no network and no
    // provider key — the only reason this branch is reachable from a test at all.
    const cmd = new AiScanCommand({ config: { baseDir: process.cwd() } as never, logger: silentLogger });
    const result = await cmd.execute({
      target: "doubleclick.net",
      provider: "local-heuristics",
    });
    const output = await captureStdout(() =>
      cmd.execute({ target: "doubleclick.net", provider: "local-heuristics", json: true }),
    );
    const parsed = parseJsonStdout<{ domain: string; verdict: string; generatedRules: string[] }>(
      output,
    );

    expect(result.success).toBe(true);
    expect(parsed.domain).toBe("doubleclick.net");
    expect(parsed.generatedRules).toContain("||doubleclick.net^");
    // Same verdict as the non-JSON run: the flag chooses a format, not an answer.
    expect(parsed.verdict).toBe(result.data.verdict);
  });
});

describe("tier-plan --json", () => {
  it("runs through the same shared capture the other commands use", async () => {
    // `tier-plan.test.ts` had the capture inlined before the helper existed, and it is the one
    // suite whose `--json` assertion is worth keeping as the definition of the contract. What
    // changed is that there is now exactly one place where "what the caller sees" is defined, so
    // a fix to it reaches every `--json` command rather than the one that happened to find it.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-json-tierplan-"));
    try {
      const rule = (host: string) => ({
        id: 1,
        priority: 1,
        action: { type: "block" },
        condition: { urlFilter: `||${host}^` },
      });
      for (const [tier, hosts] of Object.entries({
        tier_core: ["core.example.com"],
        tier_ads: ["ads.example.com"],
        // The four curated tiers must be non-empty or the command refuses the whole bundle —
        // `tier_security` and `tier_unclassified` are compiled rather than curated, so an empty
        // file is a legitimate state for them and only them.
        tier_privacy: ["privacy.example.com"],
        tier_annoyances: ["consent.example.com"],
        tier_security: [],
        tier_unclassified: [],
      })) {
        await fs.writeFile(path.join(dir, `${tier}.json`), JSON.stringify(hosts.map(rule)), "utf8");
      }
      const cmd = new TierPlanCommand({ config: {} as never, logger });
      const output = await captureStdout(() => cmd.execute({ rulesDir: dir, json: true }));
      const parsed = parseJsonStdout<{ files: Array<{ id: string; rules: number }> }>(output);
      // Every tier file is reported, including the two legitimately empty ones: a plan that
      // omitted them would be shorter and would look tidier, and would say nothing about what is
      // not in the bundle.
      expect(parsed.files.map((f) => f.id)).toHaveLength(6);
      expect(parsed.files.filter((f) => f.rules === 0).map((f) => f.id)).toEqual([
        "tier_security",
        "tier_unclassified",
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("compile-tier-rulesets --json", () => {
  // The contract does not end at the package boundary: the compiler is a plain `.mjs` that must
  // run before `dist/` exists, so it cannot import the CLI's writer — it imports the identical
  // one in `scripts/stdout.mjs`, and this runs it end to end and parses its stdout exactly as a
  // pipe would. A shared test is the only thing that makes "one contract" observable rather than
  // claimed.
  const COMPILER = path.join(repoRoot, "scripts", "compile-tier-rulesets.mjs");

  async function makeRulesWorkdir(dir: string): Promise<void> {
    // A synthetic curated baseline — one host per tier — plus the catalogue and counts module the
    // compiler writes beside them, in the shapes `tierCompiler.test.ts` uses.
    const rulesDir = path.join(dir, "rules");
    await fs.mkdir(rulesDir, { recursive: true });
    const rule = (host: string) => ({
      id: 1,
      priority: 1,
      action: { type: "block" },
      condition: { urlFilter: `||${host}^` },
    });
    const tiers = [
      "tier_core",
      "tier_ads",
      "tier_privacy",
      "tier_annoyances",
      "tier_security",
      "tier_unclassified",
    ];
    for (const tier of tiers) {
      await fs.writeFile(
        path.join(rulesDir, `${tier}.json`),
        JSON.stringify([rule(`curated-${tier}.example.com`)]),
        "utf8",
      );
    }
    await fs.writeFile(
      path.join(dir, "catalogue.ts"),
      `export const STATIC_RULE_TIERS = [\n${tiers
        .map(
          (tier) =>
            `  { id: '${tier}', label: 'L', description: 'D', path: 'rules/${tier}.json', category: 'core', defaultEnabled: false, ruleCount: 1 },`,
        )
        .join("\n")}\n] as const;\n`,
      "utf8",
    );
  }

  it("writes a document a pipe can parse, with the compilation's own numbers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-json-compiler-"));
    try {
      await makeRulesWorkdir(dir);
      const input = path.join(dir, "merged.txt");
      await fs.writeFile(
        input,
        ["0.0.0.0 ads.something.example.com", "||beacon.tracker-example.com^", ""].join("\n"),
        "utf8",
      );

      const stdout = execFileSync(
        "node",
        [
          COMPILER,
          "--input", input,
          "--budget", "200",
          "--json",
          "--rules-dir", path.join(dir, "rules"),
          "--counts-path", path.join(dir, "counts.ts"),
          "--catalogue-path", path.join(dir, "catalogue.ts"),
        ],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );

      // The whole stream is the document — `JSON.parse` refuses a log line wrapped around it, and
      // parseJsonStdout refuses colour, so both failure doors the CLI once had are checked here.
      const parsed = parseJsonStdout<{
        budget: number;
        total: number;
        counts: Record<string, number>;
        inputs: string[];
      }>(stdout);
      expect(parsed.budget).toBe(200);
      expect(parsed.counts.tier_ads).toBeGreaterThan(0);
      expect(parsed.inputs).toContain(input);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps stdout clean on a refusal — the error goes to stderr, not into the document's stream", async () => {
    // A refusal is a --json run too: the error text must not contaminate the stream a pipe reads.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-json-compiler-err-"));
    try {
      await makeRulesWorkdir(dir);
      let stdout = "";
      let status = 0;
      try {
        execFileSync(
          "node",
          [
            COMPILER,
            "--input", path.join(dir, "input.txt"),
            "--budget", "200",
            "--json",
            "--residual", "tier_adz",
            "--rules-dir", path.join(dir, "rules"),
            "--counts-path", path.join(dir, "counts.ts"),
            "--catalogue-path", path.join(dir, "catalogue.ts"),
          ],
          { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        const err = error as { status?: number; stdout?: string };
        status = err.status ?? 1;
        stdout = err.stdout ?? "";
      }
      expect(status).toBeGreaterThan(0);
      // Whatever it said, it did not say it on stdout.
      expect(stdout.trim()).toBe("");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("--check --json emits the verdict as a document instead of silently answering with prose", async () => {
    // The flag combination used to run the check and print the human line — a `--json` ignored.
    // The verdict is exactly what CI wants to gate on, so it is a document: `ok`, which tiers are
    // stale, and which check actually ran (a compilationless checkout checks the baseline, which
    // is a different question and must not read as the same one).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-json-check-"));
    try {
      await makeRulesWorkdir(dir);
      const baseArgs = [
        "--budget", "200",
        "--check",
        "--json",
        "--rules-dir", path.join(dir, "rules"),
        "--counts-path", path.join(dir, "counts.ts"),
        "--catalogue-path", path.join(dir, "catalogue.ts"),
      ];

      // No compilation recorded → the curated-baseline check answers as a document.
      const baseline = execFileSync("node", [COMPILER, ...baseArgs], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const baselineParsed = parseJsonStdout<{ check: string; ok: boolean }>(baseline);
      expect(baselineParsed).toMatchObject({ check: "curated-baseline", ok: true });

      // Compile once so a recorded compilation exists, then tamper with a tier file: the check
      // must report the staleness by tier name, on stdout, as the document.
      const input = path.join(dir, "merged.txt");
      await fs.writeFile(input, "0.0.0.0 ads.something.example.com\n", "utf8");
      execFileSync(
        "node",
        [
          COMPILER, "--input", input, "--budget", "200",
          "--rules-dir", path.join(dir, "rules"),
          "--counts-path", path.join(dir, "counts.ts"),
          "--catalogue-path", path.join(dir, "catalogue.ts"),
        ],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      await fs.writeFile(path.join(dir, "rules", "tier_ads.json"), "[]", "utf8");

      let stdout = "";
      let status = 0;
      try {
        execFileSync("node", [COMPILER, "--input", input, ...baseArgs], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const err = error as { status?: number; stdout?: string };
        status = err.status ?? 1;
        stdout = err.stdout ?? "";
      }
      expect(status).toBe(1);
      const parsed = parseJsonStdout<{ check: string; ok: boolean; staleTiers: string[] }>(stdout);
      expect(parsed).toMatchObject({ check: "compiled-plan", ok: false });
      expect(parsed.staleTiers).toContain("tier_ads");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});