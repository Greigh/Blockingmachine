/**
 * Browser-ledger aggregation tests.
 *
 * The properties worth pinning are the ones a plausible implementation gets wrong: that a busy
 * afternoon cannot outrank a rule that fires every day, that an exception never lands on the block
 * axis, and that merging the same sessions in a different order produces the same file — the last
 * one because the hot list is diff-checked, so an order-dependent build fails on a machine that read
 * its input differently.
 */

import { describe, expect, it } from '@jest/globals';

import {
  ledgerDateOf,
  mergeBrowserLedger,
  normalizeLedgerRule,
  parseHitLedgerText,
  readBrowserLedgerSessions,
  readLedgerTierTally,
  summarizeBrowserLedger,
  toHitLedgerText,
  type BrowserLedgerSession,
} from '../ledgerAggregate.js';

const session = (overrides: Partial<BrowserLedgerSession> = {}): BrowserLedgerSession => ({
  startedAt: '2026-09-01T10:00:00.000Z',
  feed: 'live',
  hits: [],
  ...overrides,
});

describe('ledgerDateOf', () => {
  it('reads the UTC date from an ISO timestamp', () => {
    expect(ledgerDateOf('2026-09-01T23:59:59.999Z')).toBe('2026-09-01');
  });

  it('refuses anything that is not a date', () => {
    for (const value of ['', 'yesterday', '2026-13-01', '2026-09-32', 42, null, undefined, {}]) {
      expect(ledgerDateOf(value)).toBeNull();
    }
  });
});

describe('normalizeLedgerRule', () => {
  it('trims and strips a byte-order mark', () => {
    expect(normalizeLedgerRule('\uFEFF  ||ads.example^  ')).toBe('||ads.example^');
  });

  it('refuses anything that would corrupt the file', () => {
    // A newline creates a second entry the parser would believe; a leading `#` or `!` turns the rule
    // into a comment; empty is not a rule. All four are silent corruption rather than loud errors.
    expect(normalizeLedgerRule('||ads.example^\n||second.example^')).toBeNull();
    expect(normalizeLedgerRule('# ||ads.example^')).toBeNull();
    expect(normalizeLedgerRule('! comment')).toBeNull();
    expect(normalizeLedgerRule('   ')).toBeNull();
    expect(normalizeLedgerRule(7)).toBeNull();
  });
});

describe('readBrowserLedgerSessions', () => {
  it('counts unusable sessions instead of dropping them silently', () => {
    const { sessions, rejected } = readBrowserLedgerSessions([
      { startedAt: 'not-a-date', hits: [{ rule: 'a', count: 1 }] },
      null,
      'nonsense',
      { hits: [{ rule: 'a', count: 1 }] },
      session({ hits: [{ rule: '||ads.example^', count: 3 }] }),
    ]);

    expect(sessions).toHaveLength(1);
    // A merge that quietly skipped half its input would report a duration it did not have.
    expect(rejected).toBe(4);
  });

  it('drops hits that are not usable rather than repairing them', () => {
    const { sessions } = readBrowserLedgerSessions([
      session({
        hits: [
          { rule: '||ok.example^', count: 2 },
          { rule: '||zero.example^', count: 0 },
          { rule: '||negative.example^', count: -5 },
          { rule: '||nan.example^', count: Number.NaN },
          { rule: '', count: 9 },
        ],
      }),
    ]);

    expect(sessions[0]?.hits).toEqual([{ rule: '||ok.example^', count: 2 }]);
  });

  it('accepts a bare array or a { sessions } wrapper', () => {
    const inner = [session({ hits: [{ rule: '||a.example^', count: 1 }] })];
    expect(readBrowserLedgerSessions(inner).sessions).toHaveLength(1);
    expect(readBrowserLedgerSessions({ sessions: inner }).sessions).toHaveLength(1);
    expect(readBrowserLedgerSessions({ nope: true }).sessions).toHaveLength(0);
  });
});

