/**
 * The background's session recorder, against a fake `chrome.storage.local`.
 *
 * What these tests are for is the two things a service worker makes easy to get wrong and hard to
 * notice: a day's evidence that only ever existed in memory (lost silently on the next teardown,
 * leaving the popup to report fewer sessions than the user browsed), and a rollover that folds two
 * days into one session — which would quietly halve the durability of every rule that fired across
 * midnight, the one number the whole ledger exists to produce.
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import {
  HIT_LEDGER_TALLY_STORAGE_KEY,
  LEDGER_FLUSH_EVERY,
  LedgerSessionRecorder,
  normalizeStoredSessions,
  normalizeStoredTally,
} from '../background/ledgerSession.js';
import {
  HIT_LEDGER_STORAGE_KEY,
  type LedgerSessionReport,
  type LedgerSessionTally,
} from '../shared/ledgerExport.js';

const date = (iso: string) => new Date(iso);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface ChromeStub {
  store: Map<string, unknown>;
  get: any;
  set: any;
}

/** A storage area that actually round-trips, so `load` tests exercise real persisted shapes. */
function installChrome(initial: Record<string, unknown> = {}): ChromeStub {
  const store = new Map(Object.entries(initial));

  const get = (jest.fn() as any).mockImplementation(async (keys: unknown) => {
    if (keys == null) return Object.fromEntries(store);
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const key of list) {
      if (store.has(key)) out[key as string] = store.get(key);
    }
    return out;
  });

  const set = (jest.fn() as any).mockImplementation(async (payload: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(payload)) store.set(key, value);
  });

  (globalThis as any).chrome = { storage: { local: { get, set } } };
  return { store, get, set };
}

function tally(overrides: Partial<LedgerSessionTally> = {}): LedgerSessionTally {
  return {
    day: '2026-09-01',
    startedAt: '2026-09-01T09:00:00.000Z',
    feed: 'live',
    hits: {},
    tierHits: {},
    tierUnattributed: 0,
    exceptions: {},
    unattributed: 0,
    ...overrides,
  };
}

function report(overrides: Partial<LedgerSessionReport> = {}): LedgerSessionReport {
  return {
    startedAt: '2026-09-01T09:00:00.000Z',
    feed: 'live',
    hits: [{ rule: '||ads.example^', count: 2 }],
    ...overrides,
  };
}

beforeEach(() => {
  delete (globalThis as any).chrome;
});

