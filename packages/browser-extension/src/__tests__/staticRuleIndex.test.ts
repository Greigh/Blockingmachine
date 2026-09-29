/**
 * The static ruleset index.
 *
 * The test that matters is the concurrent one. The bug this module was extracted to fix was invisible
 * in a single call: `ensure()` returned the same empty map for every caller that arrived while the
 * first build was still running, so a page load recorded almost every match with no rule name. A test
 * that awaits one `ensure()` before asking would have passed against the broken version too.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { StaticRuleIndex, type StaticTierSpec } from '../background/staticRuleIndex.js';

const TIERS: StaticTierSpec[] = [
  { id: 'tier_core', path: 'rules/tier_core.json' },
  { id: 'tier_ads', path: 'rules/tier_ads.json' },
];

const rules = (entries: Array<[number, string]>) =>
  entries.map(([id, urlFilter]) => ({ id, action: { type: 'block' }, condition: { urlFilter } }));

function index(readTier: (path: string) => Promise<unknown>) {
  return new StaticRuleIndex({ tiers: TIERS, readTier });
}

describe('StaticRuleIndex', () => {
  test('maps a ruleset and rule id to the filter line it came from', async () => {
    const ruleset = index(async (path) =>
      path.includes('core') ? rules([[1, '||doubleclick.net^']]) : rules([[7, '||criteo.net^']]),
    );

    await ruleset.ensure();

    expect(ruleset.filterFor('tier_core', 1)).toBe('||doubleclick.net^');
    expect(ruleset.filterFor('tier_ads', 7)).toBe('||criteo.net^');
    expect(ruleset.size).toBe(2);
  });

  test('shares one in-flight build, so a burst of matches all see the rules', async () => {
    // The build is slow on purpose: this is the window in which the old implementation handed out
    // an empty index.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readTier = jest.fn(async (path: string) => {
      await gate;
      return rules([[1, path.includes('core') ? '||doubleclick.net^' : '||criteo.net^']]);
    });
    const ruleset = index(readTier);

    // Ten matches arriving during the first build, exactly as a page load does.
    const callers = Array.from({ length: 10 }, () => ruleset.ensure());
    release!();
    await Promise.all(callers);

    // One read per tier, not one per caller.
    expect(readTier).toHaveBeenCalledTimes(2);
    expect(ruleset.filterFor('tier_core', 1)).toBe('||doubleclick.net^');
    expect(ruleset.filterFor('tier_ads', 1)).toBe('||criteo.net^');
  });

  test('does not re-read the files once built', async () => {
    const readTier = jest.fn(async () => rules([[1, '||doubleclick.net^']]));
    const ruleset = index(readTier);

    await ruleset.ensure();
    await ruleset.ensure();
    await ruleset.ensure();

    expect(readTier).toHaveBeenCalledTimes(TIERS.length);
  });

  test('returns undefined for a rule that cannot be named, never a placeholder', () => {
    const ruleset = index(async () => rules([]));

    // A dynamic rule, an unknown ruleset, a missing id: all genuinely have no filter text, and the
    // caller records the match as unattributed rather than inventing one.
    expect(ruleset.filterFor('_dynamic', 12)).toBeUndefined();
    expect(ruleset.filterFor(undefined, 12)).toBeUndefined();
    expect(ruleset.filterFor('tier_core', undefined)).toBeUndefined();
    expect(ruleset.filterFor('tier_core', '1')).toBeUndefined();
  });

  test('a tier that cannot be read goes unresolved without taking the others down', async () => {
    const ruleset = index(async (path) => {
      if (path.includes('ads')) throw new Error('HTTP 404');
      return rules([[1, '||doubleclick.net^']]);
    });

    await expect(ruleset.ensure()).resolves.toBeUndefined();
    expect(ruleset.filterFor('tier_core', 1)).toBe('||doubleclick.net^');
    expect(ruleset.filterFor('tier_ads', 1)).toBeUndefined();
  });

  test('does not re-read a tier that could not be read', async () => {
    const readTier = jest.fn(async (path: string) => {
      if (path.includes('ads')) throw new Error('HTTP 404');
      return rules([[1, '||doubleclick.net^']]);
    });
    const ruleset = index(readTier);

    await ruleset.ensure();
    await ruleset.ensure();
    await ruleset.ensure();

    // The file ships inside the extension, so one that cannot be read now will not read differently
    // on the next match; retrying per match would be the worst of both.
    expect(readTier).toHaveBeenCalledTimes(TIERS.length);
    expect(ruleset.filterFor('tier_core', 1)).toBe('||doubleclick.net^');
  });

  test('ignores rules without a usable id or filter', async () => {
    const ruleset = index(async (path: string) =>
      path.includes('ads')
        ? []
        : [
      { id: 1, condition: { urlFilter: '||ok.example^' } },
      { condition: { urlFilter: '||no-id.example^' } },
      { id: 2 },
      { id: 3, condition: { urlFilter: 42 } },
      { id: 4, condition: { urlFilter: '' } },
      null,
      'nonsense',
      { id: 5, condition: { urlFilter: '||also-ok.example^' } },
        ],
    );

    await ruleset.ensure();

    expect(ruleset.size).toBe(2);
    expect(ruleset.filterFor('tier_core', 1)).toBe('||ok.example^');
    expect(ruleset.filterFor('tier_core', 5)).toBe('||also-ok.example^');
    expect(ruleset.filterFor('tier_core', 4)).toBeUndefined();
  });

  test('survives a tier file that is not a rule array', async () => {
    const ruleset = index(async () => ({ nope: true }));

    await expect(ruleset.ensure()).resolves.toBeUndefined();
    expect(ruleset.size).toBe(0);
  });
});
