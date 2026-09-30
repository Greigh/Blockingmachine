/**
 * The tier plan computation both non-browser surfaces run.
 *
 * This is the function the CLI and the hub share, so what is worth pinning is the agreement
 * between a ledger and a tier — the join that has no counterpart in the popup, where the browser
 * has already attributed each match to a ruleset and the planner is handed the result.
 *
 * The failures that matter here are all ways of reporting zero:
 *
 *  - **A ledger line that does not match a tier.** The ledger is keyed by whatever filter text the
 *    browser reported, and a tier ships `||host^`. Comparing the strings would report a tier as
 *    never having fired while it was in fact the rule that fired.
 *  - **An exception counted as a block.** An `@@` line is on the record because it *allowed* a
 *    request; crediting it would rank a tier by the traffic it let through.
 *  - **A wildcard treated as unusable.** The real hot list is full of `*.host` lines, and
 *    refusing them would silently zero a real measurement.
 */

import { describe, expect, test } from '@jest/globals';
import { computeTierPlan, readTierLedger, parseEnabledTierIds } from '../tierPlanInput.js';
import { STATIC_RULE_TIERS, type StaticTierId } from '../tiers.js';

const tierFile = (hosts: string[]) =>
  hosts.map((host, index) => ({
    id: index + 1,
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter: `||${host}^` },
  }));

const files = {
  tier_core: tierFile(['core.example.com', 'shared.example.com']),
  tier_ads: tierFile(['ads.example.com', 'shared.example.com']),
  tier_privacy: tierFile(['privacy.example.com']),
  tier_annoyances: tierFile(['consent.example.com']),
};

const ALL: StaticTierId[] = STATIC_RULE_TIERS.map((tier) => tier.id);
const input = (overrides: Partial<Parameters<typeof computeTierPlan>[0]> = {}) => ({
  files: ALL.map((id) => ({ id, rules: files[id] })),
  enabled: ALL,
  ...overrides,
});

describe('readTierLedger', () => {
  const tierHosts = new Map<StaticTierId, Set<string>>([
    ['tier_core', new Set(['core.example.com', 'shared.example.com'])],
    ['tier_ads', new Set(['ads.example.com', 'shared.example.com'])],
  ]);

  test('credits a line to the tier whose rules ship that host', () => {
    const read = readTierLedger('3 ||core.example.com^', tierHosts);
    expect(read.hits).toEqual({ tier_core: 3 });
    expect(read.lines).toBe(1);
    expect(read.skipped).toBe(0);
  });

  test('counts a host two tiers both ship, and reports that it did', () => {
    // The export records which rule fired but not which ruleset declared it, so a shared host is
    // credited to each. Over-counting is reportable; dividing it by the claimant count would
    // invent a precision the data does not have.
    const read = readTierLedger('5 ||shared.example.com^', tierHosts);
    expect(read.hits).toEqual({ tier_core: 5, tier_ads: 5 });
    expect(read.shared).toBe(1);
  });

  test('refuses an exception, a bare number, and a directive', () => {
    const read = readTierLedger(
      ['@@||core.example.com^', '42', '||core.example.com^$badfilter', '! a comment'].join('\n'),
      tierHosts,
    );
    expect(read.hits).toEqual({});
    expect(read.lines).toBe(0);
    expect(read.skipped).toBe(3);
  });

  test('resolves a wildcard to the host the tier ships it as', () => {
    // The input side refuses `*.host` because a zone block cannot express "subdomains only". As
    // evidence it is not a refusal, and the real hot list is full of these.
    const read = readTierLedger('2 *.core.example.com', tierHosts);
    expect(read.hits).toEqual({ tier_core: 2 });
    expect(read.skipped).toBe(0);
  });

  test('reads a count before or after the rule', () => {
    expect(readTierLedger('7 ||core.example.com^', tierHosts).hits).toEqual({ tier_core: 7 });
    expect(readTierLedger('||core.example.com^ 7', tierHosts).hits).toEqual({ tier_core: 7 });
  });

  test('credits a line naming no tier to nobody, and still counts the line', () => {
    const read = readTierLedger('4 ||unknown.example.com^', tierHosts);
    expect(read.hits).toEqual({});
    expect(read.lines).toBe(1);
  });
});

