import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MATCHED_RULES_BUDGET,
  LIVE_MATCH_HORIZON_MS,
  LIVE_MATCH_PAIRING_MS,
  canRequestMatchedRules,
  dedupePolledRecords,
  hostFromFilter,
  ledgerLineFor,
  liveMatchKey,
  makeKeyedSerializer,
  matchIsBlock,
  matchedRulesQuotaView,
  readMatchedRuleRecords,
  recordLiveMatch,
  summarizeMatches,
  type LiveMatchLog,
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

describe('ledgerLineFor', () => {
  test('a block rule is its own urlFilter', () => {
    expect(ledgerLineFor('||ads.example^', 'block', {}, 1)).toBe('||ads.example^');
  });

  test('an allow match becomes an exception line, not a block', () => {
    // `@@||host^` and `||host^` compile to the *same* urlFilter — the action is the only
    // thing keeping a paused site or an exception off the block axis and out of the hot set.
    expect(ledgerLineFor('||site.example^', 'allow', {}, 2)).toBe('@@||site.example^');
    expect(ledgerLineFor('||site.example^', 'allowAllRequests', {}, 1000)).toBe(
      '@@||site.example^',
    );
    expect(matchIsBlock('allow')).toBe(false);
    expect(matchIsBlock('allowAllRequests')).toBe(false);
    expect(matchIsBlock(undefined)).toBe(true);
  });

  test('the initiator scope rides along so a scoped rule round-trips scoped', () => {
    // Without the `$domain=` suffix, `||host^$domain=site` would be recorded as `||host^`
    // and reinstalled globally the next time the ledger rebuilt the hot set.
    expect(
      ledgerLineFor('||ads.example^', 'block', { initiatorDomains: ['news.example'] }, 1),
    ).toBe('||ads.example^$domain=news.example');
    expect(
      ledgerLineFor('||ads.example^', 'allow', {
        initiatorDomains: ['news.example'],
        excludedInitiatorDomains: ['blog.news.example'],
      }),
    ).toBe('@@||ads.example^$domain=news.example|~blog.news.example');
  });

  test('the important modifier survives as `,important`', () => {
    expect(ledgerLineFor('||ads.example^', 'block', {}, 3)).toBe(
      '||ads.example^$important',
    );
    expect(
      ledgerLineFor('||ads.example^', 'block', { initiatorDomains: ['a.example'] }, 3),
    ).toBe('||ads.example^$domain=a.example,important');
  });
});

