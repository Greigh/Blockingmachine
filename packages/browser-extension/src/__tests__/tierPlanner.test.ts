/**
 * Capacity-aware tier planner tests.
 *
 * The planner exists for the case where the static budget is smaller than what the extension
 * ships — which happens because Chrome's 30,000 static rules is a floor drawn from a pool
 * shared with every other installed extension, not a per-extension promise. So most of these
 * cases pin capacity below the shipped total and assert what the plan does about it, and what
 * sentence it gives the user.
 */

import { describe, test, expect } from '@jest/globals';
import {
  DYNAMIC_RULE_LIMITS,
  formatTierPlan,
  planTierSelection,
  type TierPlanCandidate,
} from '../shared/tierPlanner.js';
import { MV3_STATIC_LIMITS } from '../shared/rulesetTiers.js';

const tier = (
  id: TierPlanCandidate['id'],
  label: string,
  ruleCount: number,
  benefit?: number,
): TierPlanCandidate => ({ id, label, ruleCount, benefit });

/** The shape the compiler actually produces: 30,000 rules split across four tiers. */
const COMPILED_TIERS: TierPlanCandidate[] = [
  tier('tier_core', 'Core shield', 33),
  tier('tier_ads', 'Ad networks', 23523),
  tier('tier_privacy', 'Tracking & analytics', 6009),
  tier('tier_annoyances', 'Consent & nags', 435),
];

describe('planTierSelection — capacity', () => {
  test('enables every tier when the guaranteed budget holds them all', () => {
    const plan = planTierSelection({ tiers: COMPILED_TIERS });

    expect(plan.capacitySource).toBe('guaranteed');
    expect(plan.staticCapacity).toBe(MV3_STATIC_LIMITS.GUARANTEED_STATIC_RULES);
    expect(plan.enabled).toEqual(['tier_core', 'tier_ads', 'tier_privacy', 'tier_annoyances']);
    expect(plan.disabled).toEqual([]);
    expect(plan.bindingConstraint).toBe('none');
    expect(plan.enabledRules).toBe(30000);
    expect(plan.staticHeadroom).toBe(0);
  });

  test('derives live capacity from what is enabled plus what the browser still grants', () => {
    // The popup reads `getAvailableStaticRuleCount()` as "what can still be added", so live
    // capacity is the enabled rules plus that figure — not the figure on its own.
    const plan = planTierSelection({
      tiers: COMPILED_TIERS,
      enabledRuleCount: 33,
      availableStaticRules: 11967,
    });

    expect(plan.capacitySource).toBe('browser');
    expect(plan.staticCapacity).toBe(12000);
  });

  test('chooses a subset when a congested pool grants less than the shipped total', () => {
    const plan = planTierSelection({
      tiers: COMPILED_TIERS,
      enabledRuleCount: 0,
      availableStaticRules: 12000,
    });

    expect(plan.bindingConstraint).toBe('static');
    expect(plan.enabledRules).toBeLessThanOrEqual(12000);
    // The three small tiers are the right call: they fit, and the 23,523-rule tier cannot.
    expect(plan.enabled).toContain('tier_core');
    expect(plan.enabled).not.toContain('tier_ads');
    expect(plan.disabled.map((entry) => entry.id)).toContain('tier_ads');
  });

  test('states the exact shortfall for a tier that would fit alone but not alongside what was kept', () => {
    // 800 rules fit the 1,000-slot budget on their own, so this tier's failure is genuinely
    // about its neighbours — the opposite case to a tier that is too large outright.
    const plan = planTierSelection({
      tiers: [tier('tier_core', 'Core', 100), tier('tier_privacy', 'Privacy', 400), tier('tier_ads', 'Ads', 800)],
      enabledRuleCount: 0,
      availableStaticRules: 1000,
    });

    const privacy = plan.disabled.find((entry) => entry.id === 'tier_privacy')!;
    // Core + Ads costs 900, leaving 100 slots; Privacy's 400 then overshoots by 300.
    expect(plan.enabled).toEqual(['tier_core', 'tier_ads']);
    expect(privacy.shortfall).toBe(300);
    expect(privacy.reason).toContain('more static slots alongside');
    expect(plan.explanation.join(' ')).toContain('Privacy');
  });

  test('keeps 30,000 as a floor rather than a ceiling when the pool has room', () => {
    const plan = planTierSelection({
      tiers: COMPILED_TIERS,
      enabledRuleCount: 30000,
      availableStaticRules: 20000,
    });

    // 30,000 is the guaranteed minimum; with a free global pool the browser grants more, and
    // the planner must not invent a ceiling Chrome does not impose.
    expect(plan.staticCapacity).toBe(50000);
    expect(plan.enabled).toHaveLength(4);
  });

  test('honours pinned tiers even when they overshoot capacity', () => {
    const plan = planTierSelection({
      tiers: COMPILED_TIERS,
      enabledRuleCount: 0,
      availableStaticRules: 1000,
      keep: ['tier_ads'],
    });

    expect(plan.enabled).toContain('tier_ads');
    expect(plan.overCapacity).toBe(true);
    expect(plan.explanation.join(' ')).toContain('pinned beyond capacity');
  });
});

