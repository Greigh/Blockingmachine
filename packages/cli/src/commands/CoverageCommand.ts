import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import {
  CompiledDomainRuleSet,
  analyzeRuleCoverage,
  blockingRuleScope,
  countNetworkRules,
  countRuleScopes,
  hostOf,
  parseRequestTrace,
  replayRuleHits,
  type BlockingRuleScope,
  type CoverageReport,
  type RuleHitCount,
} from "@blockingmachine/core";
import fs from "fs/promises";
import path from "path";
import chalk from "chalk";
import { writeJson } from "../lib/logger.js";

export interface CoverageOptions {
  rules?: string;
  /** A captured request trace: one host or URL per line, optional trailing count. */
  trace?: string;
  /** A rule-hit ledger: `count<TAB>rule`, `rule<TAB>count`, or a bare rule per line. */
  hits?: string;
  /**
   * Measure the coverage-derived hot set instead of the full compiled export.
   *
   * For a budget that cannot hold the full list, or a machine that has none: the hot set is the
   * rules a real measurement saw fire, so it is a smaller default rather than a guess. It is
   * opt-in because a report measured against 77 rules is a different question from one measured
   * against 118,000, and the caller should be the one to ask it.
   */
  hot?: boolean;
  top?: number;
  json?: boolean;
}

/** The trimmed list `scripts/build-hot-list.mjs` writes, and `--hot` measures. */
export const HOT_LIST_FILE = "hotlist.txt";

// Re-exported rather than re-implemented: the parsing contract lives in core now
// (`ruleReplay.ts`), so the coverage report, the hot-set builder, and the tests all read the
// same trace the same way. Anything importing the helpers from here keeps working without a
// second copy drifting out of step.
export { hostOf, parseRequestTrace };

/** A scope a blocking rule can need beyond the hostname. */
type ScopedScope = Exclude<BlockingRuleScope, "hostname">;

/** What fired, per context scope, for the scopes a hostname replay cannot decide. */
interface ScopeTally {
  /** Distinct rules of this scope that fired. */
  rules: Set<string>;
  /** Requests they accounted for. */
  requests: number;
}

type ScopeTallies = Record<ScopedScope, ScopeTally>;

function emptyScopeTallies(): ScopeTallies {
  return {
    initiator: { rules: new Set(), requests: 0 },
    path: { rules: new Set(), requests: 0 },
    request: { rules: new Set(), requests: 0 },
  };
}

/**
 * A fired rule's scope, defaulting to `hostname` when it cannot be classified.
 *
 * A ledger is produced by the browser, so a rule in it *did* block; a line this classifier cannot
 * place is left in the headline rate rather than silently dropped out of it.
 */
function scopeOfFiredRule(rule: string): BlockingRuleScope {
  return blockingRuleScope(rule) ?? "hostname";
}

/** Distinct rules that fired, per scoped bucket, as a plain number for the JSON payload. */
function tallyCounts(tallies: ScopeTallies): Record<ScopedScope, number> {
  return {
    initiator: tallies.initiator.rules.size,
    path: tallies.path.rules.size,
    request: tallies.request.rules.size,
  };
}

/**
 * Parses a rule-hit ledger.
 *
 * This is the higher-fidelity input: the browser reports the rule that genuinely won, so paths,
 * request types and initiators have already been applied. A trace replay can only approximate
 * those from a hostname.
 */
export function parseRuleHits(text: string): RuleHitCount[] {
  const totals = new Map<string, number>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;

    let rule = line;
    let count = 1;

    const leading = line.match(/^(\d+)\s+(.+)$/);
    const trailing = line.match(/^(.+?)\s+(\d+)$/);
    if (leading) {
      count = parseInt(leading[1], 10);
      rule = leading[2].trim();
    } else if (trailing) {
      rule = trailing[1].trim();
      count = parseInt(trailing[2], 10);
    }

    if (!rule || !Number.isFinite(count) || count <= 0) continue;
    totals.set(rule, (totals.get(rule) ?? 0) + count);
  }

  return [...totals.entries()].map(([rule, count]) => ({ rule, count }));
}

export class CoverageCommand extends BaseCommand<CoverageOptions> {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options: CoverageOptions): Promise<CommandResult> {
    const { trace, hits, json } = options ?? ({} as CoverageOptions);
    if (!trace && !hits) {
      return this.failure(
        "Please provide a request trace (--trace) or a rule-hit ledger (--hits). " +
          "Example: blockingmachine coverage --trace requests.txt",
      );
    }

    const { rules, source } = await this.resolveRules(options.rules, options.hot === true);
    if (rules.length === 0) {
      return this.failure(
        options.rules
          ? `No rules found in ${options.rules}.`
          : "Could not find a compiled rule list. Run 'blockingmachine export' first, pass --rules, or measure the coverage-derived hot set with --hot.",
      );
    }