describe('the match path records the line, not the bare filter', () => {
  const background = readFileSync(join(extensionRoot, 'src/background/index.ts'), 'utf8');

  test('resolveMatchedFilter carries the action and reconstructs the ledger line', () => {
    // The regression this pins: a snapshot that dropped `rule.action.type` recorded an allow
    // match's urlFilter as a block hit, and `firedRules()` then exported a paused site's
    // allowAllRequests as a block line — reinstalled as a global block on the next apply.
    expect(background).toContain('action: rule.action?.type');
    expect(background).toContain('initiatorDomains: rule.condition?.initiatorDomains');
    expect(background).toContain('excludedInitiatorDomains: rule.condition?.excludedInitiatorDomains');
    expect(background).toContain('ledgerLineFor(');
  });

  test('applyMatches keeps allow matches off every block axis', () => {
    // Block counters, badge counts, tier attribution and the hot-set tally must all live
    // behind the same `matchIsBlock` gate — an allow on any one of them is the inversion.
    const matches = background.indexOf('!matchIsBlock(action)');
    expect(matches).toBeGreaterThan(-1);
    const after = background.slice(matches);
    expect(after.indexOf('ledger.record(line ?? null')).toBeLessThan(
      after.indexOf('sessionTrackersBlocked += count'),
    );
    expect(after).toContain('ruleHits.record(line, count)');
    expect(after).toContain('ruleHits.recordTier(tier, count)');
    expect(after).toContain('ledger.record(line ?? null, count, Date.now(), { tier: tier ?? null })');
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

describe('live-match dedup', () => {
  function log(): LiveMatchLog {
    return new Map();
  }

  test('a polled record a live arrival already claimed is not counted again', () => {
    const live = log();
    // The debug event carries no timestamp; its arrival at ~match time is the record.
    recordLiveMatch(live, liveMatchKey(3, '_dynamic', 7), 10_000, 10_000);
    const records = dedupePolledRecords([record(7, 3, 10_050)], live);
    expect(records).toHaveLength(0);
    // The stamp was consumed, so a second identical poll is not deduplicated against it.
    expect(dedupePolledRecords([record(7, 3, 10_060)], live)).toHaveLength(1);
  });

  test('a record no live arrival saw is fresh — the wake-drop case this exists for', () => {
    const live = log();
    recordLiveMatch(live, liveMatchKey(3, '_dynamic', 7), 10_000, 10_000);
    // A match live delivery dropped has the same key but a different timestamp… unless it
    // sits inside the pairing window — then it cannot be told apart, which is why the worker
    // is expected to be either alive (all live) or down (all polled), not straddling a match.
    const missed = record(7, 3, 10_000 + LIVE_MATCH_PAIRING_MS + 5_000);
    expect(dedupePolledRecords([missed], live)).toHaveLength(1);
  });

  test('records pair against the same key across tabs and rulesets, never across them', () => {
    const live = log();
    recordLiveMatch(live, liveMatchKey(3, 'tier_ads', 9), 50_000, 50_000);
    expect(dedupePolledRecords([record(9, 4, 50_000, 'tier_ads')], live)).toHaveLength(1);
    expect(dedupePolledRecords([record(9, 3, 50_000, 'tier_ads')], live)).toHaveLength(0);
  });

  test('live stamps prune once they pass the horizon the poll can still report', () => {
    const live = log();
    const key = liveMatchKey(3, '_dynamic', 7);
    recordLiveMatch(live, key, 100_000, 100_000);
    recordLiveMatch(live, key, 100_000 + LIVE_MATCH_HORIZON_MS + 1, 100_000 + LIVE_MATCH_HORIZON_MS + 1);
    // The first stamp aged out; the second survives.
    expect(live.get(key)).toEqual([100_000 + LIVE_MATCH_HORIZON_MS + 1]);
  });

  test('the poll side and the live side build the same key from their different shapes', () => {
    // summarizeMatches groups by this key too, so a tally and a live event name one match alike.
    expect(liveMatchKey(3, '_dynamic', 7)).toBe('3#_dynamic#7');
    expect(liveMatchKey(3, undefined, 7)).toBe('3#_dynamic#7');
    expect(liveMatchKey(3, 'tier_ads', 9)).toBe('3#tier_ads#9');
  });
});

describe('makeKeyedSerializer', () => {
  test('read-modify-writes on one key cannot clobber each other', async () => {
    // The failure this guards: two match events each read the stored count, add one and write —
    // unchained, the second overwrites the first and an increment vanishes.
    const stored = { value: 0 };
    const commit = makeKeyedSerializer<number>();
    const readModifyWrite = () => async () => {
      const read = stored.value;
      await new Promise((r) => setTimeout(r, 5));
      stored.value = read + 1;
    };
    await Promise.all([
      commit(3, readModifyWrite()),
      commit(3, readModifyWrite()),
      commit(3, readModifyWrite()),
    ]);
    expect(stored.value).toBe(3);
  });

  test('different keys still run concurrently', async () => {
    const order: string[] = [];
    const commit = makeKeyedSerializer<number>();
    const task = (name: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(name);
    };
    // The fast task on key 4 finishes before the slow one on key 3 — no cross-key blocking.
    await Promise.all([commit(3, task('slow3', 20)), commit(4, task('fast4', 1))]);
    expect(order).toEqual(['fast4', 'slow3']);
  });

  test('a failed commit does not break the chain behind it', async () => {
    const commit = makeKeyedSerializer<number>();
    let ran = false;
    await Promise.all([
      commit(3, () => Promise.reject(new Error('boom'))).catch(() => {}),
      commit(3, async () => {
        ran = true;
      }),
    ]);
    expect(ran).toBe(true);
  });
});
