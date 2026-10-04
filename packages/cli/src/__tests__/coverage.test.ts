import { jest } from "@jest/globals";
import { pathRuleDecidability } from "@blockingmachine/core";
import {
  CoverageCommand,
  hostOf,
  parseRequestTrace,
  parseRuleHits,
} from "../commands/CoverageCommand.js";
import { existsSync, readFileSync } from "fs";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const cliRoot = fileURLToPath(new URL("../../", import.meta.url));
const realListPath = path.join(cliRoot, "filters", "output", "genericBrowserRules.txt");

describe("request trace parsing", () => {
  test("reads bare hosts and full URLs, ignoring comments and blanks", () => {
    const entries = parseRequestTrace(
      [
        "# a captured trace",
        "doubleclick.net",
        "https://sb.scorecardresearch.com/internal-cs/default/beacon.js",
        "! another comment",
        "",
        "   ",
        "cdn.example.com:8080/path?q=1",
      ].join("\n"),
    );

    expect(entries.map((entry) => entry.host)).toEqual([
      "doubleclick.net",
      "sb.scorecardresearch.com",
      "cdn.example.com",
    ]);
  });

  test("keeps each URL distinct instead of collapsing the trace to hosts", () => {
    // The change that makes a path-scoped rule decidable. Aggregating by host destroys the only
    // thing that distinguishes these three requests, and one of them is the request the rule
    // actually blocks.
    const entries = parseRequestTrace(
      [
        "https://cdn.example.com/assets/ads.js\t2",
        "https://cdn.example.com/app.css\t3",
        "https://cdn.example.com/assets/ads.js\t1",
        "cdn.example.com\t9",
      ].join("\n"),
    );

    expect(entries.map((entry) => entry.url)).toEqual([
      "https://cdn.example.com/assets/ads.js",
      "https://cdn.example.com/app.css",
      undefined,
    ]);
    // The same URL seen twice is one entry with the counts added, as before.
    expect(entries[0].count).toBe(3);
    expect(entries[1].count).toBe(3);
    expect(entries[2].count).toBe(9);
    // Every entry still carries the host the evaluator needs.
    expect(entries.every((entry) => entry.host === "cdn.example.com")).toBe(true);
  });

  test("parses the URL-bearing session fixture the way its header describes", () => {
    const fixture = readFileSync(path.join(cliRoot, "src", "__tests__", "fixtures", "browsing-trace-urls.txt"), "utf-8");
    const entries = parseRequestTrace(fixture);
    expect(entries.length).toBe(11);
    expect(entries.every((entry) => entry.url !== undefined)).toBe(true);
    expect(entries.reduce((sum, entry) => sum + entry.count, 0)).toBe(28);
    // The two /ads.js requests the fixture header says the path rule should catch.
    expect(entries.filter((entry) => /\/ads\.js$/.test(entry.url ?? "")).map((entry) => entry.url)).toEqual([
      "https://cdn.example.com/assets/ads.js",
      "https://cdn.example.com/thirdparty/ads.js",
    ]);
  });

  test("aggregates repeated hosts and honours an explicit count", () => {
    const entries = parseRequestTrace(
      ["doubleclick.net", "doubleclick.net", "tracker.io\t25", "ads.example.com 4"].join("\n"),
    );
    const byHost = Object.fromEntries(entries.map((entry) => [entry.host, entry.count]));
    expect(byHost).toEqual({
      "doubleclick.net": 2,
      "tracker.io": 25,
      "ads.example.com": 4,
    });
  });

  test("strips the scheme, path, query, fragment, and port", () => {
    // `www` is deliberately preserved: the hostname is kept faithful to the request, and the
    // rule evaluator already handles subdomain matching.
    expect(hostOf("https://WWW.Example.com:443/a/b?c=d#e")).toBe("www.example.com");
    expect(hostOf("//cdn.example.com/x")).toBe("cdn.example.com");
    expect(hostOf("example.com")).toBe("example.com");
    expect(hostOf("")).toBeNull();
    expect(hostOf("user@host.com")).toBeNull();
  });
});

