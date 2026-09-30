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
  planTierBenefits,
  tierFromRulesetId,
  type TierAttributionCandidate,
} from '../shared/tierAttribution.js';
import { planTierSelection } from '../shared/tierPlanner.js';
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

/**
 * Feeding the ledger into the tier plan.
 *
 * The planner has accepted a per-tier `benefit` since it was written, and nothing supplied one —
 * the popup computed a ledger-graded blocking card and then planned by rule count anyway, so the
 * card and the recommendation disagreed about what a tier was worth and only the card said so.
 *
 * The failure these pin is specific. A tier that is switched off accumulates no matches, so a plan
 * that read its zero as a measurement would rank every tier the user had deliberately disabled
 * below every tier they had left on, and would argue for re-enabling the ones they turned off. That
 * is an artefact of the switch wearing the costume of a measurement, so the gate is the verdicts
 * rather than the hit counts.
 */
describe('planTierBenefits — whether the ledger may weight the plan', () => {
  const byId = (summary: ReturnType<typeof buildTierBlocking>) =>
    new Map(summary.tiers.map((tier) => [tier.id, tier]));

  test('weights by evidence once every tier has been measured', () => {
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ALL_IDS,
      hits: { tier_core: 900, tier_ads: 100, tier_privacy: 40, tier_annoyances: 10 },
    });
    const view = planTierBenefits(summary);

    expect(view.source).toBe('evidence');
    expect(view.unmeasured).toEqual([]);
    expect(view.benefits).toEqual({
      tier_core: 900,
      tier_ads: 100,
      tier_privacy: 40,
      tier_annoyances: 10,
    });
    expect(view.reason).toContain('1,050 attributed blocks across 4 tiers');
  });

  test('a tier that was on, earned a fair chance, and never fired is a measured zero', () => {
    // This is the case that makes the feature reachable at all. `idle` is enabled with a real
    // sample behind it, so its zero is a result — and it is how a tier that never earns its slots
    // gets argued out of a congested plan.
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ALL_IDS,
      hits: { tier_core: 800, tier_ads: 300, tier_privacy: 120, tier_annoyances: 0 },
    });
    const view = planTierBenefits(summary);

    expect(byId(summary).get('tier_annoyances')?.verdict).toBe('idle');
    expect(view.source).toBe('evidence');
    // Zero, present and finite: which is what keeps the planner on the evidence basis rather
    // than treating a missing number as an absent measurement.
    expect(view.benefits?.tier_annoyances).toBe(0);
    expect(view.reason).toContain('including 1 that never fired');
  });

  test('a tier that was switched off is not measured, and the whole plan falls back', () => {
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      // tier_ads off. Its zero is the switch, not the tier.
      enabledIds: ['tier_core', 'tier_privacy', 'tier_annoyances'],
      hits: { tier_core: 900, tier_ads: 0, tier_privacy: 200, tier_annoyances: 60 },
    });
    const view = planTierBenefits(summary);

    expect(byId(summary).get('tier_ads')?.verdict).toBe('disabled');
    expect(view.source).toBe('coverage');
    expect(view.benefits).toBeNull();
    expect(view.unmeasured).toEqual(['tier_ads']);
    // The reason names the tier and says why, because "planned by rule count" with no
    // explanation is indistinguishable from the plan simply not caring about evidence.
    expect(view.reason).toContain('Ad networks (switched off with no history)');
    expect(view.reason).toContain('its silence is the switch');
  });

  test('a tier with too little traffic behind it is unmeasured, not a zero', () => {
    // Two blocks is not evidence that a tier is worthless; it is evidence that nothing happened.
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ALL_IDS,
      hits: { tier_core: 2, tier_ads: 0, tier_privacy: 0, tier_annoyances: 0 },
    });
    const view = planTierBenefits(summary);

    expect(summary.observed).toBe(false);
    expect(view.source).toBe('coverage');
    expect(view.unmeasured).toEqual(['tier_ads', 'tier_privacy', 'tier_annoyances']);
    expect(view.reason).toContain('not enough traffic yet');
  });

  test('a tier that was on and has since been off keeps its measurement', () => {
    // Switching a tier *off* keeps its history; only switching it *on* clears it. That is what
    // makes a user who has tried each tier once able to reach the evidence basis, rather than the
    // feature being unreachable for anyone who ever turned anything off.
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ['tier_core', 'tier_ads', 'tier_privacy'],
      hits: { tier_core: 500, tier_ads: 400, tier_privacy: 90, tier_annoyances: 12 },
    });
    const view = planTierBenefits(summary);

    expect(byId(summary).get('tier_annoyances')?.verdict).toBe('disabled');
    // Off, but it has a history, so it counts — otherwise the ledger's own retention rule would
    // be silently contradicted by the gate and the evidence basis would be unreachable for anyone
    // who had ever switched a tier off.
    expect(view.source).toBe('evidence');
    expect(view.benefits?.tier_annoyances).toBe(12);
  });

  test('a ledger with nothing in it produces no benefits rather than four zeros', () => {
    const view = planTierBenefits(buildTierBlocking({ tiers: CATALOGUE, enabledIds: ALL_IDS, hits: {} }));
    expect(view.source).toBe('coverage');
    expect(view.benefits).toBeNull();
  });

  test('an empty catalogue is not evidence, it is nothing to plan', () => {
    // "Every tier is measured" is vacuously true of no tiers, and an empty benefit map would
    // claim the plan had been weighted by measurement when there is no plan to weight.
    const view = planTierBenefits(buildTierBlocking({ tiers: [], enabledIds: [], hits: {} }));
    expect(view.benefits).toBeNull();
    expect(view.source).toBe('coverage');
    expect(view.reason).toBe('No tiers to plan.');
  });
});

