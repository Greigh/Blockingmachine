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
import {
  computeTierPlan,
  findTierRedundancy,
  readSyncedHosts,
  readTierLedger,
  parseEnabledTierIds,
} from '../tierPlanInput.js';
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

/**
 * What the synced list already blocks, which is the question a ledger cannot answer.
 *
 * The failures worth pinning here are the ones that make the answer *look* like a finding: a
 * comment read as a host, an exception counted as a block, and — the one that actually inverts the
 * report — a narrow synced rule retiring a broad tier.
 */
describe('readSyncedHosts', () => {
  test('reads ABP and hosts-file blocks, and refuses what blocks nothing at a domain level', () => {
    const read = readSyncedHosts(
      [
        '! a comment, which names no host',
        '# another comment',
        '',
        '||doubleclick.net^',
        '0.0.0.0 tracker.example.com',
        '||priority.com^$important',
        'example.com##.ad-banner',
        '||scoped.com^$script',
        '||narrowed.com^$~third-party',
        '||removed.com^$removeparam=x',
      ].join('\n'),
    );
    expect([...read.block].sort()).toEqual(['doubleclick.net', 'priority.com', 'tracker.example.com']);
    // A cosmetic filter and a `$removeparam` rule do not block the domain at all. A `$script` rule
    // does, but only for scripts, so a tier shipping the host unconditionally blocks more and is
    // not duplicated by it — counting it would report redundancy on partial evidence.
    expect(read.block.has('example.com')).toBe(false);
    expect(read.block.has('scoped.com')).toBe(false);
    expect(read.block.has('narrowed.com')).toBe(false);
    expect(read.block.has('removed.com')).toBe(false);
    // `$important` changes priority, not the request set, so it does cover the host.
    expect(read.block.has('priority.com')).toBe(true);
    // Seven usable lines of nine; the skip count is the honesty of the read.
    expect(read.lines).toBe(7);
    expect(read.skipped).toBe(4);
  });

  test('separates exceptions from blocks in both spellings', () => {
    // An exception is where a tier is *not* redundant, so dropping it would report the exact
    // inversion the ledger reader refuses: coverage measured by what the list let through.
    const read = readSyncedHosts(
      ['||tracker.com^', '@@||allowed.tracker.com^', '!@@legacy.tracker.com', '!just a comment'].join('\n'),
    );
    expect([...read.block]).toEqual(['tracker.com']);
    expect([...read.allow].sort()).toEqual(['allowed.tracker.com', 'legacy.tracker.com']);
    // A `!@@` line is an exception and was read; a bare `!` comment was not.
    expect(read.lines).toBe(3);
  });
});

describe('findTierRedundancy', () => {
  const rules = (hosts: string[]) =>
    hosts.map((host, index) => ({
      id: index + 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: `||${host}^` },
    }));
  const syncedOf = (text: string) => readSyncedHosts(text);

  test('counts a tier host a synced parent domain already covers', () => {
    // `||doubleclick.net^` blocks every subdomain, so a tier shipping `||ads.doubleclick.net^`
    // adds nothing. This is the case that makes the diff a suffix walk rather than a lookup.
    const result = findTierRedundancy(
      rules(['ads.doubleclick.net', 'uncovered.example.com']),
      syncedOf('||doubleclick.net^'),
    );
    expect(result.rules).toBe(1);
    expect(result.hosts).toBe(1);
    expect(result.complete).toBe(false);
  });

  test('does not let a narrow synced rule retire a broad tier', () => {
    // The reverse direction is the trap: `||ads.doubleclick.net^` leaves `doubleclick.net` and its
    // other subdomains open, so the tier is still doing work. Testing both directions would
    // recommend dropping the tier that covers the most.
    const result = findTierRedundancy(rules(['doubleclick.net']), syncedOf('||ads.doubleclick.net^'));
    expect(result.rules).toBe(0);
    expect(result.complete).toBe(false);
  });

  test('does not count a neighbouring domain that merely shares a suffix string', () => {
    // `notdoubleclick.net` ends with `doubleclick.net` as a *string* and not as a label sequence.
    // A `String.endsWith` diff would retire it; a label walk does not.
    const result = findTierRedundancy(
      rules(['notdoubleclick.net', 'doubleclick.net.evil.com']),
      syncedOf('||doubleclick.net^'),
    );
    expect(result.rules).toBe(0);
  });

  test('an exception restores a tier host the block would have covered', () => {
    const result = findTierRedundancy(
      rules(['tracker.com', 'allowed.tracker.com', 'other.tracker.com']),
      syncedOf('||tracker.com^\n@@||allowed.tracker.com^'),
    );
    // `tracker.com` and `other.tracker.com` are duplicated; the excepted host is not, because the
    // synced list explicitly does not block it.
    expect(result.rules).toBe(2);
    expect(result.complete).toBe(false);
  });

  test('reports a tier as complete only when every rule is duplicated', () => {
    const all = findTierRedundancy(rules(['a.com', 'b.com']), syncedOf('||a.com^\n||b.com^'));
    expect(all).toEqual({ rules: 2, hosts: 2, complete: true });

    const most = findTierRedundancy(
      rules(['a.com', 'b.com', 'c.com']),
      syncedOf('||a.com^\n||b.com^'),
    );
    // 67% duplicated is mostly redundant and still load-bearing for the rest, which is a
    // different decision from dropping a tier that adds nothing.
    expect(most.complete).toBe(false);

    // An empty tier is not a redundant one; there is nothing there to duplicate.
    expect(findTierRedundancy([], syncedOf('||a.com^')).complete).toBe(false);
  });
});

