/**
 * The extension's session tally, before it becomes a ledger.
 *
 * The two rules with teeth: a session that crosses midnight has to split, because durability is
 * measured in distinct days and one date for two days of hits understates the evidence; and an
 * unnamed match is counted rather than guessed at, because a fabricated rule in this file becomes a
 * fabricated entry in the hot set.
 */

import { describe, expect, it } from '@jest/globals';
import {
  HIT_LEDGER_MAX_SESSIONS,
  appendLedgerSession,
  finalizeLedgerSession,
  isNewLedgerDay,
  ledgerDayOf,
  ledgerExportFilename,
  recordLedgerHit,
  startLedgerSession,
  summarizeLedgerSessions,
  toLedgerExportJson,
  type LedgerSessionReport,
} from '../shared/ledgerExport.js';

const date = (iso: string) => new Date(iso);

describe('session tally', () => {
  it('counts repeated matches of the same rule', () => {
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    for (let i = 0; i < 3; i += 1) tally = recordLedgerHit(tally, '||ads.example^', i).tally;

    expect(finalizeLedgerSession(tally, date('2026-09-01T09:05:00Z'))?.hits).toEqual([
      { rule: '||ads.example^', count: 3 },
    ]);
  });

  it('keeps a firing exception off the block axis', () => {
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    tally = recordLedgerHit(tally, '||ads.example^', 0).tally;
    tally = recordLedgerHit(tally, '@@||allowed.example^', 0).tally;

    const report = finalizeLedgerSession(tally, date('2026-09-01T09:05:00Z'));
    expect(report?.hits).toEqual([{ rule: '||ads.example^', count: 1 }]);
    expect(report?.exceptions).toEqual(['@@||allowed.example^']);
  });

  it('counts an unnamed match instead of inventing a rule', () => {
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'polled');
    for (const rule of [null, '', '   ', '||named.example^']) {
      tally = recordLedgerHit(tally, rule, 0).tally;
    }

    const report = finalizeLedgerSession(tally, date('2026-09-01T09:05:00Z'));
    // Three matches could not be named; only one could. Guessing would put a fabricated rule into
    // the file the hot set is built from.
    expect(report?.unattributed).toBe(3);
    expect(report?.hits).toEqual([{ rule: '||named.example^', count: 1 }]);
  });

  it('rolls the day over, so a session spanning midnight becomes two', () => {
    const tally = startLedgerSession(date('2026-09-01T23:50:00Z'), 'live');

    expect(isNewLedgerDay(tally, date('2026-09-01T23:59:00Z'))).toBe(false);
    expect(isNewLedgerDay(tally, date('2026-09-02T00:05:00Z'))).toBe(true);
    expect(tally.startedAt).toBe('2026-09-01T23:50:00.000Z');
  });

  it('reports nothing for a session that saw nothing', () => {
    const tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    expect(finalizeLedgerSession(tally, date('2026-09-01T09:05:00Z'))).toBeNull();
  });

  it('keeps the most-fired rules when a session hits the cap', () => {
    // Distinct counts on purpose: the property under test is "the tail is evicted, the head is not",
    // and asserting a particular winner between two equally-fired rules would pin a tie-break
    // instead. The tie-break is deterministic (fewest hits, then rule text) but it is not the point.
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    for (let i = 0; i < 3; i += 1) {
      tally = recordLedgerHit(tally, '||big.example^', 0, { maxRules: 2 }).tally;
    }
    for (let i = 0; i < 2; i += 1) {
      tally = recordLedgerHit(tally, '||mid.example^', 0, { maxRules: 2 }).tally;
    }
    const capped = recordLedgerHit(tally, '||small.example^', 0, { maxRules: 2 });

    expect(capped.dropped).toBe(1);
    expect(capped.atCap).toBe(true);
    expect(Object.keys(capped.tally.hits).sort()).toEqual(['||big.example^', '||mid.example^']);

    // And the eviction is reproducible: same input, same survivors.
    expect(
      Object.keys(recordLedgerHit(tally, '||small.example^', 0, { maxRules: 2 }).tally.hits).sort(),
    ).toEqual(['||big.example^', '||mid.example^']);
  });
});

describe('stored sessions', () => {
  const report = (overrides: Partial<LedgerSessionReport> = {}): LedgerSessionReport => ({
    startedAt: '2026-09-01T09:00:00.000Z',
    feed: 'live',
    hits: [{ rule: '||ads.example^', count: 2 }],
    ...overrides,
  });

  it('appends in order and drops the oldest past the cap', () => {
    let stored: LedgerSessionReport[] = [];
    for (let day = 1; day <= 4; day += 1) {
      stored = appendLedgerSession(
        stored,
        report({ startedAt: `2026-09-0${day}T09:00:00.000Z` }),
        { maxSessions: 3 },
      );
    }

    expect(stored.map((entry) => entry.startedAt.slice(8, 10))).toEqual(['02', '03', '04']);
    expect(HIT_LEDGER_MAX_SESSIONS).toBeGreaterThan(3);
  });

  it('exports the shape the merge tool reads', () => {
    const json = toLedgerExportJson([report()]);
    const parsed = JSON.parse(json) as { sessions: LedgerSessionReport[] };

    expect(parsed.sessions).toHaveLength(1);
    // The merge reads `{ sessions: [...] }` and validates each session's date and hits.
    expect(parsed.sessions[0]?.startedAt).toBe('2026-09-01T09:00:00.000Z');
    expect(parsed.sessions[0]?.hits).toEqual([{ rule: '||ads.example^', count: 2 }]);
  });

  it('dates the export file so several of them sort', () => {
    expect(ledgerExportFilename(date('2026-09-29T23:00:00Z'))).toBe(
      'blockingmachine-hit-ledger-2026-09-29.json',
    );
    expect(ledgerDayOf(date('2026-09-29T23:00:00Z'))).toBe('2026-09-29');
  });

  it('summarizes what the stored sessions add up to', () => {
    const line = summarizeLedgerSessions([
      report({ hits: [{ rule: '||ads.example^', count: 2 }], unattributed: 4 }),
      report({ startedAt: '2026-09-02T09:00:00.000Z', hits: [{ rule: '||ads.example^', count: 1 }] }),
    ]);

    expect(line).toContain('2 sessions');
    expect(line).toContain('2 days');
    expect(line).toContain('3 hits on 1 rules');
    expect(line).toContain('4 unattributable');

    expect(summarizeLedgerSessions([])).toBe('No sessions recorded yet');
  });
});
