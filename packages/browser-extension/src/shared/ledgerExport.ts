/**
 * The extension's side of the browser-reported rule-hit ledger.
 *
 * The hot set has always been built from *a* measurement, and the honest one available to a browser
 * extension is not a captured trace but the matches the browser itself applied. This module
 * accumulates those into a **session report** — raw evidence, dated, one file per session — and the
 * aggregation happens afterwards, in `packages/core/src/ledgerAggregate.ts`, where it can be tested
 * over many sessions and re-run on the same input.
 *
 * The division is deliberate:
 *
 * - The browser reports what happened and stays dumb. It does not decide which rules are durable,
 *   does not rank anything, and does not need to know what a hot set is. A session report it wrote
 *   last month is still valid input.
 * - The aggregate is reproducible. Because the browser exports sessions rather than a running
 *   summary, the same files merged twice give the same ledger, and a user can see exactly which
 *   session a number came from.
 *
 * Two rules the accumulation itself has to follow, both of which a naive tally gets wrong:
 *
 * 1. **A session that crosses midnight becomes two.** Durability is measured in distinct days, so a
 *    report claiming one date for hits that happened on two would understate the evidence and make
 *    the day count depend on when a browser happened to be opened.
 * 2. **A match whose rule cannot be named is counted as unattributed, not guessed at.** The filter
 *    text comes from loading the shipped rule files, which can fail; inventing a rule for a match
 *    would put a fabricated entry into the file the hot set is built from, so an unnamed hit is
 *    reported as a number the reader can see instead.
 *
 * There is a **second axis, the tier that shipped the rule**, and it is not derivable from the first.
 * A match names the ruleset that won, so a tier is known even when its filter text could not be
 * read; and the same urlFilter can ship in two tiers, which collapse into one filter entry here and
 * into two tier entries there. That axis is the number the tier plan is weighted by, so a ledger
 * that cannot be exported with it leaves the plan unreproducible outside the popup that measured it.
 *
 * Imported by the background and, for the export action, by the popup. Pure arithmetic and JSON —
 * no `chrome` reference — so it is tested without a browser.
 */

import { isTierId } from '@blockingmachine/core/tiers';

/** Which reporting path produced these numbers, mirroring the popup's ledger status. */
export type LedgerSessionFeed = 'live' | 'hybrid' | 'polled' | 'unknown';

/** One rule's hits within one session. */
export interface LedgerHitCount {
  rule: string;
  count: number;
}

/** One shipped tier's hits within one session. */
export interface LedgerTierCount {
  tier: string;
  count: number;
}

/**
 * One session, as exported.
 *
 * This is the shape `readBrowserLedgerSessions` accepts — an array of these, or an object with a
 * `sessions` array, is exactly what `scripts/merge-browser-ledger.mjs --in` reads.
 */
export interface LedgerSessionReport {
  startedAt: string;
  endedAt?: string;
  feed: LedgerSessionFeed;
  hits: LedgerHitCount[];
  /**
   * Blocks attributed to each shipped tier, by the tier id the browser named.
   *
   * Optional, because an export written before this axis existed has none and remains valid input.
   * It is *not* the same information as `hits`: a tier is counted whenever the browser named it, so
   * these counts hold for matches whose filter text was never resolved, and a rule shipped in two
   * tiers appears in two entries here against one in `hits`. `tiers` plus `tierUnattributed` add up
   * to the session's blocks, which is what makes a missing tier a visible hole rather than a guess.
   */
  tiers?: LedgerTierCount[];
  /**
   * Blocks this session made that named no shipped tier — the synced list, most often, since those
   * rules are not in a tier ruleset at all.
   *
   * Reported for the same reason `unattributed` is: a tier plan that silently dropped them would
   * read as though the tiers had blocked everything, and a plan weighted by that is the wrong cut.
   */
  tierUnattributed?: number;
  exceptions?: string[];
  /**
   * Matches whose rule could not be named — usually a failed rule-file load.
   *
   * Reported rather than dropped: a ledger that silently omitted them would look like a session
   * with fewer blocks, and the difference between "nothing matched" and "we cannot say what
   * matched" is the difference between a small hot set and a broken one.
   */
  unattributed?: number;
  /**
   * Distinct rules the per-session cap evicted — the tail the tally could not keep.
   *
   * Reported for the same reason `unattributed` is: a session that hit the cap and said nothing
   * would read as one with fewer rules than the traffic actually carried.
   */
  rulesDropped?: number;
}

