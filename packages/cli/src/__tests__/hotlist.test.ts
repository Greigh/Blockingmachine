import { jest } from "@jest/globals";
import { CoverageCommand, HOT_LIST_FILE } from "../commands/CoverageCommand.js";
import {
  CompiledDomainRuleSet,
  formatHotList,
  parseHitLedgerText,
  parseRequestTrace,
  replayRuleHits,
  selectHotList,
} from "@blockingmachine/core";
import { existsSync, readFileSync } from "fs";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const cliRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = path.resolve(cliRoot, "..", "..");
const fullListPath = path.join(cliRoot, "filters", "output", "genericBrowserRules.txt");
const hotListPath = path.join(cliRoot, "filters", "output", HOT_LIST_FILE);
const tracePath = path.join(cliRoot, "src", "__tests__", "fixtures", "browsing-trace.txt");

/** The artifacts are large and generated; the suite skips rather than pretending to have checked.
 *  The derivation input is part of that: a header naming a measurement that is not on disk is a
 *  file the suite genuinely cannot check, not a reason to fall back to a different one. */
const ready =
  [fullListPath, hotListPath, tracePath].every((file) => existsSync(file)) &&
  existsSync(derivationOf(readFileSync(hotListPath, "utf8")).file);

/**
 * What the shipped artifact declares it was built from — the `! Derivation:` header line the
 * builder writes and `--check` replays. The list used to always derive from the checked-in
 * trace; the browser-reported ledger changes the input, and the tests must replay the input the
 * file says it came from rather than assume the trace.
 */
function derivationOf(text: string): { kind: "hits" | "trace"; file: string } {
  const match = /^! Derivation:\s+(.+)$/m.exec(text);
  const declared = match?.[1] ?? "";
  const hits = /--hits\s+(\S+)/.exec(declared);
  const trace = /--trace\s+(\S+)/.exec(declared);
  if (hits) return { kind: "hits", file: path.resolve(repoRoot, hits[1]) };
  return { kind: "trace", file: trace ? path.resolve(repoRoot, trace[1]) : tracePath };
}

const maybe = ready ? test : test.skip;

/** Splits the checked-in trace into its pages, so a derivation set and a hold-out set can be made. */
function pagesOf(text: string): string[][] {
  const pages: string[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("!")) continue;
    if (line.startsWith("# page:")) {
      pages.push([]);
      continue;
    }
    if (line.startsWith("#")) continue;
    const current = pages[pages.length - 1];
    if (current) current.push(line);
  }
  return pages.filter((page) => page.length > 0);
}

