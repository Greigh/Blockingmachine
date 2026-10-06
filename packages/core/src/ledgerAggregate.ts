/**
 * Aggregating browser-reported rule hits across sessions.
 *
 * The hot set has always been built from *a* measurement: one captured request trace, or one
 * browser-reported ledger. Both are honest about what they saw and silent about how little that is,
 * and a trace is the narrower of the two — it is one browsing session, sampled, from one machine.
 * What makes the number mean more is not a better list of requests but **more sessions of the same
 * kind of evidence**, which is what this module is for.
 *
 * Three properties are load-bearing, and each exists because the obvious version gets it wrong:
 *
 * 1. **A rule is durable by the number of distinct days it fired on, not by its total count.** One
 *    busy afternoon of one site can out-count a rule that quietly fires every day for a month, and
 *    the hot set is supposed to hold what a user's traffic actually encounters — so the aggregate
 *    keeps days and sessions per rule and lets the caller require both.
 * 2. **A firing exception is never a firing block.** `@@` rules are the ones that *allowed* a
 *    request; summing them into the hit counts would build a hot set out of the rules that did the
 *    least work, so they are accumulated on their own axis.
 * 3. **Order must not matter.** Sessions arrive in whatever order a directory listing, a merge or a
 *    retry produces, so the merge is commutative and the output is sorted deterministically — the
 *    generated hot list is diff-checked, and a build that depends on input order would fail that
 *    check on a machine that read the files in a different order.
 *
 * The text format is deliberately the one `scripts/build-hot-list.mjs --hits` already parses
 * (`<count> <rule>`, `#` comments, `@@` exceptions) rather than a new one: the file a browser
 * exports is the file the build reads, with no translation step to drift.
 *
 * A fourth axis rides along, and it is the one that decides a plan rather than a hot list: **the
 * tier that shipped each rule.** It is merged with the same durability semantics as a rule — days
 * and sessions per tier, not just a total — because "this tier blocked a lot once" and "this tier
 * blocks every day" are the same distinction a rule gets. It is kept separate because it cannot be
 * derived: one filter shipped in two tiers is one rule line and two tier rows, and a tier is
 * credited for a match whose filter text was never resolved.
 */

import { isTierId, type TierHitCounts } from './tiers.js';
import { leadingCountSplit, trailingCountSplit } from './utils/textScan.js';

/** One rule's hits inside one session, as the browser reported them. */
export interface BrowserLedgerHit {
  rule: string;
  count: number;
}

/** One shipped tier's blocks inside one session. */
export interface BrowserLedgerTierHit {
  tier: string;
  count: number;
}

/** One browsing session's hits, dated so durability can be measured in days. */
export interface BrowserLedgerSession {
  /** ISO date-time the session started; only the date part is used for durability. */
  startedAt: string;
  /** ISO date-time the session ended, when the reporter knows it. */
  endedAt?: string;
  /** Which extension reporting path produced these numbers, for provenance. */
  feed?: 'live' | 'polled' | 'unknown';
  hits: BrowserLedgerHit[];
  /**
   * Blocks attributed to each shipped tier, by the tier id the browser named.
   *
   * Absent on sessions exported before the axis existed, and read as *no measurement* rather than as
   * a measurement of zero. That distinction is the reason `tierSessions` is reported below.
   */
  tiers?: BrowserLedgerTierHit[];
  /** Blocks this session made that named no shipped tier — the synced list, usually. */
  tierUnattributed?: number;
  /** Rules that fired as exceptions (`@@`) in this session. */
  exceptions?: string[];
}

/** One rule in the merged ledger. */
export interface BrowserLedgerRule {
  rule: string;
  count: number;
  /** Sessions the rule fired in. */
  sessions: number;
  /** Distinct UTC dates the rule fired on, oldest first. */
  days: string[];
}

/** One tier in the merged ledger, measured the same way a rule is. */
export interface BrowserLedgerTier {
  tier: string;
  count: number;
  /** Sessions the tier blocked in. */
  sessions: number;
  /** Distinct UTC dates the tier blocked on, oldest first. */
  days: string[];
}

