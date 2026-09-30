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
    { id: 'tier_core', label: 'Core shield', rules: 33, hits: 1204, redundant: { rules: 2, hosts: 2, complete: false }, errors: [] },
    { id: 'tier_ads', label: 'Ad networks', rules: 23523, hits: 12, redundant: { rules: 19000, hosts: 18402, complete: false }, errors: [] },
    { id: 'tier_privacy', label: 'Tracking & analytics', rules: 6009, hits: 0, redundant: { rules: 6009, hosts: 5911, complete: true }, errors: [] },
    { id: 'tier_annoyances', label: 'Consent & nags', rules: 435, hits: 800, redundant: { rules: 0, hosts: 0, complete: false }, errors: [] },
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
  synced: { hosts: 122801, exceptions: 312, lines: 743634, skipped: 1200 },
  syncedPath: '/Users/greigh/Documents/Blockingmachine/browser.txt',
  redundantTiers: ['tier_privacy'],
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
    // The rows have to carry null hits for this to be a test of the column at all. Leaving the
    // fixture's measured numbers in place made the assertion below pass on an em dash inside the
    // explanation string, which is a different part of the card entirely.
    const markup = render({
      result: {
        ...RESULT,
        basis: null,
        ledger: null,
        rows: RESULT.rows.map((row) => ({ ...row, hits: null })),
      },
    });
    expect(markup).toContain('No ledger was supplied');
    expect(markup).toContain('ranked by rule count');
    // No ledger means the column reads as absent, not as zero. A "0" there is a claim that the
    // tier was measured and never fired, which is the one thing an absent ledger cannot say.
    // Scoped to the one row, because another tier's "0" in the redundancy column would otherwise
    // satisfy a whole-table negative assertion and mask a real zero in the blocked column.
    const coreRow = markup.slice(markup.indexOf('Core shield'), markup.indexOf('Ad networks'));
    expect(coreRow).toContain('<td>—</td>');
    expect(coreRow).not.toContain('<td>0</td>');
  });

  it('names the tier the synced list already blocks entirely', () => {
    // The finding the comparison exists to produce. Four rows of numbers do not announce that one
    // of them duplicates the dynamic rules, so the card says which tier and on what evidence.
    const markup = render();
    expect(markup).toContain('tier-plan-redundant');
    expect(markup).toContain('nothing the synced list does not');
    expect(markup).toContain('Tracking &amp; analytics');
    expect(markup).toContain('122,801 blocked hosts');
    expect(markup).toContain('/Users/greigh/Documents/Blockingmachine/browser.txt');
  });

  it('shows how much of every tier the dynamic rules already cover', () => {
    const markup = render();
    // Partly-redundant tiers stay in their own row rather than being named as findings: 19,000 of
    // 23,523 is mostly duplicated, and mostly-duplicated is not the same decision as fully so.
    expect(markup).toContain('19,000 of 23,523');
    expect(markup).toContain('6,009 of 6,009');
    expect(markup).toContain('2 of 33');
  });

  it('separates "not redundant" from "not compared"', () => {
    // An empty cell reads as "nothing was redundant", which is the reassuring reading and the
    // wrong one when the reason is that no synced list was found to diff against.
    const compared = render({
      result: { ...RESULT, redundantTiers: [] },
    });
    expect(compared).toContain('no tier is redundant with it');
    expect(compared).not.toContain('tier-plan-redundant unknown');

    const absent = render({
      result: { ...RESULT, synced: null, syncedPath: null, redundantTiers: [] },
    });
    expect(absent).toContain('No synced list was found');
    expect(absent).toContain('tier-plan-redundant unknown');
    expect(absent).not.toContain('no tier is redundant with it');
  });

  it('says a redundant tier is not a worthless one', () => {
    // The caveat is the difference between the card recommending a deletion and the card
    // reporting a duplication. Static rules and dynamic rules are separate budgets, so a
    // duplicated tier still buys coverage back if the synced list stops carrying those hosts.
    const markup = render();
    expect(markup).toContain('Redundant is not the same as useless');
    expect(markup).toContain('still cost static slots');
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
        broken: [
          {
            id: 'tier_ads',
            label: 'Ad networks',
            rules: 0,
            hits: null,
            redundant: { rules: 0, hosts: 0, complete: false },
            errors: ['priority must be 1'],
          },
        ],
        rows: RESULT.rows.map((row) =>
          row.id === 'tier_ads' ? { ...row, errors: ['priority must be 1'] } : row,
        ),
      },
    });
    expect(markup).toContain('failed validation');
    expect(markup).toContain('Ad networks');
    expect(markup).not.toContain('11,565 free');
  });

  it('offers to choose a ledger, because the hub holds no measurement of its own', () => {
    // Without this the card is structurally incapable of ever being weighted by measurement: the
    // extension accumulates the blocks and the user exports them, so pointing at that file is the
    // whole mechanism.
    let chosen = 0;
    const markup = render({ onChooseLedger: () => { chosen += 1; } });
    expect(markup).toContain('Weight by a rule-hit ledger');
    expect(chosen).toBe(0);
  });

  it('shows the chosen ledger and offers to forget it', () => {
    let cleared = 0;
    const markup = render({
      result: { ...RESULT, ledgerPath: '/Users/greigh/Downloads/hit-ledger.json' },
      onClearLedger: () => { cleared += 1; },
      onChooseLedger: () => {},
    });
    expect(markup).toContain('/Users/greigh/Downloads/hit-ledger.json');
    expect(markup).toContain('Forget');
    expect(cleared).toBe(0);
  });

  it('says a chosen ledger is gone rather than quietly planning by rule count', () => {
    // "The ledger you picked is missing" and "you have no ledger" lead to different decisions
    // about which one to go and get, so they are not the same message.
    const markup = render({
      result: {
        ...RESULT,
        basis: null,
        ledger: null,
        ledgerPath: '/Users/greigh/Downloads/moved.json',
        ledgerMissing: '/Users/greigh/Downloads/moved.json — ENOENT',
      },
      onChooseLedger: () => {},
    });
    expect(markup).toContain('could not be read');
    expect(markup).toContain('Choose the ledger again');
    expect(markup).toContain('tier-plan-ledger-missing');
    // The plan still renders, ranked by rule count, and says so rather than erroring the card.
    expect(markup).toContain('No ledger was supplied');
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
