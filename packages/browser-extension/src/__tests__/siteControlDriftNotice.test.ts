/**
 * Renders the line that says the browser is not enforcing the site choices the toggles describe.
 *
 * The wording is load-bearing: it is the only place the popup can say a saved pause is not
 * pausing or a saved allowance is not allowing, and each direction is a different user problem —
 * enforcement missing versus enforcement nobody asked for. Both are asserted, plus the two
 * states that must not be confused with agreement: a view that has not arrived yet, and a
 * browser that would not answer.
 *
 * The drifts are written out rather than produced by `computeSiteControlDrift`, which has its
 * own suite: this one is about what the notice does with a drift, so stating the drift
 * literally keeps a rendering test from failing because a comparison changed.
 */

import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { SiteControlDriftNotice } from '../popup/SiteControlDriftNotice.js';
import type { SiteControlDrift } from '../shared/types.js';

const SYNCED: SiteControlDrift = {
  known: true,
  inSync: true,
  missingPauses: [],
  missingAllowances: [],
  missingRules: [],
  unexpectedPauses: [],
  unexpectedAllowances: [],
  unexpectedRules: [],
  unexpectedBlocking: 0,
};

function drift(partial: Partial<SiteControlDrift>): SiteControlDrift {
  return { ...SYNCED, inSync: false, ...partial };
}

function render(
  d: SiteControlDrift | null | undefined,
  globalPaused = false,
  busy = false,
  applyError?: string,
): string {
  return renderToStaticMarkup(
    createElement(SiteControlDriftNotice, {
      drift: d,
      applyError,
      globalPaused,
      onReapply: () => {},
      busy,
    }),
  );
}

describe('popup site-control drift notice', () => {
  it('renders nothing while the browser agrees with the saved choices', () => {
    // Agreement is the normal state, and a permanent "everything is fine" banner is one
    // nobody reads — the notice has to mean something when it appears.
    expect(render(SYNCED)).toBe('');
  });

  it('renders nothing before the first view arrives — no reading is not agreement', () => {
    expect(render(undefined)).toBe('');
    expect(render(null)).toBe('');
  });

  it('names a saved pause the browser is not enforcing', () => {
    const markup = render(drift({ missingPauses: ['paused.example'] }));
    expect(markup).toContain('data-drift="drifted"');
    expect(markup).toContain('The browser and your saved choices disagree');
    expect(markup).toContain('paused.example');
    expect(markup).toContain('still being filtered');
    expect(markup).toContain('Re-apply my choices');
  });

  it('names a saved allowance the browser is not enforcing', () => {
    const markup = render(drift({ missingAllowances: ['allowed.example'] }));
    expect(markup).toContain('allowed.example');
    expect(markup).toContain('still being blocked');
  });

  it('names a saved rule the browser has no rule for', () => {
    const markup = render(drift({ missingRules: ['||custom.example^'] }));
    expect(markup).toContain('||custom.example^');
    expect(markup).toContain('not in effect');
  });

  it('names a pause the browser is still enforcing that nobody asked for', () => {
    const markup = render(drift({ unexpectedPauses: ['stale.example'] }));
    expect(markup).toContain('stale.example');
    expect(markup).toContain('no longer have saved');
  });

  it('counts the blocklist still held while paused everywhere', () => {
    const markup = render(drift({ unexpectedBlocking: 15000 }), true);
    expect(markup).toContain('paused everywhere');
    expect(markup).toContain('15,000');
    expect(markup).toContain('did not clear');
    expect(markup).toContain('Re-apply the pause');
  });

  it('says an unreadable browser is unread rather than in sync', () => {
    const markup = render(drift({ known: false }));
    expect(markup).toContain('data-drift="unknown"');
    expect(markup).toContain('could not be read');
    expect(markup).toContain('Try again');
    // Not a disagreement claim either: the copy has to leave the possibility open.
    expect(markup).not.toContain('disagree');
  });

  it('labels the button while a reconcile is in flight', () => {
    const markup = render(drift({ missingPauses: ['paused.example'] }), false, true);
    expect(markup).toContain('Re-applying…');
    expect(markup).toContain('disabled');
  });

  it('names the apply failure behind the disagreement, so the gap has a cause rather than only a symptom', () => {
    const markup = render(
      drift({ missingPauses: ['paused.example'] }),
      false,
      false,
      'updateDynamicRules failed: quota exceeded',
    );
    expect(markup).toContain('The last attempt to apply your choices failed');
    expect(markup).toContain('quota exceeded');
  });

  it('names the apply failure on the unread-browser notice too — it is the same missing enforcement', () => {
    const markup = render(drift({ known: false }), false, false, 'service worker torn down');
    expect(markup).toContain('data-drift="unknown"');
    expect(markup).toContain('The last attempt to apply them failed');
    expect(markup).toContain('service worker torn down');
  });
});
