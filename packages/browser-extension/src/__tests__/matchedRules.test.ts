import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MATCHED_RULES_BUDGET,
  canRequestMatchedRules,
  hostFromFilter,
  matchedRulesQuotaView,
  readMatchedRuleRecords,
  summarizeMatches,
} from '../background/matchedRules.js';

const extensionRoot = fileURLToPath(new URL('../../', import.meta.url));

function record(ruleId: number, tabId: number, timeStamp: number, rulesetId = '_dynamic') {
  return { rule: { ruleId, rulesetId }, tabId, timeStamp };
}

describe('readMatchedRuleRecords', () => {
  test('reads the wrapper Chrome resolves with', () => {
    const records = readMatchedRuleRecords({ rulesMatchedInfo: [record(7, 3, 1000)] });
    expect(records).toEqual([{ rule: { ruleId: 7, rulesetId: '_dynamic' }, tabId: 3, timeStamp: 1000 }]);
  });

  test('reads a bare array, which the specification also allows', () => {
    const records = readMatchedRuleRecords([record(7, 3, 1000)]);
    expect(records).toHaveLength(1);
    expect(records[0].rule.ruleId).toBe(7);
  });

  test('drops entries without a usable rule id or timestamp instead of guessing', () => {
    const records = readMatchedRuleRecords({
      rulesMatchedInfo: [
        record(1, 3, 1000),
        { rule: { rulesetId: '_dynamic' }, tabId: 3, timeStamp: 1000 },
        { rule: { ruleId: 2 }, tabId: 3, timeStamp: 0 },
        { rule: { ruleId: 3 }, tabId: 3 },
        null,
        'nonsense',
      ],
    });
    expect(records.map((entry) => entry.rule.ruleId)).toEqual([1]);
  });

  test('reports a closed tab as -1 and keeps an unknown ruleset id as a string', () => {
    const records = readMatchedRuleRecords({ rulesMatchedInfo: [{ rule: { ruleId: 9 }, timeStamp: 5 }] });
    expect(records[0].tabId).toBe(-1);
    expect(records[0].rule.rulesetId).toBe('');
  });

  test('survives a missing, null or malformed result', () => {
    expect(readMatchedRuleRecords(undefined)).toEqual([]);
    expect(readMatchedRuleRecords(null)).toEqual([]);
    expect(readMatchedRuleRecords({ rulesMatchedInfo: 'no' })).toEqual([]);
  });
});

describe('summarizeMatches', () => {
  test('counts per tab and rule, and advances the cursor to the newest match', () => {
    const delta = summarizeMatches([
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 4, timeStamp: 1000 },
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 4, timeStamp: 1200 },
      { rule: { ruleId: 2, rulesetId: 'tier_ads' }, tabId: 4, timeStamp: 1500 },
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 9, timeStamp: 1100 },
    ]);

    expect(delta.counted).toBe(4);
    expect(delta.alreadyCounted).toBe(0);
    expect(delta.cursor).toBe(1500);
    expect(delta.tallies).toEqual([
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 4, count: 2 },
      { rule: { ruleId: 2, rulesetId: 'tier_ads' }, tabId: 4, count: 1 },
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 9, count: 1 },
    ]);
  });

  test('never counts the same match twice across polls', () => {
    const batch = [
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 4, timeStamp: 1000 },
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 4, timeStamp: 2000 },
    ];

    const first = summarizeMatches(batch, 0);
    expect(first.counted).toBe(2);
    expect(first.cursor).toBe(2000);

    // Replaying the same batch — or a browser reporting inclusively — must not double it.
    const replay = summarizeMatches(batch, first.cursor);
    expect(replay.counted).toBe(0);
    expect(replay.alreadyCounted).toBe(2);
    expect(replay.cursor).toBe(2000);

    const next = summarizeMatches(
      [{ rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 4, timeStamp: 3000 }],
      replay.cursor,
    );
    expect(next.counted).toBe(1);
    expect(next.cursor).toBe(3000);
  });

  test('keeps a closed tab distinct, so its matches are not attributed to a live one', () => {
    const delta = summarizeMatches([
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: -1, timeStamp: 10 },
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: -1, timeStamp: 12 },
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 2, timeStamp: 11 },
    ]);
    expect(delta.tallies).toEqual([
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: -1, count: 2 },
      { rule: { ruleId: 1, rulesetId: '_dynamic' }, tabId: 2, count: 1 },
    ]);
  });

  test('is empty and inert for no matches', () => {
    const delta = summarizeMatches([], 0);
    expect(delta).toEqual({ tallies: [], counted: 0, alreadyCounted: 0, cursor: 0 });
  });
});