/** The in-progress tally the background keeps in memory. */
export interface LedgerSessionTally {
  /** UTC date the tally belongs to; a rollover closes it. */
  day: string;
  startedAt: string;
  feed: LedgerSessionFeed;
  /** Rule text → hits. */
  hits: Record<string, number>;
  /** Tier id → blocks attributed to it. Independent of `hits`: see `recordLedgerHit`. */
  tierHits: Record<string, number>;
  /** Blocks that named no shipped tier. */
  tierUnattributed: number;
  /** `@@` rules that fired, as a set of rule texts. */
  exceptions: Record<string, true>;
  unattributed: number;
  /** Rules the cap has evicted so far — evidence the tally could not keep, reported not hidden. */
  rulesDropped?: number;
}

/** Distinct rules kept per session before the smallest are dropped. */
export const HIT_LEDGER_MAX_RULES = 5000;

/** Storage key for the persisted sessions the export action writes out. */
export const HIT_LEDGER_STORAGE_KEY = 'hitLedgerSessions';

/** Sessions kept in storage; the oldest is dropped past this, since the newest are the ones a user exports. */
export const HIT_LEDGER_MAX_SESSIONS = 50;

/** The UTC date of a timestamp, as `YYYY-MM-DD`. */
export function ledgerDayOf(date: Date | number): string {
  const value = date instanceof Date ? date : new Date(date);
  return value.toISOString().slice(0, 10);
}

/** Starts a tally for the current day. */
export function startLedgerSession(now: Date | number, feed: LedgerSessionFeed): LedgerSessionTally {
  const iso = new Date(now).toISOString();
  return {
    day: ledgerDayOf(now),
    startedAt: iso,
    feed,
    hits: {},
    tierHits: {},
    tierUnattributed: 0,
    exceptions: {},
    unattributed: 0,
  };
}

/** Whether the day has rolled over since the tally started, so it has to be closed and reopened. */
export function isNewLedgerDay(tally: LedgerSessionTally, now: Date | number): boolean {
  return tally.day !== ledgerDayOf(now);
}

export interface RecordHitResult {
  tally: LedgerSessionTally;
  /** Rules dropped to stay under the cap, most-hit kept. */
  dropped: number;
  /** Whether the cap was reached by this hit (the caller may want to note it once). */
  atCap: boolean;
}

/**
 * Credits `amount` blocks to a tier, in place.
 *
 * Kept separate from `recordLedgerHit` because the two axes have different rules: a tier is counted
 * whether or not the filter resolved, but only for a block, and only against a tier the catalogue
 * knows. Everything else lands in `tierUnattributed`, so `tierHits` plus `tierUnattributed` is the
 * session's block count and a reader can check the split rather than trust it.
 */
function addTierHit(tally: LedgerSessionTally, tier: unknown, amount: number): void {
  if (isTierId(tier)) {
    tally.tierHits[tier] = (tally.tierHits[tier] ?? 0) + amount;
    return;
  }
  tally.tierUnattributed += amount;
}

/**
 * Adds a match to the tally.
 *
 * `rule` is the filter text the browser applied, or `null` when it could not be resolved — which is
 * counted, never invented. A rule already in the tally is incremented in place; hitting the cap
 * evicts the least-fired rules, because a session is bounded but the ranking that matters happens
 * later, over many sessions, where the tail is still visible.
 *
 * `options.tier` is the shipped ruleset that won, when the browser named one. It is recorded on its
 * own axis and **independently of the filter lookup**, which is the whole point: a tier that fired
 * is measured whether or not its rule file could be read to name the filter. Two refusals, both
 * deliberate:
 *
 * - An `@@` rule credits no tier. It *allowed* a request, so giving it to a tier would rank that
 *   tier by the traffic it let through — the same inversion the block/exception split exists to
 *   prevent, one level up.
 * - A tier id the catalogue does not know is counted as tier-unattributed rather than stored. The
 *   ids are what the plan's weightings are keyed on, so an unrecognised one could not be weighed and
 *   must not become a row that looks like it was.
 */
