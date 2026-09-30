/**
 * Renders the line that states what the tier plan was weighted by.
 *
 * The wording is load-bearing rather than decorative: it is the only thing telling a user that a
 * recommendation they are about to apply was weighed by measurement rather than by size. So both
 * states are asserted on their content *and* on the `data-basis` attribute, because the attribute
 * is what the stylesheet keys off and what a test can read without matching on prose.
 */

import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { TierPlanBasis } from '../popup/TierPlanBasis.js';
import { buildTierBlocking, planTierBenefits, type PlanBenefitView } from '../shared/tierAttribution.js';
import { STATIC_RULE_TIERS } from '../shared/rulesetTiers.js';

const CATALOGUE = STATIC_RULE_TIERS.map((tier) => ({
  id: tier.id,
  label: tier.label,
  category: tier.category,
}));
const ALL_IDS = CATALOGUE.map((tier) => tier.id);

function render(basis: PlanBenefitView): string {
  return renderToStaticMarkup(createElement(TierPlanBasis, { basis }));
}

describe('popup tier-plan basis line', () => {
  it('says the plan was weighted by measurement, and marks itself as such', () => {
    const basis = planTierBenefits(
      buildTierBlocking({
        tiers: CATALOGUE,
        enabledIds: ALL_IDS,
        hits: { tier_core: 900, tier_ads: 100, tier_privacy: 40, tier_annoyances: 10 },
      }),
    );
    const markup = render(basis);

    expect(markup).toContain('data-basis="evidence"');
    expect(markup).toContain('Weighted by what actually blocked');
    expect(markup).toContain('1,050 attributed blocks');
  });

  it('names the tier it could not measure rather than shrugging at rule counts', () => {
    // The failure this guards: a plan silently reverting to rule counts, which looks like a plan
    // that weighed the evidence and decided the evidence was fine.
    const basis = planTierBenefits(
      buildTierBlocking({
        tiers: CATALOGUE,
        enabledIds: ['tier_core'],
        hits: { tier_core: 900, tier_ads: 0, tier_privacy: 0, tier_annoyances: 0 },
      }),
    );
    const markup = render(basis);

    expect(markup).toContain('data-basis="coverage"');
    expect(markup).toContain('Planned by rule count');
    expect(markup).toContain('Ad networks');
    expect(markup).toContain('its silence is the switch');
  });

  it('says so when there is nothing to plan at all, rather than rendering nothing', () => {
    const basis = planTierBenefits(buildTierBlocking({ tiers: [], enabledIds: [], hits: {} }));
    const markup = render(basis);

    expect(markup).toContain('data-basis="coverage"');
    expect(markup).toContain('No tiers to plan.');
  });
});