describe('the ledger changes what the planner keeps', () => {
  // A congested pool where the choice is genuinely open, and where the two bases answer
  // *differently*. Two earlier shapes could not show this: at the planner's own 12,033-slot
  // measurement the ad tier's 23,523 rules exceed the entire budget, so it is dropped either way,
  // and with a 33-rule `tier_core` in the mix that tier rides along in every combination, so both
  // bases landed on the same set for arithmetic reasons rather than because they agreed.
  const CANDIDATES = [
    { id: 'tier_core' as const, label: 'Core shield', ruleCount: 33 },
    { id: 'tier_ads' as const, label: 'Ad networks', ruleCount: 1800 },
    { id: 'tier_privacy' as const, label: 'Tracking & analytics', ruleCount: 1000 },
    { id: 'tier_annoyances' as const, label: 'Consent & nags', ruleCount: 1000 },
  ];
  const CONGESTED = { enabledRuleCount: 0, availableStaticRules: 2100 };

  /** What the ledger saw: one tier did nearly all the work, the other two barely any. */
  const MEASURED: Record<string, number> = {
    tier_core: 5,
    tier_ads: 5000,
    tier_privacy: 10,
    tier_annoyances: 20,
  };

  test('by rule count the plan is won by whichever tiers are biggest', () => {
    const plan = planTierSelection({ tiers: CANDIDATES, ...CONGESTED });

    expect(plan.benefitSource).toBe('coverage');
    // 2,033 rules of core + tracking + consent beats 1,833 of core + ads, purely on size.
    expect(plan.enabled).toEqual(['tier_core', 'tier_privacy', 'tier_annoyances']);
    expect(plan.explanation.join(' ')).toContain('Ranked by rule count');
  });

  test('by measured blocks the same budget keeps the tiers that earned their slots', () => {
    const plan = planTierSelection({
      tiers: CANDIDATES.map((tier) => ({ ...tier, benefit: MEASURED[tier.id] })),
      ...CONGESTED,
    });

    expect(plan.benefitSource).toBe('evidence');
    // Same slots, same tiers, opposite answer: the 1,800-rule ad tier that blocked 5,000 requests
    // beats 2,000 rules of tiers that blocked 30 between them.
    expect(plan.enabled).toEqual(['tier_core', 'tier_ads']);
    expect(plan.benefit).toBe(5005);
    expect(plan.explanation.join(' ')).toContain('Ranked by measured blocking');
    expect(plan.explanation.join(' ')).not.toContain('Ranked by rule count');
  });

  test('a benefit supplied for only some tiers is ignored entirely, not blended', () => {
    // The planner's existing rule, now reachable from the popup: a partial set falls back to
    // coverage rather than comparing a measured tier against an unmeasured one.
    const plan = planTierSelection({
      tiers: CANDIDATES.map((tier) =>
        tier.id === 'tier_ads' ? { ...tier, benefit: MEASURED[tier.id] } : tier,
      ),
      ...CONGESTED,
    });

    expect(plan.benefitSource).toBe('coverage');
    expect(plan.enabled).toEqual(['tier_core', 'tier_privacy', 'tier_annoyances']);
  });

  test('the benefits the bridge hands over actually reach the plan', () => {
    // End to end through the same two calls the popup makes, so the wiring is what is tested
    // rather than the two functions in isolation.
    const summary = buildTierBlocking({
      tiers: CATALOGUE,
      enabledIds: ALL_IDS,
      hits: { tier_core: 5, tier_ads: 5000, tier_privacy: 10, tier_annoyances: 20 },
    });
    const view = planTierBenefits(summary);
    expect(view.benefits).not.toBeNull();

    const plan = planTierSelection({
      tiers: CANDIDATES.map((tier) => ({ ...tier, benefit: view.benefits?.[tier.id] })),
      ...CONGESTED,
    });

    expect(plan.benefitSource).toBe('evidence');
    expect(plan.enabled).toEqual(['tier_core', 'tier_ads']);
  });
});