describe('mergeBrowserLedger', () => {
  it('counts days, not hits, so one busy afternoon cannot outrank a daily rule', () => {
    const spree = session({
      startedAt: '2026-09-01T09:00:00.000Z',
      hits: [{ rule: '||spree.example^', count: 5000 }],
    });
    const daily = [2, 3, 4, 5, 6].map((day) =>
      session({
        startedAt: `2026-09-0${day}T09:00:00.000Z`,
        hits: [{ rule: '||daily.example^', count: 3 }],
      }),
    );

    const aggregate = mergeBrowserLedger([spree, ...daily]);
    const byRule = new Map(aggregate.rules.map((rule) => [rule.rule, rule]));

    expect(byRule.get('||spree.example^')).toMatchObject({ count: 5000, sessions: 1 });
    expect(byRule.get('||spree.example^')?.days).toEqual(['2026-09-01']);
    expect(byRule.get('||daily.example^')).toMatchObject({ count: 15, sessions: 5 });
    expect(byRule.get('||daily.example^')?.days).toHaveLength(5);

    // The selection is the caller's, but the evidence for it has to exist.
    expect(aggregate.rules.map((rule) => rule.rule)).toEqual([
      '||spree.example^',
      '||daily.example^',
    ]);
    expect(mergeBrowserLedger([spree, ...daily], { minDays: 3 }).rules.map((r) => r.rule)).toEqual([
      '||daily.example^',
    ]);
  });

  it('counts a session once per rule, and a day once however many sessions it holds', () => {
    const sameDay = [1, 2, 3].map((hour) =>
      session({
        startedAt: `2026-09-01T0${hour}:00:00.000Z`,
        hits: [{ rule: '||repeat.example^', count: 4 }],
      }),
    );

    const aggregate = mergeBrowserLedger(sameDay);
    expect(aggregate.sessions).toBe(3);
    expect(aggregate.days).toEqual(['2026-09-01']);
    expect(aggregate.rules[0]).toMatchObject({ count: 12, sessions: 3 });
    // Three sessions in one day is one day of evidence, which is the whole point of the split.
    expect(aggregate.rules[0]?.days).toEqual(['2026-09-01']);
  });

  it('is order-independent', () => {
    const sessions = [
      session({ startedAt: '2026-09-03T09:00:00.000Z', hits: [{ rule: '||b.example^', count: 2 }] }),
      session({ startedAt: '2026-09-01T09:00:00.000Z', hits: [{ rule: '||a.example^', count: 2 }] }),
      session({
        startedAt: '2026-09-02T09:00:00.000Z',
        hits: [
          { rule: '||a.example^', count: 1 },
          { rule: '||c.example^', count: 9 },
        ],
      }),
    ];

    const forward = toHitLedgerText(mergeBrowserLedger(sessions));
    const reversed = toHitLedgerText(mergeBrowserLedger([...sessions].reverse()));
    expect(reversed).toBe(forward);
  });

  it('never puts a firing exception on the blocking axis', () => {
    const aggregate = mergeBrowserLedger([
      session({
        hits: [
          { rule: '||ads.example^', count: 10 },
          // A `@@` rule that reached the hits array is an exception that fired; counting it as a
          // block would invert the rule's meaning.
          { rule: '@@||allowed.example^', count: 7 },
        ],
        exceptions: ['||legacy-allowed.example^'],
      }),
    ]);

    expect(aggregate.rules.map((rule) => rule.rule)).toEqual(['||ads.example^']);
    expect(aggregate.exceptions.map((rule) => rule.rule).sort()).toEqual([
      '@@||allowed.example^',
      '@@||legacy-allowed.example^',
    ]);
  });

  it('caps rules, and the cap keeps the most-fired', () => {
    const aggregate = mergeBrowserLedger(
      [
        session({
          startedAt: '2026-09-01T09:00:00.000Z',
          hits: [
            { rule: '||small.example^', count: 1 },
            { rule: '||big.example^', count: 100 },
            { rule: '||mid.example^', count: 50 },
          ],
        }),
      ],
      { maxRules: 2 },
    );

    expect(aggregate.rules.map((rule) => rule.rule)).toEqual(['||big.example^', '||mid.example^']);
  });

  it('survives junk it was never promised it would not get', () => {
    const aggregate = mergeBrowserLedger([
      null as never,
      session({ startedAt: 'not-a-date', hits: [{ rule: '||a.example^', count: 4 }] }),
      session({ hits: null as never }),
    ]);

    // The undated session cannot contribute: a hit that cannot be dated can neither prove nor
    // disprove durability, and counting it would make the day total a guess.
    expect(aggregate.sessions).toBe(1);
    expect(aggregate.rules).toHaveLength(0);
    expect(summarizeBrowserLedger(aggregate)).toContain('1 session');
  });
});

