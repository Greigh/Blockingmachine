/**
 * The background's side of the browser-reported rule-hit ledger.
 *
 * `shared/ledgerExport.ts` owns the arithmetic — the tally, the midnight split, the rule cap — and
 * is pure. This class owns the parts that need a browser: reading and writing
 * `chrome.storage.local`, deciding when a rollover has happened against the real clock, and
 * producing the file the popup hands to the user. Nothing here decides which rules matter; that is
 * `mergeBrowserLedger` in core, run later over many sessions.
 *
 * Two durability decisions are worth stating, because a service worker makes them non-obvious:
 *
 * 1. **The in-progress tally is persisted too, not just the closed sessions.** An MV3 worker is
 *    torn down constantly, and a day's evidence that lived only in memory would be lost with it —
 *    invisibly, since the popup would simply report fewer sessions than the user browsed.
 * 2. **A tally from an earlier day is closed, not resumed or dropped.** Its day cannot be extended,
 *    and the date hits happened on is the entire basis of the durability count, so it is finalized
 *    at the end of its own day and kept.
 *
 * Writes are batched for the same reason `RuleHitStats` batches its own: a busy page matches
 * hundreds of requests, and a storage write per match would thrash the worker.
 *
 * The recorder keeps **two** axes from one match — the filter text and the tier that shipped it —
 * because they disagree usefully. A tier is known whenever the browser named a ruleset, even if the
 * filter could not be read, and one filter can ship in two tiers. Both normalisers below accept a
 * stored value with neither, so a tally written before the tier axis existed resumes unchanged.
 */

import { isTierId } from '@blockingmachine/core/tiers';

import {
  HIT_LEDGER_MAX_SESSIONS,
  HIT_LEDGER_STORAGE_KEY,
  appendLedgerSession,
  finalizeLedgerSession,
  isNewLedgerDay,
  ledgerDayOf,
  ledgerExportFilename,
  mergeSessionRuleHits,
  mergeSessionTiers,
  recordLedgerHit,
  startLedgerSession,
  summarizeLedgerSessions,
  toLedgerExportJson,
  type LedgerExportPayload,
  type LedgerHitCount,
  type LedgerSessionFeed,
  type LedgerTierCount,
  type LedgerSessionReport,
  type LedgerSessionTally,
} from '../shared/ledgerExport.js';

/** Storage key for the tally still being accumulated, so a worker restart resumes the same day. */
export const HIT_LEDGER_TALLY_STORAGE_KEY = 'hitLedgerActiveTally';

/** Matches accumulated before the tally is written back to storage. */
export const LEDGER_FLUSH_EVERY = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFeed(value: unknown): LedgerSessionFeed {
  return value === 'live' || value === 'hybrid' || value === 'polled' ? value : 'unknown';
}

function positiveInt(value: unknown): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : 0;
}

/** Whether a storage failure names quota exhaustion rather than corruption or transport. */
function isQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /quota/i.test(message);
}

/** Tier id → count, keeping only ids the catalogue knows. An empty result is not a rejection. */
function readTierCounts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(raw)) return out;
  for (const [tier, count] of Object.entries(raw)) {
    const value = positiveInt(count);
    if (isTierId(tier) && value > 0) out[tier] = value;
  }
  return out;
}

/**
 * The end of a UTC day, in epoch ms.
 *
 * Used to date a tally that is being closed after the fact: the hits happened during that day, so
 * stamping the session with the moment the worker happened to notice would claim it ran for days.
 */
function endOfDayMs(day: string): number {
  const end = Date.parse(`${day}T23:59:59.999Z`);
  return Number.isFinite(end) ? end : Date.now();
}

/**
 * Reads a persisted tally, or null when it is missing or malformed.
 *
 * Strict about `day` agreeing with `startedAt`: the day is what durability is counted on, so a
 * stored pair that disagrees cannot be trusted to mean either, and a session dated from a guess
 * would put a made-up day into the hot set's evidence.
 */
export function normalizeStoredTally(raw: unknown): LedgerSessionTally | null {
  if (!isRecord(raw)) return null;
  const { day, startedAt } = raw;
  if (typeof day !== 'string' || typeof startedAt !== 'string') return null;

  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime()) || ledgerDayOf(started) !== day) return null;
  if (!isRecord(raw.hits) || !isRecord(raw.exceptions)) return null;

  const hits: Record<string, number> = {};
  for (const [rule, count] of Object.entries(raw.hits)) {
    const value = positiveInt(count);
    if (rule && value > 0) hits[rule] = value;
  }

  const exceptions: Record<string, true> = {};
  for (const rule of Object.keys(raw.exceptions)) {
    if (rule) exceptions[rule] = true;
  }

  const unattributed = positiveInt(raw.unattributed);
  const tierHits = readTierCounts(raw.tierHits);
  const tierUnattributed = positiveInt(raw.tierUnattributed);
  if (
    Object.keys(hits).length === 0 &&
    Object.keys(tierHits).length === 0 &&
    Object.keys(exceptions).length === 0 &&
    unattributed === 0 &&
    tierUnattributed === 0
  ) {
    return null;
  }

  return {
    day,
    startedAt,
    feed: readFeed(raw.feed),
    hits,
    tierHits,
    tierUnattributed,
    exceptions,
    unattributed,
    ...(positiveInt(raw.rulesDropped) > 0 ? { rulesDropped: positiveInt(raw.rulesDropped) } : {}),
  };
}

