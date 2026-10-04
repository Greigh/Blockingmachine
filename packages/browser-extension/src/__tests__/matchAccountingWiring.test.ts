/**
 * The match ledger's losses were all wiring, never arithmetic: a gate that skipped the poll
 * whenever `onRuleMatchedDebug` existed (live delivery is lossy across a worker wake — measured
 * at two of three burst events dropped), concurrent match events whose read-modify-writes
 * clobbered each other's counts, an active-tab-only poll that left background tabs' blocks
 * uncounted on builds whose feedback permission could see every tab, and a tabId guard that
 * dropped the whole record — ledger and all — for a match that outlived its tab.
 *
 * `background/index.ts` starts the service worker on import, so the handlers cannot be
 * exercised directly; this pins the gates by reading them, the way
 * `syncConcurrencyWiring.test.ts` does.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'background', 'index.ts'),
  'utf8',
);

function bodyOf(startMarker: string, endMarker = '\n}'): string {
  const at = src.indexOf(startMarker);
  expect(at).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf(endMarker, at));
}

describe('the poll is the backstop, not the alternative', () => {
  test('reconcile is never gated off by live feedback existing', () => {
    // The original bug: `if (hasLiveMatchFeedback()) return 0` assumed a live event meant
    // nothing was missed. Measured live, a three-request burst at a sleeping worker delivered
    // one event — the rest surfaced only in getMatchedRules. (The feedback check may only gate
    // the all-tabs scope a packed build cannot honour, never the poll itself.)
    expect(bodyOf('async function reconcileMatchedRules')).not.toContain(
      'hasLiveMatchFeedback()) return',
    );
  });

  test('polled records are deduplicated against the live log before they are counted', () => {
    expect(bodyOf('async function reconcileMatchedRules')).toContain('dedupePolledRecords');
  });

  test('the reconcile cursor and live log survive a worker restart', () => {
    // An MV3 worker suspends routinely; an in-memory cursor restarting at zero would let the
    // first poll after every restart re-count the whole five-minute window.
    expect(bodyOf('async function reconcileMatchedRules')).toContain('ensureMatchState');
    expect(bodyOf('function persistMatchState')).toContain('MATCH_STATE_KEY');
  });

  test('a live match is stamped before the first await, so a mid-flight poll sees it', () => {
    const listenerAt = src.indexOf('onRuleMatchedDebug.addListener');
    expect(listenerAt).toBeGreaterThan(-1);
    const body = src.slice(listenerAt, src.indexOf('});', listenerAt));
    const stampAt = body.indexOf('recordLiveMatch');
    const applyAt = body.indexOf('applyMatches');
    expect(stampAt).toBeGreaterThan(-1);
    expect(stampAt).toBeLessThan(applyAt);
  });
});

describe('the poll covers what the build can see', () => {
  test('a feedback build polls all open tabs, not just the active one', () => {
    // `getMatchedRules` without a tabId returns every open tab's matches — scoping an unpacked
    // build to the active tab would drop background tabs' blocks the same call could recover.
    expect(src).toContain('reconcileMatchedRules(null)');
  });

  test('the all-tabs scope is refused without the feedback permission', () => {
    // A packed build only has `activeTab`; an unscoped query it cannot honour must never be
    // sent, so `null` is gated on the permission that makes it legal.
    const body = bodyOf('async function reconcileMatchedRules');
    const nullCheck = body.indexOf('tabId === null ? !hasLiveMatchFeedback()');
    expect(nullCheck).toBeGreaterThan(-1);
  });

  test('a match that outlived its tab still reaches the ledger', () => {
    // `getMatchedRules` reports tabId -1 for a tab that closed: the block happened, so the
    // guard may only skip the per-tab telemetry write — never the session or ledger counts
    // that sit before it.
    const body = bodyOf('async function applyMatches');
    const ledgerAt = body.indexOf('ledger.record(line ?? null, count, Date.now(), { tier');
    const guardAt = body.indexOf('match.tabId < 0');
    expect(ledgerAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(ledgerAt);
  });
});

describe('concurrent match events cannot clobber each other', () => {
  test('per-tab telemetry commits run through the keyed serializer', () => {
    // A page load produces dozens of match events at once; without the chain each one's
    // read-modify-write races and the stored count becomes whichever write landed last.
    const body = bodyOf('async function applyMatches');
    expect(body).toContain('enqueueTabCommit(tabId');
    expect(src).toContain('makeKeyedSerializer<number>()');
  });

  test('the popup gesture call reconciles all tabs on a feedback build too', () => {
    const getAt = src.indexOf("case 'GET_TAB_TELEMETRY'");
    expect(getAt).toBeGreaterThan(-1);
    const body = src.slice(getAt, src.indexOf('return true', getAt));
    expect(body).toContain('hasLiveMatchFeedback() ? null : tabId');
  });
});
