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
 */

import {
  HIT_LEDGER_MAX_SESSIONS,
  HIT_LEDGER_STORAGE_KEY,
  appendLedgerSession,
  finalizeLedgerSession,
  isNewLedgerDay,
  ledgerDayOf,
  ledgerExportFilename,
  recordLedgerHit,
  startLedgerSession,
  summarizeLedgerSessions,
  toLedgerExportJson,
  type LedgerExportPayload,
  type LedgerHitCount,
  type LedgerSessionFeed,
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
  return value === 'live' || value === 'polled' ? value : 'unknown';
}

function positiveInt(value: unknown): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : 0;
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
  if (raw.feed !== 'live' && raw.feed !== 'polled' && raw.feed !== 'unknown') return null;
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
  if (Object.keys(hits).length === 0 && Object.keys(exceptions).length === 0 && unattributed === 0) {
    return null;
  }

  return { day, startedAt, feed: readFeed(raw.feed), hits, exceptions, unattributed };
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
    sessions.push({
      startedAt: entry.startedAt,
      ...(typeof entry.endedAt === 'string' ? { endedAt: entry.endedAt } : {}),
      feed: readFeed(entry.feed),
      hits,
      ...(exceptions.length > 0 ? { exceptions } : {}),
      ...(unattributed > 0 ? { unattributed } : {}),
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
    if (feed === 'live' || feed === 'polled' || feed === 'unknown') this.feed = feed;
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
      this.sessions = normalizeStoredSessions(stored?.[HIT_LEDGER_STORAGE_KEY]);

      const tally = normalizeStoredTally(stored?.[HIT_LEDGER_TALLY_STORAGE_KEY]);
      if (!tally) {
        this.tally = null;
        return;
      }
      if (isNewLedgerDay(tally, now)) {
        this.sessions = this.appendFinalized(tally, endOfDayMs(tally.day));
        this.tally = null;
        this.pending += 1;
      } else {
        this.tally = tally;
      }
    } catch (err) {
      console.warn('[Ledger] Could not read the stored ledger:', err);
    }
  }

  /**
   * Records that `rule` matched `amount` times.
   *
   * `rule` is null when the browser reported a match whose filter could not be resolved; it is
   * counted as unattributed rather than invented.
   */
  record(rule: string | null, amount = 1, now: Date | number = Date.now()): void {
    const count = Number.isFinite(amount) ? Math.floor(amount) : 1;
    if (count <= 0) return;

    if (!this.tally) {
      this.tally = startLedgerSession(now, this.feed);
    } else if (isNewLedgerDay(this.tally, now)) {
      // Midnight: close the day that just ended so its evidence keeps its own date, then start a
      // fresh session — the match being recorded belongs to today.
      this.sessions = this.appendFinalized(this.tally, now);
      this.tally = startLedgerSession(now, this.feed);
    }

    this.tally = recordLedgerHit(this.tally, rule, now, { amount: count }).tally;
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

  /** The downloadable file for the popup: name, JSON, and the one-line summary. */
  exportPayload(now: Date | number = Date.now()): LedgerExportPayload {
    const sessions = this.sessionsForExport(now);
    return {
      filename: ledgerExportFilename(now),
      json: toLedgerExportJson(sessions),
      summary: summarizeLedgerSessions(sessions),
      sessions: sessions.length,
    };
  }

  private appendFinalized(tally: LedgerSessionTally, at: Date | number): LedgerSessionReport[] {
    const report = finalizeLedgerSession(tally, at);
    return report ? appendLedgerSession(this.sessions, report) : this.sessions;
  }
}
