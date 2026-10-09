import {
  CompiledDomainRuleSet,
  createReplayDecider,
  decideRequest,
  parseHitLedgerText,
  parseRequestTrace,
  replayRuleHits,
  requestUrlMatcher,
  selectHotList,
  type ReplayDecision,
  type ReplayRequest,
} from "@blockingmachine/core";
import { existsSync, readFileSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const cliRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = path.resolve(cliRoot, "..", "..");
const fullListPath = path.join(cliRoot, "filters", "output", "genericBrowserRules.txt");
const hotListPath = path.join(cliRoot, "filters", "output", "hotlist.txt");
const tracePath = path.join(cliRoot, "src", "__tests__", "fixtures", "browsing-trace.txt");

/**
 * The input the shipped artifact says it was derived from — the `! Derivation:` header the
 * builder writes and `--check` replays. A `--trace` derivation can be replayed request by
 * request; a `--hits` derivation is a ledger of *decisions* (`<count> <rule>`) and carries no
 * requests at all — the same gap open flag 15 records for paths, one level up. The request
 * replay is gated on the kind rather than skipped silently, and the ledger's own equivalence —
 * every deciding rule the export carries is in the set — is checked separately below.
 */
function derivationOf(text: string): { kind: "hits" | "trace"; file: string } {
  const declared = /^! Derivation:\s+(.+)$/m.exec(text)?.[1] ?? "";
  const hits = /--hits\s+(\S+)/.exec(declared);
  const trace = /--trace\s+(\S+)/.exec(declared);
  if (hits) return { kind: "hits", file: path.resolve(repoRoot, hits[1]) };
  return { kind: "trace", file: trace ? path.resolve(repoRoot, trace[1]) : tracePath };
}
const derivation = existsSync(hotListPath)
  ? derivationOf(readFileSync(hotListPath, "utf8"))
  : { kind: "trace" as const, file: tracePath };

/** The artifacts are large and generated; the suite skips rather than pretending to have checked. */
const ready = [fullListPath, hotListPath, tracePath, derivation.file].every((file) => existsSync(file));
const maybe = ready ? test : test.skip;
const requestsDecided = ready && derivation.kind === "trace";
const onMeasuredRequests = requestsDecided ? test : test.skip;

/** One request — host, and the URL when the measurement carried one — and what each list decided. */
interface Comparison {
  host: string;
  url?: string;
  full: ReplayDecision;
  hot: ReplayDecision;
}

/** The key a per-request verdict cache is safe to be read back by — two requests sharing a host
 * can decide differently when a path rule is doing the deciding, so the URL is part of the key. */
function requestKey(request: { host: string; url?: string }): string {
  return `${request.host}\t${request.url ?? ""}`;
}

/** Splits a measurement file on its `# page:` markers, then parses each page's share through
 * `parseRequestTrace` — the same parser the builder and the coverage report read the trace
 * through — so a derivation half and a hold-out half can be made without a second idea of what
 * a request line means. */
function pagesOfRequests(text: string): ReplayRequest[][] {
  const chunks: string[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().startsWith("# page:")) {
      chunks.push([]);
      continue;
    }
    chunks[chunks.length - 1]?.push(raw);
  }
  return chunks
    .map((chunk) => parseRequestTrace(chunk.join("\n")))
    .filter((page) => page.length > 0);
}

/**
 * The safety invariant: on the traffic it was derived from, the trimmed hot set decides every
 * request exactly as the full export does.
 *
 * **Scoped to the derivation traffic, and the scope is the point.** This is not a claim that the
 * hot set is interchangeable with the full list — the opposite is measured and pinned in
 * `hotlist.test.ts`: on held-out pages it keeps 38 of 93 blocks. The claim is the narrower one that
 * makes it safe to install by default, that for the traffic it was measured from it is not a
 * *different* list but the same list with the rules that never fired removed. A client trading a
 * prefix of the export for this is trading rules it could never have installed for zero rules it
 * would have blocked.
 *
 * Compared per request, and the reason is the shape of the failure rather than its absence. Totals
 * cannot see a substitution: a list that blocked `a.example` and missed `b.example` while another
 * blocked `b.example` and missed `a.example` reports identical counts. The sibling suite in
 * `hotlist.test.ts` does compare the fired *rule set*, which catches most substitutions too — but
 * as a set, so it reports "the rules differ" without saying which host either rule decided. This
 * form names the host and both deciding rules, which is the difference between a failure a person
 * can act on and a count that has to be re-derived. And when the derivation measurement carries
 * URLs — as the adopted trace does — the replay decides *path-scoped* rules against the request
 * that carried them, which a hostname-only measurement could never exercise at all.
 *
 * Both verdicts come from {@link decideRequest} — the same function the coverage report and the
 * hot-set builder use — rather than from a second implementation written here, because the whole
 * content of "what this list does to that request" is the precedence (a path rule outranks a bare
 * zone block, an exception outranks both) and a copy of it could keep agreeing with itself after
 * the rule underneath it changed.
 */