describe('computeTierPlan redundancy', () => {
  test('reports redundancy as unknown, not as zero, when no synced list is given', () => {
    // The whole point of the null: a table of zeroes reads as "nothing is redundant", which is a
    // claim about a comparison that never happened.
    const result = computeTierPlan(input());
    expect(result.synced).toBeNull();
    expect(result.redundantTiers).toEqual([]);
    expect(result.rows.every((row) => row.redundant === null)).toBe(true);
  });

  test('names the tiers that add nothing, and leaves the partly-duplicated ones out', () => {
    // Every tier but one ships a host the list does not cover, so the difference between the
    // finding and the footnote is one fully-covered tier against three half-covered ones.
    const result = computeTierPlan(
      input({
        files: [
          { id: 'tier_core', rules: tierFile(['core.example.com', 'shared.example.com']) },
          { id: 'tier_ads', rules: tierFile(['ads.example.com', 'shared.example.com']) },
          { id: 'tier_privacy', rules: tierFile(['privacy.example.com', 'extra.example.com']) },
          { id: 'tier_annoyances', rules: tierFile(['consent.example.com', 'nag.example.com']) },
        ],
        synced: {
          text: [
            '||shared.example.com^', // both tier_core and tier_ads ship it
            '||ads.example.com^', // tier_ads only
            '||privacy.example.com^', // tier_privacy only
            '||consent.example.com^', // tier_annoyances only
          ].join('\n'),
        },
      }),
    );
    // tier_ads ships two hosts and both are covered, so it adds nothing at all.
    expect(result.redundantTiers).toEqual(['tier_ads']);

    const byId = new Map(result.rows.map((row) => [row.id, row]));
    // tier_core ships two hosts, only one of which is covered: a 50% figure that must not be
    // reported as a finding.
    expect(byId.get('tier_core')?.redundant).toEqual({ rules: 1, hosts: 1, complete: false });
    expect(byId.get('tier_ads')?.redundant).toEqual({ rules: 2, hosts: 2, complete: true });
    expect(byId.get('tier_annoyances')?.redundant).toEqual({ rules: 1, hosts: 1, complete: false });

    expect(result.synced).toEqual({ hosts: 4, exceptions: 0, lines: 4, skipped: 0 });
  });

  test('still reports a tier with a broken file as not redundant, so the row is not blank', () => {
    // The broken tier is not planned at all, but a null there would render as an em dash beside
    // three real figures, which reads as a comparison that failed rather than a tier with no rules.
    const result = computeTierPlan(
      input({
        files: [
          { id: 'tier_core', rules: files.tier_core },
          { id: 'tier_ads', rules: null, readError: 'cannot read /tmp/tier_ads.json' },
          { id: 'tier_privacy', rules: files.tier_privacy },
          { id: 'tier_annoyances', rules: files.tier_annoyances },
        ],
        synced: { text: '||core.example.com^' },
      }),
    );
    const ads = result.rows.find((row) => row.id === 'tier_ads');
    expect(ads?.redundant).toEqual({ rules: 0, hosts: 0, complete: false });
    expect(ads?.errors.length).toBeGreaterThan(0);
  });
});
