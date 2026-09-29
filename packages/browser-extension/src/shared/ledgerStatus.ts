/**
 * What is feeding the per-tab block ledger, and how much polling budget is left.
 *
 * The browser can tell the extension about a DNR match in two ways, and they are not equivalent.
 * `onRuleMatchedDebug` reports every match live, with the request URL and initiator attached — but
 * Chrome only exposes it to unpacked builds. `getMatchedRules` works in a packed build, at the cost
 * of batching, withholding the request URL, and a hard rate limit. A count means something
 * different depending on which one produced it, so the popup states the source rather than leaving
 * the user to assume.
 *
 * The second half is the quota itself: Chrome allows only a handful of `getMatchedRules` calls per
 * window, so "how many are left" is the number that explains why a polled ledger lags. This module
 * is pure arithmetic and formatting — the background owns the clock and the call log, the popup
 * only reads the result.
 */

import type { LedgerSessionFeed } from './ledgerExport.js';

/** Which reporting path is filling the ledger. */
export type LedgerFeed =
  /** `onRuleMatchedDebug`: every match, live, with the request URL (unpacked builds). */
  | 'live'
  /** `getMatchedRules`: batched, five minutes back, no request URL (packed builds). */
  | 'polled'
  /** Neither path exists, so nothing can feed the ledger. */
  | 'unavailable';

/**
 * The same source, named for a hit-ledger session record.
 *
 * The session format has an `unknown` case that the popup's status does not: a session can be
 * written by a build that could not tell, and the exported file has to be readable by a merge that
 * was told honestly rather than being handed the nearest of three words.
 */
export function ledgerFeedForSession(feed: LedgerFeed): LedgerSessionFeed {
  if (feed === 'live') return 'live';
  if (feed === 'polled') return 'polled';
  return 'unknown';
}

/** How much of the browser's `getMatchedRules` quota is left inside the current window. */
export interface LedgerQuotaView {
  /** Calls logged inside the window. */
  callsInWindow: number;
  /** Calls the browser allows per window. */
  maxCalls: number;
  /** Calls that still fit before the oldest logged call ages out. */
  remaining: number;
  /** Milliseconds until a spent slot frees; `0` while a call still fits. */
  resetsInMs: number;
  /** The quota window, in milliseconds. */
  windowMs: number;
}

/** Everything the popup needs to explain how the ledger is being filled. */
export interface LedgerStatus {
  feed: LedgerFeed;
  /** Whether `onRuleMatchedDebug` is exposed in this build. */
  liveAvailable: boolean;
  /** Whether `getMatchedRules` exists at all, regardless of any `activeTab` grant. */
  pollAvailable: boolean;
  quota: LedgerQuotaView;
}

/**
 * Picks the path the browser will actually use.
 *
 * Live feedback wins when both exist because it is strictly better: same matches, plus the request
 * URL. The polling path is not attempted at all in that case, so its quota stays untouched.
 */
export function ledgerFeedFromAvailability(input: {
  liveAvailable: boolean;
  pollAvailable: boolean;
}): LedgerFeed {
  if (input.liveAvailable) return 'live';
  if (input.pollAvailable) return 'polled';
  return 'unavailable';
}

const FEED_LABELS: Record<LedgerFeed, string> = {
  live: 'Live',
  polled: 'Polled',
  unavailable: 'Off',
};

export function ledgerFeedLabel(feed: LedgerFeed): string {
  return FEED_LABELS[feed];
}

/** The badge tone: green for the honest path, amber for the degraded one, grey for neither. */
export function ledgerFeedTone(feed: LedgerFeed): 'ok' | 'warn' | 'off' {
  if (feed === 'live') return 'ok';
  if (feed === 'polled') return 'warn';
  return 'off';
}

/** The plain-language consequence of each path, for the card's detail line. */
export function ledgerFeedDetail(feed: LedgerFeed): string {
  switch (feed) {
    case 'live':
      return 'Fed by onRuleMatchedDebug — every match, live, with the request URL. Unpacked builds only.';
    case 'polled':
      return 'Fed by getMatchedRules — the last five minutes, batched and without the request URL, so blocked hosts are inferred from the matching rule.';
    case 'unavailable':
      return 'Neither onRuleMatchedDebug nor getMatchedRules is available, so nothing can fill the ledger.';
  }
}

/** A short duration for a quota reset, e.g. `3m 20s` or `45s`. */
export function formatQuotaReset(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/**
 * The quota as one phrase.
 *
 * The three cases read differently on purpose: a full budget is not "0 used", a partial one names
 * what is left, and an exhausted one names when the next call becomes legal — which is the only
 * thing a user staring at a stuck count actually wants to know.
 */
export function formatLedgerQuota(quota: LedgerQuotaView): string {
  if (quota.remaining <= 0) {
    return `none left · next in ${formatQuotaReset(quota.resetsInMs)}`;
  }
  if (quota.remaining >= quota.maxCalls) {
    return `${quota.maxCalls} of ${quota.maxCalls} available`;
  }
  return `${quota.remaining} of ${quota.maxCalls} left`;
}

/** One line naming the source and the quota, for a tooltip or a compact readout. */
export function describeLedger(status: LedgerStatus): string {
  return `${ledgerFeedLabel(status.feed)} · getMatchedRules ${formatLedgerQuota(status.quota)}`;
}
