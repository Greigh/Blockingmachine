/**
 * Turning files and a ledger into a tier plan, for every surface that has to produce one.
 *
 * ## Why this is in core
 *
 * Three surfaces need this and none of them is the extension: the popup (live, in a browser), the
 * CLI (whatever is on disk), and the desktop hub (what it is about to ship). The popup has the
 * browser's numbers already and goes straight to `planTierSelection`; the other two have to *read*
 * the tier rulesets and a ledger off disk first, and if each wrote that reader the two would drift
 * — a CLI that reported one plan and a hub panel that reported another for the same files would be
 * worse than having neither, because the disagreement would be invisible.
 *
 * So the reading, the validation, the ledger matching and the arithmetic all live here, and the
 * surfaces keep only what is genuinely theirs: how to get bytes off disk and what to do with the
 * answer.
 *
 * ## Why the ledger is matched by host
 *
 * A ledger is keyed by the filter line the browser reported, and a static tier ships `||host^`
 * while the ledger may hold `||host^`, `|http://host^`, a hosts-file line, or a `*.host` wildcard.
 * Matching on the host they all reduce to is the only comparison that does not silently report
 * zero for a tier that in fact fired, and a silently-zero ledger is indistinguishable from a tier
 * that never blocked.
 *
 * ## What a host in two tiers costs
 *
 * The same host can appear in two tier files. The export records which *rule* fired but not which
 * ruleset declared it, so a host two tiers both ship is counted for both. That over-counts, and
 * the number of such lines is returned rather than quietly divided by the claimant count: a plan
 * weighted by a slightly generous measurement is a different thing from a plan weighted by a
 * number nobody can account for.
 *
 * ## Why redundancy is a set difference, not a count
 *
 * The ledger answers "did this tier's rule fire", which is a question about past traffic the
 * browser happened to see. It cannot answer "does this tier block anything the dynamic rules do
 * not", which is a question about the present and is the one that decides whether a tier is worth
 * its static slots. A tier that duplicates the synced list has spent most of the browser's
 * guaranteed static rules on coverage the dynamic quota was already carrying, and no ledger ever
 * shows that — the rules that fire look entirely ordinary.
 *
 * So redundancy is computed over *hosts*: the hosts a tier blocks, minus the hosts the dynamic
 * rules block. It needs no ledger, so a user with no traffic history still gets the answer, and
 * every user gets the same one.
 */

import {
  STATIC_RULE_TIERS,
  isTierId,
  planTierBenefits,
  planTierSelection,
  buildTierBlocking,
  summarizeTierCapacity,
  validateTierRuleset,
  MV3_STATIC_LIMITS,
  type PlanBenefitView,
  type StaticTierId,
  type TierCapacitySummary,
  type TierHitCounts,
  type TierPlan,
} from './tiers.js';
import { extractHostFromRule as hostFromRule } from './ruleHost.js';

export interface TierFileInput {
  id: StaticTierId;
  /** The file's parsed JSON. `null` when it could not be read at all. */
  rules: unknown;
  /** Why the file could not be read, when it could not. */
  readError?: string;
}

export interface TierLedgerInput {
  text: string;
}

export interface TierLedgerRead {
  hits: TierHitCounts;
  /** Lines that named a blockable host and were counted. */
  lines: number;
  /** Lines that named no blockable host: exceptions, bare numbers, directives. */
  skipped: number;
  /** Lines whose host more than one tier ships, and so were credited to each. */
  shared: number;
}

export interface TierPlanRow {
  id: StaticTierId;
  label: string;
  /** Rules in the file, which is what the planner is charged for. */
  rules: number;
  /** Measured blocks attributed to this tier, or null when no ledger was given. */
  hits: number | null;
  /**
   * How much of this tier the synced list already blocks, or null when no list was given.
   *
   * Null rather than zero when absent, because "nothing was compared" and "nothing was redundant"
   * are different facts and a table that cannot tell them apart will eventually be read as the
   * second one.
   */
  redundant: TierRedundancy | null;
  /** Validation failures. A tier with any is not planned at all. */
  errors: string[];
}