describe('hit-ledger text', () => {
  it('round-trips through the format the build reads', () => {
    const aggregate = mergeBrowserLedger([
      session({
        startedAt: '2026-09-01T09:00:00.000Z',
        hits: [
          { rule: '||ads.example^', count: 12 },
          { rule: '||track.example^', count: 30 },
        ],
        exceptions: ['||allowed.example^'],
      }),
      session({
        startedAt: '2026-09-05T09:00:00.000Z',
        hits: [{ rule: '||ads.example^', count: 8 }],
      }),
    ]);

    const text = toHitLedgerText(aggregate, { source: 'popup export' });
    const parsed = parseHitLedgerText(text);

    expect(parsed.hits).toEqual([
      { rule: '||track.example^', count: 30 },
      { rule: '||ads.example^', count: 20 },
    ]);
    expect(parsed.exceptions).toEqual(['@@||allowed.example^']);
    // Provenance travels with the numbers rather than living in a commit message.
    expect(parsed.header.sessions).toBe('2');
    expect(parsed.header.days).toBe('2');
    expect(parsed.header['first seen']).toBe('2026-09-01');
    expect(parsed.header['last seen']).toBe('2026-09-05');
  });

  it('reads `rule count` as well as `count rule`', () => {
    const parsed = parseHitLedgerText(
      ['# a comment', '10 ||leading.example^', '||trailing.example^ 4', '@@||allow.example^', ''].join(
        '\n',
      ),
    );

    expect(parsed.hits).toEqual([
      { rule: '||leading.example^', count: 10 },
      { rule: '||trailing.example^', count: 4 },
    ]);
    expect(parsed.exceptions).toEqual(['@@||allow.example^']);
  });

  it('skips a line it cannot read instead of inventing an entry', () => {
    const parsed = parseHitLedgerText(['||ok.example^', '42', '#', '!'].join('\n'));

    expect(parsed.hits).toEqual([{ rule: '||ok.example^', count: 1 }]);
  });

  it('summarizes the coverage in one line', () => {
    const aggregate = mergeBrowserLedger([
      session({ startedAt: '2026-09-01T09:00:00.000Z', hits: [{ rule: '||a.example^', count: 1 }] }),
      session({ startedAt: '2026-09-09T09:00:00.000Z', hits: [{ rule: '||b.example^', count: 1 }] }),
    ]);

    const line = summarizeBrowserLedger(aggregate);
    expect(line).toContain('2 sessions across 2 days');
    expect(line).toContain('2026-09-01 to 2026-09-09');
    expect(line).toContain('2 blocking rules');

    expect(summarizeBrowserLedger(mergeBrowserLedger([]))).toBe('no sessions');
    expect(
      summarizeBrowserLedger(
        mergeBrowserLedger([session({ hits: [{ rule: '||a.example^', count: 1 }] })]),
      ),
    ).toContain('1 session across 1 day');
  });
});

/**
 * The per-tier axis through the merge. This is the export's reason for existing: the tier plan is
 * weighted by how much each ruleset blocked, and a merge that could not report that left the
 * measurement stuck in the popup that took it. The properties worth pinning are the ones that would
 * make the number look better than it is — inheriting `minDays`, implying coverage it does not have,
 * and writing tiers as rule lines.
 */