describe('canRequestMatchedRules', () => {
  const now = 1_000_000;
  const window = DEFAULT_MATCHED_RULES_BUDGET.windowMs;

  test('allows calls until the quota for the window is spent', () => {
    const spent = Array.from({ length: DEFAULT_MATCHED_RULES_BUDGET.maxCalls }, (_, i) => now - i);
    expect(canRequestMatchedRules(spent, now)).toBe(false);
    expect(canRequestMatchedRules(spent.slice(1), now)).toBe(true);
  });

  test('forgets calls that have aged out of the window', () => {
    const spent = Array.from({ length: DEFAULT_MATCHED_RULES_BUDGET.maxCalls }, () => now - window - 1);
    expect(canRequestMatchedRules(spent, now)).toBe(true);
  });

  test('treats a custom budget as authoritative', () => {
    expect(canRequestMatchedRules([now - 1], now, { maxCalls: 1, windowMs: window })).toBe(false);
    expect(canRequestMatchedRules([now - 1], now, { maxCalls: 2, windowMs: window })).toBe(true);
  });
});

describe('matchedRulesQuotaView', () => {
  const now = 2_000_000;
  const window = DEFAULT_MATCHED_RULES_BUDGET.windowMs;
  const max = DEFAULT_MATCHED_RULES_BUDGET.maxCalls;

  test('reports an untouched budget as full, with nothing to wait for', () => {
    expect(matchedRulesQuotaView([], now)).toEqual({
      callsInWindow: 0,
      maxCalls: max,
      remaining: max,
      resetsInMs: 0,
      windowMs: window,
    });
  });

  test('counts only the calls still inside the window', () => {
    const view = matchedRulesQuotaView([now - 1, now - 2, now - window - 1, now - window - 2], now);
    expect(view.callsInWindow).toBe(2);
    expect(view.remaining).toBe(max - 2);
    // A slot is still free, so there is no wait to report.
    expect(view.resetsInMs).toBe(0);
  });

  test('a spent budget reports when the oldest call ages out', () => {
    // The oldest is a minute old, so one slot frees a minute before the full window elapses.
    const oldest = now - 60_000;
    const spent = Array.from({ length: max }, (_, i) => oldest + i);
    const view = matchedRulesQuotaView(spent, now);
    expect(view.callsInWindow).toBe(max);
    expect(view.remaining).toBe(0);
    expect(view.resetsInMs).toBe(window - 60_000);
  });

  test('agrees with the gate it exists to explain', () => {
    const partial = Array.from({ length: max - 1 }, () => now - 1);
    expect(canRequestMatchedRules(partial, now)).toBe(true);
    expect(matchedRulesQuotaView(partial, now).remaining).toBe(1);

    const full = Array.from({ length: max }, () => now - 1);
    expect(canRequestMatchedRules(full, now)).toBe(false);
    expect(matchedRulesQuotaView(full, now).remaining).toBe(0);
  });

  test('treats a custom budget as authoritative and ignores junk calls', () => {
    const view = matchedRulesQuotaView([now - 1, NaN, Infinity, -Infinity], now, {
      maxCalls: 1,
      windowMs: window,
    });
    expect(view.callsInWindow).toBe(1);
    expect(view.maxCalls).toBe(1);
    expect(view.remaining).toBe(0);
  });
});

describe('hostFromFilter', () => {
  test('names the host of every domain-anchored form', () => {
    expect(hostFromFilter('||doubleclick.net^')).toBe('doubleclick.net');
    expect(hostFromFilter('||cdn.example.com/ads/banner.js')).toBe('cdn.example.com');
    expect(hostFromFilter('||ubembed.com^')).toBe('ubembed.com');
    expect(hostFromFilter('|https://tracker.example.com/beacon.js|')).toBe('tracker.example.com');
    expect(hostFromFilter('https://telemetry.example.com/pixel')).toBe('telemetry.example.com');
  });

  test('refuses to invent a host for a rule that does not name one', () => {
    // The per-tab domain list depends on this: a wrong host is worse than no host.
    expect(hostFromFilter('/pop.js')).toBeNull();
    expect(hostFromFilter('')).toBeNull();
    expect(hostFromFilter('/banner\\d+/')).toBeNull();
    expect(hostFromFilter('||localhost^')).toBeNull();
    expect(hostFromFilter('plainword')).toBeNull();
  });
});

describe('the packed-build path has the permission it needs', () => {
  test('the manifest grants activeTab, without which getMatchedRules cannot be called packed', () => {
    const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'));
    // `declarativeNetRequestFeedback` unlocks getMatchedRules for unpacked extensions only; for a
    // packed build the only route is `activeTab` granted on the tab named in the filter.
    expect(manifest.permissions).toContain('activeTab');
  });
});