export function recordLedgerHit(
  tally: LedgerSessionTally,
  rule: string | null,
  now: Date | number,
  options: { maxRules?: number; amount?: number; tier?: string | null } = {},
): RecordHitResult {
  const maxRules = Math.max(1, Math.floor(options.maxRules ?? HIT_LEDGER_MAX_RULES));
  // A polled batch reports how many times one rule matched in one tab, so a caller can add a whole
  // batch in one call rather than looping — which matters at the cap, where every call re-sorts.
  const amount =
    Number.isFinite(options.amount) && (options.amount as number) > 0
      ? Math.floor(options.amount as number)
      : 1;
  const next: LedgerSessionTally = {
    ...tally,
    hits: { ...tally.hits },
    tierHits: { ...tally.tierHits },
    exceptions: { ...tally.exceptions },
  };

  if (rule === null || rule === undefined) {
    next.unattributed = tally.unattributed + amount;
    addTierHit(next, options.tier, amount);
    return { tally: next, dropped: 0, atCap: false };
  }

  const trimmed = String(rule).trim();
  if (!trimmed) {
    next.unattributed = tally.unattributed + amount;
    addTierHit(next, options.tier, amount);
    return { tally: next, dropped: 0, atCap: false };
  }

  // An `@@` rule allowed a request. It is kept on its own axis so the block counts stay block counts.
  // The axis is a set of rules, not a hit count, so an amount adds nothing there — and it credits no
  // tier either, because nothing was blocked.
  if (trimmed.startsWith('@@')) {
    next.exceptions = { ...next.exceptions, [trimmed]: true };
  } else {
    next.hits = { ...next.hits, [trimmed]: (next.hits[trimmed] ?? 0) + amount };
    addTierHit(next, options.tier, amount);
  }

  const keys = Object.keys(next.hits);
  if (keys.length <= maxRules) return { tally: next, dropped: 0, atCap: keys.length === maxRules };

  const evict = keys
    .map((key) => ({ key, count: next.hits[key] }))
    .sort((a, b) => a.count - b.count || a.key.localeCompare(b.key))
    .slice(0, keys.length - maxRules);
  for (const { key } of evict) delete next.hits[key];
  next.rulesDropped = (next.rulesDropped ?? 0) + evict.length;
  void now;

  return { tally: next, dropped: evict.length, atCap: true };
}

/** Closes a tally into an exportable report, or null when it holds nothing worth writing. */
export function finalizeLedgerSession(
  tally: LedgerSessionTally,
  now: Date | number,
): LedgerSessionReport | null {
  const hits = Object.entries(tally.hits)
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
  const tiers = Object.entries(tally.tierHits)
    .map(([tier, count]) => ({ tier, count }))
    .sort((a, b) => b.count - a.count || a.tier.localeCompare(b.tier));
  const exceptions = Object.keys(tally.exceptions).sort();

  // A tally whose only content is a tier split is still a measurement: the filter files may have
  // been unreadable for every match, which leaves the block axis empty and the tier axis whole, and
  // the tier plan is the consumer that needs it.
  if (
    hits.length === 0 &&
    tiers.length === 0 &&
    exceptions.length === 0 &&
    tally.unattributed === 0 &&
    tally.tierUnattributed === 0
  ) {
    return null;
  }

  return {
    startedAt: tally.startedAt,
    endedAt: new Date(now).toISOString(),
    feed: tally.feed,
    hits,
    ...(tiers.length > 0 ? { tiers } : {}),
    ...(tally.tierUnattributed > 0 ? { tierUnattributed: tally.tierUnattributed } : {}),
    ...(exceptions.length > 0 ? { exceptions } : {}),
    ...(tally.unattributed > 0 ? { unattributed: tally.unattributed } : {}),
    ...((tally.rulesDropped ?? 0) > 0 ? { rulesDropped: tally.rulesDropped } : {}),
  };
}

/**
 * Appends a report to the stored list, oldest first, capped.
 *
 * The oldest sessions are dropped past the cap rather than the newest because the export exists to be
 * run by the user: what they want to export is recent traffic, and a capped window that kept the
 * oldest would hand them a ledger from months ago.
 */
export function appendLedgerSession(
  stored: readonly LedgerSessionReport[] | null | undefined,
  report: LedgerSessionReport,
  options: { maxSessions?: number } = {},
): LedgerSessionReport[] {
  const maxSessions = Math.max(1, Math.floor(options.maxSessions ?? HIT_LEDGER_MAX_SESSIONS));
  const list = Array.isArray(stored) ? [...stored] : [];
  list.push(report);
  return list.length > maxSessions ? list.slice(list.length - maxSessions) : list;
}

/**
 * The export format's version.
 *
 * Bumped to 2 when the per-tier axis was added to each session. Nothing in the reader *requires* 2 —
 * a version 1 session is a valid session with no tier split — but the number is the one place a
 * downstream tool can tell which shape it is holding without inspecting a session.
 */
export const LEDGER_EXPORT_VERSION = 2;

/** The JSON the merge tool reads. `{ sessions: [...] }` is what `readBrowserLedgerSessions` expects. */
export function toLedgerExportJson(sessions: readonly LedgerSessionReport[]): string {
  return `${JSON.stringify(
    {
      format: 'blockingmachine-hit-ledger',
      version: LEDGER_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      sessions: [...sessions],
    },
    null,
    2,
  )}\n`;
}

/** `blockingmachine-hit-ledger-2026-09-29.json` — dated so several exports sort and merge in order. */
export function ledgerExportFilename(now: Date | number): string {
  return `blockingmachine-hit-ledger-${ledgerDayOf(now)}.json`;
}

/**
 * What the popup receives when it asks to export the ledger.
 *
 * A plain data contract, so the background can build it and the popup can render it without either
 * importing the other.
 */
