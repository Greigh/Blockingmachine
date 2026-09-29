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
});