export interface BrowserLedgerAggregate {
  rules: BrowserLedgerRule[];
  exceptions: BrowserLedgerRule[];
  /** Per-tier block counts, highest first. Empty when no session carried the axis. */
  tiers: BrowserLedgerTier[];
  /**
   * Sessions of `sessions` that carried a tier split.
   *
   * The coverage number for the tier axis, and the reason it is not implied by `tiers.length`:
   * merging three exports written before the axis with one written after produces a tier table that
   * describes a quarter of the evidence, and a plan weighted by it would look measured where it is
   * not.
   */
  tierSessions: number;
  /** Blocks across all sessions that named no shipped tier. */
  tierUnattributed: number;
  /** Tier entries dropped as unusable, so a reader can see what the split could not cover. */
  tierRejected: number;
  /** Sessions merged, including any that contributed nothing. */
  sessions: number;
  /** Distinct UTC dates across every session, oldest first. */
  days: string[];
  /** Earliest and latest date seen, or null when nothing was merged. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** Sessions dropped as unusable, so a caller can report coverage rather than guess it. */
  rejected: number;
}

export interface MergeBrowserLedgerOptions {
  /**
   * Keep only rules that fired on at least this many distinct days.
   *
   * The default is 1 — "keep everything you were told" — because filtering is a decision about the
   * hot set, and `selectHotList` already decides what the list can afford to drop. Raising it is
   * how a caller says "I would rather ship fewer rules that show up routinely than more that fired
   * once", and the aggregate states the days it kept so the claim stays checkable.
   */
  minDays?: number;
  /** Cap on rules kept, highest count first. `exceptions` is capped the same way and separately. */
  maxRules?: number;
}

const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * The UTC date of an ISO timestamp, or null when it is not a date.
 *
 * UTC rather than local on purpose: the same ledger merged on two machines in different time zones
 * has to agree about how many days it covers, or the durability number is not portable.
 */