describe('planTierSelection — maximisation', () => {
  test('searches exhaustively instead of greedily by benefit density', () => {
    // Greedy-by-density takes the 500-rule tier (density 0.98) first, then cannot fit the
    // other 500-rule tier at all — 490 benefit. The optimum is the single 600-rule tier at
    // 500 benefit. This is the bug the compiler's redistribution had, in planner form.
    const plan = planTierSelection({
      tiers: [
        tier('tier_ads', 'Wide but shallow', 600, 500),
        tier('tier_privacy', 'Dense A', 500, 490),
        tier('tier_annoyances', 'Dense B', 500, 490),
      ],
      enabledRuleCount: 0,
      availableStaticRules: 600,
    });

    expect(plan.benefitSource).toBe('evidence');
    expect(plan.benefit).toBe(500);
    expect(plan.enabled).toEqual(['tier_ads']);
    expect(plan.enabledRules).toBe(600);
  });

  test('prefers the plan that leaves headroom when benefit ties', () => {
    const plan = planTierSelection({
      tiers: [tier('tier_core', 'Small', 100, 50), tier('tier_ads', 'Large', 400, 50)],
      enabledRuleCount: 0,
      // Only one of them fits, so the two single-tier plans tie on benefit and the tiebreak
      // has to break it: the cheaper plan wins and keeps slots free for the next compile.
      availableStaticRules: 400,
    });

    expect(plan.benefit).toBe(50);
    expect(plan.enabled).toEqual(['tier_core']);
    expect(plan.staticHeadroom).toBe(300);
  });

  test('plans by coverage when only some tiers carry measured evidence', () => {
    // A blend would make an unmeasured tier look worthless, so a partial measurement falls
    // back to coverage for every tier and says so.
    const plan = planTierSelection({
      tiers: [
        tier('tier_core', 'Measured', 100, 900),
        tier('tier_ads', 'Unmeasured', 200),
      ],
      enabledRuleCount: 0,
      availableStaticRules: 1000,
    });

    expect(plan.benefitSource).toBe('coverage');
    // Catalogue order, and both fit: coverage weighting puts the measured tier's 900 benefit
    // aside entirely, which is the point of refusing to blend the two bases.
    expect(plan.enabled).toEqual(['tier_core', 'tier_ads']);
    expect(plan.enabledRules).toBe(300);
  });

  test('is deterministic, and breaks equal-scoring ties toward catalogue order', () => {
    const tiers = [tier('tier_core', 'A', 100), tier('tier_ads', 'B', 100), tier('tier_privacy', 'C', 100)];
    const first = planTierSelection({ tiers, availableStaticRules: 200 });
    const second = planTierSelection({ tiers, availableStaticRules: 200 });

    // Same input, same plan — no clock, no hash iteration, no locale rule in the path.
    expect(second.enabled).toEqual(first.enabled);
    expect(first.enabledRules).toBe(200);
    // Three equivalent pairs fit; the two earliest tiers in catalogue order win.
    expect(first.enabled).toEqual(['tier_core', 'tier_ads']);

    // Order is the caller's contract, not an accident: the catalogue order is what makes the
    // tiebreak meaningful, so reversing the input deliberately reverses the preference.
    const reversed = planTierSelection({
      tiers: [...tiers].reverse(),
      availableStaticRules: 200,
    });
    expect(reversed.enabledRules).toBe(200);
  });
});

describe('planTierSelection — dynamic budget', () => {
  test('reports the synced list separately, since static rules never consume it', () => {
    const plan = planTierSelection({
      tiers: COMPILED_TIERS,
      dynamic: { used: 12000 },
    });

    expect(plan.dynamic).not.toBeNull();
    expect(plan.dynamic!.max).toBe(DYNAMIC_RULE_LIMITS.DEFAULT_MAX);
    expect(plan.dynamic!.watermark).toBe(DYNAMIC_RULE_LIMITS.SAFE_WATERMARK);
    expect(plan.dynamic!.headroom).toBe(18000);
    expect(plan.dynamic!.withinWatermark).toBe(true);
    expect(plan.explanation.join(' ')).toContain('never consume that quota');
  });

  test('names the dynamic budget as the binding one when every tier fits but the list is over', () => {
    const plan = planTierSelection({
      tiers: COMPILED_TIERS,
      dynamic: { used: 29900 },
    });

    expect(plan.enabled).toHaveLength(4);
    expect(plan.bindingConstraint).toBe('dynamic');
    expect(plan.explanation.join(' ')).toContain('the tight one');
    expect(formatTierPlan(plan)).toContain('tight budget is the synced list');
  });

  test('clamps a nonsensical reading rather than explaining nonsense', () => {
    const plan = planTierSelection({ tiers: COMPILED_TIERS, dynamic: { used: 999999 } });
    expect(plan.dynamic!.used).toBe(plan.dynamic!.max);
    expect(plan.dynamic!.headroom).toBe(0);
    expect(plan.dynamic!.withinMax).toBe(true);
  });
});