    const ruleSet = new CompiledDomainRuleSet(rules);
    const indexedRules = ruleSet.getIndexedRuleCount();
    const indexedBlockingRules = ruleSet.getIndexedBlockingRuleCount();
    // The list as the browser actually expresses it. A hostname replay can decide the
    // `hostname` bucket exactly; the other three need a path, a request type or the requesting
    // page, none of which a hostname carries.
    const scopes = countRuleScopes(rules);
    const tallies = emptyScopeTallies();
    const topLimit = options.top ? Math.max(1, options.top) : 10;

    let ledger: RuleHitCount[];
    let traceStats: {
      file: string;
      uniqueHosts: number;
      requests: number;
      blockedHosts: number;
      blockedRequests: number;
      allowlistedHosts: number;
      exceptionRulesFired: number;
      matchedHostRatePercent: number;
      scopedHosts: number;
      scopedRequests: number;
      urlDecidedRequests: number;
      urlDecidedRules: number;
      urlsInTrace: number;
    } | null = null;

    if (hits) {
      let text: string;
      try {
        text = await fs.readFile(path.resolve(process.cwd(), hits), "utf8");
      } catch (err: any) {
        return this.failure(`Failed to read hit ledger (${hits}): ${err.message}`);
      }
      const fired = parseRuleHits(text);
      if (fired.length === 0) {
        return this.failure(
          `No rule hits found in ${hits}. Expected lines like "12\t||doubleclick.net^".`,
        );
      }
      // The ledger is what the browser genuinely matched, so everything in it really fired —
      // including rules a hostname replay could never have validated. Only the hostname-decidable
      // fires enter the rate; the rest are tallied by scope so none is silently folded in.
      ledger = [];
      for (const entry of fired) {
        const scope = scopeOfFiredRule(entry.rule);
        if (scope === "hostname") {
          ledger.push(entry);
          continue;
        }
        tallies[scope].rules.add(entry.rule);
        tallies[scope].requests += entry.count;
      }
    } else {
      let traceText: string;
      try {
        traceText = await fs.readFile(path.resolve(process.cwd(), trace as string), "utf8");
      } catch (err: any) {
        return this.failure(`Failed to read trace file (${trace}): ${err.message}`);
      }

      const entries = parseRequestTrace(traceText);
      if (entries.length === 0) {
        return this.failure(`No usable requests found in the trace (${trace}).`);
      }

      // One shared pass: the same replay the hot-set builder derives its artifact from, so a
      // measured list and the report that justifies it cannot disagree about what fired.
      const replay = replayRuleHits(ruleSet, entries);

      // Only the hostname-decidable winners enter the rate; the rest are tallied by scope, which is
      // what stops the rate from being an upper bound.
      ledger = replay.hits;
      for (const hit of replay.scopedHits) {
        tallies[hit.scope].rules.add(hit.rule);
        tallies[hit.scope].requests += hit.count;
      }

      traceStats = {
        file: path.resolve(process.cwd(), trace as string),
        uniqueHosts: entries.length,
        requests: entries.reduce((sum, entry) => sum + entry.count, 0),
        blockedHosts: replay.blockedHosts,
        blockedRequests: replay.blockedRequests,
        allowlistedHosts: replay.allowlistedHosts,
        exceptionRulesFired: replay.exceptions.length,
        matchedHostRatePercent:
          entries.length > 0 ? (replay.blockedHosts / entries.length) * 100 : 0,
        scopedHosts: replay.scopedHosts,
        scopedRequests: replay.scopedRequests,
        urlDecidedRequests: replay.urlDecidedRequests,
        urlDecidedRules: replay.urlDecidedRules,
        urlsInTrace: entries.filter((entry) => entry.url !== undefined).length,
      };
    }

    // The headline rate is stated over the hostname-decidable bucket alone — the one set a replay
    // measures exactly — so it is a measurement rather than an upper bound. The per-scope tallies
    // above carry the fires it deliberately leaves out.
    const report = analyzeRuleCoverage({
      totalRules: scopes.hostname,
      hits: ledger,
      topLimit,
    });

    const scopedRulesFired = tallyCounts(tallies);
    const contextScopedRulesFired =
      scopedRulesFired.initiator + scopedRulesFired.path + scopedRulesFired.request;
    const scopedRequests =
      tallies.initiator.requests + tallies.path.requests + tallies.request.requests;