export function ledgerDateOf(timestamp: unknown): string | null {
  if (typeof timestamp !== 'string') return null;
  const match = ISO_DATE_PREFIX.exec(timestamp.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return null;
  return `${year}-${month}-${day}`;
}

/**
 * Normalizes a rule as it will be written to the ledger.
 *
 * Anything that could corrupt the format is refused rather than escaped: a rule containing a newline
 * or a leading `#` would become a comment or a second entry, and the file is parsed by a build step
 * that has no way to know a line was never a rule.
 */
export function normalizeLedgerRule(rule: unknown): string | null {
  if (typeof rule !== 'string') return null;
  const trimmed = rule.replace(/^\uFEFF/, '').trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return null;
  if (/[\r\n\0]/.test(trimmed)) return null;
  return trimmed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads sessions from untrusted input — a file a user pointed at, or an export from a browser.
 *
 * Junk is *counted*, not ignored: a merge that silently skipped half its input would report a
 * duration it did not have, and the whole point of the aggregate is that its claims are checkable.
 * A session with no usable date is rejected too, because a hit that cannot be dated can neither
 * prove nor disprove durability.
 */
export function readBrowserLedgerSessions(input: unknown): {
  sessions: BrowserLedgerSession[];
  rejected: number;
  tierRejected: number;
} {
  const raw = Array.isArray(input)
    ? input
    : isObject(input) && Array.isArray(input.sessions)
      ? input.sessions
      : null;
  if (!raw) return { sessions: [], rejected: 0, tierRejected: 0 };

  const sessions: BrowserLedgerSession[] = [];
  let rejected = 0;
  let tierRejected = 0;

  for (const entry of raw) {
    if (!isObject(entry) || !ledgerDateOf(entry.startedAt) || !Array.isArray(entry.hits)) {
      rejected += 1;
      continue;
    }
    const hits: BrowserLedgerHit[] = [];
    for (const hit of entry.hits) {
      if (!isObject(hit)) continue;
      const rule = normalizeLedgerRule(hit.rule);
      const count = typeof hit.count === 'number' && Number.isFinite(hit.count) ? hit.count : 0;
      if (!rule || count <= 0) continue;
      hits.push({ rule, count: Math.floor(count) });
    }
    // A tier id the catalogue does not know is refused, not normalised. These ids are what a plan's
    // weightings are keyed on, so one nobody recognises could not be weighed — and storing it would
    // put a row in the table that looks measured. Counted rather than dropped, like sessions.
    const tiers: BrowserLedgerTierHit[] = [];
    if (Array.isArray(entry.tiers)) {
      for (const hit of entry.tiers) {
        if (!isObject(hit) || !isTierId(hit.tier)) {
          tierRejected += 1;
          continue;
        }
        const count = typeof hit.count === 'number' && Number.isFinite(hit.count) ? hit.count : 0;
        if (count <= 0) continue;
        tiers.push({ tier: hit.tier, count: Math.floor(count) });
      }
    }
    const exceptions: string[] = [];
    if (Array.isArray(entry.exceptions)) {
      for (const rule of entry.exceptions) {
        const normalized = normalizeLedgerRule(rule);
        if (normalized) exceptions.push(normalized);
      }
    }
    const feed =
      entry.feed === 'live' || entry.feed === 'polled' || entry.feed === 'unknown'
        ? entry.feed
        : 'unknown';
    const startedAt = String(entry.startedAt);
    const tierUnattributed =
      typeof entry.tierUnattributed === 'number' && Number.isFinite(entry.tierUnattributed)
        ? Math.max(0, Math.floor(entry.tierUnattributed))
        : 0;
    sessions.push({
      startedAt,
      ...(typeof entry.endedAt === 'string' ? { endedAt: entry.endedAt } : {}),
      feed,
      hits,
      ...(tiers.length > 0 ? { tiers } : {}),
      ...(tierUnattributed > 0 ? { tierUnattributed } : {}),
      ...(exceptions.length > 0 ? { exceptions } : {}),
    });
  }

  return { sessions, rejected, tierRejected };
}

interface Accumulator {
  count: number;
  sessions: number;
  days: Set<string>;
}

function accumulate(
  target: Map<string, Accumulator>,
  rule: string,
  count: number,
  day: string,
): void {
  const existing = target.get(rule) ?? { count: 0, sessions: 0, days: new Set<string>() };
  existing.count += count;
  // A session counts once per rule, not once per hit: "fired in 40 sessions" is a statement about
  // recurrence, and adding the hit count there would just be `count` again.
  existing.sessions += 1;
  existing.days.add(day);
  target.set(rule, existing);
}

function finalize(entries: Map<string, Accumulator>): BrowserLedgerRule[] {
  return [...entries.entries()]
    .map(([rule, acc]) => ({
      rule,
      count: acc.count,
      sessions: acc.sessions,
      days: [...acc.days].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}

/** The same merge, keyed by tier: a total, plus the sessions and days it was observed on. */
function finalizeTiers(entries: Map<string, Accumulator>): BrowserLedgerTier[] {
  return [...entries.entries()]
    .map(([tier, acc]) => ({
      tier,
      count: acc.count,
      sessions: acc.sessions,
      days: [...acc.days].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.tier.localeCompare(b.tier));
}

/**
 * Merges browser-reported sessions into one ledger.
 *
 * Sessions whose dates cannot be read are already gone by the time they get here
 * (`readBrowserLedgerSessions` rejects them), which is what lets durability be a plain distinct-day
 * count rather than a guess about a session's age.
 */
export function mergeBrowserLedger(
  sessions: readonly BrowserLedgerSession[],
  options: MergeBrowserLedgerOptions = {},
): BrowserLedgerAggregate {
  const minDays = Math.max(1, Math.floor(options.minDays ?? 1));
  const maxRules = Math.max(1, Math.floor(options.maxRules ?? Number.MAX_SAFE_INTEGER));

  const blocks = new Map<string, Accumulator>();
  const allows = new Map<string, Accumulator>();
  const tierBlocks = new Map<string, Accumulator>();
  const days = new Set<string>();
  let accepted = 0;
  let tiered = 0;
  let tierUnattributed = 0;
  let tierRejected = 0;

  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!isObject(session)) continue;
    const day = ledgerDateOf(session.startedAt);
    if (!day) continue;
    accepted += 1;
    days.add(day);

    for (const hit of Array.isArray(session.hits) ? session.hits : []) {
      if (!isObject(hit)) continue;
      const rule = normalizeLedgerRule(hit.rule);
      const count = typeof hit.count === 'number' && Number.isFinite(hit.count) ? hit.count : 0;
      if (!rule || count <= 0) continue;
      // An `@@` rule that reached the hits array is an exception; counting it as a block would
      // invert the rule's meaning, which is worse than dropping it.
      const target = rule.startsWith('@@') ? allows : blocks;
      accumulate(target, rule, Math.floor(count), day);
    }

    // The tier axis is read from the session's own tally, never inferred from the rules above: a
    // filter shipped in two tiers is one line here and two entries there, and a tier is credited for
    // a match whose filter could not be resolved at all — so both directions of guessing are wrong.
    const sessionTiers = Array.isArray(session.tiers) ? session.tiers : [];
    if (sessionTiers.length > 0) tiered += 1;
    for (const hit of sessionTiers) {
      // A tier id the catalogue does not know is unusable, and it is counted here rather than
      // dropped quietly: a caller that hands raw session JSON straight to the merge never went
      // through the reader's count, so the refusal has to be measured where it happens.
      // On the shipped path this finds nothing — the reader already dropped and counted these —
      // so the two counts cover disjoint sets and the script adds them rather than choosing one.
      if (!isObject(hit) || !isTierId(hit.tier)) {
        tierRejected += 1;
        continue;
      }
      const count = typeof hit.count === 'number' && Number.isFinite(hit.count) ? hit.count : 0;
      if (count <= 0) continue;
      accumulate(tierBlocks, hit.tier, Math.floor(count), day);
    }
    if (typeof session.tierUnattributed === 'number' && Number.isFinite(session.tierUnattributed)) {
      tierUnattributed += Math.max(0, Math.floor(session.tierUnattributed));
    }

    for (const rule of Array.isArray(session.exceptions) ? session.exceptions : []) {
      const normalized = normalizeLedgerRule(rule);
      if (!normalized) continue;
      accumulate(allows, normalized.startsWith('@@') ? normalized : `@@${normalized}`, 1, day);
    }
  }

  const durable = (rules: BrowserLedgerRule[]): BrowserLedgerRule[] =>
    rules.filter((rule) => rule.days.length >= minDays).slice(0, maxRules);

  const orderedDays = [...days].sort();

  return {
    rules: durable(finalize(blocks)),
    exceptions: durable(finalize(allows)),
    // `minDays` is the caller's statement about *rules*: it is asking which rules are durable
    // enough to ship. A tier is a measurement of the plan rather than an entry in it, so filtering
    // it by the same threshold would delete a tier from the evidence that judged the very filter
    // being applied — the tier table keeps every tier it was told about, with its own days.
    tiers: finalizeTiers(tierBlocks),
    tierSessions: tiered,
    tierUnattributed,
    tierRejected,
    sessions: accepted,
    days: orderedDays,
    firstSeen: orderedDays[0] ?? null,
    lastSeen: orderedDays[orderedDays.length - 1] ?? null,
    rejected: 0,
  };
}

/**
 * The aggregate as the text `build-hot-list.mjs --hits` parses.
 *
 * The provenance header is `#` comments, which that parser already skips — so the file works with
 * an older build of the script, and the numbers a hot set is derived from travel with it instead of
 * living in a commit message. Sorted by count then rule so the output is stable enough to diff.
 */
export function toHitLedgerText(
  aggregate: BrowserLedgerAggregate,
  options: { source?: string; note?: string } = {},
): string {
  const lines: string[] = [];
  lines.push('# Browser-reported rule-hit ledger');
  if (options.source) lines.push(`# Source: ${options.source}`);
  lines.push(`# Sessions: ${aggregate.sessions}`);
  lines.push(`# Days: ${aggregate.days.length}`);
  if (aggregate.firstSeen) lines.push(`# First seen: ${aggregate.firstSeen}`);
  if (aggregate.lastSeen) lines.push(`# Last seen: ${aggregate.lastSeen}`);
  if (aggregate.rejected > 0) lines.push(`# Rejected sessions: ${aggregate.rejected}`);
  // The per-tier tally, in the header rather than as rule lines. It is not blockable evidence —
  // `readTierLedger` and the tier compiler both key rules to tiers, never the reverse — so writing
  // it as `tier_core 543` would invent 543 rules named `tier_core` and let them into a host list.
  // `Tier sessions` is the coverage claim: a table built from two of ten sessions says so here.
  if (aggregate.tiers.length > 0) {
    lines.push(`# Tiers: ${aggregate.tiers.map((tier) => `${tier.tier} ${tier.count}`).join(', ')}`);
    lines.push(`# Tier sessions: ${aggregate.tierSessions} of ${aggregate.sessions}`);
  }
  if (aggregate.tierUnattributed > 0) {
    lines.push(`# Tier unattributed: ${aggregate.tierUnattributed}`);
  }
  if (aggregate.tierRejected > 0) lines.push(`# Rejected tier entries: ${aggregate.tierRejected}`);
  if (options.note) lines.push(`# ${options.note}`);
  lines.push('#');
  lines.push('# <count> <rule>, highest first. @@ rules are exceptions that fired, not blocks.');
  lines.push('');

  for (const rule of aggregate.rules) lines.push(`${rule.count} ${rule.rule}`);
  for (const rule of aggregate.exceptions) lines.push(`1 ${rule.rule}`);
  return `${lines.join('\n')}\n`;
}

/** What a hit-ledger text file said, including the provenance someone may have written into it. */
export interface ParsedHitLedger {
  hits: BrowserLedgerHit[];
  exceptions: string[];
  /** `# Sessions: 12` and friends, when the header carries them. */
  header: Record<string, string>;
}

/**
 * Extracts one `Key: value` field from a `#` header line, or null when it is not that shape.
 *
 * Keys are lowercased (`# Tier sessions:` → `tier sessions`), so a reader can match the header
 * `toHitLedgerText` writes without caring about the writer's casing. Shared between
 * `parseHitLedgerText` and `readTierLedger` so a comment means the same thing to both readers.
 */
export function readLedgerHeaderLine(line: string): { key: string; value: string } | null {
  // The `# Key Name: value` shape walked by index rather than
  // `/^#\s*([A-Za-z][A-Za-z ]*):\s*(.+?)\s*$/` — on a colon-less letter-and-space line the
  // regex's key run backs off one character per start position, quadratically.
  if (!line.startsWith('#')) return null;
  const body = line.slice(1).trimStart();
  const colon = body.indexOf(':');
  if (colon <= 0) return null;
  const rawKey = body.slice(0, colon);
  for (let i = 0; i < rawKey.length; i += 1) {
    const c = rawKey.charCodeAt(i);
    const alpha = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    // The key is letters, with internal spaces allowed (`# Tier sessions:`); a space in
    // the first position or any other character fails it, as `[A-Za-z][A-Za-z ]*` did.
    if (!alpha && !(i > 0 && c === 32)) return null;
  }
  const rawValue = body.slice(colon + 1);
  if (rawValue.length === 0) return null;
  return { key: rawKey.trim().toLowerCase(), value: rawValue.trim() };
}

/**
 * The per-tier tally a merged ledger's header carries, when it carries one.
 *
 * Unlike a rule line this is the browser's own split — the ruleset that shipped the winning
 * filter, credited even when the filter text never resolved — so where it covers every session
 * it is the more exact measurement. `tierSessions`/`sessions` say how much of the ledger it
 * covers: a tally from one session of four is a measurement of one session, and a plan that
 * weighted it as though it covered all four would be silently discarding three.
 */
export interface LedgerTierTally {
  /** Per-tier block counts as the browser reported them at match time. */
  hits: TierHitCounts;
  /** Sessions that carried a tier split — the tally's coverage numerator, or null if unrecorded. */
  tierSessions: number | null;
  /** Sessions the ledger merged — the tally's coverage denominator, or null if unrecorded. */
  sessions: number | null;
  /** Tally entries that named no known tier, counted rather than silently dropped. */
  rejected: number;
}

/**
 * Reads the `# Tiers:` / `# Tier sessions:` / `# Sessions:` header fields, when present.
 *
 * Returns null when the file carries no `# Tiers:` line at all — absent means "this ledger
 * predates the axis or was written by something else", which a caller must not turn into a
 * tally of zero. Entries naming an unknown tier id are refused exactly the way the session
 * reader refuses them: counted, not normalised, because these ids are what a plan keys on.
 */
export function readLedgerTierTally(header: Record<string, string>): LedgerTierTally | null {
  const raw = header['tiers'];
  if (typeof raw !== 'string') return null;

  const hits: TierHitCounts = {};
  let rejected = 0;
  for (const part of raw.split(',')) {
    const match = /^(\S+)\s+(\d+)$/.exec(part.trim());
    const id = match?.[1];
    const count = match ? Number(match[2]) : NaN;
    if (!id || !isTierId(id) || !Number.isFinite(count) || count <= 0) {
      rejected += 1;
      continue;
    }
    hits[id] = (hits[id] ?? 0) + Math.floor(count);
  }

  const int = (value: string | undefined): number | null => {
    const match = value === undefined ? null : /^(\d+)$/.exec(value.trim());
    return match ? Number(match[1]) : null;
  };
  // `Tier sessions` is written `X of Y`; a hand-edited or foreign file may carry the bare count,
  // so the denominator falls back to the `Sessions:` line when the "of Y" is absent.
  const split = /^(\d+)\s+of\s+(\d+)$/.exec(header['tier sessions'] ?? '');
  const tierSessions = split ? Number(split[1]) : int(header['tier sessions']);
  const sessions = split ? Number(split[2]) : int(header['sessions']);

  return { hits, tierSessions, sessions, rejected };
}

/**
 * Parses the `<count> <rule>` form, with the count allowed on either side.
 *
 * Both orders are accepted because both exist in the wild: the exports write `count rule`, while a
 * hand-written list is usually `rule count`.
 *
 * A line that is *only* a number is refused rather than read as a rule. Both readings are possible
 * and they disagree — `42` as a count with no rule, or a one-count hit on a pattern named `42` — and
 * inventing a rule from a line whose meaning cannot be determined is worse than skipping it. The
 * same reasoning drops a line whose count parses but whose rule does not.
 */
export function parseHitLedgerText(text: string): ParsedHitLedger {
  const hits: BrowserLedgerHit[] = [];
  const exceptions = new Set<string>();
  const totals = new Map<string, number>();
  const header: Record<string, string> = {};

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('!')) {
      const parsed = readLedgerHeaderLine(line);
      if (parsed) header[parsed.key] = parsed.value;
      continue;
    }

    if (/^\d+$/.test(line)) continue;

    let rule = line;
    let count = 1;
    const leading = leadingCountSplit(line);
    const trailing = leading ? null : trailingCountSplit(line);
    if (leading) {
      count = leading.count;
      rule = leading.rest;
    } else if (trailing) {
      rule = trailing.head;
      count = trailing.count;
    }

    const normalized = normalizeLedgerRule(rule);
    if (!normalized || !Number.isFinite(count) || count <= 0) continue;
    if (normalized.startsWith('@@')) {
      exceptions.add(normalized);
      continue;
    }
    totals.set(normalized, (totals.get(normalized) ?? 0) + Math.floor(count));
  }

  for (const [rule, count] of [...totals.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )) {
    hits.push({ rule, count });
  }

  return { hits, exceptions: [...exceptions].sort(), header };
}

/**
 * One line naming what the aggregate covers.
 *
 * The duration is the honest part and the reason this exists: "12 sessions across 34 days" is a
 * different claim from "a trace", and the hot set's header quotes it rather than leaving a reader to
 * assume the evidence was a week of real browsing.
 */
export function summarizeBrowserLedger(aggregate: BrowserLedgerAggregate): string {
  if (aggregate.sessions === 0) return 'no sessions';
  const sessions = `${aggregate.sessions} session${aggregate.sessions === 1 ? '' : 's'}`;
  const days = `${aggregate.days.length} day${aggregate.days.length === 1 ? '' : 's'}`;
  const span =
    aggregate.firstSeen && aggregate.lastSeen && aggregate.firstSeen !== aggregate.lastSeen
      ? ` (${aggregate.firstSeen} to ${aggregate.lastSeen})`
      : aggregate.firstSeen
        ? ` (${aggregate.firstSeen})`
        : '';
  const parts = [`${sessions} across ${days}${span}`, `${aggregate.rules.length} blocking rules`];
  if (aggregate.tiers.length > 0) {
    // Coverage first, then the size. "4 tiers over 1 of 10 sessions" is the honest reading of a
    // mixed-age merge, and leading with the total would invite the other one.
    parts.push(
      `${aggregate.tiers.length} tiers over ${aggregate.tierSessions} of ${aggregate.sessions} session${aggregate.sessions === 1 ? '' : 's'}`,
    );
  }
  if (aggregate.tierUnattributed > 0) {
    parts.push(`${aggregate.tierUnattributed.toLocaleString()} blocks in no tier`);
  }
  if (aggregate.exceptions.length > 0) parts.push(`${aggregate.exceptions.length} exceptions`);
  if (aggregate.rejected > 0) parts.push(`${aggregate.rejected} rejected as unusable`);
  if (aggregate.tierRejected > 0) parts.push(`${aggregate.tierRejected} tier entries rejected`);
  return parts.join(' · ');
}