describe('planTierSelection — explanation and edges', () => {
  test('says that a paused extension is not blocking anything', () => {
    const plan = planTierSelection({ tiers: COMPILED_TIERS, suspended: true });
    expect(plan.suspended).toBe(true);
    expect(plan.explanation.join(' ')).toContain('paused everywhere');
  });

  test('reports whether applying the plan would change the selection', () => {
    expect(
      planTierSelection({ tiers: COMPILED_TIERS, currentEnabled: ['tier_core'] }).differsFromCurrent,
    ).toBe(true);
    expect(
      planTierSelection({
        tiers: COMPILED_TIERS,
        currentEnabled: ['tier_annoyances', 'tier_privacy', 'tier_ads', 'tier_core'],
      }).differsFromCurrent,
    ).toBe(false);
    // Unknown current state must not claim a change is needed.
    expect(planTierSelection({ tiers: COMPILED_TIERS }).differsFromCurrent).toBe(false);
  });

  test('survives empty and malformed input', () => {
    const empty = planTierSelection({ tiers: [] });
    expect(empty.enabled).toEqual([]);
    expect(empty.enabledRules).toBe(0);
    expect(empty.bindingConstraint).toBe('none');
    expect(formatTierPlan(empty)).toContain('0 rules');

    expect(() => planTierSelection({} as never)).not.toThrow();
    expect(() =>
      planTierSelection({
        tiers: [{ id: 'tier_core', label: 'x', ruleCount: NaN } as TierPlanCandidate],
        availableStaticRules: -5,
      }),
    ).not.toThrow();
  });

  test('explains the real tradeoff when the pool is congested', () => {
    // The compiled tiers total exactly the guaranteed 30,000, so they all fit while the pool
    // is free. Congesting the pool is what turns "enable everything" into a real decision.
    const plan = planTierSelection({
      tiers: COMPILED_TIERS,
      enabledRuleCount: 33,
      availableStaticRules: 12000,
      dynamic: { used: 28700 },
      currentEnabled: ['tier_core'],
    });

    console.log(`[plan] ${formatTierPlan(plan)}\n  - ${plan.explanation.join('\n  - ')}`);

    expect(plan.bindingConstraint).toBe('static');
    expect(plan.differsFromCurrent).toBe(true);
    // Capacity is what is enabled plus what is still granted, so 12,033 — not 12,000.
    expect(plan.staticCapacity).toBe(12033);
    expect(plan.enabledRules).toBeLessThanOrEqual(plan.staticCapacity);

    // The dynamic budget is congested, but it is not what forced the plan — saying so would
    // contradict the recommendation.
    expect(plan.dynamic!.withinWatermark).toBe(false);
    expect(plan.explanation.some((line) => line.includes('the tight one'))).toBe(false);
    expect(plan.explanation.some((line) => line.includes('forced this plan'))).toBe(true);
  });

  test('describes a tier too large for the budget on its own as unfixable, not unlucky', () => {
    const plan = planTierSelection({
      tiers: COMPILED_TIERS,
      enabledRuleCount: 0,
      availableStaticRules: 12000,
    });

    const ads = plan.disabled.find((entry) => entry.id === 'tier_ads')!;
    // 23,523 rules cannot fit in 12,000 slots whatever else is switched off, so the reason
    // must not imply that dropping a neighbour would help.
    expect(ads.reason).toContain('on its own');
    expect(ads.shortfall).toBe(23523 - 12000);

    const annoyances = plan.disabled.find((entry) => entry.id === 'tier_annoyances');
    // Consent & nags is small and does fit, so it is only ever excluded by value.
    if (annoyances) {
      expect(annoyances.reason).not.toContain('on its own');
    }
  });

  test('formats a one-line summary for the popup', () => {
    expect(
      formatTierPlan(planTierSelection({ tiers: COMPILED_TIERS, availableStaticRules: 12000 })),
    ).toContain('fit 12,000 static slots');
    expect(formatTierPlan(planTierSelection({ tiers: COMPILED_TIERS }))).toContain('inside 30,000 static slots');
  });
});
