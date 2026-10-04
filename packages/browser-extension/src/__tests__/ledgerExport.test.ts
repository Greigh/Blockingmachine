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
  LEDGER_EXPORT_VERSION,
  appendLedgerSession,
  finalizeLedgerSession,
  isNewLedgerDay,
  ledgerDayOf,
  ledgerExportFilename,
  mergeSessionTiers,
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

  it('adds a whole batch in one call, which is what a polled match reports', () => {
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'polled');
    // `getMatchedRules` reports how many times one rule matched in one tab, so the recorder adds a
    // batch at once rather than looping — which matters at the cap, where every call re-sorts.
    tally = recordLedgerHit(tally, '||ads.example^', 0, { amount: 40 }).tally;
    tally = recordLedgerHit(tally, '||ads.example^', 0, { amount: 2 }).tally;

    const report = finalizeLedgerSession(tally, date('2026-09-01T09:05:00Z'));
    expect(report?.hits).toEqual([{ rule: '||ads.example^', count: 42 }]);
  });

  it('counts a whole unattributed batch, and treats a bad amount as one match', () => {
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    tally = recordLedgerHit(tally, null, 0, { amount: 5 }).tally;
    tally = recordLedgerHit(tally, '||ads.example^', 0, { amount: 0 }).tally;

    const report = finalizeLedgerSession(tally, date('2026-09-01T09:05:00Z'));
    expect(report?.unattributed).toBe(5);
    // An amount of zero is not a way to record nothing quietly; it falls back to one match.
    expect(report?.hits).toEqual([{ rule: '||ads.example^', count: 1 }]);
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

  it('carries what the cap evicted onto the session, so the export says the tail went missing', () => {
    // `dropped` is the per-call answer; `rulesDropped` is the running total the report carries —
    // a capped session that printed no sign of it would read as a day with less traffic.
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    tally = recordLedgerHit(tally, '||big.example^', 0, { maxRules: 1, amount: 5 }).tally;
    tally = recordLedgerHit(tally, '||small.example^', 0, { maxRules: 1 }).tally;
    tally = recordLedgerHit(tally, '||smaller.example^', 0, { maxRules: 1 }).tally;

    expect(tally.rulesDropped).toBe(2);
    const report = finalizeLedgerSession(tally, date('2026-09-01T20:00:00Z'));
    expect(report?.rulesDropped).toBe(2);
  });
});

/**
 * The tier axis: which shipped ruleset blocked, which is the number the tier plan is weighted by and
 * which the filter text cannot supply. Three properties, each of which a plausible implementation gets
 * wrong — a tier credited from the rule text, an exception credited to a tier, and a match from the
 * synced list quietly disappearing from the split.
 */
