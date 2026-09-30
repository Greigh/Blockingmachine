/**
 * Renders the line that says the browser's enabled tiers disagree with the saved selection.
 *
 * The wording is load-bearing rather than decorative: it is the only place the popup says whether
 * the switches describe what is actually blocking, and the two directions are different user
 * problems — rules blocking that the user turned off, and blocking the user thinks they have and
 * do not. So both directions are asserted, plus the two states that must not be confused with
 * agreement: a browser that would not answer, and the global pause, where the expected browser
 * state is silence rather than the selection.
 *
 * The drifts are written out rather than produced by `compareRulesetState`, which has its own
 * suite: this one is about what the notice does with a drift, so stating the drift literally keeps
 * a rendering test from failing because a comparison changed.
 */

import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { TierDriftNotice } from '../popup/TierDriftNotice.js';
import type { RulesetDrift, StaticTierId } from '../shared/rulesetTiers.js';

/** A catalogue in the shape the notice receives, with the real labels for two of the tiers. */
const TIERS: ReadonlyArray<{ id: StaticTierId; label: string }> = [
  { id: 'tier_core', label: 'Core shield' },
  { id: 'tier_ads', label: 'Ad networks' },
  { id: 'tier_privacy', label: 'Tracking & analytics' },
  { id: 'tier_annoyances', label: 'Consent & nags' },
  { id: 'tier_security', label: 'Threat & malware' },
];

const IN_SYNC: RulesetDrift = { known: true, unexpected: [], missing: [], inSync: true };

function render(drift: RulesetDrift, suspended = false, busy = false): string {
  return renderToStaticMarkup(
    createElement(TierDriftNotice, { drift, tiers: TIERS, suspended, onReapply: () => {}, busy }),
  );
}

describe('popup tier drift notice', () => {
  it('renders nothing while the browser agrees with the selection', () => {
    // Agreement is the normal state, and a permanent "everything is fine" banner is one nobody
    // reads — the notice has to mean something when it appears.
    expect(render(IN_SYNC)).toBe('');
  });

  it('names the tier the browser has on that the selection does not', () => {
    const markup = render({
      known: true,
      unexpected: ['tier_security'],
      missing: [],
      inSync: false,
    });

    expect(markup).toContain('data-drift="drifted"');
    expect(markup).toContain('The browser and your saved selection disagree');
    expect(markup).toContain('Threat &amp; malware');
    expect(markup).toContain('blocking rules you turned off');
    expect(markup).toContain('Re-apply my selection');
  });

  it('names a selected tier the browser has off, and says nothing is blocking', () => {
    const markup = render({ known: true, unexpected: [], missing: ['tier_ads'], inSync: false });

    expect(markup).toContain('Ad networks');
    expect(markup).toContain('not blocking anything right now');
    expect(markup).toContain('that tier is');
  });

  it('renders both directions when both are true', () => {
    // Neither direction stands for the other: a repair that applied one and ignored the other would
    // still leave the user with a blocking state they did not choose.
    const markup = render({
      known: true,
      unexpected: ['tier_ads', 'tier_privacy'],
      missing: ['tier_annoyances'],
      inSync: false,
    });

    expect(markup).toContain('Ad networks, Tracking &amp; analytics');
    expect(markup).toContain('Consent &amp; nags');
    expect(markup).toContain('those tiers are');
    expect(markup.match(/tier-drift-detail/g)).toHaveLength(2);
  });

  it('says an unreadable browser is unread rather than in sync', () => {
    const markup = render({ known: false, unexpected: [], missing: [], inSync: false });

    expect(markup).toContain('data-drift="unknown"');
    expect(markup).toContain('not what is actually blocking');
    expect(markup).toContain('Try again');
    // Not a disagreement claim either: the copy has to leave the possibility open.
    expect(markup).not.toContain('disagree');
  });

  it('speaks about the pause, not the selection, while blocking is paused everywhere', () => {
    const markup = render(
      { known: true, unexpected: ['tier_core'], missing: [], inSync: false },
      true,
    );

    expect(markup).toContain('paused everywhere');
    expect(markup).toContain('the pause did not silence it');
    expect(markup).toContain('Re-apply the pause');
  });

  it('labels the button while a reconcile is in flight', () => {
    const markup = render({ known: true, unexpected: [], missing: ['tier_core'], inSync: false }, false, true);

    expect(markup).toContain('Re-applying…');
    expect(markup).toContain('disabled');
  });
});
