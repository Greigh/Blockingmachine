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
 */

/** One rule's hits inside one session, as the browser reported them. */
export interface BrowserLedgerHit {
  rule: string;
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

export interface BrowserLedgerAggregate {
  rules: BrowserLedgerRule[];
  exceptions: BrowserLedgerRule[];
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
} {
  const raw = Array.isArray(input)
    ? input
    : isObject(input) && Array.isArray(input.sessions)
      ? input.sessions
      : null;
  if (!raw) return { sessions: [], rejected: 0 };

  const sessions: BrowserLedgerSession[] = [];
  let rejected = 0;

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
    sessions.push({
      startedAt,
      ...(typeof entry.endedAt === 'string' ? { endedAt: entry.endedAt } : {}),
      feed,
      hits,
      ...(exceptions.length > 0 ? { exceptions } : {}),
    });
  }

  return { sessions, rejected };
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
  const days = new Set<string>();
  let accepted = 0;

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

function readHeaderValue(line: string): { key: string; value: string } | null {
  const match = /^#\s*([A-Za-z][A-Za-z ]*):\s*(.+?)\s*$/.exec(line);
  if (!match) return null;
  return { key: match[1].trim().toLowerCase(), value: match[2] };
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
      const parsed = readHeaderValue(line);
      if (parsed) header[parsed.key] = parsed.value;
      continue;
    }

    if (/^\d+$/.test(line)) continue;

    let rule = line;
    let count = 1;
    const leading = /^(\d+)\s+(.+)$/.exec(line);
    const trailing = /^(.+?)\s+(\d+)$/.exec(line);
    if (leading) {
      count = parseInt(leading[1], 10);
      rule = leading[2];
    } else if (trailing) {
      rule = trailing[1];
      count = parseInt(trailing[2], 10);
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
  if (aggregate.exceptions.length > 0) parts.push(`${aggregate.exceptions.length} exceptions`);
  if (aggregate.rejected > 0) parts.push(`${aggregate.rejected} rejected as unusable`);
  return parts.join(' · ');
}