describe('LedgerSessionRecorder', () => {
  test('starts empty and reports nothing to export', () => {
    installChrome();
    const ledger = new LedgerSessionRecorder();

    const payload = ledger.exportPayload(date('2026-09-01T09:00:00Z'));
    expect(payload.sessions).toBe(0);
    expect(payload.summary).toBe('No sessions recorded yet');
    expect(payload.filename).toBe('blockingmachine-hit-ledger-2026-09-01.json');
    expect(JSON.parse(payload.json).sessions).toEqual([]);
  });

  test('accumulates matches into one dated session', () => {
    installChrome();
    const ledger = new LedgerSessionRecorder();
    ledger.setFeed('live');

    ledger.record('||ads.example^', 2, date('2026-09-01T09:00:00Z'));
    ledger.record('||ads.example^', 1, date('2026-09-01T09:01:00Z'));
    ledger.record('@@||allowed.example^', 1, date('2026-09-01T09:02:00Z'));

    const sessions = ledger.sessionsForExport(date('2026-09-01T09:03:00Z'));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].startedAt).toBe('2026-09-01T09:00:00.000Z');
    expect(sessions[0].feed).toBe('live');
    expect(sessions[0].hits).toEqual([{ rule: '||ads.example^', count: 3 }]);
    // A firing exception is kept off the block axis, as the merge expects.
    expect(sessions[0].exceptions).toEqual(['@@||allowed.example^']);
  });

  test('exporting is a read, not a rollover', () => {
    installChrome();
    const ledger = new LedgerSessionRecorder();

    ledger.record('||ads.example^', 1, date('2026-09-01T09:00:00Z'));
    const first = ledger.exportPayload(date('2026-09-01T09:01:00Z'));
    const second = ledger.exportPayload(date('2026-09-01T09:02:00Z'));

    // Two exports of an unchanged ledger describe the same single open session — the only field
    // that moves is the export's own timestamp, and neither call closes anything.
    expect(JSON.parse(first.json).sessions).toHaveLength(1);
    expect(JSON.parse(second.json).sessions).toHaveLength(1);
    expect(JSON.parse(second.json).sessions[0].hits).toEqual(
      JSON.parse(first.json).sessions[0].hits,
    );
    expect(second.summary).toBe(first.summary);

    // Browsing after an export continues the same session instead of starting a second one for
    // the same day, which would inflate every rule's recurrence count with no new evidence.
    ledger.record('||ads.example^', 1, date('2026-09-01T09:03:00Z'));
    const sessions = ledger.sessionsForExport(date('2026-09-01T09:04:00Z'));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].hits).toEqual([{ rule: '||ads.example^', count: 2 }]);
  });

  test('splits a session at UTC midnight instead of merging two days', () => {
    installChrome();
    const ledger = new LedgerSessionRecorder();

    ledger.record('||day1.example^', 1, date('2026-09-01T23:59:00Z'));
    ledger.record('||day2.example^', 1, date('2026-09-02T00:01:00Z'));

    const sessions = ledger.sessionsForExport(date('2026-09-02T00:02:00Z'));
    expect(sessions).toHaveLength(2);
    expect(sessions[0].startedAt).toBe('2026-09-01T23:59:00.000Z');
    expect(sessions[0].hits).toEqual([{ rule: '||day1.example^', count: 1 }]);
    expect(sessions[1].startedAt).toBe('2026-09-02T00:01:00.000Z');
    expect(sessions[1].hits).toEqual([{ rule: '||day2.example^', count: 1 }]);
  });

  test('counts an unnamed match as unattributed rather than inventing a rule', () => {
    installChrome();
    const ledger = new LedgerSessionRecorder();

    ledger.record(null, 1, date('2026-09-01T09:00:00Z'));
    ledger.record('  ', 3, date('2026-09-01T09:00:01Z'));

    const sessions = ledger.sessionsForExport(date('2026-09-01T09:01:00Z'));
    expect(sessions[0].hits).toEqual([]);
    expect(sessions[0].unattributed).toBe(4);
  });

  test('ignores a non-positive or non-finite amount', () => {
    installChrome();
    const ledger = new LedgerSessionRecorder();

    ledger.record('||ads.example^', 0, date('2026-09-01T09:00:00Z'));
    ledger.record('||ads.example^', -5, date('2026-09-01T09:00:00Z'));
    ledger.record('||ads.example^', Number.NaN, date('2026-09-01T09:00:00Z'));

    // NaN falls back to a single match, the others are dropped outright.
    expect(ledger.sessionsForExport(date('2026-09-01T09:01:00Z'))[0].hits).toEqual([
      { rule: '||ads.example^', count: 1 },
    ]);
  });

  test('batches storage writes and persists the open tally', async () => {
    const stub = installChrome();
    const ledger = new LedgerSessionRecorder();

    for (let i = 0; i < LEDGER_FLUSH_EVERY - 1; i += 1) {
      ledger.record('||ads.example^', 1, date('2026-09-01T09:00:00Z'));
    }
    expect(stub.set).not.toHaveBeenCalled();

    ledger.record('||ads.example^', 1, date('2026-09-01T09:00:00Z'));
    await settle();

    expect(stub.set).toHaveBeenCalledTimes(1);
    const [payload] = stub.set.mock.calls[0];
    expect(payload[HIT_LEDGER_STORAGE_KEY]).toEqual([]);
    expect(payload[HIT_LEDGER_TALLY_STORAGE_KEY]).toMatchObject({
      day: '2026-09-01',
      feed: 'unknown',
      hits: { '||ads.example^': LEDGER_FLUSH_EVERY },
    });
  });

  test('does not write when nothing was recorded since the last flush', async () => {
    const stub = installChrome();
    const ledger = new LedgerSessionRecorder();

    await ledger.flush();
    expect(stub.set).not.toHaveBeenCalled();
  });

  test('a failed write keeps the day and retries on the next flush', async () => {
    const stub = installChrome();
    stub.set.mockRejectedValueOnce(new Error('quota'));
    const ledger = new LedgerSessionRecorder();

    ledger.record('||ads.example^', 4, date('2026-09-01T09:00:00Z'));
    await ledger.flush();

    // Still in memory, so the next flush can persist it.
    expect(ledger.sessionsForExport(date('2026-09-01T09:01:00Z'))[0].hits).toEqual([
      { rule: '||ads.example^', count: 4 },
    ]);

    await ledger.flush();
    const [payload] = stub.set.mock.calls[1];
    expect(payload[HIT_LEDGER_TALLY_STORAGE_KEY]).toMatchObject({
      hits: { '||ads.example^': 4 },
    });
  });

  test('a quota failure sheds the oldest sessions and retries, rather than failing forever', async () => {
    // The cap keeps the *newest* sessions for the same reason: what the user exports is recent
    // traffic. A store that is simply full gets the same answer one level down.
    const stub = installChrome({
      [HIT_LEDGER_STORAGE_KEY]: [
        report({ startedAt: '2026-08-29T09:00:00.000Z' }),
        report({ startedAt: '2026-08-30T09:00:00.000Z' }),
        report({ startedAt: '2026-08-31T09:00:00.000Z' }),
      ],
    });
    stub.set
      .mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'))
      .mockImplementation(async (payload: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(payload)) stub.store.set(key, value);
      });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ledger = new LedgerSessionRecorder();
    await ledger.load(date('2026-09-01T09:00:00Z'));
    ledger.record('||today.example^', 1, date('2026-09-01T09:00:00Z'));

    try {
      await ledger.flush();
      await settle(); // the quota retry is scheduled inside flush

      const sessions = stub.store.get(HIT_LEDGER_STORAGE_KEY) as LedgerSessionReport[];
      expect(sessions.length).toBeLessThan(3);
      expect(sessions[sessions.length - 1].startedAt).toBe('2026-08-31T09:00:00.000Z');
    } finally {
      warn.mockRestore();
    }
  });

  test('a rollover closes the day at its end, not at the first next-day match', () => {
    // `load` stamps a closed tally at 23:59:59.999Z of its own day; a rollover discovered by a
    // match has to answer the same way, or the same event reports two different end times.
    installChrome();
    const ledger = new LedgerSessionRecorder();
    ledger.record('||ads.example^', 1, date('2026-09-01T23:00:00Z'));
    ledger.record('||next.example^', 1, date('2026-09-02T00:05:00Z'));

    const sessions = ledger.sessionsForExport(date('2026-09-02T00:06:00Z'));
    expect(sessions).toHaveLength(2);
    expect(sessions[0].endedAt).toBe('2026-09-01T23:59:59.999Z');
  });
});

