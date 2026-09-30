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

export interface ComputeTierPlanInput {
  /** The tier rulesets, in any order. A tier absent here is not planned. */
  files: readonly TierFileInput[];
  /** A rule-hit ledger, if the caller has one. */
  ledger?: TierLedgerInput | null;
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

  const rows: TierPlanRow[] = [];
  for (const tier of STATIC_RULE_TIERS) {
    const file = byId.get(tier.id);
    if (!file) {
      rows.push({
        id: tier.id,
        label: tier.label,
        rules: 0,
        hits: null,
        errors: [`no file was supplied for ${tier.id}`],
      });
      tierHosts.set(tier.id, new Set());
      continue;
    }
    const result = file.readError
      ? { ok: false, ruleCount: 0, errors: [file.readError] }
      : validateTierRuleset(file.rules, tier.id);
    tierHosts.set(tier.id, tierHostsOf(file.rules));
    rows.push({ id: tier.id, label: tier.label, rules: result.ruleCount, hits: null, errors: result.errors });
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
        tiers: STATIC_RULE_TIERS.map((tier) => ({
          id: tier.id,
          label: tier.label,
          category: tier.category,
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