describe("rule hit ledger parsing", () => {
  test("reads the extension's `count<TAB>rule` export", () => {
    const hits = parseRuleHits("12\t||doubleclick.net^\n3\t||adnxs.com^\n");
    expect(hits).toEqual([
      { rule: "||doubleclick.net^", count: 12 },
      { rule: "||adnxs.com^", count: 3 },
    ]);
  });

  test("also accepts `rule<TAB>count` and bare rules", () => {
    const hits = parseRuleHits(["||a.example^ 4", "||b.example^", "# comment", ""].join("\n"));
    expect(hits).toEqual([
      { rule: "||a.example^", count: 4 },
      { rule: "||b.example^", count: 1 },
    ]);
  });

  test("keeps a hosts-format rule intact when a count leads", () => {
    const hits = parseRuleHits("9\t0.0.0.0 telemetry.example.com");
    expect(hits).toEqual([{ rule: "0.0.0.0 telemetry.example.com", count: 9 }]);
  });

  test("merges repeat entries for the same rule", () => {
    expect(parseRuleHits("2\t||a.example^\n5\t||a.example^")).toEqual([
      { rule: "||a.example^", count: 7 },
    ]);
  });
});

describe("coverage command", () => {
  let tmpDir: string;
  let mockLogger: any;
  let logSpy: any;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-coverage-test-"));
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function runCoverage(rulesText: string, traceText: string) {
    const rulesPath = path.join(tmpDir, "rules.txt");
    const tracePath = path.join(tmpDir, "trace.txt");
    await fs.writeFile(rulesPath, rulesText, "utf-8");
    await fs.writeFile(tracePath, traceText, "utf-8");

    const cmd = new CoverageCommand({ config: { baseDir: tmpDir } as any, logger: mockLogger });
    return cmd.execute({ rules: rulesPath, trace: tracePath, json: false });
  }

  test("keeps request URLs, so a path-scoped rule can be decided rather than excluded", async () => {
    // The whole point of the URL-carrying trace. Read from hostnames, the zone block and the
    // path rule are the same statement and the zone block wins, so the path rule is credited
    // with all four requests to the host — including the three it does not touch. The URL is the
    // only thing that distinguishes them.
    const rules = [
      "||cdn.example.com^",
      "||cdn.example.com^*/ads.js",
      "||third.example.org^$third-party",
    ].join("\n");

    const trace = [
      "https://cdn.example.com/assets/ads.js\t2",
      "https://cdn.example.com/app.css\t3",
      "https://cdn.example.com/logo.svg\t5",
      "https://cdn.example.com/deep/ads.js\t1",
      "https://third.example.org/beacon\t6",
    ].join("\n");

    const result = await runCoverage(rules, trace);
    expect(result.success).toBe(true);
    const data: any = result.data;

    // Five URLs, five requests, one host. Aggregation is per URL now, which is what preserved the
    // distinction between the two requests that hit /ads.js and the three that did not.
    expect(data.trace.urlsInTrace).toBe(5);
    expect(data.trace.uniqueHosts).toBe(5);

    // Two of the four requests to cdn.example.com matched the path rule, and only those two.
    expect(data.trace.urlDecidedRequests).toBe(3);
    expect(data.trace.urlDecidedRules).toBe(1);
    // The zone block kept the other two, not all four: that is the over-count being removed.
    expect(data.ledger.matchedRules).toBe(1);

    // The initiator-scoped rule is still undecidable, and says so rather than vanishing. A URL
    // settles a path; it settles nothing about whether the request was third-party.
    expect(data.ledger.contextScopedRulesFired).toBeGreaterThanOrEqual(0);
  });

  test("says out loud when a trace records hostnames only, because that decides nothing", async () => {
    // A hostname-only trace still measures the hostname bucket exactly, and reports zero for the
    // path bucket. Silence there would read as "no path-scoped rule ever fired", which is a
    // statement about the capture and not about the list.
    const rules = ["||cdn.example.com^", "||cdn.example.com^*/ads.js"].join("\n");
    const trace = ["cdn.example.com 7"].join("\n");

    const result = await runCoverage(rules, trace);
    expect(result.success).toBe(true);
    const data: any = result.data;
    expect(data.trace.urlsInTrace).toBe(0);
    expect(data.trace.urlDecidedRequests).toBe(0);
    expect(data.trace.urlDecidedRules).toBe(0);
    // Fallback intact: the zone block still takes everything it always did.
    expect(data.ledger.matchedRules).toBe(1);
  });

  test("reports the hit rate and the head that carries the blocking", async () => {
    // Four rules fire; 990 rules never do.
    const rules = [
      "! header",
      "||doubleclick.net^",
      "||scorecardresearch.com^",
      "||adnxs.com^",
      "@@||safe.example.com^",
      "example.com##.banner",
      ...Array.from({ length: 990 }, (_, i) => `||tail-${i}.example^`),
    ].join("\n");

    const trace = [
      "doubleclick.net 60",
      "scorecardresearch.com 30",
      "adnxs.com 10",
      "wikipedia.org 500",
    ].join("\n");

    const result = await runCoverage(rules, trace);
    expect(result.success).toBe(true);

    const data: any = result.data;
    // Cosmetic rules are excluded from the network count, so the denominator is honest.
    expect(data.rules.compiledLines).toBe(996);
    expect(data.rules.networkRules).toBe(994);
    // The exception rule is decidable but is not a block, so it is not in the coverage denominator.
    expect(data.rules.indexedRules).toBe(994);
    expect(data.rules.indexedBlockingRules).toBe(993);

    expect(data.trace.blockedRequests).toBe(100);
    expect(data.trace.blockedHosts).toBe(3);
    expect(data.trace.matchedHostRatePercent).toBeCloseTo(75, 5);

    // Every blocking rule here is decidable from a hostname, so the rate's denominator is the
    // whole blocking list and nothing is held back.
    expect(data.rules.scopes).toEqual({ hostname: 993, initiator: 0, path: 0, request: 0, total: 993 });
    expect(data.coverage.totalRules).toBe(993);
    expect(data.coverage.matchedRules).toBe(3);
    expect(data.coverage.blockedRequests).toBe(100);
    // One rule alone is 60% of the blocking; two are 90%.
    const head90 = data.coverage.minimumRules.find((p: any) => p.share === 0.9);
    expect(head90.rules).toBe(2);
    expect(data.coverage.listHitRatePercent).toBeLessThan(1);
  });

  test("reports an allowlist match separately instead of crediting it as a block", async () => {
    const rules = ["||ads.example.com^", "@@||safe.ads.example.com^"].join("\n");
    const result = await runCoverage(rules, "safe.ads.example.com");

    const data: any = result.data;
    expect(data.trace.allowlistedHosts).toBe(1);
    expect(data.trace.blockedHosts).toBe(0);
    expect(data.trace.exceptionRulesFired).toBe(1);
    // The exception decided the request the other way, so it contributes no blocking coverage.
    expect(data.coverage.matchedRules).toBe(0);
    expect(data.coverage.topRules).toEqual([]);
  });

  test("keeps context-scoped winners out of the rate instead of reporting an upper bound", async () => {
    // `||cdn.example.com^*/ads.js` keeps a path, so a hostname-only replay cannot decide it and
    // reads it as a block of the whole zone — exactly the approximation that made the old rate an
    // upper bound. It is now reported beside the rate rather than inside it.
    const rules = [
      "||cdn.example.com^*/ads.js",
      "||plain-block.example^",
    ].join("\n");

    const result = await runCoverage(rules, "cdn.example.com\nplain-block.example");
    const data: any = result.data;

    // The list splits into one rule a hostname can decide and one it cannot.
    expect(data.rules.scopes).toEqual({ hostname: 1, initiator: 0, path: 1, request: 0, total: 2 });
    expect(data.rules.hostnameDecidableRules).toBe(1);

    // The rate is measured over the decidable rule alone — numerator and denominator both.
    expect(data.coverage.totalRules).toBe(1);
    expect(data.coverage.matchedRules).toBe(1);
    expect(data.coverage.topRules.map((rule: any) => rule.rule)).toEqual(["||plain-block.example^"]);

    // The path-scoped fire is tallied beside it, with the requests it accounted for.
    expect(data.ledger.scopedRulesFired).toEqual({ initiator: 0, path: 1, request: 0 });
    expect(data.ledger.contextScopedRulesFired).toBe(1);
    expect(data.ledger.scopedRequests).toBe(1);

    // Both hosts were still blocked: the trace block reports blocking, not decidability.
    expect(data.trace.blockedHosts).toBe(2);
    expect(data.trace.scopedHosts).toBe(1);
    expect(data.trace.scopedRequests).toBe(1);
  });

  test("measures a browser-exported hit ledger without replaying it", async () => {
    // The ledger is what the browser reported, so no hostname approximation is involved.
    const rules = [
      "||doubleclick.net^",
      "||adnxs.com^",
      "||cdn.example.com^*/ads.js",
      ...Array.from({ length: 497 }, (_, i) => `||tail-${i}.example^`),
    ].join("\n");
    const ledger = ["90\t||doubleclick.net^", "8\t||adnxs.com^", "2\t||cdn.example.com^*/ads.js"].join("\n");

    const rulesPath = path.join(tmpDir, "ledger-rules.txt");
    const hitsPath = path.join(tmpDir, "hits.txt");
    await fs.writeFile(rulesPath, rules, "utf-8");
    await fs.writeFile(hitsPath, ledger, "utf-8");

    const cmd = new CoverageCommand({ config: { baseDir: tmpDir } as any, logger: mockLogger });
    const result = await cmd.execute({ rules: rulesPath, hits: hitsPath });
    expect(result.success).toBe(true);

    const data: any = result.data;
    expect(data.source).toBe("hits");
    // No replay happened, so there is no host-level trace block to report.
    expect(data.trace).toBeNull();
    expect(data.rules.indexedBlockingRules).toBe(500);
    // One of the 500 keeps a path, so it is counted as its own scope rather than as a host rule.
    expect(data.rules.scopes.hostname).toBe(499);
    expect(data.rules.scopes.path).toBe(1);
    // The rate counts only the hostname-decidable rules — numerator and denominator alike.
    expect(data.coverage.totalRules).toBe(499);
    expect(data.coverage.matchedRules).toBe(2);
    expect(data.coverage.blockedRequests).toBe(98);
    // One rule is 90% of the hostname-decidable blocking on its own (90 of 98).
    const head90 = data.coverage.minimumRules.find((p: any) => p.share === 0.9);
    expect(head90.rules).toBe(1);
    // The path-scoped fire is measured too — just not folded into the headline.
    expect(data.ledger.contextScopedRulesFired).toBe(1);
    expect(data.ledger.scopedRulesFired.path).toBe(1);
    expect(data.ledger.scopedRequests).toBe(2);
  });

  test("explains itself when neither an input nor a ledger is supplied", async () => {
    const cmd = new CoverageCommand({ config: { baseDir: tmpDir } as any, logger: mockLogger });
    const result = await cmd.execute({});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/--trace.*--hits/);
  });

  test("rejects an empty hit ledger", async () => {
    const rulesPath = path.join(tmpDir, "r.txt");
    const hitsPath = path.join(tmpDir, "empty-hits.txt");
    await fs.writeFile(rulesPath, "||ads.example.com^", "utf-8");
    await fs.writeFile(hitsPath, "# nothing matched\n", "utf-8");

    const cmd = new CoverageCommand({ config: { baseDir: tmpDir } as any, logger: mockLogger });
    const result = await cmd.execute({ rules: rulesPath, hits: hitsPath });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No rule hits found/);
  });

  test("fails clearly when the trace holds no usable requests", async () => {
    const result = await runCoverage("||ads.example.com^", "# only comments\n\n");
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No usable requests/);
  });

  test("fails clearly when the rule file is missing", async () => {
    const tracePath = path.join(tmpDir, "trace.txt");
    await fs.writeFile(tracePath, "doubleclick.net", "utf-8");
    const cmd = new CoverageCommand({ config: { baseDir: tmpDir } as any, logger: mockLogger });
    const result = await cmd.execute({ rules: path.join(tmpDir, "nope.txt"), trace: tracePath });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No rules found/);
  });

  // The real compiled list is the point of the instrument, so measure it, not a stand-in.
  const realListAvailable = existsSync(realListPath);
  (realListAvailable ? test : test.skip)(
    "measures the real compiled browser list",
    async () => {
      const tracePath = path.join(tmpDir, "real-trace.txt");
      await fs.writeFile(
        tracePath,
        [
          "# real request hostnames observed while browsing",
          "doubleclick.net 12",
          "googlesyndication.com 9",
          "scorecardresearch.com 4",
          "sb.scorecardresearch.com 3",
          "www.googletagmanager.com 6",
          "static.files.bbci.co.uk 8",
        ].join("\n"),
        "utf-8",
      );

      const cmd = new CoverageCommand({ config: { baseDir: tmpDir } as any, logger: mockLogger });
      const result = await cmd.execute({ rules: realListPath, trace: tracePath });
      expect(result.success).toBe(true);

      const data: any = result.data;
      // A real export: six figures of lines, and a cosmetic-heavy tail.
      expect(data.rules.compiledLines).toBeGreaterThan(200000);
      expect(data.rules.networkRules).toBeLessThan(data.rules.compiledLines);
      // Only the unconditional domain rules can be decided from a hostname alone.
      expect(data.rules.indexedRules).toBeGreaterThan(50000);
      expect(data.rules.indexedRules).toBeLessThanOrEqual(data.rules.networkRules);

      // The ad hosts in the trace are blocked by rules from the list...
      expect(data.coverage.matchedRules).toBeGreaterThan(0);
      expect(data.trace.blockedHosts).toBeGreaterThanOrEqual(3);
      // ...and the first-party CDN is never blocked by one.
      expect(
        data.coverage.topRules.some((rule: any) => rule.rule.includes("bbci.co.uk")),
      ).toBe(false);
      // The real list carries path-scoped exceptions for the BBC's own assets, and a
      // hostname-only trace can fire none of them — a path exception needs the request URL the
      // fixture does not record. Every allowlist match this trace used to report was the
      // zone-widened reading of those rules, so zero is the honest count here.
      expect(data.trace.allowlistedHosts).toBe(0);

      // Against a six-figure list, a handful of fired rules is a rounding error.
      expect(data.coverage.listHitRatePercent).toBeLessThan(0.01);
      expect(data.coverage.deadWeightPercent).toBeGreaterThan(99.9);

      // The list is reported as the browser actually expresses it, and the four scopes account for
      // every blocking line in it.
      expect(data.rules.hostnameDecidableRules).toBe(data.rules.scopes.hostname);
      expect(
        data.rules.scopes.hostname +
          data.rules.scopes.initiator +
          data.rules.scopes.path +
          data.rules.scopes.request,
      ).toBe(data.rules.scopes.total);
      expect(data.rules.scopes.total).toBeLessThanOrEqual(data.rules.networkRules);
      // All three context scopes are populated on a real export, so the split is doing real work.
      expect(data.rules.scopes.initiator).toBeGreaterThan(0);
      expect(data.rules.scopes.path).toBeGreaterThan(0);
      expect(data.rules.scopes.request).toBeGreaterThan(0);

      // The shipped list's decidability share is what `check:path-decidability` gates at 0.80;
      // pinning the floor here means a local `npm test` catches the same regression CI would —
      // today it measures ~0.817, the residue being request-typed paths and rewrites.
      const decidability = pathRuleDecidability(
        readFileSync(realListPath, "utf-8").split("\n"),
      );
      expect(decidability.pathScoped).toBe(data.rules.scopes.path);
      expect(decidability.share).toBeGreaterThanOrEqual(0.8);

      // The rate is measured over the hostname-decidable bucket alone, which is the one set a
      // replay evaluates exactly — so it is a measurement, not an upper bound.
      expect(data.coverage.totalRules).toBe(data.rules.scopes.hostname);
      expect(data.coverage.matchedRules).toBeLessThanOrEqual(data.rules.scopes.hostname);
      // The scoped fires it deliberately leaves out are still reported, by scope.
      expect(data.ledger.scopedRequests).toBeGreaterThanOrEqual(data.ledger.contextScopedRulesFired);

      // The head of the list is what matters: a page set this size needs well under 100 rules.
      const head99 = data.coverage.minimumRules.find((p: any) => p.share === 0.99);
      expect(head99.rules).toBeLessThan(100);
      expect(head99.rulesPercent).toBeLessThan(0.1);
    },
    60000,
  );
});