describe('the per-tier axis', () => {
  const tiered = (overrides: Partial<BrowserLedgerSession> = {}): BrowserLedgerSession =>
    session({
      hits: [{ rule: '||ads.example^', count: 10 }],
      tiers: [{ tier: 'tier_ads', count: 10 }],
      ...overrides,
    });

  it('merges per-tier counts with the same days and sessions a rule gets', () => {
    const aggregate = mergeBrowserLedger([
      tiered({ startedAt: '2026-09-01T09:00:00.000Z' }),
      tiered({ startedAt: '2026-09-02T09:00:00.000Z', tiers: [{ tier: 'tier_ads', count: 3 }] }),
    ]);

    expect(aggregate.tiers).toEqual([
      { tier: 'tier_ads', count: 13, sessions: 2, days: ['2026-09-01', '2026-09-02'] },
    ]);
    expect(aggregate.tierSessions).toBe(2);
    expect(aggregate.tierUnattributed).toBe(0);
  });

  it('accepts a session with no split and reports the coverage rather than filling it in', () => {
    // Three exports written before the axis existed and one after. A table built from the four would
    // describe a quarter of the evidence, and nothing in the totals would show it.
    const aggregate = mergeBrowserLedger([
      session({ startedAt: '2026-09-01T09:00:00.000Z', hits: [{ rule: '||a.example^', count: 5 }] }),
      session({ startedAt: '2026-09-02T09:00:00.000Z', hits: [{ rule: '||a.example^', count: 5 }] }),
      session({ startedAt: '2026-09-03T09:00:00.000Z', hits: [{ rule: '||a.example^', count: 5 }] }),
      tiered({ startedAt: '2026-09-04T09:00:00.000Z' }),
    ]);

    expect(aggregate.tiers).toHaveLength(1);
    expect(aggregate.tierSessions).toBe(1);
    expect(aggregate.sessions).toBe(4);
    // The block axis is untouched: a missing tier measurement is not a missing session, and the
    // three untiered sessions still contribute their rules.
    expect(aggregate.rules.map((rule) => rule.rule)).toEqual(['||a.example^', '||ads.example^']);
  });

  it('is not filtered by minDays, which is a statement about rules', () => {
    // `--min-days` asks which *rules* are durable enough to ship. A tier is the evidence that judged
    // that filter, so dropping a tier from the table deletes the measurement of the decision itself.
    const aggregate = mergeBrowserLedger(
      [tiered({ startedAt: '2026-09-01T09:00:00.000Z' })],
      { minDays: 7 },
    );

    expect(aggregate.rules).toEqual([]);
    expect(aggregate.tiers).toEqual([
      { tier: 'tier_ads', count: 10, sessions: 1, days: ['2026-09-01'] },
    ]);
  });

  it('counts blocks that named no tier, so the split adds up to the blocks', () => {
    const aggregate = mergeBrowserLedger([
      // 10 blocks, all attributed to a tier. A second session of 7 blocks from the synced list,
      // which is not a ruleset at all and so names no tier.
      tiered(),
      session({
        startedAt: '2026-09-02T09:00:00.000Z',
        hits: [{ rule: '||synced.example^', count: 7 }],
        tierUnattributed: 7,
      }),
    ]);

    expect(aggregate.tierUnattributed).toBe(7);
    const tierTotal = aggregate.tiers.reduce((sum, tier) => sum + tier.count, 0);
    const blockTotal = aggregate.rules.reduce((sum, rule) => sum + rule.count, 0);
    // The check a reader can make without trusting anything above it: every block is either on a tier
    // or counted as one that was not, and nothing is quietly in neither column.
    expect(tierTotal + aggregate.tierUnattributed).toBe(blockTotal);
    expect(blockTotal).toBe(17);
  });

  it('refuses a tier id the catalogue does not know, and counts the refusal', () => {
    // These ids are what a plan's weightings are keyed on, so one nobody recognises could not be
    // weighed — and storing it would put a row in the table that looks measured.
    const read = readBrowserLedgerSessions([
      session({
        tiers: [
          { tier: 'tier_ads', count: 4 },
          { tier: 'tier_invented', count: 100 },
          { tier: 'CORE', count: 50 },
        ] as never,
      }),
    ]);

    expect(read.sessions[0]?.tiers).toEqual([{ tier: 'tier_ads', count: 4 }]);
    expect(read.tierRejected).toBe(2);
  });

  it('counts a refused tier id even when the input skipped the reader', () => {
    // The merge is a public boundary too: a caller can hand it parsed exports that never went
    // through `readBrowserLedgerSessions`, and the refusal then has to happen — and be counted —
    // where the entry is actually dropped, or an entry naming `tier_invented` merges as though
    // it was never there.
    const aggregate = mergeBrowserLedger([
      session({
        hits: [{ rule: '||a.example^', count: 1 }],
        tiers: [
          { tier: 'tier_ads', count: 4 },
          { tier: 'tier_invented', count: 100 },
          { tier: 'CORE', count: 50 },
        ] as never,
      }),
    ]);

    expect(aggregate.tiers).toEqual([
      { tier: 'tier_ads', count: 4, sessions: 1, days: ['2026-09-01'] },
    ]);
    expect(aggregate.tierRejected).toBe(2);
  });

  it('does not double-count the rejections on the shipped read-then-merge path', () => {
    // The reader drops and counts what it refuses, so the merge sees none of them — the script's
    // sum of the two counts is disjoint by construction, not by convention.
    const read = readBrowserLedgerSessions([
      session({ tiers: [{ tier: 'tier_invented', count: 9 }] as never }),
    ]);
    const aggregate = mergeBrowserLedger(read.sessions);

    expect(read.tierRejected).toBe(1);
    expect(aggregate.tierRejected).toBe(0);
  });

  it('writes the tally into the header rather than as rule lines', () => {
    const text = toHitLedgerText(mergeBrowserLedger([tiered({ tierUnattributed: 4 })]));
    const parsed = parseHitLedgerText(text);

    expect(parsed.header.tiers).toBe('tier_ads 10');
    expect(parsed.header['tier sessions']).toBe('1 of 1');
    expect(parsed.header['tier unattributed']).toBe('4');
    // A `tier_core 543` line would be 543 rules *named* `tier_core` — a ruleset id masquerading as a
    // host — and the hot list would inherit it.
    expect(parsed.hits).toEqual([{ rule: '||ads.example^', count: 10 }]);
  });

  it('leaves the header alone when no session carried a split', () => {
    const text = toHitLedgerText(mergeBrowserLedger([session()]));
    expect(parseHitLedgerText(text).header.tiers).toBeUndefined();
  });

  it('says the coverage in the summary, before the total', () => {
    const line = summarizeBrowserLedger(
      mergeBrowserLedger([
        tiered({ startedAt: '2026-09-01T09:00:00.000Z' }),
        session({ startedAt: '2026-09-02T09:00:00.000Z' }),
      ]),
    );

    expect(line).toContain('1 tiers over 1 of 2 sessions');
    expect(line).not.toMatch(/\b1 tiers\b(?![^·]*over)/);
  });
});

