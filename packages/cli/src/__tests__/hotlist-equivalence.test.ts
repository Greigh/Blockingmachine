import {
  CompiledDomainRuleSet,
  decideRequest,
  parseHitLedgerText,
  replayRuleHits,
  requestUrlMatcher,
  selectHotList,
  type ReplayDecision,
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

/** The artifacts are large and generated; the suite skips rather than pretending to have checked. */
const ready = [fullListPath, hotListPath, tracePath].every((file) => existsSync(file));
const maybe = ready ? test : test.skip;

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
const requestsDecided = ready && derivation.kind === "trace";
const onMeasuredRequests = requestsDecided ? test : test.skip;

/** One host, and what each of the two lists decided for it. */
interface Comparison {
  host: string;
  full: ReplayDecision;
  hot: ReplayDecision;
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
 * can act on and a count that has to be re-derived. It also covers something the counts cannot
 * reach at all: the measured trace records hostnames, so nothing in the existing suite ever
 * exercises a *path-scoped* rule as one. The URL case below does.
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
  let pages: string[][];

  beforeAll(async () => {
    // `ready` rather than `requestsDecided`: the subset-boundary test at the end derives its own
    // hot set from the trace regardless of what the shipped artifact was built from, and needs
    // the cached verdicts this computes.
    if (!ready) return;
    const [fullText, hotText, traceText] = await Promise.all([
      fs.readFile(fullListPath, "utf8"),
      fs.readFile(hotListPath, "utf8"),
      fs.readFile(tracePath, "utf8"),
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
    const traceHosts = body(traceText);

    // Decided once for the whole suite. Each `evaluate` against the 147,000-rule export is real
    // work, and six tests re-reading the same 232 requests costs a minute for no extra coverage.
    comparisons = traceHosts.map((host) => ({
      host,
      full: decideRequest(full, { host }),
      hot: decideRequest(hot, { host }),
    }));

    pages = pagesOf(traceText);
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
    // 232 requests over 178 distinct hosts: 132 blocked, 12 released by an exception.
    expect(comparisons.length).toBe(232);
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

    // Six exceptions actually fire, so this is not passing on an empty set.
    expect(firedFull.size).toBe(6);
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

    // The measured session decides hostname rules, one path rule, and the exceptions. Each is
    // present and each agrees — so no bucket is passing vacuously.
    expect(summary).toEqual({
      hostname: 127,
      "exception (allow)": 12,
      path: 5,
      "no rule matched": 88,
    });
    for (const [scope, list] of byScope) {
      expect({ scope, disagreements: disagreementsOf(list) }).toEqual({ scope, disagreements: [] });
    }
  });

  onMeasuredRequests("agrees on the path-scoped rule when the request carries a URL", () => {
    // The measured trace records hostnames only, so the one path-scoped rule in the hot set is
    // never *decided by its path* there — it wins on the host alone, and the bucket above could be
    // read as covering path matching. It does not, so this does.
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
    expect(pathDecided.size).toBe(2);

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
    const derivationHosts = pages.slice(0, half).flat();
    const holdoutHosts = pages.slice(half).flat();

    const outcome = replayRuleHits(
      full,
      derivationHosts.map((host) => ({ host, count: 1 })),
    );
    const selection = selectHotList({
      lines: fullLines,
      hits: [...outcome.hits, ...outcome.scopedHits.map((hit) => ({ rule: hit.rule, count: hit.count }))],
      exceptions: outcome.exceptions.map((entry) => entry.rule),
    });

    const derived = new CompiledDomainRuleSet(selection.lines);

    // The full export's verdict for a host is looked up from the suite-wide cache rather than
    // re-decided. `decideRequest` walks the wildcard rules of all 147,000, so re-asking it 232
    // times cost about twenty seconds of CPU — and because that work is synchronous, Jest cannot
    // interrupt it, so it passes here while starving an async sibling in another worker past the
    // 5s default. `beforeAll` already decided every trace host, and the two halves below partition
    // exactly those hosts, so this asks for nothing new.
    const fullVerdicts = new Map(comparisons.map((entry) => [entry.host, entry.full]));

    const compareAll = (hosts: string[]) =>
      hosts
        .map((host) => {
          const fullVerdict = fullVerdicts.get(host);
          if (!fullVerdict) throw new Error(`no cached full-export verdict for ${host}`);
          return { host, full: fullVerdict, hot: decideRequest(derived, { host }) };
        })
        .filter((entry) => entry.full.verdict !== entry.hot.verdict);

    const onDerivation = compareAll(derivationHosts);
    const onHoldout = compareAll(holdoutHosts);

    process.stdout.write(
      `\n  [hot set equivalence scope] derived from ${derivationHosts.length} requests: ` +
        `${onDerivation.length} disagreements on its own traffic, ${onHoldout.length} on ${holdoutHosts.length} held-out\n`,
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

/** Splits a trace into its pages, so a derivation set and a hold-out set can be made from it. */
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
    pages[pages.length - 1]?.push(line);
  }
  return pages.filter((page) => page.length > 0);
}