describe("coverage-derived hot set", () => {
  let tmpDir: string;
  let logSpy: any;
  const mockLogger: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-hotlist-test-"));
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function measure(rulesFile: string, traceFile: string, hot = false) {
    // `baseDir` is the install root the command resolves a default list from, so it points at the
    // package that carries `filters/output` — that is what `--hot` is supposed to find.
    const cmd = new CoverageCommand({ config: { baseDir: cliRoot } as any, logger: mockLogger });
    const result = await cmd.execute({ rules: hot ? undefined : rulesFile, trace: traceFile, hot });
    expect(result.success).toBe(true);
    return result.data as any;
  }

  maybe("ships a measured head of the list, not a guess", async () => {
    const [text, fullText] = await Promise.all([
      fs.readFile(hotListPath, "utf8"),
      fs.readFile(fullListPath, "utf8"),
    ]);
    const shipped = text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("!"));

    // It is small...
    expect(shipped.length).toBeLessThan(200);
    expect(fullText.split(/\r?\n/).filter(Boolean).length).toBeGreaterThan(200000);
    // ...and every line in it is a line the full export actually carries.
    const available = new Set(fullText.split(/\r?\n/).map((line) => line.trim()));
    expect(shipped.filter((rule) => !available.has(rule))).toEqual([]);

    // And it is exactly the rules the measurement saw fire — no pruning by hand, no favourites.
    // Replayed the way the file was built: the header's derivation names the input, so a list
    // derived from the browser ledger is checked against the ledger, not the checked-in trace.
    const lines = fullText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const derivation = derivationOf(text);
    let hits: { rule: string; count: number }[];
    let exceptions: string[];
    if (derivation.kind === "hits") {
      const ledger = parseHitLedgerText(readFileSync(derivation.file, "utf8"));
      hits = ledger.hits;
      exceptions = ledger.exceptions;
    } else {
      // The same parse the builder performs — core's `parseRequestTrace` keeps the URL a line
      // carries and honours its repeat count, so the replay sees the measured requests, not a
      // per-line approximation of them.
      const requests = parseRequestTrace(await fs.readFile(derivation.file, "utf8"));
      const outcome = replayRuleHits(new CompiledDomainRuleSet(lines), requests);
      hits = [
        ...outcome.hits,
        ...outcome.urlHits,
        ...outcome.scopedHits.map((hit) => ({ rule: hit.rule, count: hit.count })),
      ];
      exceptions = outcome.exceptions.map((entry) => entry.rule);
    }
    const selection = selectHotList({ lines, hits, exceptions });
    expect(shipped.slice().sort()).toEqual([...selection.lines].sort());
  });

  maybe("blocks the same traffic as the full list on the measurement it came from", async () => {
    const shippedText = await fs.readFile(hotListPath, "utf8");
    const derivation = derivationOf(shippedText);

    if (derivation.kind === "hits") {
      // A rule-hit ledger records *decisions*, not requests: `<count> <rule>` is the browser
      // saying "this rule decided this many blocks". There is no request to replay (a session
      // carries no hosts — the same gap flag 15 records for paths, one level up). What can be
      // checked is what the check is really about: every deciding rule the export carries is in
      // the hot set, so on the measured traffic the two lists cannot disagree; and every
      // exception the ledger kept survived, so no released request becomes a block.
      const lines = (await fs.readFile(fullListPath, "utf8"))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const available = new Set(lines);
      const shipped = new Set(
        shippedText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("!")),
      );
      const ledger = parseHitLedgerText(readFileSync(derivation.file, "utf8"));

      const unshippable = ledger.hits.filter((entry) => !available.has(entry.rule));
      const uncovered = ledger.hits.filter((entry) => available.has(entry.rule) && !shipped.has(entry.rule));
      const droppedExceptions = ledger.exceptions.filter(
        (rule) => available.has(rule) && !shipped.has(rule),
      );
      // The uncovered side is the export's limit, not the trim's: a rule the source list does
      // not carry cannot ship. It is reported rather than pinned to zero, because the ledger
      // comes from the extension's own compiled rulesets and the two lists genuinely differ.
      process.stdout.write(
        `\n  [hot list ledger coverage] ${ledger.hits.length - unshippable.length - uncovered.length}` +
          ` of ${ledger.hits.length} reported rules ship` +
          ` (${unshippable.length} the export cannot carry)\n`,
      );
      expect(uncovered).toEqual([]);
      expect(droppedExceptions).toEqual([]);
      return;
    }

    // The measurement is the one the file's header names, not the checked-in fixture: a shipped
    // set derived from a different trace (or a richer capture of the same pages) replays that
    // input, per the derivation contract the `hits` branch above already honors.
    const full = await measure(fullListPath, derivation.file);
    const hot = await measure(hotListPath, derivation.file, true);

    // The claim, stated as the thing a user would notice: the same hosts, the same requests, the
    // same allow decisions.
    expect(hot.trace.blockedHosts).toBe(full.trace.blockedHosts);
    expect(hot.trace.blockedRequests).toBe(full.trace.blockedRequests);
    expect(hot.trace.allowlistedHosts).toBe(full.trace.allowlistedHosts);
    expect(hot.trace.exceptionRulesFired).toBe(full.trace.exceptionRulesFired);
    expect(hot.trace.uniqueHosts).toBe(full.trace.uniqueHosts);

    // The same *rules* decided them, not merely the same totals.
    const rulesOf = (data: any) =>
      data.coverage.topRules.map((entry: any) => entry.rule).sort();
    expect(rulesOf(hot)).toEqual(rulesOf(full));

    // And the trimmed list reports honestly about itself: every rule in it fired. The winners
    // live in three buckets — `matchedRules` counts the hostname-decided ones, `urlDecidedRules`
    // the winners a path rule settled by matching the request URL, and `scopedRulesFired` the
    // winners the replay could not decide even with a URL. The shipped set ships all three, so
    // the sum — not any single bucket — is what `scopes.total` must equal.
    const fired =
      hot.coverage.matchedRules +
      hot.trace.urlDecidedRules +
      hot.ledger.scopedRulesFired.initiator +
      hot.ledger.scopedRulesFired.path +
      hot.ledger.scopedRulesFired.request;
    expect(fired).toBe(hot.rules.scopes.total);
    expect(hot.coverage.listHitRatePercent).toBe(100);
    expect(hot.rules.compiledLines).toBeLessThan(200);
  });

  maybe("re-deriving from half the traffic measures what the other half loses", async () => {
    const pages = pagesOf(await fs.readFile(tracePath, "utf8"));
    expect(pages.length).toBeGreaterThan(4);
    const half = Math.floor(pages.length / 2);

    const lines = (await fs.readFile(fullListPath, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    // Derive the hot set from half the pages, then measure it on the pages it never saw.
    const derived = pages.slice(0, half);
    const derivationHosts = derived.flat();
    const ruleSet = new CompiledDomainRuleSet(lines);
    const outcome = replayRuleHits(
      ruleSet,
      derivationHosts.map((host) => ({ host, count: 1 })),
    );
    const selection = selectHotList({
      lines,
      hits: [
        ...outcome.hits,
        ...outcome.urlHits,
        ...outcome.scopedHits.map((hit) => ({ rule: hit.rule, count: hit.count })),
      ],
      exceptions: outcome.exceptions.map((entry) => entry.rule),
    });
    const derivedPath = path.join(tmpDir, "derived-hotlist.txt");
    await fs.writeFile(derivedPath, formatHotList(selection, { source: "full", measuredOn: "half" }), "utf8");

    const holdoutHosts = pages.slice(half).flat();
    const holdoutPath = path.join(tmpDir, "holdout-trace.txt");
    await fs.writeFile(holdoutPath, holdoutHosts.join("\n"), "utf8");
    const derivationTracePath = path.join(tmpDir, "derivation-trace.txt");
    await fs.writeFile(derivationTracePath, derivationHosts.join("\n"), "utf8");

    // On the traffic it was derived from, the equivalence is exact — as it must be.
    const fullOnDerivation = await measure(fullListPath, derivationTracePath);
    const hotOnDerivation = await measure(derivedPath, derivationTracePath);
    expect(hotOnDerivation.trace.blockedRequests).toBe(fullOnDerivation.trace.blockedRequests);
    expect(hotOnDerivation.trace.blockedHosts).toBe(fullOnDerivation.trace.blockedHosts);

    // On traffic it has never seen, it does not. That is the overfitting limit, and it is a number
    // rather than a footnote: X of Y blocks on the held-out pages, against the full list's Z.
    const fullOnHoldout = await measure(fullListPath, holdoutPath);
    const hotOnHoldout = await measure(derivedPath, holdoutPath);
    const heldShare = fullOnHoldout.trace.blockedRequests > 0
      ? hotOnHoldout.trace.blockedRequests / fullOnHoldout.trace.blockedRequests
      : 0;
    // `console.log` is mocked for this suite (the command prints a full report), so the record goes
    // straight to stdout where a reader of the test output can see it.
    process.stdout.write(
      `\n  [hot list hold-out] derived from ${derivationHosts.length} hosts on ${derived.length} pages, ` +
        `measured on ${holdoutHosts.length} hosts on ${pages.length - half} pages: ` +
        `${hotOnHoldout.trace.blockedRequests} of ${fullOnHoldout.trace.blockedRequests} blocks ` +
        `(${(heldShare * 100).toFixed(1)}%) in ${selection.lines.length} rules\n`,
    );

    // Pinned, because this is the honest half of the claim and the number that stops the artifact
    // from being sold as a general list: a hot set is exact for the traffic it came from and loses
    // most of the rest. Deriving from half the pages yields 34 rules — one fewer than before the
    // evaluator indexed path-preserving exceptions, because `@@||host^*/x` can no longer ride
    // along having fired zone-wide on a trace that records no URLs. On the pages it never saw
    // they keep 38 of the full list's 93 blocks. A change that makes this look better should have
    // to move this assertion deliberately.
    expect(selection.lines.length).toBe(34);
    expect(fullOnHoldout.trace.blockedRequests).toBe(93);
    expect(hotOnHoldout.trace.blockedRequests).toBe(38);
    expect(hotOnHoldout.trace.blockedRequests).toBeLessThan(fullOnHoldout.trace.blockedRequests);
    expect(hotOnHoldout.trace.blockedRequests).toBeGreaterThan(0);
  });

  maybe("--hot measures the trimmed list, and only when asked", async () => {
    const full = await measure(fullListPath, tracePath);
    const hot = await measure(hotListPath, tracePath, true);

    expect(path.basename(hot.rules.file)).toBe(HOT_LIST_FILE);
    expect(path.basename(full.rules.file)).toBe("genericBrowserRules.txt");
    // Both are real measurements of real lists; they differ in which list, not in method.
    expect(hot.rules.scopes.total).toBeLessThan(full.rules.scopes.total);
  });
});