describe("hot set decides as the full export does, on the traffic it was derived from", () => {
  let full: CompiledDomainRuleSet;
  let hotRules: string[];
  let comparisons: Comparison[];
  let fullLines: string[];
  let pages: ReplayRequest[][];

  beforeAll(async () => {
    // `ready` rather than `requestsDecided`: the subset-boundary test at the end derives its own
    // hot set from the derivation measurement regardless of what the shipped artifact was built
    // from, and needs the cached verdicts this computes.
    if (!ready) return;
    const [fullText, hotText, derivationText] = await Promise.all([
      fs.readFile(fullListPath, "utf8"),
      fs.readFile(hotListPath, "utf8"),
      fs.readFile(derivation.file, "utf8"),
    ]);
    const body = (text: string) =>
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("!") && !line.startsWith("#"));

    fullLines = body(fullText);
    full = new CompiledDomainRuleSet(fullLines);
    hotRules = body(hotText);
    const hot = new CompiledDomainRuleSet(hotRules);

    // The replay is the derivation file the header names, not a fixture — a shipped set measured
    // on one trace cannot promise identical verdicts on another session's traffic, and asserting
    // it would be asserting the wrong claim (the hold-out measurement is the sibling suite's).
    // Parsed once through the same parser the builder used, so the suite's requests are exactly
    // the measured requests.
    const requests = parseRequestTrace(derivationText);

    // Decided once for the whole suite. `createReplayDecider` rather than `decideRequest`: the
    // per-call form recompiles the path rules for every request, which at a URL trace's size is
    // minutes of identical work — the decider shares the compile across all of them and the
    // decision it returns is the same one.
    const fullDecider = createReplayDecider(full);
    const hotDecider = createReplayDecider(hot);
    comparisons = requests.map((request) => ({
      host: request.host,
      url: request.url,
      full: fullDecider(request),
      hot: hotDecider(request),
    }));

    pages = pagesOfRequests(derivationText);
  });

  /** Every mismatch between the two lists, shaped so a failure reads as a disagreement. */
  function disagreementsOf(entries: Comparison[]) {
    return entries
      .filter((entry) => entry.full.verdict !== entry.hot.verdict)
      .map((entry) => ({
        host: entry.host,
        fullExport: `${entry.full.verdict} (${entry.full.rule ?? "—"})`,
        hotSet: `${entry.hot.verdict} (${entry.hot.rule ?? "—"})`,
      }));
  }

  onMeasuredRequests("agrees on every request, not merely in total", () => {
    // The count is whatever the derivation measurement carried — the assertion that makes it a
    // check and not a description is that the number is non-trivial and every verdict agrees.
    expect(comparisons.length).toBeGreaterThan(100);
    expect(disagreementsOf(comparisons)).toEqual([]);
  });

  onMeasuredRequests("never turns a block into an allow, or an allow into a block", () => {
    // The direction that matters, stated on its own. Under-protecting is the loss the held-out
    // figure already quantifies; *inverting* a decision is a different failure — a request a
    // publisher deliberately released by `@@` would start being blocked — and it would not move a
    // single count in the direction the existing suite watches.
    const inverted = comparisons.filter(
      (entry) =>
        (entry.full.verdict === "blocked" && entry.hot.verdict !== "blocked") ||
        (entry.full.verdict === "exception" && entry.hot.verdict === "blocked") ||
        (entry.full.verdict === "allowed" && entry.hot.verdict === "blocked"),
    );

    expect(inverted).toEqual([]);
  });

  onMeasuredRequests("keeps every fired exception, so the allow decisions survive the trim", () => {
    // An allowlist is the rule a trimmed list is most likely to lose, and losing it is the worst
    // outcome available: the list does not merely stop protecting, it starts blocking requests the
    // full export deliberately released. So the fired exception *rules* are compared as a set, not
    // only as a verdict count.
    const firedFull = new Set<string>();
    const firedHot = new Set<string>();
    for (const entry of comparisons) {
      if (entry.full.rule && entry.full.verdict === "exception") firedFull.add(entry.full.rule);
      if (entry.hot.rule && entry.hot.verdict === "exception") firedHot.add(entry.hot.rule);
    }

    // At least one exception actually fires, so this is not passing on an empty set. (The count
    // is whatever the derivation measurement released — asserting a fixture's number would pin
    // the measurement, not the invariant.)
    expect(firedFull.size).toBeGreaterThan(0);
    expect([...firedHot].sort()).toEqual([...firedFull].sort());
    // And every one is carried verbatim, so the hot set cannot allow a *different* set of hosts
    // than the export did even if it happened to reach the same number.
    for (const rule of firedFull) {
      expect(hotRules).toContain(rule);
    }
  });

  onMeasuredRequests("agrees within every scope it actually exercises", () => {
    // "Across every scope" only means something if each bucket is non-empty, so the buckets are
    // counted and asserted rather than assumed — a test comparing only hostname rules would report
    // agreement for the whole list while saying nothing about the rest.
    const bucketOf = (decision: ReplayDecision) => {
      if (decision.verdict === "exception") return "exception (allow)";
      if (decision.verdict === "allowed") return "no rule matched";
      return decision.scope ?? "hostname";
    };

    const byScope = new Map<string, Comparison[]>();
    for (const entry of comparisons) {
      const key = bucketOf(entry.full);
      byScope.set(key, [...(byScope.get(key) ?? []), entry]);
    }

    const summary = Object.fromEntries([...byScope].map(([scope, list]) => [scope, list.length]));
    // `console.log` is not mocked here, but `process.stdout.write` keeps the record in the test
    // output either way: which scopes were actually compared is the point of the bucketing.
    process.stdout.write(
      `\n  [hot set equivalence] requests compared per scope: ${JSON.stringify(summary)}\n`,
    );

    // The four buckets the measurement can exercise — hostname decisions, path decisions, fired
    // exceptions, and untouched requests — must each be present or the suite is reporting
    // agreement across a scope it never looked at; then each is required to actually agree.
    for (const scope of ["hostname", "path", "exception (allow)", "no rule matched"]) {
      expect(summary[scope]).toBeGreaterThan(0);
    }
    for (const [scope, list] of byScope) {
      expect({ scope, disagreements: disagreementsOf(list) }).toEqual({ scope, disagreements: [] });
    }
  });

  onMeasuredRequests("agrees on the path-scoped rule when the request carries a URL", () => {
    // On a URL-bearing derivation the trace itself decides path rules by their path — those are
    // the entries this collects — and the check then goes one step further than per-request
    // agreement: it constructs a fresh URL under each fired path rule and requires both lists to
    // let the URL settle it, so "path scope" is exercised as path matching and not merely as a
    // bucket label.
    //
    // The URL comes from the rule's own text and is checked against the matcher before use, so the
    // assertion cannot pass on a URL the rule does not actually govern. Note the extra path
    // segment: Chrome's `^` separator consumes a character, so a wildcard-then-slash tail really
    // does need one more segment before its own slash. See `compileGlobToRegex`.
    const pathDecided = new Map<string, string>();
    for (const entry of comparisons) {
      if (entry.full.verdict === "blocked" && entry.full.scope === "path" && entry.full.rule) {
        pathDecided.set(entry.host, entry.full.rule);
      }
    }
    expect(pathDecided.size).toBeGreaterThan(0);

    for (const [host, rule] of pathDecided) {
      expect(hotRules).toContain(rule);
      const matches = requestUrlMatcher(rule);
      expect(matches).not.toBeNull();

      const literalPath = rule.slice(rule.indexOf("/"));
      const candidates = [
        `https://${host}/x${literalPath}`,
        `https://${host}/deep/er${literalPath}`,
        `https://${host}${literalPath}`,
      ];
      const url = candidates.find((candidate) => matches!(candidate));
      expect(url).toBeDefined();

      const a = decideRequest(full, { host, url: url! });
      const b = decideRequest(new CompiledDomainRuleSet(hotRules), { host, url: url! });

      expect({ full: a.verdict, rule: a.rule, byUrl: a.decidedByUrl }).toEqual({
        full: "blocked",
        rule,
        byUrl: true,
      });
      expect({ hot: b.verdict, rule: b.rule, byUrl: b.decidedByUrl }).toEqual({
        hot: "blocked",
        rule,
        byUrl: true,
      });
    }
  });

  maybe("holds for a hot set derived from any subset, and stops at its edge", () => {
    // The invariant is about *derivation traffic*, not about the checked-in artifact — the shipped
    // `hotlist.txt` was derived from the whole session, so there is no traffic inside it that the
    // set has not seen, and testing the boundary against it would find nothing. So this derives a
    // second hot set from half the pages and checks the boundary against that.
    //
    // Both halves are asserted, because a test that only checked the disagreement would pass just
    // as happily on a set that disagreed everywhere.
    const half = Math.floor(pages.length / 2);
    const derivationRequests = pages.slice(0, half).flat();
    const holdoutRequests = pages.slice(half).flat();

    const outcome = replayRuleHits(full, derivationRequests);
    const selection = selectHotList({
      lines: fullLines,
      // `urlHits` too — the builder keeps them (`build-hot-list.mjs`), and dropping path-decided
      // winners here would manufacture disagreements on URL-carrying derivation traffic.
      hits: [
        ...outcome.hits,
        ...outcome.urlHits,
        ...outcome.scopedHits.map((hit) => ({ rule: hit.rule, count: hit.count })),
      ],
      exceptions: outcome.exceptions.map((entry) => entry.rule),
    });

    const derived = new CompiledDomainRuleSet(selection.lines);

    // The full export's verdict for a request is looked up from the suite-wide cache rather
    // than re-decided — `beforeAll` already decided every measured request, and the two halves
    // below partition exactly those requests, so this asks for nothing new. The cache keys on
    // host *and* URL: two requests to one host can decide differently once a path rule is doing
    // the deciding, so a host-keyed lookup would sometimes hand back the wrong verdict.
    const fullVerdicts = new Map(comparisons.map((entry) => [requestKey(entry), entry.full]));

    const compareAll = (requests: ReplayRequest[]) =>
      requests
        .map((request) => {
          const fullVerdict = fullVerdicts.get(requestKey(request));
          if (!fullVerdict) throw new Error(`no cached full-export verdict for ${request.host}`);
          return { host: request.host, full: fullVerdict, hot: decideRequest(derived, request) };
        })
        .filter((entry) => entry.full.verdict !== entry.hot.verdict);

    const onDerivation = compareAll(derivationRequests);
    const onHoldout = compareAll(holdoutRequests);

    process.stdout.write(
      `\n  [hot set equivalence scope] derived from ${derivationRequests.length} requests: ` +
        `${onDerivation.length} disagreements on its own traffic, ${onHoldout.length} on ${holdoutRequests.length} held-out\n`,
    );

    // Exact on the traffic it came from — the invariant, on a derivation of the operator's choosing.
    expect(onDerivation).toEqual([]);
    // And not beyond it. This is the boundary, asserted rather than described: the invariant is
    // never true of a hot set outside the traffic that produced it, which is why the suite is
    // named for the traffic and not for the list.
    expect(onHoldout.length).toBeGreaterThan(0);
  });
});