describe('per-tier tally', () => {
  it('credits a tier whenever the browser named one, even with no filter resolved', () => {
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    // The rule files could not be read, so no filter text exists. The ruleset still did not lie
    // about which tier matched, and a plan weighted by that would be wrong to call it unmeasured.
    tally = recordLedgerHit(tally, null, 0, { tier: 'tier_ads' }).tally;
    tally = recordLedgerHit(tally, null, 0, { tier: 'tier_ads' }).tally;
    tally = recordLedgerHit(tally, '||tracker.example^', 0, { tier: 'tier_privacy' }).tally;

    const report = finalizeLedgerSession(tally, date('2026-09-01T09:05:00Z'));
    expect(report?.tiers).toEqual([
      { tier: 'tier_ads', count: 2 },
      { tier: 'tier_privacy', count: 1 },
    ]);
    // One axis cannot be read off the other: the filter axis holds one rule for three blocks.
    expect(report?.hits).toEqual([{ rule: '||tracker.example^', count: 1 }]);
    expect(report?.unattributed).toBe(2);
  });

  it('counts one filter in two tiers, which is the case the split exists for', () => {
    // The same urlFilter shipping in both tiers is one entry in `hits` and two in `tiers`. A tier
    // axis derived from the filter text would report one block and understate the other tier.
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    tally = recordLedgerHit(tally, '||shared.example^', 0, { tier: 'tier_core' }).tally;
    tally = recordLedgerHit(tally, '||shared.example^', 0, { tier: 'tier_privacy' }).tally;

    const report = finalizeLedgerSession(tally, date('2026-09-01T09:05:00Z'));
    expect(report?.hits).toEqual([{ rule: '||shared.example^', count: 2 }]);
    expect(report?.tiers).toEqual([
      { tier: 'tier_core', count: 1 },
      { tier: 'tier_privacy', count: 1 },
    ]);
  });

  it('credits no tier for an exception, because an exception blocked nothing', () => {
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    tally = recordLedgerHit(tally, '@@||allowed.example^', 0, { tier: 'tier_ads' }).tally;

    const report = finalizeLedgerSession(tally, date('2026-09-01T09:05:00Z'));
    // The rule *allowed* the request. Ranking a tier by the traffic it let through is the exact
    // inversion the block/exception split exists to prevent, one level up.
    expect(report?.exceptions).toEqual(['@@||allowed.example^']);
    expect(report?.tiers).toBeUndefined();
  });

  it('counts a block from the synced list as tier-unattributed rather than dropping it', () => {
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    tally = recordLedgerHit(tally, '||synced.example^', 0, { amount: 3 }).tally;
    tally = recordLedgerHit(tally, '||ads.example^', 0, { tier: 'tier_ads', amount: 2 }).tally;

    const report = finalizeLedgerSession(tally, date('2026-09-01T09:05:00Z'));
    expect(report?.tierUnattributed).toBe(3);
    // The check a reader can make: tier totals plus the unattributed count are the session's blocks.
    const tierTotal = (report?.tiers ?? []).reduce((sum, tier) => sum + tier.count, 0);
    const blockTotal = (report?.hits ?? []).reduce((sum, hit) => sum + hit.count, 0);
    expect(tierTotal + (report?.tierUnattributed ?? 0)).toBe(blockTotal);
  });

  it('refuses a tier id the catalogue does not know, and says so in the unattributed count', () => {
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    // These are the weightings a plan is keyed on, so an id nobody recognises could not be weighed
    // — and storing it would put a row in the table that looks measured.
    for (const tier of ['tier_invented', '', 'CORE', 42, undefined]) {
      tally = recordLedgerHit(tally, '||a.example^', 0, { tier: tier as string | undefined }).tally;
    }

    const report = finalizeLedgerSession(tally, date('2026-09-01T09:05:00Z'));
    expect(report?.tiers).toBeUndefined();
    expect(report?.tierUnattributed).toBe(5);
  });

  it('writes a session whose only content is a tier split', () => {
    // Every match was unnamed and every one named a tier. The block axis is empty and the tier axis
    // is whole, and the consumer of the tier axis is exactly who needs that file.
    let tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    tally = recordLedgerHit(tally, null, 0, { tier: 'tier_core' }).tally;

    const report = finalizeLedgerSession(tally, date('2026-09-01T09:05:00Z'));
    expect(report?.hits).toEqual([]);
    expect(report?.tiers).toEqual([{ tier: 'tier_core', count: 1 }]);
  });

  it('leaves the tier list absent rather than empty, so a measurement is not implied', () => {
    const tally = startLedgerSession(date('2026-09-01T09:00:00Z'), 'live');
    const report = finalizeLedgerSession(
      recordLedgerHit(tally, '||ads.example^', 0).tally,
      date('2026-09-01T09:05:00Z'),
    );
    // `tiers: []` would claim the session was measured and every tier blocked nothing. The block
    // itself is not hidden, though: no tier named it, so it is counted where a reader will see it.
    expect(report?.tiers).toBeUndefined();
    expect(report?.tierUnattributed).toBe(1);
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
    const parsed = JSON.parse(json) as { version: number; sessions: LedgerSessionReport[] };

    expect(parsed.sessions).toHaveLength(1);
    // The merge reads `{ sessions: [...] }` and validates each session's date and hits.
    expect(parsed.sessions[0]?.startedAt).toBe('2026-09-01T09:00:00.000Z');
    expect(parsed.sessions[0]?.hits).toEqual([{ rule: '||ads.example^', count: 2 }]);
    // 2 is the shape that carries the tier axis. A reader can tell which it is holding without
    // inspecting a session, and a version 1 file is still valid input either way.
    expect(parsed.version).toBe(LEDGER_EXPORT_VERSION);
    expect(LEDGER_EXPORT_VERSION).toBe(2);
  });

  it('carries the tier split inside the exported file, not beside it', () => {
    const json = toLedgerExportJson([
      report({ tiers: [{ tier: 'tier_ads', count: 2 }], tierUnattributed: 5 }),
    ]);
    const parsed = JSON.parse(json) as { sessions: LedgerSessionReport[] };

    // The whole point of the change: a measured plan can be re-derived from the file, so the tiers
    // have to be in the file the merge reads rather than in a sidecar nobody is sent.
    expect(parsed.sessions[0]?.tiers).toEqual([{ tier: 'tier_ads', count: 2 }]);
    expect(parsed.sessions[0]?.tierUnattributed).toBe(5);
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

  it('says how much of a file carries a tier split', () => {
    // One session of two was exported before the axis existed. "1 tier" next to "2 sessions" would
    // read as though the whole file had been measured, and the plan would be weighted on half of it.
    const line = summarizeLedgerSessions([
      report({ tiers: [{ tier: 'tier_ads', count: 9 }] }),
      report({ startedAt: '2026-09-02T09:00:00.000Z' }),
    ]);

    expect(line).toContain('1 tiers (1 of 2 sessions)');
    expect(
      summarizeLedgerSessions([report({ tiers: [{ tier: 'tier_ads', count: 1 }] })]),
    ).toContain('1 tiers');
  });
});

describe('mergeSessionTiers', () => {
  const session = (overrides: Partial<LedgerSessionReport> = {}): LedgerSessionReport => ({
    startedAt: '2026-09-01T09:00:00.000Z',
    feed: 'live',
    hits: [],
    ...overrides,
  });

  it('sums the axis across sessions and counts the coverage', () => {
    const split = mergeSessionTiers([
      session({ tiers: [{ tier: 'tier_ads', count: 5 }] }),
      session({ startedAt: '2026-09-02T09:00:00.000Z', tiers: [{ tier: 'tier_ads', count: 3 }] }),
      session({ startedAt: '2026-09-03T09:00:00.000Z' }),
    ]);

    expect(split.tiers).toEqual([{ tier: 'tier_ads', count: 8 }]);
    expect(split.sessions).toBe(2);
  });

  it('refuses an unrecognised tier and a non-positive count rather than summing them', () => {
    const split = mergeSessionTiers([
      session({
        tiers: [
          { tier: 'tier_invented', count: 100 },
          { tier: 'tier_ads', count: -4 },
          { tier: 'tier_core', count: 2 },
        ],
      }),
    ]);

    expect(split.tiers).toEqual([{ tier: 'tier_core', count: 2 }]);
  });
});
