/**
 * Renders the tier card's redundancy line and reads the markup.
 *
 * The states are asserted on `data-state` rather than prose — the same reason `TierPlanBasis`
 * carries `data-basis` — because they are different facts a user could confuse: the browser
 * refusing to list its rules is not "nothing is redundant", and an installed set that names no
 * whole domain is not "we could not check". The component is pure, so `react-dom/server` covers
 * it with no browser and no mocked extension API; the message that fills it lives in `PopupApp`
 * and the background's `GET_TIER_REDUNDANCY` handler.
 */

import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  TierRedundancyNotice,
  type TierRedundancyNoticeProps,
} from '../popup/TierRedundancyNotice.js';
import type { TierRedundancyReport } from '../background/tierRedundancy.js';

const TIERS = [
  { id: 'tier_core', label: 'Core' },
  { id: 'tier_ads', label: 'Ads' },
];

function report(overrides: Partial<TierRedundancyReport> = {}): TierRedundancyReport {
  return {
    synced: { hosts: 41_000, exceptions: 2, lines: 45_000, skipped: 4_000 },
    userOwned: null,
    tiers: {},
    redundantTiers: [],
    ...overrides,
  };
}

function render(overrides: Partial<TierRedundancyNoticeProps> = {}): string {
  return renderToStaticMarkup(
    createElement(TierRedundancyNotice, { report: report(), tiers: TIERS, ...overrides }),
  );
}

describe('popup tier redundancy notice', () => {
  it('names the tiers that add nothing, with the diff they were checked against', () => {
    const markup = render({ report: report({ redundantTiers: ['tier_core', 'tier_ads'] }) });

    expect(markup).toContain('data-state="finding"');
    expect(markup).toContain('2 tiers block');
    expect(markup).toContain('nothing the synced list&#x27;s rules do not: Core, Ads');
    expect(markup).toContain('41,000');
    expect(markup).toContain('(2 excepted)');
    // The caveat travels with the finding, so "redundant" is never read as "delete this".
    expect(markup).toContain('not the same as useless');
  });

  it('says so when every tier still adds coverage the dynamic rules lack', () => {
    const markup = render();

    expect(markup).toContain('data-state="none"');
    expect(markup).toContain('Every tier blocks something the synced list&#x27;s rules do not');
  });

  it('distinguishes a browser refusal from an empty finding', () => {
    const markup = render({ report: report({ synced: null }) });

    expect(markup).toContain('data-state="unknown"');
    expect(markup).toContain('could not be read');
    expect(markup).not.toContain('no tier is redundant');
  });

  it('distinguishes nothing-installed from rules-that-name-no-domain', () => {
    const empty = render({
      report: report({ synced: { hosts: 0, exceptions: 0, lines: 0, skipped: 0 } }),
    });
    expect(empty).toContain('data-state="empty"');
    expect(empty).toContain('No dynamic rules are installed');

    const scoped = render({
      report: report({ synced: { hosts: 0, exceptions: 0, lines: 12, skipped: 12 } }),
    });
    expect(scoped).toContain('data-state="empty"');
    expect(scoped).toContain('12 dynamic rules installed');
    expect(scoped).toContain('none from the synced list blocking a whole domain');
  });

  it('names host-covered-but-type-limited tiers instead of calling them redundant', () => {
    // A tier whose hosts all sit under six-type blocks is not redundant — navigations and
    // websockets still rely on it. The sentence must say so rather than imply full coverage.
    const markup = render({
      report: report({
        tiers: {
          tier_ads: {
            total: 2,
            redundant: { rules: 2, hosts: 2, typeLimited: 2, complete: false },
            userCovered: null,
          },
        },
      }),
    });

    expect(markup).toContain('data-state="none"');
    expect(markup).toContain('Ads is host-covered, but only for the request types the synced rules claim');
    expect(markup).not.toContain('data-state="finding"');
  });

  it('names the user\'s own rules separately instead of folding them into the diff', () => {
    // A hand-typed rule shares the list's priority band, so "covered by your rules" and
    // "covered by the list" have to stay different numbers in the sentence — folding them in
    // would report the provenance the split exists to expose.
    const markup = render({
      report: report({
        userOwned: { hosts: 7, exceptions: 0, lines: 7, skipped: 0 },
      }),
    });

    expect(markup).toContain('41,000');
    expect(markup).toContain('plus 7 from your own rules');
  });
});
