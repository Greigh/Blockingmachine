/**
 * Matched-rule accounting, shared by the two ways the browser can report a DNR match.
 *
 * `onRuleMatchedDebug` is the honest one: it reports the request URL, the initiator and the tab for
 * every match, live. Chrome only exposes it to *unpacked* extensions though, so a packed build sees
 * nothing at all from that event — which silently leaves the per-tab ledger, the badge, and the
 * rule-hit ledger that feeds `blockingmachine coverage --hits` completely empty.
 *
 * `getMatchedRules` does work in a packed build, at three costs the browser imposes on purpose:
 * it never returns the request URL (so a match can be attributed to a rule and a tab, but not to a
 * host), it only reports matches from the last five minutes against a still-active document, and it
 * is rate limited to a handful of calls per ten minutes.
 *
 * This module owns the parts of that which are pure arithmetic and worth asserting: the
 * `minTimeStamp` cursor that stops a poll from counting the same match twice, the budget that keeps
 * a poll inside the browser's quota, how much of that budget is left to report to the popup, and
 * how a filter line narrows down to the host it blocks.
 */

import type { LedgerQuotaView } from '../shared/ledgerStatus.js';

export interface MatchedRuleRef {
  ruleId: number;
  rulesetId: string;
}

/** The fields of a `getMatchedRules` result this extension actually uses. */
export interface MatchedRuleRecord {
  rule: MatchedRuleRef;
  /** The tab the match came from, or `-1` when that tab is no longer open. */
  tabId: number;
  /** Milliseconds since the epoch. */
  timeStamp: number;
}

/** How often one rule matched in one tab within a single batch. */
export interface MatchTally {
  tabId: number;
  rule: MatchedRuleRef;
  count: number;
}

export interface MatchDelta {
  /** One entry per (tab, rule) pair, most-matching first. */
  tallies: MatchTally[];
  /** Matches newly counted in this batch. */
  counted: number;
  /** Records the browser re-reported at or below the cursor, so they were not counted again. */
  alreadyCounted: number;
  /** The value to pass as `minTimeStamp` on the next poll. */
  cursor: number;
}

/**
 * Reads the shapes browsers return from `getMatchedRules`.
 *
 * Chrome resolves with a `RulesMatchedDetails` wrapper, but the WebExtensions specification lets a
 * browser resolve with the array itself, and either can contain junk. Anything without a usable
 * rule id and timestamp is dropped rather than guessed at.
 */
export function readMatchedRuleRecords(result: unknown): MatchedRuleRecord[] {
  const wrapped = (result ?? {}) as { rulesMatchedInfo?: unknown };
  const source = Array.isArray(result)
    ? result
    : Array.isArray(wrapped.rulesMatchedInfo)
    ? wrapped.rulesMatchedInfo
    : [];

  const records: MatchedRuleRecord[] = [];
  for (const entry of source) {
    const raw = (entry ?? {}) as {
      rule?: { ruleId?: unknown; rulesetId?: unknown };
      tabId?: unknown;
      timeStamp?: unknown;
    };
    const ruleId = Number(raw.rule?.ruleId);
    const timeStamp = Number(raw.timeStamp);
    if (!Number.isFinite(ruleId) || !Number.isFinite(timeStamp) || timeStamp <= 0) continue;

    const tabId = Number(raw.tabId);
    records.push({
      rule: {
        ruleId,
        rulesetId: typeof raw.rule?.rulesetId === 'string' ? raw.rule.rulesetId : '',
      },
      tabId: Number.isInteger(tabId) ? tabId : -1,
      timeStamp,
    });
  }

  return records;
}

/**
 * Collapses a batch of matches into per-(tab, rule) counts and the next cursor.
 *
 * `minTimeStamp` is documented as exclusive — "only matches rules after the given timestamp" — so
 * the cursor is the newest timestamp seen and no overlap is expected. The explicit filter below is
 * a guard for a browser that reports inclusively: dropping the overlap undercounts a single
 * straddling match, whereas counting it would double every match each poll happens to straddle.
 */