describe('readLedgerTierTally', () => {
  it('parses the tally and its coverage from a merged ledger header', () => {
    const tally = readLedgerTierTally({
      tiers: 'tier_privacy 60, tier_ads 25, tier_unclassified 6',
      'tier sessions': '1 of 4',
      sessions: '4',
    });

    expect(tally).toEqual({
      hits: { tier_privacy: 60, tier_ads: 25, tier_unclassified: 6 },
      tierSessions: 1,
      sessions: 4,
      rejected: 0,
    });
  });

  it('is null when the header carries no tally at all', () => {
    // Absent is "no measurement", not "a measurement of zero": a ledger written before the axis
    // exists must not be read as a tally that credits nobody.
    expect(readLedgerTierTally({ sessions: '4' })).toBeNull();
    expect(readLedgerTierTally({})).toBeNull();
  });

  it('refuses entries that name no known tier, and counts them', () => {
    const tally = readLedgerTierTally({
      tiers: 'tier_ads 40, tier_invented 900, bogus 3, tier_ads 10',
      'tier sessions': '2 of 2',
    });

    expect(tally?.hits).toEqual({ tier_ads: 50 });
    expect(tally?.rejected).toBe(2);
  });

  it('takes the coverage denominator from Sessions when "of N" is absent', () => {
    const tally = readLedgerTierTally({ tiers: 'tier_ads 4', 'tier sessions': '2', sessions: '2' });
    expect(tally?.tierSessions).toBe(2);
    expect(tally?.sessions).toBe(2);
  });
});
