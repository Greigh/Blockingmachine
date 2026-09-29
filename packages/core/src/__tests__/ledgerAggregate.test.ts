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