export interface TierPlanComputation {
  rows: TierPlanRow[];
  /** Tiers whose files failed validation. When non-empty there is no plan. */
  broken: TierPlanRow[];
  plan: TierPlan;
  basis: PlanBenefitView | null;
  ledger: TierLedgerRead | null;
  /** The synced list the tiers were diffed against, or null when none was given. */
  synced: SyncedListSummary | null;
  /**
   * Tiers that block nothing the synced list does not, in catalogue order.
   *
   * Reported separately from the per-row numbers because this is the finding the whole
   * comparison exists to produce, and a reader would otherwise have to compare four cells
   * against four others to notice it.
   */
  redundantTiers: StaticTierId[];
  capacity: TierCapacitySummary;
  /** The capacity the plan was computed against. */
  capacitySlots: number;
}

/** Hosts a tier's rules block, for matching a ledger line back to the tier that could fire it. */
function tierHostsOf(rules: unknown): Set<string> {
  const hosts = new Set<string>();
  if (!Array.isArray(rules)) return hosts;
  for (const rule of rules) {
    const filter = (rule as { condition?: { urlFilter?: unknown } })?.condition?.urlFilter;
    if (typeof filter !== 'string') continue;
    // The same extractor the ledger is read with, so a tier rule and a ledger line naming the
    // same host cannot disagree about the host because two different functions normalised it.
    const host = hostFromRule(filter);
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * The synced list read as two host sets, plus what could not be read.
 *
 * Exceptions get their own set rather than being dropped, because dropping one would make the
 * diff run backwards. A list that excepts a host does not block it, so a tier shipping that host
 * is the only thing left blocking it, and a diff that ignored the exception would report the tier
 * as redundant precisely where it is load-bearing.
 */
export interface SyncedHostRead {
  /** Hosts the synced list blocks. */
  block: Set<string>;
  /** Hosts it excepts, which it therefore does not block. */
  allow: Set<string>;
  /** Blockable lines read, excluding comments and blanks. */
  lines: number;
  /** Lines naming no blockable host in either direction. */
  skipped: number;
}

/** `@@host^` and the `!@@host` hosts-file spelling both except rather than block. */
const SYNCED_EXCEPTION = /^!?@@/;

/**
 * Modifiers that do not narrow *which* requests a rule blocks.
 *
 * The distinction decides whether a scoped synced rule may retire a tier. A `$script` rule blocks
 * scripts to that host and leaves its images and frames alone, so a tier shipping the same host
 * unconditionally blocks strictly more and is *not* duplicated by it. `$important` and `$all` are
 * on the other side of that line: the first changes priority, the second is a synonym for every
 * resource type, and neither narrows the request set.
 *
 * Refusing the scoped rule is the safe direction. It can under-report a tier that is covered only
 * by a pile of per-resource-type synced rules, which is rare and costs nothing; crediting those
 * rules would over-report a tier as redundant on evidence that covers part of what it does.
 */
const NON_NARROWING_MODIFIERS = new Set(['important', 'all']);

/** Whether a rule's `$` section restricts the requests it applies to. */
function hasNarrowingModifier(line: string): boolean {
  const dollar = line.indexOf('$');
  if (dollar < 0) return false;
  return line
    .slice(dollar + 1)
    .split(',')
    .some((raw) => {
      const name = raw.trim().toLowerCase().replace(/^~/, '');
      if (!name) return false;
      return !NON_NARROWING_MODIFIERS.has(name);
    });
}

/**
 * Reads a synced list into the hosts it blocks and the hosts it excepts.
 *
 * The reader is `extractHostFromRule` on both sides, so a host the tier computes and a host the
 * list computes are normalised by one function and cannot disagree because two disagreed. That
 * also means cosmetic filters and modifier-scoped rules are refused rather than counted as hosts:
 * a rule that blocks nothing at the domain level cannot make a tier's domain rule redundant.
 */
export function readSyncedHosts(text: string): SyncedHostRead {
  const block = new Set<string>();
  const allow = new Set<string>();
  let lines = 0;
  let skipped = 0;

  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const excepted = SYNCED_EXCEPTION.test(line);
    // A bare `!` comment is not an exception, and a `!@@` is.
    if (!excepted && line.startsWith('!')) continue;
    lines += 1;
    const stripped = excepted ? line.replace(SYNCED_EXCEPTION, '') : line;
    // A scoped rule cannot stand in for the unscoped tier rule it resembles. An exception is not
    // held to this: an exception that only covers scripts still *permits* that host, so a tier
    // shipping it is still the only thing blocking the rest, and the same refusal applies.
    const host = hasNarrowingModifier(stripped) ? null : hostFromRule(stripped);
    if (!host) {
      skipped += 1;
      continue;
    }
    (excepted ? allow : block).add(host);
  }

  return { block, allow, lines, skipped };
}

/**
 * Whether `set` already blocks `host`: it names the host itself, or a parent domain of it.
 *
 * A dynamic rule for `doubleclick.net` blocks `ads.doubleclick.net` too, so the answer for a host
 * depends on its ancestors, not on itself alone — hence the walk up the labels rather than a
 * lookup. The walk stops at the bare TLD because `extractHostFromRule` never puts one in the set,
 * so no suffix can be mistaken for coverage of an entire registry.
 */
function coversSynced(set: ReadonlySet<string>, host: string): boolean {
  let candidate = host;
  for (;;) {
    if (set.has(candidate)) return true;
    const dot = candidate.indexOf('.');
    if (dot < 0) return false;
    candidate = candidate.slice(dot + 1);
  }
}

/** How much of a tier the synced list already blocks. */
export interface TierRedundancy {
  /** Tier rules the synced list already blocks. Rules, not hosts, because rules are the cost. */
  rules: number;
  /** Distinct hosts among those rules. */
  hosts: number;
  /**
   * The tier blocks nothing the synced list does not.
   *
   * This is the answer to "is this tier redundant", and it is deliberately not the same as a low
   * ratio. A tier that is 90% duplicated is mostly redundant but still 10% load-bearing, and
   * dropping it is a different decision from dropping one that adds nothing at all.
   */
  complete: boolean;
}

/**
 * How much of a tier's file the synced list already blocks.
 *
 * The diff is one-directional on purpose. A synced rule for `ads.doubleclick.net` does not block
 * `doubleclick.net`, so a tier shipping `||doubleclick.net^` still covers the apex and every
 * other subdomain, and is not redundant. Only a synced host that is the tier host *or an ancestor
 * of it* counts as coverage — testing the other direction would let one narrow synced rule retire
 * a broad tier, which is the opposite of what the number is for.
 */
export function findTierRedundancy(rules: unknown, synced: SyncedHostRead): TierRedundancy {
  if (!Array.isArray(rules)) return { rules: 0, hosts: 0, complete: false };
  const redundantHosts = new Set<string>();
  let total = 0;
  let redundantRules = 0;

  for (const rule of rules) {
    const filter = (rule as { condition?: { urlFilter?: unknown } })?.condition?.urlFilter;
    if (typeof filter !== 'string') continue;
    total += 1;
    const host = hostFromRule(filter);
    if (!host) continue;
    if (!coversSynced(synced.block, host) || coversSynced(synced.allow, host)) continue;
    redundantRules += 1;
    redundantHosts.add(host);
  }

  return {
    rules: redundantRules,
    hosts: redundantHosts.size,
    complete: total > 0 && redundantRules === total,
  };
}

/** What a surface can report about the synced list without shipping two 120,000-entry sets. */
export interface SyncedListSummary {
  /** Distinct hosts the synced list blocks. */
  hosts: number;
  /** Distinct hosts it excepts. */
  exceptions: number;
  /** Blockable lines read. */
  lines: number;
  /** Lines naming no blockable host. */
  skipped: number;
}

export function summarizeSyncedList(read: SyncedHostRead): SyncedListSummary {
  return {
    hosts: read.block.size,
    exceptions: read.allow.size,
    lines: read.lines,
    skipped: read.skipped,
  };
}

/**
 * Credits every measured line to the tier that could have produced it.
 *
 * The refusals are the ledger's own. An `@@` line is on the record because it *allowed* a
 * request, and crediting it to a tier would rank a tier by the traffic it let through — the exact
 * inversion the ledger exists to prevent. A line that is only a number names no rule. A `*.host`
 * rule is *not* refused, though the tier *input* side refuses that shape: `||host^` is how a tier
 * ships the coverage either way, so the host the rule is about is the base domain, and narrowing
 * it back cannot invent a tier that did not already ship that host. The real hot list is full of
 * these lines, and treating them as unusable would have silently zeroed a real measurement.
 */
export function readTierLedger(
  text: string,
  tierHosts: ReadonlyMap<StaticTierId, Set<string>>,
): TierLedgerRead {
  const hits: TierHitCounts = {};
  let lines = 0;
  let skipped = 0;
  let shared = 0;

  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;

    let count = 1;
    let rule = line;
    const leading = /^(\d+)\s+(.+)$/.exec(line);
    const trailing = /^(.+?)\s+(\d+)$/.exec(line);
    if (leading) {
      count = Number(leading[1]);
      rule = leading[2];
    } else if (trailing) {
      rule = trailing[1];
      count = Number(trailing[2]);
    }
    if (!Number.isFinite(count) || count <= 0) {
      skipped += 1;
      continue;
    }

    const trimmed = rule.trim();
    const host = hostFromRule(/^\*+\./.test(trimmed) ? trimmed.replace(/^\*+\./, '') : rule);
    if (!host) {
      skipped += 1;
      continue;
    }
    lines += 1;

    const claimants: StaticTierId[] = [];
    for (const [id, hosts] of tierHosts) {
      if (hosts.has(host)) claimants.push(id);
    }
    if (claimants.length > 1) shared += 1;
    for (const id of claimants) {
      hits[id] = (hits[id] ?? 0) + count;
    }
  }

  return { hits, lines, skipped, shared };
}