describe('computeTierPlan', () => {
  test('plans against the rule counts the files actually hold', () => {
    // Not the catalogue's curated numbers: a packaged build ships tens of thousands per tier, and
    // a plan computed from the baseline would be a plan about a different bundle.
    const result = computeTierPlan(input());
    expect(result.rows.map((row) => row.rules)).toEqual([2, 2, 1, 1]);
    expect(result.plan.totalRules).toBe(6);
    expect(result.plan.benefitSource).toBe('coverage');
  });

  test('refuses to plan a tier whose file is invalid, and says which', () => {
    // A plan that charged a tier for rules the browser would refuse to load is worse than no plan.
    const broken = computeTierPlan(
      input({
        files: ALL.map((id) =>
          id === 'tier_ads'
            ? { id, rules: [{ id: 1, priority: 5, action: { type: 'block' }, condition: { urlFilter: '||x.example^' } }] }
            : { id, rules: files[id] },
        ),
      }),
    );
    expect(broken.broken.map((row) => row.id)).toEqual(['tier_ads']);
    expect(broken.broken[0]?.errors.join(' ')).toContain('priority must be 1');
    // Excluded from the plan entirely: the total counts the four rules the three valid tiers hold,
    // so an unloadable tier is never charged for.
    expect(broken.plan.totalRules).toBe(4);
    expect(broken.plan.enabled).not.toContain('tier_ads');
  });

  test('a tier with no file at all is broken rather than silently empty', () => {
    const result = computeTierPlan(
      input({ files: ALL.filter((id) => id !== 'tier_privacy').map((id) => ({ id, rules: files[id] })) }),
    );
    expect(result.broken.map((row) => row.id)).toEqual(['tier_privacy']);
    expect(result.broken[0]?.errors.join(' ')).toContain('no file was supplied');
  });

  test('a congested capacity is planned against, and the guarantee is not quoted instead', () => {
    const wide = computeTierPlan(
      input({
        files: ALL.map((id) => ({
          id,
          rules: id === 'tier_ads' ? tierFile(Array.from({ length: 40 }, (_, i) => `a${i}.example.com`)) : files[id],
        })),
        capacity: 10,
      }),
    );
    expect(wide.capacitySlots).toBe(10);
    expect(wide.plan.enabledRules).toBeLessThanOrEqual(10);
    // The explanation must attribute the shortfall to the figure that was asked for, not to the
    // guaranteed floor, or the number the caller supplied is being ignored.
    expect(wide.plan.explanation.join(' ')).toContain('10 static slots');
    expect(wide.plan.explanation.join(' ')).toContain('10 available');
  });

  test('weights by the ledger once every tier has been measured', () => {
    const allMeasured = computeTierPlan(
      input({
        ledger: {
          text: [
            '500 ||core.example.com^',
            '900 ||ads.example.com^',
            '30 ||privacy.example.com^',
            '4 ||consent.example.com^',
          ].join('\n'),
        },
      }),
    );
    expect(allMeasured.basis?.source).toBe('evidence');
    expect(allMeasured.plan.benefitSource).toBe('evidence');
    expect(allMeasured.plan.benefit).toBe(1434);
  });

  test('a tier that fired nothing while the ledger saw plenty is a measured zero', () => {
    // The distinction that makes the whole feature work. 1,400 real matches happened while these
    // tiers were on and two of them contributed none: that is a result, not an absence of one, so
    // the plan is weighted by evidence and the zero is what costs those tiers their slots.
    const measured = computeTierPlan(
      input({ ledger: { text: '500 ||core.example.com^\n900 ||ads.example.com^' } }),
    );
    expect(measured.basis?.source).toBe('evidence');
    expect(measured.basis?.unmeasured).toEqual([]);
    expect(measured.rows.find((row) => row.id === 'tier_privacy')?.hits).toBe(0);
    expect(measured.plan.benefit).toBe(1400);
  });

  test('falls back to rule counts, naming the tiers, below the sample the ledger needs', () => {
    // Twenty matches is not enough traffic to conclude anything from a silence, so a tier that
    // fired nothing is *unobserved* rather than idle — and an unobserved tier is not a zero.
    const thin = computeTierPlan(
      input({ ledger: { text: '12 ||core.example.com^\n8 ||ads.example.com^' } }),
    );
    expect(thin.basis?.source).toBe('coverage');
    expect(thin.basis?.unmeasured).toEqual(['tier_privacy', 'tier_annoyances']);
    expect(thin.plan.benefitSource).toBe('coverage');
    expect(thin.basis?.reason).toContain('not enough traffic yet');
    // Per-row hits are still reported, so a reader can see the ledger was read at all.
    expect(thin.rows.find((row) => row.id === 'tier_core')?.hits).toBe(12);
  });

  test('a tier switched off with no history is never measured, however busy the ledger is', () => {
    // The refusal the attribution gate exists for: an off tier cannot block, so its zero is the
    // switch. Without this the plan would argue for switching back on everything the user turned
    // off, and call it evidence.
    const off = computeTierPlan(
      input({
        enabled: ['tier_core', 'tier_ads'],
        ledger: { text: '500 ||core.example.com^\n900 ||ads.example.com^' },
      }),
    );
    expect(off.basis?.source).toBe('coverage');
    expect(off.basis?.unmeasured).toEqual(['tier_privacy', 'tier_annoyances']);
    expect(off.basis?.reason).toContain('switched off with no history');
  });

  test('reports no hits at all when no ledger was supplied, rather than reporting zeros', () => {
    // A `0` in the hits column is a measurement; a `—` is an absence of one, and the difference is
    // the whole refusal the attribution gate is built on.
    const none = computeTierPlan(input());
    expect(none.basis).toBeNull();
    expect(none.ledger).toBeNull();
    expect(none.rows.every((row) => row.hits === null)).toBe(true);
  });

  test('a missing file is an error on the row, not a thrown exception', () => {
    const result = computeTierPlan(
      input({
        files: [
          { id: 'tier_core', rules: files.tier_core },
          { id: 'tier_ads', rules: null, readError: 'cannot read /tmp/tier_ads.json' },
          { id: 'tier_privacy', rules: files.tier_privacy },
          { id: 'tier_annoyances', rules: files.tier_annoyances },
        ],
      }),
    );
    expect(result.broken[0]?.errors.join(' ')).toContain('cannot read /tmp/tier_ads.json');
  });
});

describe('parseEnabledTierIds', () => {
  test('falls back when given nothing, and keeps only real tier ids', () => {
    expect(parseEnabledTierIds(undefined, ['tier_core'])).toEqual(['tier_core']);
    expect(parseEnabledTierIds('  ', ['tier_core'])).toEqual(['tier_core']);
    expect(parseEnabledTierIds('tier_ads,not_a_tier,tier_ads', [])).toEqual(['tier_ads']);
  });
});
