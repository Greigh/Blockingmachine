/**
 * Renders the hub's extension tier plan card.
 *
 * Pure presentational, so `react-dom/server` renders it with no DOM and no Electron API. What
 * matters is the three things a user cannot check for themselves: which tiers survived, what the
 * plan was *worth*, and whether a tier the plan dropped is being confused with one the user turned
 * off — two facts that look identical in a list of numbers.
 */

import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ExtensionTierPlanCard, type TierPlanResult } from '../components/ExtensionTierPlanCard.js';

const RESULT: TierPlanResult = {
  ok: true,
  rulesDir: '/repo/packages/browser-extension/rules',
  capacitySlots: 12033,
  rows: [
    { id: 'tier_core', label: 'Core shield', rules: 33, hits: 1204, errors: [] },
    { id: 'tier_ads', label: 'Ad networks', rules: 23523, hits: 12, errors: [] },
    { id: 'tier_privacy', label: 'Tracking & analytics', rules: 6009, hits: 0, errors: [] },
    { id: 'tier_annoyances', label: 'Consent & nags', rules: 435, hits: 800, errors: [] },
  ],
  broken: [],
  plan: {
    enabled: ['tier_core', 'tier_annoyances'],
    enabledRules: 468,
    totalRules: 30000,
    staticHeadroom: 11565,
    bindingConstraint: 'static',
    benefit: 2004,
    benefitSource: 'evidence',
    explanation: ['Keeping 2 of 4 tiers — 468 rules.', 'Ranked by measured blocking: 2,004 requests.'],
  },
  basis: {
    source: 'evidence',
    reason: 'Weighted by what actually blocked: 2,016 attributed blocks across 4 tiers, including 1 that never fired.',
    unmeasured: [],
  },
  ledger: { lines: 71, skipped: 6, shared: 3 },
};

function render(overrides: Partial<Parameters<typeof ExtensionTierPlanCard>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ExtensionTierPlanCard, { state: 'ready', result: RESULT, ...overrides }),
  );
}

describe('hub extension tier plan card', () => {
  it('leads with the headline: what fits in what', () => {
    const markup = render();
    expect(markup).toContain('Extension tier capacity');
    expect(markup).toContain('468');
    expect(markup).toContain('30,000');
    expect(markup).toContain('12,033 static slots');
    expect(markup).toContain('11,565 free');
  });

  it('shows the measured blocks beside the rules each tier costs', () => {
    const markup = render();
    // The whole reason the card exists: 23,523 rules against 12 measured blocks, visible in one
    // row, is what the plan is reasoning about and what a rule count alone would hide.
    expect(markup).toContain('1,204');
    expect(markup).toContain('23,523');
    expect(markup).toContain('12');
  });

  it('distinguishes a tier the plan dropped from one it never had on', () => {
    // Both read as "not in the plan" in a bare table. One is a recommendation against a tier that
    // is currently on; the other is the user's own choice being reported back untouched.
    const markup = render({
      enabled: ['tier_core', 'tier_ads', 'tier_privacy'],
      result: {
        ...RESULT,
        // A plan that does not turn the off tier on, so all three states appear at once.
        plan: { ...RESULT.plan, enabled: ['tier_core'], enabledRules: 33 },
      },
    });
    // tier_ads and tier_privacy are on and the plan dropped them.
    expect(markup).toMatch(/Ad networks[\s\S]*?Dropped/);
    expect(markup).toMatch(/Tracking &amp; analytics[\s\S]*?Dropped/);
    // tier_annoyances is off and the plan does not recommend it.
    expect(markup).toMatch(/Consent &amp; nags[\s\S]*?Not included/);
  });

  it('reports a tier the plan turns on as kept, not as a change to the user', () => {
    const markup = render({ enabled: ['tier_core'] });
    expect(markup).toMatch(/Consent &amp; nags[\s\S]*?Kept/);
  });

  it('always states the basis, including when the plan fell back to rule counts', () => {
    const evidence = render();
    expect(evidence).toContain('basis-evidence');
    expect(evidence).toContain('Weighted by what actually blocked');

    // A plan ranked by size and a plan ranked by measurement look identical in the tier list, so
    // the basis has to be stated whether or not it is the interesting one.
    const coverage = render({
      result: {
        ...RESULT,
        basis: { source: 'coverage', reason: 'Planned by rule count: the ledger has not measured X.', unmeasured: ['tier_ads'] },
        plan: { ...RESULT.plan, benefitSource: 'coverage' },
      },
    });
    expect(coverage).toContain('basis-coverage');
    expect(coverage).toContain('Planned by rule count');
    expect(coverage).not.toContain('basis-evidence');
  });

  it('says there was no ledger at all rather than implying a measurement of zero', () => {
    const markup = render({ result: { ...RESULT, basis: null, ledger: null } });
    expect(markup).toContain('No ledger was supplied');
    expect(markup).toContain('ranked by rule count');
    // No ledger means the column is absent, not zero.
    expect(markup).toContain('—');
  });

  it('reports the ledger it read, and the hosts two tiers both ship', () => {
    const markup = render();
    expect(markup).toContain('71 measured lines');
    expect(markup).toContain('6 naming no blockable host');
    // A shared host is credited to both tiers, so the measurement is slightly generous. Saying so
    // is better than a plan weighted by a number nobody can account for.
    expect(markup).toContain('3 matching a host two tiers both ship');
  });

  it('refuses to show a plan when a tier file is invalid, and names the tier', () => {
    const markup = render({
      result: {
        ...RESULT,
        broken: [{ id: 'tier_ads', label: 'Ad networks', rules: 0, hits: null, errors: ['priority must be 1'] }],
        rows: RESULT.rows.map((row) =>
          row.id === 'tier_ads' ? { ...row, errors: ['priority must be 1'] } : row,
        ),
      },
    });
    expect(markup).toContain('failed validation');
    expect(markup).toContain('Ad networks');
    expect(markup).not.toContain('11,565 free');
  });

  it('reports a missing ruleset directory as an error, not an empty plan', () => {
    // "Everything fits" over zero tiers looks exactly like a good result, and is not one.
    const markup = render({
      state: 'error',
      result: null,
      error: 'No tier ruleset directory was found.',
    });
    expect(markup).toContain('No tier ruleset directory was found.');
    expect(markup).not.toContain('static slots');
  });

  it('says it is reading rather than rendering a plan of nothing', () => {
    const markup = render({ state: 'loading', result: null });
    expect(markup).toContain('Reading the tier rulesets');
    expect(markup).not.toContain('static slots');
  });
});