/**
 * The same claim on a ledger-derived artifact. The browser ledger records decisions —
 * `<count> <rule>` — not requests, so there is nothing to replay per request (open flag 15's
 * gap, one level up: sessions carry rules and counts, no hosts, no paths). What survives of the
 * equivalence is what actually makes it true: each reported hit is a block the browser made with
 * a named rule, and rule matching is deterministic given the request — so if every deciding rule
 * the export carries is in the hot set, the two lists cannot disagree on that traffic. The
 * requests that remain uncheckable are the hits whose rules the export does not carry, which is
 * the export's coverage gap rather than the trim's, and the header states it.
 */
describe("hot set carries every decision the ledger recorded that the export can express", () => {
  const onLedger = ready && derivation.kind === "hits" ? test : test.skip;

  onLedger("every reported blocking rule in the source list is in the shipped set", () => {
    const fullLines = readFileSync(fullListPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const available = new Set(fullLines);
    const shipped = new Set(
      readFileSync(hotListPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("!")),
    );
    const ledger = parseHitLedgerText(readFileSync(derivation.file, "utf8"));

    const unshippable = ledger.hits.filter((entry) => !available.has(entry.rule));
    const uncovered = ledger.hits.filter((entry) => available.has(entry.rule) && !shipped.has(entry.rule));
    const droppedExceptions = ledger.exceptions.filter(
      (rule) => available.has(rule) && !shipped.has(rule),
    );

    // Named rather than counted, for the same reason the request replay names hosts: "N rules
    // differ" has to be re-derived; "these rules are missing" is actionable.
    process.stdout.write(
      `\n  [hot set ledger equivalence] ${shipped.size} rules ship; ` +
        `${ledger.hits.length - unshippable.length - uncovered.length} of ${ledger.hits.length} ` +
        `reported hits are carried (${unshippable.length} the export cannot express)\n`,
    );
    expect(uncovered).toEqual([]);
    expect(droppedExceptions).toEqual([]);
  });
});