/** Reads persisted sessions, dropping anything unusable rather than letting it corrupt the list. */
export function normalizeStoredSessions(raw: unknown): LedgerSessionReport[] {
  if (!Array.isArray(raw)) return [];
  const sessions: LedgerSessionReport[] = [];

  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.startedAt !== 'string') continue;
    const started = new Date(entry.startedAt);
    if (Number.isNaN(started.getTime())) continue;

    const hits: LedgerHitCount[] = [];
    if (Array.isArray(entry.hits)) {
      for (const hit of entry.hits) {
        if (!isRecord(hit) || typeof hit.rule !== 'string' || !hit.rule) continue;
        const count = positiveInt(hit.count);
        if (count > 0) hits.push({ rule: hit.rule, count });
      }
    }

    const exceptions: string[] = [];
    if (Array.isArray(entry.exceptions)) {
      for (const rule of entry.exceptions) {
        if (typeof rule === 'string' && rule) exceptions.push(rule);
      }
    }

    const unattributed = positiveInt(entry.unattributed);
    const tiers: LedgerTierCount[] = [];
    if (Array.isArray(entry.tiers)) {
      for (const tier of entry.tiers) {
        if (!isRecord(tier) || !isTierId(tier.tier)) continue;
        const count = positiveInt(tier.count);
        if (count > 0) tiers.push({ tier: tier.tier, count });
      }
    }
    const tierUnattributed = positiveInt(entry.tierUnattributed);
    sessions.push({
      startedAt: entry.startedAt,
      ...(typeof entry.endedAt === 'string' ? { endedAt: entry.endedAt } : {}),
      feed: readFeed(entry.feed),
      hits,
      // Absent stays absent: a session from before the tier axis is a session with no split, and
      // writing an empty `tiers` would make the export claim it had been measured and found empty.
      ...(tiers.length > 0 ? { tiers } : {}),
      ...(tierUnattributed > 0 ? { tierUnattributed } : {}),
      ...(exceptions.length > 0 ? { exceptions } : {}),
      ...(unattributed > 0 ? { unattributed } : {}),
      ...(positiveInt(entry.rulesDropped) > 0
        ? { rulesDropped: positiveInt(entry.rulesDropped) }
        : {}),
    });
  }

  // Same cap the append path enforces, so a hand-edited or older store cannot grow unbounded.
  return sessions.slice(-HIT_LEDGER_MAX_SESSIONS);
}

/**
 * Accumulates what the browser actually blocked into dated sessions.
 *
 * One instance lives in the background worker. `record` is deliberately synchronous: it is called
 * from the match path, where awaiting a storage write per match would stall request accounting.
 */
export class LedgerSessionRecorder {
  private tally: LedgerSessionTally | null = null;
  private sessions: LedgerSessionReport[] = [];
  private pending = 0;
  private feed: LedgerSessionFeed = 'unknown';

  /** Which reporting path is filling the ledger; stamped onto every session it opens. */
  setFeed(feed: LedgerSessionFeed): void {
    if (feed === 'live' || feed === 'hybrid' || feed === 'polled' || feed === 'unknown') {
      this.feed = feed;
    }
  }

  getFeed(): LedgerSessionFeed {
    return this.feed;
  }

  /** Restores the stored sessions and the in-progress tally. Never throws. */
  async load(now: Date | number = Date.now()): Promise<void> {
    try {
      const stored = await chrome.storage.local.get([
        HIT_LEDGER_STORAGE_KEY,
        HIT_LEDGER_TALLY_STORAGE_KEY,
      ]);
      const storedSessions = normalizeStoredSessions(stored?.[HIT_LEDGER_STORAGE_KEY]);
      // Hits recorded while the storage read was in flight live in `this.tally` already —
      // assigning over it would lose them. Merge instead: stored sessions precede any
      // closed in-memory, and a stored tally's hits are replayed into the open one.
      this.sessions = [...storedSessions, ...this.sessions].slice(-HIT_LEDGER_MAX_SESSIONS);

      const tally = normalizeStoredTally(stored?.[HIT_LEDGER_TALLY_STORAGE_KEY]);
      if (!tally) return;
      if (isNewLedgerDay(tally, now)) {
        this.sessions = this.appendFinalized(tally, endOfDayMs(tally.day));
        this.pending += 1;
        return;
      }
      if (!this.tally) {
        this.tally = tally;
        return;
      }
      for (const [rule, count] of Object.entries(tally.hits)) {
        this.tally = recordLedgerHit(this.tally, rule, now, { amount: count }).tally;
      }
      for (const rule of Object.keys(tally.exceptions)) {
        this.tally = recordLedgerHit(this.tally, rule, now).tally;
      }
      this.tally.tierUnattributed += tally.tierUnattributed;
      for (const [tier, count] of Object.entries(tally.tierHits)) {
        this.tally.tierHits[tier] = (this.tally.tierHits[tier] ?? 0) + count;
      }
      this.tally.unattributed += tally.unattributed;
    } catch (err) {
      console.warn('[Ledger] Could not read the stored ledger:', err);
    }
  }

