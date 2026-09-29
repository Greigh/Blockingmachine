/**
 * Per-tier block attribution tests.
 *
 * The feature exists so a tier can be judged on the traffic it actually blocked rather than on how
 * many rules it shipped. Most of what needs pinning down is therefore *not* the arithmetic but the
 * restraint: a tier that has seen no traffic must not be called idle, because acting on that would
 * switch off blocking that works.
 */

import { describe, expect, test } from '@jest/globals';
import {
  TIER_HIT_MIN_SAMPLE,
  buildTierBlocking,
  formatTierBlocking,
  tierFromRulesetId,
  type TierAttributionCandidate,
} from '../shared/tierAttribution.js';
import { STATIC_RULE_TIERS } from '../shared/rulesetTiers.js';

/** The real catalogue, so the tests exercise the shipped labels and order. */
const CATALOGUE: TierAttributionCandidate[] = STATIC_RULE_TIERS.map((tier) => ({
  id: tier.id,
  label: tier.label,
  category: tier.category,
}));

const ALL_IDS = CATALOGUE.map((tier) => tier.id);

describe('tierFromRulesetId', () => {
  test('maps a shipped ruleset to its tier, which is the same identifier', () => {
    expect(tierFromRulesetId('tier_core')).toBe('tier_core');
    expect(tierFromRulesetId('tier_annoyances')).toBe('tier_annoyances');
  });

  test('rejects anything that is not a tier, rather than guessing', () => {
    // The dynamic pipeline writes rules too, and its matches carry no ruleset id at all.
    expect(tierFromRulesetId('')).toBeNull();
    expect(tierFromRulesetId(undefined)).toBeNull();
    expect(tierFromRulesetId(null)).toBeNull();
    expect(tierFromRulesetId(7)).toBeNull();
    expect(tierFromRulesetId('tier_nope')).toBeNull();
    // A prefix is not a match — `includes` would have accepted this one.
    expect(tierFromRulesetId('tier_core_extra')).toBeNull();
  });
});

describe('buildTierBlocking — restraint', () => {
  test('calls a silent tier unproven, not idle, until the sample is meaningful', () => {
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ALL_IDS,
      hits: { tier_ads: TIER_HIT_MIN_SAMPLE - 1 },
    });

    expect(summary.observed).toBe(false);
    expect(summary.idle).toEqual([]);
    // Every tier that has not fired is merely unproven, so nothing is offered for dropping.
    expect(summary.tiers.map((tier) => tier.verdict)).toEqual([
      'unobserved',
      'productive',
      'unobserved',
      'unobserved',
    ]);
  });

  test('makes silence evidence exactly at the sample boundary', () => {
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ALL_IDS,
      hits: { tier_ads: TIER_HIT_MIN_SAMPLE },
    });

    expect(summary.observed).toBe(true);
    expect(summary.idle.map((tier) => tier.id)).toEqual([
      'tier_core',
      'tier_privacy',
      'tier_annoyances',
    ]);
    expect(summary.tiers[1].verdict).toBe('productive');
  });

  test('never calls a disabled tier idle, because being off is why it has no matches', () => {
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ['tier_ads', 'tier_privacy'],
      hits: { tier_ads: 900, tier_privacy: 100 },
    });

    const core = summary.tiers.find((tier) => tier.id === 'tier_core')!;
    expect(core.enabled).toBe(false);
    expect(core.verdict).toBe('disabled');
    // A big sample overall, and the disabled tier is still not offered as droppable — it is already
    // off, so "drop it" would be a no-op dressed up as a finding.
    expect(summary.idle).toEqual([]);
  });

  test('honours a caller-set sample threshold', () => {
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ALL_IDS,
      hits: { tier_ads: 5 },
      minSample: 5,
    });

    expect(summary.observed).toBe(true);
    expect(summary.minSample).toBe(5);
    expect(summary.idle).toHaveLength(3);
  });
});

describe('buildTierBlocking — attribution', () => {
  test('reports each tier’s share of the blocks that were attributed to tiers', () => {
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ALL_IDS,
      hits: { tier_core: 25, tier_ads: 60, tier_privacy: 15 },
    });

    expect(summary.totalHits).toBe(100);
    expect(summary.tiers.map((tier) => tier.hits)).toEqual([25, 60, 15, 0]);
    expect(summary.tiers.map((tier) => tier.verdict)).toEqual([
      'productive',
      'productive',
      'productive',
      'idle',
    ]);
    expect(Math.round(summary.tiers[1].share * 100)).toBe(60);
    expect(summary.tiers.map((tier) => tier.share).reduce((sum, share) => sum + share, 0)).toBeCloseTo(1);
    expect(summary.idle.map((tier) => tier.label)).toEqual(['Consent & nags']);
  });

  test('keeps catalogue order regardless of which tiers fired', () => {
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ALL_IDS,
      hits: { tier_annoyances: 300, tier_core: 200 },
    });

    expect(summary.tiers.map((tier) => tier.id)).toEqual(ALL_IDS);
  });

  test('drops junk counts instead of reporting them', () => {
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ALL_IDS,
      hits: {
        tier_core: Number.NaN,
        tier_ads: -40,
        tier_privacy: Number.POSITIVE_INFINITY,
        tier_annoyances: 12.9,
      },
    });

    expect(summary.totalHits).toBe(12);
    expect(summary.tiers.map((tier) => tier.hits)).toEqual([0, 0, 0, 12]);
  });

  test('survives empty and malformed input', () => {
    const empty = buildTierBlocking({ tiers: [], enabledIds: [], hits: {} });
    expect(empty.tiers).toEqual([]);
    expect(empty.totalHits).toBe(0);
    expect(empty.observed).toBe(false);
    expect(empty.summary).toBe('No tier blocks recorded yet');

    expect(() => buildTierBlocking({} as never)).not.toThrow();
    expect(buildTierBlocking({ tiers: null, enabledIds: [], hits: {} } as never).totalHits).toBe(0);
  });
});

describe('formatTierBlocking', () => {
  test('says what was seen, and says so plainly when nothing was', () => {
    expect(buildTierBlocking({ tiers: CATALOGUE, enabledIds: ALL_IDS, hits: {} }).summary).toBe(
      'No tier blocks recorded yet',
    );

    const busy = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ALL_IDS,
      hits: { tier_core: 900, tier_ads: 100 },
    });
    expect(formatTierBlocking(busy)).toBe('1,000 blocks from 2 of 4 tiers');
    expect(busy.summary).toBe('1,000 blocks from 2 of 4 tiers');
  });
});