/** The synced list's text, as the hub writes it and as the CLI reads it off disk. */
export interface SyncedListInput {
  text: string;
}

export interface ComputeTierPlanInput {
  /** The tier rulesets, in any order. A tier absent here is not planned. */
  files: readonly TierFileInput[];
  /** A rule-hit ledger, if the caller has one. */
  ledger?: TierLedgerInput | null;
  /** The synced list — what the dynamic rules already block. */
  synced?: SyncedListInput | null;
  /** Tiers to treat as currently on. */
  enabled: readonly StaticTierId[];
  /** Static slots to plan against. Defaults to Chrome's guaranteed floor. */
  capacity?: number;
}

/**
 * The whole computation, from parsed files to a plan.
 *
 * A file that fails validation stops the computation rather than being planned: the planner would
 * happily charge a tier for rules the browser will refuse to load, and a plan that recommended
 * shipping an unloadable ruleset is worse than no plan. The caller is told which tier and why.
 */
export function computeTierPlan(input: ComputeTierPlanInput): TierPlanComputation {
  const byId = new Map(input.files.map((file) => [file.id, file]));
  const tierHosts = new Map<StaticTierId, Set<string>>();
  // Read before the row loop so every row is diffed against the same list, and so a caller that
  // supplies a list gets an answer for tiers whose file is broken rather than a silent null.
  const synced = input.synced ? readSyncedHosts(input.synced.text) : null;

  const rows: TierPlanRow[] = [];
  for (const tier of STATIC_RULE_TIERS) {
    const file = byId.get(tier.id);
    if (!file) {
      rows.push({
        id: tier.id,
        label: tier.label,
        rules: 0,
        hits: null,
        // A tier with no file cannot be redundant, because there is nothing to duplicate.
        redundant: synced ? { rules: 0, hosts: 0, complete: false } : null,
        errors: [`no file was supplied for ${tier.id}`],
      });
      tierHosts.set(tier.id, new Set());
      continue;
    }
    const result = file.readError
      ? { ok: false, ruleCount: 0, errors: [file.readError] }
      : validateTierRuleset(file.rules, tier.id);
    tierHosts.set(tier.id, tierHostsOf(file.rules));
    rows.push({
      id: tier.id,
      label: tier.label,
      rules: result.ruleCount,
      hits: null,
      redundant: synced ? findTierRedundancy(file.rules, synced) : null,
      errors: result.errors,
    });
  }

  const broken = rows.filter((row) => row.errors.length > 0);
  const capacitySlots = input.capacity ?? MV3_STATIC_LIMITS.GUARANTEED_STATIC_RULES;
  const countOf = (tier: { id: StaticTierId }): number =>
    rows.find((row) => row.id === tier.id)?.rules ?? 0;

  let ledger: TierLedgerRead | null = null;
  let basis: PlanBenefitView | null = null;
  if (input.ledger) {
    ledger = readTierLedger(input.ledger.text, tierHosts);
    for (const row of rows) {
      if (row.errors.length === 0) row.hits = ledger.hits[row.id] ?? 0;
    }
    basis = planTierBenefits(
      buildTierBlocking({
        // The counts come along so a tier that carries no rules is graded `empty` rather than
        // silent. `tier_security` is exactly that on a machine that has not run the classifier,
        // and a tier that can never be measured must not hold the plan on the rule-count basis.
        tiers: STATIC_RULE_TIERS.map((tier) => ({
          id: tier.id,
          label: tier.label,
          category: tier.category,
          ruleCount: countOf(tier),
        })),
        enabledIds: input.enabled,
        hits: ledger.hits,
      }),
    );
  }

  const candidates = rows
    .filter((row) => row.errors.length === 0)
    .map((row) => ({
      id: row.id,
      label: row.label,
      ruleCount: row.rules,
      // Left undefined unless the ledger measured this tier: a partial set would make the planner
      // fall back to rule counts while the report claimed measurement.
      ...(basis?.benefits?.[row.id] === undefined ? {} : { benefit: basis.benefits[row.id] }),
    }));

  const plan = planTierSelection({
    tiers: candidates,
    // A capacity other than the guaranteed floor is a congestion scenario, and the live figure the
    // popup uses is "already enabled plus what the browser still grants". Here nothing is being
    // enabled yet, so the number asked for *is* the live figure. Passing it at the default would
    // say the browser "did not report a live figure", which is true of a CLI and false of a hub
    // that was handed one deliberately.
    ...(capacitySlots === MV3_STATIC_LIMITS.GUARANTEED_STATIC_RULES
      ? {}
      : { enabledRuleCount: 0, availableStaticRules: capacitySlots }),
    currentEnabled: input.enabled,
  });

  return {
    rows,
    broken,
    plan,
    basis,
    ledger,
    synced: synced ? summarizeSyncedList(synced) : null,
    redundantTiers: rows.filter((row) => row.redundant?.complete).map((row) => row.id),
    capacity: summarizeTierCapacity(input.enabled, countOf),
    capacitySlots,
  };
}

/** The tier ids a manifest enables on a fresh install, or every tier when told nothing. */
export function parseEnabledTierIds(raw: string | undefined, fallback: readonly StaticTierId[]): StaticTierId[] {
  if (typeof raw !== 'string' || !raw.trim()) return [...fallback];
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(isTierId);
  return [...new Set(ids)];
}