  /**
   * Records that `rule` matched `amount` times.
   *
   * `rule` is null when the browser reported a match whose filter could not be resolved; it is
   * counted as unattributed rather than invented. `tier` is the shipped ruleset the browser named,
   * recorded on its own axis whether or not the filter resolved — a tier that fired is measured
   * either way, and a match from the synced list simply names no tier and is counted as such.
   */
  record(
    rule: string | null,
    amount = 1,
    now: Date | number = Date.now(),
    options: { tier?: string | null } = {},
  ): void {
    const count = Number.isFinite(amount) ? Math.floor(amount) : 1;
    if (count <= 0) return;

    if (!this.tally) {
      this.tally = startLedgerSession(now, this.feed);
    } else if (isNewLedgerDay(this.tally, now)) {
      // Midnight: close the day that just ended so its evidence keeps its own date — stamped at
      // the day's end, not the moment of the first next-day match, which is the convention
      // `load` applies to a tally that crosses midnight unobserved.
      this.sessions = this.appendFinalized(this.tally, endOfDayMs(this.tally.day));
      this.tally = startLedgerSession(now, this.feed);
    }

    this.tally = recordLedgerHit(this.tally, rule, now, { amount: count, tier: options.tier }).tally;
    this.pending += 1;
    if (this.pending >= LEDGER_FLUSH_EVERY) void this.flush();
  }

  /** Persists the closed sessions and the open tally. Safe at any time; a no-op when unchanged. */
  async flush(): Promise<void> {
    if (this.pending === 0) return;
    this.pending = 0;
    try {
      await chrome.storage.local.set({
        [HIT_LEDGER_STORAGE_KEY]: this.sessions,
        [HIT_LEDGER_TALLY_STORAGE_KEY]: this.tally,
      });
    } catch (err) {
      // A full store retries with the oldest sessions shed rather than failing every flush
      // forever — the same answer the session cap already gives, one level down. A failure
      // that is not about size keeps everything and retries next time.
      if (this.sessions.length > 1 && isQuotaError(err)) {
        const shed = Math.ceil(this.sessions.length / 2);
        console.warn(`[Ledger] Storage quota hit — dropping the ${shed} oldest sessions.`);
        this.sessions = this.sessions.slice(shed);
        this.pending = 1;
        void this.flush();
        return;
      }
      // Keep the data in memory and retry on the next flush rather than losing the day.
      this.pending = 1;
      console.warn('[Ledger] Could not persist the ledger:', err);
    }
  }

  /**
   * What an export would contain, including today's still-open session.
   *
   * Read-only on purpose: exporting is not a rollover. Two exports in a row are identical, and
   * browsing after an export continues the same session instead of starting a second one for the
   * same day — which would inflate every rule's session count without adding any evidence.
   */
  sessionsForExport(now: Date | number = Date.now()): LedgerSessionReport[] {
    if (!this.tally) return [...this.sessions];
    const report = finalizeLedgerSession(this.tally, now);
    return report ? [...this.sessions, report] : [...this.sessions];
  }

  /**
   * The rule lines this browser has actually fired, hottest first — the per-deployment evidence
   * a hot set is meant to be measured against.
   *
   * Includes the open tally through `sessionsForExport`, so a rule blocked ten minutes ago is
   * evidence the planner can use on the next apply rather than waiting for tomorrow's rollover.
   */
  firedRules(now: Date | number = Date.now()): { rule: string; count: number }[] {
    return mergeSessionRuleHits(this.sessionsForExport(now));
  }

  /** The downloadable file for the popup: name, JSON, and the one-line summary. */
  exportPayload(now: Date | number = Date.now()): LedgerExportPayload {
    const sessions = this.sessionsForExport(now);
    const split = mergeSessionTiers(sessions);
    return {
      filename: ledgerExportFilename(now),
      json: toLedgerExportJson(sessions),
      summary: summarizeLedgerSessions(sessions),
      sessions: sessions.length,
      tiers: split.tiers,
      tierUnattributed: split.unattributed,
      tieredSessions: split.sessions,
      rulesDropped: sessions.reduce(
        (sum, session) => sum + (Number.isFinite(session.rulesDropped) ? (session.rulesDropped as number) : 0),
        0,
      ),
    };
  }

  private appendFinalized(tally: LedgerSessionTally, at: Date | number): LedgerSessionReport[] {
    const report = finalizeLedgerSession(tally, at);
    return report ? appendLedgerSession(this.sessions, report) : this.sessions;
  }
}