export function summarizeMatches(
  records: readonly MatchedRuleRecord[],
  previousCursor = 0,
): MatchDelta {
  const tallies = new Map<string, MatchTally>();
  let counted = 0;
  let alreadyCounted = 0;
  let cursor = Number.isFinite(previousCursor) ? previousCursor : 0;
  // The overlap guard compares against the cursor we arrived with, never the one this pass is
  // building: a batch is not ordered, so comparing against a cursor that moves mid-loop would
  // discard every record older than the newest one already seen.
  const floor = cursor;

  for (const record of records) {
    if (!record?.rule || !Number.isFinite(record.timeStamp)) continue;

    if (record.timeStamp <= floor) {
      alreadyCounted++;
      continue;
    }

    const key = `${record.tabId}#${record.rule.rulesetId}#${record.rule.ruleId}`;
    const existing = tallies.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      tallies.set(key, { tabId: record.tabId, rule: record.rule, count: 1 });
    }
    counted++;
    if (record.timeStamp > cursor) cursor = record.timeStamp;
  }

  return {
    tallies: [...tallies.values()].sort(
      (a, b) => b.count - a.count || a.tabId - b.tabId || a.rule.ruleId - b.rule.ruleId,
    ),
    counted,
    alreadyCounted,
    cursor,
  };
}

export interface MatchedRulesBudget {
  maxCalls: number;
  windowMs: number;
}

/** Chrome's own `getMatchedRules` quota: 20 calls per 10 minutes. */
export const DEFAULT_MATCHED_RULES_BUDGET: MatchedRulesBudget = {
  maxCalls: 20,
  windowMs: 10 * 60 * 1000,
};

/**
 * Whether one more `getMatchedRules` call fits inside the browser's quota.
 *
 * Chrome fails an over-quota call immediately with `runtime.lastError` instead of queueing it, so
 * the extension has to budget its own calls. Calls the browser ties to a user gesture are exempt,
 * so the caller can bypass this — but only for a call it knows a gesture caused.
 */
export function canRequestMatchedRules(
  recentCalls: readonly number[],
  now: number,
  budget: MatchedRulesBudget = DEFAULT_MATCHED_RULES_BUDGET,
): boolean {
  const windowStart = now - budget.windowMs;
  let inWindow = 0;
  for (const at of recentCalls) {
    if (Number.isFinite(at) && at > windowStart) inWindow++;
  }
  return inWindow < budget.maxCalls;
}

/**
 * The same call log `canRequestMatchedRules` gates on, turned into something readable.
 *
 * Kept next to the gate on purpose: the count the popup reports has to be the count that decides
 * whether the next poll is allowed, or the readout is describing a different quota than the one
 * the extension is living under. `resetsInMs` is the wait until the *oldest* in-window call ages
 * out, which is the first moment a spent budget frees up.
 */
export function matchedRulesQuotaView(
  recentCalls: readonly number[],
  now: number,
  budget: MatchedRulesBudget = DEFAULT_MATCHED_RULES_BUDGET,
): LedgerQuotaView {
  const windowStart = now - budget.windowMs;
  const inWindow: number[] = [];
  for (const at of recentCalls) {
    if (Number.isFinite(at) && at > windowStart) inWindow.push(at);
  }
  inWindow.sort((a, b) => a - b);

  const remaining = Math.max(0, budget.maxCalls - inWindow.length);
  const oldest = inWindow[0];
  const resetsInMs =
    remaining > 0 || oldest === undefined ? 0 : Math.max(0, oldest + budget.windowMs - now);

  return {
    callsInWindow: inWindow.length,
    maxCalls: budget.maxCalls,
    remaining,
    resetsInMs,
    windowMs: budget.windowMs,
  };
}

const HOST_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The host a matched filter is anchored to, or null when it names no single host.
 *
 * `getMatchedRules` reports which rule matched but never the request URL, so in a packed build the
 * blocked host can only be inferred from the rule that did the blocking. For `||host^` and
 * `||host/path` — almost the whole list — the inference is exact. For a path-only rule such as
 * `/pop.js`, or a regex, there is no host to name, and the caller records the block without one.
 */
export function hostFromFilter(filter: string): string | null {
  const trimmed = (filter || '').trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('||')) {
    const host = trimmed.slice(2).split(/[/^$]/)[0].toLowerCase();
    return host.includes('.') && HOST_REGEX.test(host) ? host : null;
  }

  const absolute = /^\|?https?:\/\/([^/|^$]+)/i.exec(trimmed);
  if (absolute) {
    const host = absolute[1].toLowerCase();
    return host.includes('.') && HOST_REGEX.test(host) ? host : null;
  }

  return null;
}