    const data = {
      rules: {
        file: source,
        compiledLines: rules.length,
        networkRules: countNetworkRules(rules),
        indexedRules,
        indexedBlockingRules,
        /** Blocking rules by how much of a request the browser needs to decide them. */
        scopes,
        /** The bucket the hit rate is measured over, and the only one a replay can decide. */
        hostnameDecidableRules: scopes.hostname,
        /**
         * `/regex/` rules refused at compile time — provably backtracking structures the
         * evaluator declined to run, each with its reason.
         */
        refusedRules: ruleSet.getRefusedRules(),
      },
      source: hits ? "hits" : "trace",
      trace: traceStats,
      ledger: {
        file: hits ? path.resolve(process.cwd(), hits) : null,
        matchedRules: report.matchedRules,
        matchedRequests: report.blockedRequests,
        /** Fired rules, and requests, that a hostname replay cannot decide — by scope. */
        scopedRulesFired,
        scopedRequests,
        contextScopedRulesFired,
      },
      coverage: report,
    };

    if (json) {
      writeJson(data);
      return this.success(data, "Coverage analysis complete");
    }

    this.print(data, report);
    return this.success(data, "Coverage analysis complete");
  }

  /**
   * Resolves the compiled list to measure against.
   *
   * Prefers a browser-rule export, because that is the artifact the browser applies. `hot` swaps
   * the candidate for the coverage-derived hot set, which is the trimmed default for a budget that
   * cannot hold the full list — an explicit request, never a silent substitution.
   */
  private async resolveRules(
    explicit?: string,
    hot = false,
  ): Promise<{ rules: string[]; source: string }> {
    const baseDir = this.config?.baseDir || process.cwd();
    const candidates: string[] = [];
    const outputDir = path.join(baseDir, "filters", "output");

    if (explicit) {
      candidates.push(path.resolve(process.cwd(), explicit));
    } else if (hot) {
      candidates.push(
        path.join(outputDir, HOT_LIST_FILE),
        path.join(process.cwd(), "packages", "cli", "filters", "output", HOT_LIST_FILE),
      );
    } else {
      candidates.push(
        path.join(outputDir, "genericBrowserRules.txt"),
        path.join(outputDir, "adguardBrowser.txt"),
        path.join(outputDir, "filter-list.txt"),
        path.join(process.cwd(), "packages", "cli", "filters", "output", "genericBrowserRules.txt"),
        path.join(process.cwd(), "packages", "electron-app", "filters", "output", "genericBrowserRules.txt"),
      );
    }

    for (const file of candidates) {
      try {
        const text = await fs.readFile(file, "utf8");
        const rules = text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (rules.length > 0) return { rules, source: file };
      } catch {
        // Try the next candidate.
      }
    }

    return { rules: [], source: "" };
  }

  private print(data: any, report: CoverageReport): void {
    const { rules, trace, ledger } = data;

    console.log("\n" + chalk.bold.underline("Blocklist Coverage Analysis:") + "\n");
    console.log(`  Rule source:       ${chalk.dim(rules.file)}`);
    console.log(
      `  Compiled list:     ${chalk.bold(rules.compiledLines.toLocaleString())} lines` +
        chalk.dim(` (${rules.networkRules.toLocaleString()} network rules)`),
    );
    console.log(
      `  Blocking rules:    ${chalk.bold(rules.scopes.total.toLocaleString())} of the ${rules.networkRules.toLocaleString()} network rules can block a request` +
        chalk.dim(` (${rules.indexedBlockingRules.toLocaleString()} reach the hostname index, path rules folded into their host)`),
    );
    console.log(
      `  Rule scopes:       ${chalk.bold(rules.scopes.hostname.toLocaleString())} hostname-decidable` +
        chalk.dim(" · ") +
        `${chalk.yellow(rules.scopes.initiator.toLocaleString())} initiator-scoped` +
        chalk.dim(" · ") +
        `${chalk.yellow(rules.scopes.path.toLocaleString())} path-scoped` +
        chalk.dim(" · ") +
        `${chalk.yellow(rules.scopes.request.toLocaleString())} request-scoped`,
    );
    // A refused /regex/ is coverage the scan deliberately declined — named, with the reason,
    // rather than silently absent from the denominator.
    if (rules.refusedRules.length > 0) {
      console.log(
        `  Refused rules:     ${chalk.yellow(rules.refusedRules.length.toLocaleString())}` +
          chalk.dim(" regex rules whose structure provably backtracks (not run):"),
      );
      for (const refused of rules.refusedRules.slice(0, 5)) {
        console.log(chalk.dim(`    ${refused.rule} — ${refused.reason}`));
      }
      if (rules.refusedRules.length > 5) {
        console.log(chalk.dim(`    … and ${rules.refusedRules.length - 5} more`));
      }
    }
    console.log("");
    console.log(
      `  Input:             ${chalk.dim(data.source === "hits" ? ledger.file : trace.file)}` +
        chalk.dim(data.source === "hits" ? " (browser-reported rule hits)" : " (request trace replay)"),
    );

    if (trace) {
      console.log(
        `  Requests:          ${chalk.bold(trace.requests.toLocaleString())} across ${trace.uniqueHosts.toLocaleString()} distinct hosts`,
      );
      console.log(
        `  Blocked:           ${chalk.bold.red(trace.blockedRequests.toLocaleString())} requests on ${trace.blockedHosts.toLocaleString()} hosts ` +
          chalk.dim(`(${trace.matchedHostRatePercent.toFixed(1)}% of distinct hosts)`),
      );
      if (trace.allowlistedHosts > 0) {
        console.log(
          `  Allowlisted:       ${chalk.yellow(trace.allowlistedHosts.toLocaleString())} hosts matched ${trace.exceptionRulesFired.toLocaleString()} exception rule(s)` +
            chalk.dim(" (not counted as blocks)"),
        );
      }
      if (trace.urlDecidedRequests > 0) {
        console.log(
          `  Path-decided:      ${chalk.green(trace.urlDecidedRequests.toLocaleString())} requests settled by matching ${trace.urlDecidedRules.toLocaleString()} path-scoped rule(s) against the request URL` +
            chalk.dim(" (decided, not counted as undecidable)"),
        );
      } else if (trace.urlsInTrace === 0) {
        // The state this report is in whenever the trace is hostname-only, which is the
        // default capture. It is worth saying out loud rather than staying silent: a reader
        // would otherwise conclude every path-scoped rule in the list fired.
        console.log(
          `  Path-decided:      ${chalk.yellow("0")}` +
            chalk.dim(" — this trace records hostnames only, so no path-scoped rule could be decided"),
        );
      }
      if (trace.scopedHosts > 0) {
        console.log(
          `  Context-scoped:    ${chalk.yellow(trace.scopedRequests.toLocaleString())} requests on ${trace.scopedHosts.toLocaleString()} hosts won on a rule a hostname cannot decide` +
            chalk.dim(" (counted as blocked, kept out of the rate)"),
        );
      }
    }
    console.log("");

    const head95 = report.minimumRules.find((point) => point.share === 0.95);
    const head99 = report.minimumRules.find((point) => point.share === 0.99);

    console.log(
      `  ${chalk.bold.white("List hit rate:")}     ${chalk.bold(report.matchedRules.toLocaleString())} of ${report.totalRules.toLocaleString()} hostname-decidable rules fired ` +
        chalk.dim(`(${report.listHitRatePercent.toFixed(3)}%)`),
    );
    console.log(
      `  ${chalk.bold.white("Dead weight:")}       ${chalk.bold(report.deadWeightPercent.toFixed(3))}% of the hostname-decidable list never fired`,
    );
    if (head95 && head99) {
      console.log(
        `  ${chalk.bold.white("Head of the list:")} ${chalk.bold.green(head95.rules.toLocaleString())} rules cover 95% of blocks, ` +
          `${chalk.bold.green(head99.rules.toLocaleString())} cover 99%`,
      );
    }
    if (ledger.contextScopedRulesFired > 0) {
      const scoped = ledger.scopedRulesFired as Record<ScopedScope, number>;
      const fired = ledger.contextScopedRulesFired as number;
      console.log(
        `  ${chalk.bold.white("Scoped fires:")}     ${chalk.yellow(fired.toLocaleString())} rule${fired === 1 ? "" : "s"} fired that the rate above excludes ` +
          chalk.dim(
            `(${scoped.initiator.toLocaleString()} initiator, ${scoped.path.toLocaleString()} path, ${scoped.request.toLocaleString()} request; ` +
              `${ledger.scopedRequests.toLocaleString()} requests)`,
          ),
      );
    }

    console.log("\n" + chalk.bold.underline("Coverage curve:") + "\n");
    for (const point of report.curve) {
      const share = `${Math.round(point.share * 100)}%`.padStart(4);
      console.log(
        `  ${chalk.cyan(share)} of blocks  →  ${chalk.bold(point.rules.toLocaleString().padStart(9))} rules  ${chalk.dim(`(${point.rulesPercent.toFixed(3)}% of list)`)}`,
      );
    }

    if (report.topRules.length > 0) {
      console.log("\n" + chalk.bold.underline("Hottest rules:") + "\n");
      for (const rule of report.topRules) {
        console.log(
          `  ${chalk.yellow(String(rule.count).padStart(7))} ×  ${chalk.dim(`cum ${(rule.cumulativeShare * 100).toFixed(1)}%`)}  ${rule.rule}`,
        );
      }
    }
    console.log("");
  }
}