describe('LedgerSessionRecorder.load', () => {
  test("resumes today's tally, so a worker restart does not split the day", async () => {
    installChrome({
      [HIT_LEDGER_TALLY_STORAGE_KEY]: tally({ hits: { '||ads.example^': 2 } }),
    });
    const ledger = new LedgerSessionRecorder();

    await ledger.load(date('2026-09-01T10:00:00Z'));
    ledger.record('||ads.example^', 3, date('2026-09-01T10:00:01Z'));

    const sessions = ledger.sessionsForExport(date('2026-09-01T10:00:02Z'));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].hits).toEqual([{ rule: '||ads.example^', count: 5 }]);
    expect(sessions[0].startedAt).toBe('2026-09-01T09:00:00.000Z');
  });

  test("closes a tally from an earlier day at the end of that day, and keeps it", async () => {
    installChrome({
      [HIT_LEDGER_TALLY_STORAGE_KEY]: tally({
        day: '2026-08-30',
        startedAt: '2026-08-30T09:00:00.000Z',
        feed: 'polled',
        hits: { '||old.example^': 4 },
      }),
    });
    const ledger = new LedgerSessionRecorder();

    await ledger.load(date('2026-09-05T12:00:00Z'));

    const sessions = ledger.sessionsForExport(date('2026-09-05T12:00:01Z'));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].startedAt).toBe('2026-08-30T09:00:00.000Z');
    // Dated to its own day, not to the moment the worker happened to notice.
    expect(sessions[0].endedAt).toBe('2026-08-30T23:59:59.999Z');
    expect(sessions[0].feed).toBe('polled');

    // And the closed session is what gets persisted, with no open tally left behind.
    await ledger.flush();
  });

  test('restores stored sessions and appends today to them', async () => {
    installChrome({ [HIT_LEDGER_STORAGE_KEY]: [report()] });
    const ledger = new LedgerSessionRecorder();

    await ledger.load(date('2026-09-01T10:00:00Z'));
    ledger.record('||today.example^', 1, date('2026-09-01T10:00:01Z'));

    const sessions = ledger.sessionsForExport(date('2026-09-01T10:00:02Z'));
    expect(sessions).toHaveLength(2);
    expect(sessions[0].hits).toEqual([{ rule: '||ads.example^', count: 2 }]);
    expect(sessions[1].hits).toEqual([{ rule: '||today.example^', count: 1 }]);
  });

  test('survives a storage read failure without throwing', async () => {
    installChrome();
    (globalThis as any).chrome.storage.local.get.mockRejectedValueOnce(new Error('nope'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ledger = new LedgerSessionRecorder();

    try {
      await expect(ledger.load(date('2026-09-01T09:00:00Z'))).resolves.toBeUndefined();
      expect(ledger.exportPayload(date('2026-09-01T09:00:00Z')).sessions).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The tier axis through the recorder, which is where it has to survive the two things a service
   * worker does to it: a teardown between the match and the write, and a session that was already on
   * disk before the axis existed.
   */
  test('records the tier that shipped the rule, and merges it into the export payload', () => {
    installChrome();
    const ledger = new LedgerSessionRecorder();

    ledger.record('||ads.example^', 2, date('2026-09-01T09:00:00Z'), { tier: 'tier_ads' });
    ledger.record('||shared.example^', 1, date('2026-09-01T09:01:00Z'), { tier: 'tier_ads' });
    // The same filter in a second tier, and a block from the synced list that names no tier.
    ledger.record('||shared.example^', 1, date('2026-09-01T09:02:00Z'), { tier: 'tier_privacy' });
    ledger.record('||synced.example^', 4, date('2026-09-01T09:03:00Z'));

    const payload = ledger.exportPayload(date('2026-09-01T09:04:00Z'));
    expect(payload.tiers).toEqual([
      { tier: 'tier_ads', count: 3 },
      { tier: 'tier_privacy', count: 1 },
    ]);
    expect(payload.tierUnattributed).toBe(4);
    expect(payload.tieredSessions).toBe(1);
    expect(payload.sessions).toBe(1);

    // The card and the file are the same numbers, not two readings of it.
    const sessions = JSON.parse(payload.json).sessions;
    expect(sessions[0].tiers).toEqual(payload.tiers);
  });

  test('sums what the per-session caps evicted, so the card can say the file lost evidence', async () => {
    // Each session already reports its own `rulesDropped`; the payload's job is the aggregate,
    // because "the file saw all of your traffic" is only true when the sum is zero.
    installChrome({
      [HIT_LEDGER_STORAGE_KEY]: [
        report({ startedAt: '2026-08-30T09:00:00.000Z', rulesDropped: 3 }),
        report({ startedAt: '2026-08-31T09:00:00.000Z', rulesDropped: 2 }),
        report({ startedAt: '2026-08-29T09:00:00.000Z' }),
      ],
    });
    const ledger = new LedgerSessionRecorder();
    await ledger.load(date('2026-09-01T09:00:00Z'));

    expect(ledger.exportPayload(date('2026-09-01T09:01:00Z')).rulesDropped).toBe(5);
  });

  test('a tally persisted with the tier axis resumes with it intact', async () => {
    // The failure this guards is silent in the worst way: a worker restart that dropped the tier axis
    // would still report every rule and every session, and only the plan's weighting would be wrong.
    const stub = installChrome({
      [HIT_LEDGER_TALLY_STORAGE_KEY]: tally({
        hits: { '||ads.example^': 2 },
        tierHits: { tier_ads: 2, tier_invented: 50 },
        tierUnattributed: 1,
      }),
    });
    const ledger = new LedgerSessionRecorder();

    await ledger.load(date('2026-09-01T10:00:00Z'));
    ledger.record('||ads.example^', 1, date('2026-09-01T10:00:01Z'), { tier: 'tier_ads' });

    const sessions = ledger.sessionsForExport(date('2026-09-01T10:00:02Z'));
    expect(sessions[0].tiers).toEqual([{ tier: 'tier_ads', count: 3 }]);
    expect(sessions[0].tierUnattributed).toBe(1);

    // And it is written back out, so the next restart reads the same thing. The tally is still open,
    // so this is the active key rather than the closed-session list.
    await ledger.flush();
    expect(stub.store.get(HIT_LEDGER_TALLY_STORAGE_KEY)).toMatchObject({
      tierHits: { tier_ads: 3 },
      tierUnattributed: 1,
    });
  });

  test('a tally stored before the tier axis resumes unchanged, with no split claimed', async () => {
    installChrome({
      [HIT_LEDGER_TALLY_STORAGE_KEY]: {
        day: '2026-09-01',
        startedAt: '2026-09-01T09:00:00.000Z',
        feed: 'live',
        hits: { '||ads.example^': 2 },
        exceptions: {},
        unattributed: 0,
      },
    });
    const ledger = new LedgerSessionRecorder();

    await ledger.load(date('2026-09-01T10:00:00Z'));
    ledger.record('||today.example^', 1, date('2026-09-01T10:00:01Z'), { tier: 'tier_core' });

    const sessions = ledger.sessionsForExport(date('2026-09-01T10:00:02Z'));
    // Absent, not empty: the session was not measured per tier, and `tiers: []` would claim it was
    // and that every tier blocked nothing.
    expect(sessions[0].tiers).toEqual([{ tier: 'tier_core', count: 1 }]);
    expect(sessions[0].hits).toEqual([
      { rule: '||ads.example^', count: 2 },
      { rule: '||today.example^', count: 1 },
    ]);
  });

  test('merges the stored tally into hits recorded while load was in flight', async () => {
    // A worker can record before its startup load resolves — assigning the stored tally over
    // the live one would silently lose those hits. The stored hits are replayed into the tally
    // the live records already opened.
    installChrome({
      [HIT_LEDGER_TALLY_STORAGE_KEY]: tally({ hits: { '||stored.example^': 2 } }),
    });
    const ledger = new LedgerSessionRecorder();
    ledger.record('||inflight.example^', 1, date('2026-09-01T09:30:00Z'));

    await ledger.load(date('2026-09-01T10:00:00Z'));

    const sessions = ledger.sessionsForExport(date('2026-09-01T10:00:01Z'));
    expect(sessions[0].hits).toEqual([
      { rule: '||stored.example^', count: 2 },
      { rule: '||inflight.example^', count: 1 },
    ]);
  });

  test('a tally stored with an unrecognised feed resumes as unknown, not dropped', async () => {
    // Same coercion the session normaliser makes: a corrupt feed names the reporting path
    // wrong, but the day's hits are still the day's hits.
    installChrome({
      [HIT_LEDGER_TALLY_STORAGE_KEY]: tally({ feed: 'garbage' as never, hits: { '||a.example^': 3 } }),
    });
    const ledger = new LedgerSessionRecorder();
    await ledger.load(date('2026-09-01T10:00:00Z'));
    expect(ledger.sessionsForExport(date('2026-09-01T10:00:01Z'))[0].feed).toBe('unknown');
  });
});

describe('normalizeStoredTally', () => {
  test('accepts a well-formed tally', () => {
    expect(
      normalizeStoredTally(tally({ hits: { '||a.example^': 3 }, exceptions: { '@@||b.example^': true }, unattributed: 2 })),
    ).toMatchObject({ day: '2026-09-01', unattributed: 2 });
  });

  test('refuses a tally whose day disagrees with its start time', () => {
    // The day is what durability is counted on, so a pair that disagrees cannot be trusted to mean
    // either one.
    expect(normalizeStoredTally(tally({ day: '2026-09-02' }))).toBeNull();
  });

  test('refuses junk, bad dates and an empty tally', () => {
    expect(normalizeStoredTally(null)).toBeNull();
    expect(normalizeStoredTally('nope')).toBeNull();
    expect(normalizeStoredTally([])).toBeNull();
    expect(normalizeStoredTally({ day: '2026-09-01', startedAt: 'not-a-date' })).toBeNull();
    expect(normalizeStoredTally({ day: '2026-09-01', startedAt: '2026-09-01T00:00:00Z', feed: 'live', hits: {}, exceptions: {}, unattributed: 0 })).toBeNull();
  });

  test('drops unusable hit entries but keeps the tally', () => {
    const normalized = normalizeStoredTally(
      tally({ hits: { '||ok.example^': 2, '': 5, '||zero.example^': 0, '||bad.example^': 'lots' } as never }),
    );
    expect(normalized?.hits).toEqual({ '||ok.example^': 2 });
  });

  test('keeps a tally whose only content is a tier split', () => {
    // Every match was unnamed and every one named a tier, so the block axis is empty. Returning null
    // here would drop the file that the tier plan's evidence lives in.
    const normalized = normalizeStoredTally(
      tally({ hits: {}, tierHits: { tier_core: 12 } }),
    );
    expect(normalized?.tierHits).toEqual({ tier_core: 12 });
  });

  test('refuses a tier id the catalogue does not know, without losing the tally', () => {
    const normalized = normalizeStoredTally(
      tally({
        hits: { '||ads.example^': 1 },
        tierHits: { tier_ads: 1, tier_invented: 99, '': 5 } as never,
      }),
    );
    // A weight key nobody recognises could not be weighed, and a row for it would look measured.
    expect(normalized?.tierHits).toEqual({ tier_ads: 1 });
  });
});

describe('normalizeStoredSessions', () => {
  test('drops unusable sessions and hit rows instead of letting them through', () => {
    const sessions = normalizeStoredSessions([
      report(),
      { startedAt: 'not-a-date', hits: [] },
      { hits: [{ rule: '||x.example^', count: 1 }] },
      'nonsense',
      null,
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].hits).toEqual([{ rule: '||ads.example^', count: 2 }]);
  });

  test('keeps only the newest sessions when the stored list is over the cap', () => {
    const many: LedgerSessionReport[] = [];
    const base = Date.UTC(2026, 7, 1, 9, 0, 0);
    for (let day = 0; day < 60; day += 1) {
      many.push(report({ startedAt: new Date(base + day * 86_400_000).toISOString() }));
    }
    const sessions = normalizeStoredSessions(many);
    expect(sessions.length).toBeLessThan(many.length);
    expect(sessions[sessions.length - 1].startedAt).toBe(many[many.length - 1].startedAt);
  });

  test('an unknown feed is unknown, never guessed to be live', () => {
    const sessions = normalizeStoredSessions([report({ feed: 'garbage' as never })]);
    expect(sessions[0].feed).toBe('unknown');
  });

  test('reads a stored tier split and leaves a session without one absent', () => {
    const sessions = normalizeStoredSessions([
      report({ tiers: [{ tier: 'tier_ads', count: 3 }], tierUnattributed: 2 }),
      report({ startedAt: '2026-09-02T09:00:00.000Z' }),
    ]);
    expect(sessions[0].tiers).toEqual([{ tier: 'tier_ads', count: 3 }]);
    expect(sessions[0].tierUnattributed).toBe(2);
    // A session from before the axis is a session with no measurement, not one that measured zero.
    expect(sessions[1].tiers).toBeUndefined();
    expect(sessions[1].tierUnattributed).toBeUndefined();
  });

  test('drops a stored tier entry with an unknown id or an unusable count', () => {
    const sessions = normalizeStoredSessions([
      report({
        tiers: [
          { tier: 'tier_ads', count: 4 },
          { tier: 'tier_invented', count: 100 },
          { tier: 'tier_core', count: 0 },
          { tier: '', count: 7 },
        ] as never,
      }),
    ]);
    expect(sessions[0].tiers).toEqual([{ tier: 'tier_ads', count: 4 }]);
  });
});