export interface LedgerExportPayload {
  /** Suggested download name, dated so several exports sort and merge in order. */
  filename: string;
  /** The file's contents, exactly as `scripts/merge-browser-ledger.mjs` wants to read them. */
  json: string;
  /** One line naming what the file covers, for the popup to show before the click. */
  summary: string;
  /** Sessions included, counting today's still-open one. */
  sessions: number;
  /**
   * The per-tier split across every session in the file, highest first.
   *
   * Merged here rather than left in the sessions so the popup can show what a plan built from this
   * export would be weighted by, without the user having to open the file. It is the same numbers the
   * JSON carries — a reader comparing the card against the file should not find two answers.
   */
  tiers: LedgerTierCount[];
  /** Blocks in the included sessions that named no shipped tier. */
  tierUnattributed: number;
  /** Sessions that carried a tier split at all, so a mixed-age file states its own coverage. */
  tieredSessions: number;
  /**
   * Distinct rules the per-session cap evicted across the included sessions, summed for the card.
   *
   * Each session reports its own `rulesDropped`; the card needs the aggregate because "the file
   * describes all of your traffic" is only true when this is zero.
   */
  rulesDropped: number;
}

/**
 * Sums the per-tier axis over a set of sessions.
 *
 * Sessions without one contribute nothing and are counted separately, because a file holding five old
 * sessions and one new one would otherwise present a tier split as though it described all six.
 */
export function mergeSessionTiers(sessions: readonly LedgerSessionReport[]): {
  tiers: LedgerTierCount[];
  unattributed: number;
  sessions: number;
} {
  const totals = new Map<string, number>();
  let unattributed = 0;
  let tiered = 0;

  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || typeof session !== 'object') continue;
    const entries = Array.isArray(session.tiers) ? session.tiers : [];
    if (entries.length > 0) tiered += 1;
    for (const entry of entries) {
      if (!entry || typeof entry.tier !== 'string' || !isTierId(entry.tier)) continue;
      const count = Number.isFinite(entry.count) ? Math.floor(entry.count) : 0;
      if (count > 0) totals.set(entry.tier, (totals.get(entry.tier) ?? 0) + count);
    }
    if (Number.isFinite(session.tierUnattributed) && (session.tierUnattributed as number) > 0) {
      unattributed += Math.floor(session.tierUnattributed as number);
    }
  }

  const tiers = [...totals.entries()]
    .map(([tier, count]) => ({ tier, count }))
    .sort((a, b) => b.count - a.count || a.tier.localeCompare(b.tier));
  return { tiers, unattributed, sessions: tiered };
}

/**
 * Sums the per-rule axis over a set of sessions — the deployment's own fired rules, hottest
 * first.
 *
 * This is the per-deployment counterpart of the shipped hot set: the rules *this* browser has
 * actually blocked, in the order the evidence ranks them. The hot set the planner merges these
 * into is then measured against the user's own traffic, not only the repository's scripted
 * sessions — the flag-17 gap between "the list the ledger was scripted from" and "the list this
 * machine needs".
 */
export function mergeSessionRuleHits(
  sessions: readonly LedgerSessionReport[],
): { rule: string; count: number }[] {
  const totals = new Map<string, number>();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || typeof session !== 'object') continue;
    for (const hit of Array.isArray(session.hits) ? session.hits : []) {
      if (!hit || typeof hit.rule !== 'string' || !hit.rule) continue;
      const count = Number.isFinite(hit.count) ? Math.floor(hit.count) : 0;
      if (count > 0) totals.set(hit.rule, (totals.get(hit.rule) ?? 0) + count);
    }
  }
  return [...totals.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}

/** One line for the popup: what the stored sessions add up to. */
export function summarizeLedgerSessions(sessions: readonly LedgerSessionReport[]): string {
  if (!Array.isArray(sessions) || sessions.length === 0) return 'No sessions recorded yet';
  const rules = new Set<string>();
  let hits = 0;
  let unattributed = 0;
  const days = new Set<string>();
  for (const session of sessions) {
    days.add(ledgerDayOf(new Date(session.startedAt)));
    for (const hit of session.hits ?? []) {
      rules.add(hit.rule);
      hits += hit.count;
    }
    unattributed += session.unattributed ?? 0;
  }
  const { tiers, sessions: tiered } = mergeSessionTiers(sessions);
  const parts = [
    `${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
    `${days.size} day${days.size === 1 ? '' : 's'}`,
    `${hits.toLocaleString()} hits on ${rules.size.toLocaleString()} rules`,
  ];
  // The tier clause says how much of the file carries it. A file where one session of six has a
  // split must not read as though the plan could be weighted from all six.
  if (tiers.length > 0) {
    parts.push(
      tiered === sessions.length
        ? `${tiers.length} tiers`
        : `${tiers.length} tiers (${tiered} of ${sessions.length} sessions)`,
    );
  }
  if (unattributed > 0) parts.push(`${unattributed.toLocaleString()} unattributable`);
  return parts.join(' · ');
}
