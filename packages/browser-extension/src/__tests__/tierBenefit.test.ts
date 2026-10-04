import { describe, test, expect, jest } from '@jest/globals';
import { TierBenefitIndex, tierBenefitOrder } from '../background/tierBenefit.js';
import {
  ALL_STATIC_TIER_IDS,
  type StaticTierId,
  type TierHitCounts,
} from '../shared/tierAttribution.js';

/**
 * The fallback ordering behind the no-hot-set trim — host → rank built from the shipped tier
 * files, weighted by the deployment's own per-tier tally. Tested directly because the claim
 * it makes ("the cut keeps what evidence ranks") is checkable rule by rule.
 */

const TIERS = [
  { id: 'tier_core', path: 'rules/tier_core.json' },
  { id: 'tier_ads', path: 'rules/tier_ads.json' },
  { id: 'tier_privacy', path: 'rules/tier_privacy.json' },
];

function tierFile(hosts: string[]) {
  return hosts.map((host, index) => ({
    id: index + 1,
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter: `||${host}^` },
  }));
}

function indexWith(files: Record<string, string[]>, tierHits?: TierHitCounts) {
  const readTier = jest.fn(async (path: string) => {
    const name = path.split('/').pop()!.replace('.json', '');
    if (!(name in files)) throw new Error(`HTTP 404`);
    return tierFile(files[name]);
  });
  const index = new TierBenefitIndex({
    tiers: TIERS,
    readTier,
    ...(tierHits ? { tierHits: () => tierHits } : {}),
  });
  return { index, readTier };
}

describe('tierBenefitOrder', () => {
  test('orders tiers by measured blocks, catalogue order breaking ties', () => {
    const order = tierBenefitOrder({ tier_annoyances: 50, tier_core: 5 });

    expect(order[0]).toBe('tier_annoyances');
    expect(order[1]).toBe('tier_core');
    // Unmeasured tiers keep their authored place rather than dropping to the bottom.
    expect(order.indexOf('tier_ads')).toBeLessThan(order.indexOf('tier_unclassified'));
    expect(order.indexOf('tier_ads')).toBeLessThan(order.indexOf('tier_security'));
  });

  test('a deployment with no measurement gets the authored order back', () => {
    expect(tierBenefitOrder({})).toEqual(ALL_STATIC_TIER_IDS);
    expect(tierBenefitOrder({ tier_ads: 0, tier_core: 0 })).toEqual(ALL_STATIC_TIER_IDS);
  });
});

describe('TierBenefitIndex', () => {
  test('ranks a host the tier files ship, and an ancestor it does not', async () => {
    const { index } = indexWith({ tier_ads: ['doubleclick.net', 'ads.example'] });
    await index.ensure();

    // `||doubleclick.net^` blocks the zone, so the subdomain inherits its rank — the same
    // coverage walk the redundancy diff uses.
    expect(index.rankFor('doubleclick.net')).not.toBeNull();
    expect(index.rankFor('metrics.doubleclick.net')).toBe(index.rankFor('doubleclick.net'));
    expect(index.rankFor('ads.example')!).toBeGreaterThan(index.rankFor('doubleclick.net')!);
    expect(index.rankFor('unknown.example')).toBeNull();
  });

  test('ranks earlier tiers and earlier positions ahead', async () => {
    const { index } = indexWith({
      tier_core: ['first.example'],
      tier_ads: ['second.example', 'third.example'],
    });
    await index.ensure();

    const first = index.rankFor('first.example')!;
    const second = index.rankFor('second.example')!;
    const third = index.rankFor('third.example')!;
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
  });

  test('measured hits reorder the tiers they weight', async () => {
    const { index } = indexWith(
      { tier_core: ['quiet.example'], tier_privacy: ['busy.example'] },
      { tier_privacy: 900 },
    );
    await index.ensure();

    // tier_privacy is catalogue-late but evidence-heavy — the tally beats the authored order.
    expect(index.rankFor('busy.example')!).toBeLessThan(index.rankFor('quiet.example')!);
  });

  test('a host shipped by two tiers keeps the better rank', async () => {
    const { index } = indexWith({
      tier_core: ['shared.example'],
      tier_ads: ['shared.example'],
    });
    await index.ensure();

    expect(index.rankFor('shared.example')).toBe(0);
  });

  test('a tier that will not read ranks nothing and the build still completes', async () => {
    const readTier = jest.fn(async (path: string) => {
      if (path.includes('ads')) throw new Error('gone');
      return tierFile(path.includes('core') ? ['fine.example'] : ['other.example']);
    });
    const index = new TierBenefitIndex({
      tiers: [
        { id: 'tier_core' as StaticTierId, path: 'rules/tier_core.json' },
        { id: 'tier_ads' as StaticTierId, path: 'rules/tier_ads.json' },
      ],
      readTier,
    });
    await index.ensure();

    expect(index.rankFor('fine.example')).not.toBeNull();
    expect(index.size).toBe(1);
  });

  test('builds once — a second ensure reuses the build rather than re-reading', async () => {
    const { index, readTier } = indexWith({ tier_ads: ['a.example'] });
    await index.ensure();
    await index.ensure();

    expect(readTier).toHaveBeenCalledTimes(TIERS.length);
  });
});
