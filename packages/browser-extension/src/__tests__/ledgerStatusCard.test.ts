/**
 * Renders the popup's block-ledger card and reads the markup.
 *
 * The card is pure, so `react-dom/server` renders it with no DOM, no browser and no mocked
 * extension API — what these tests read is what the popup paints. What a static render cannot
 * check is the fetch that fills it, which lives in `PopupApp` and is asserted from the background
 * side instead.
 */

import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { LedgerStatusCard } from '../popup/LedgerStatusCard.js';
import type { LedgerStatus } from '../shared/ledgerStatus.js';

function status(overrides: Partial<LedgerStatus> = {}): LedgerStatus {
  return {
    feed: 'live',
    liveAvailable: true,
    pollAvailable: true,
    quota: {
      callsInWindow: 0,
      maxCalls: 20,
      remaining: 20,
      resetsInMs: 0,
      windowMs: 10 * 60 * 1000,
    },
    ...overrides,
  };
}

function render(value: LedgerStatus | null): string {
  return renderToStaticMarkup(createElement(LedgerStatusCard, { status: value }));
}

describe('popup block-ledger card', () => {
  it('shows a loading badge and no rows before the first read', () => {
    const markup = render(null);
    expect(markup).toContain('Block ledger');
    expect(markup).toContain('Loading…');
    expect(markup).not.toContain('Match source');
    expect(markup).not.toContain('getMatchedRules quota');
  });

  it('names the live debug event as the source and the full quota', () => {
    const markup = render(status());
    expect(markup).toContain('mini-status ok');
    expect(markup).toContain('>Live<');
    expect(markup).toContain('Match source');
    expect(markup).toContain('Live events');
    expect(markup).toContain('20 of 20 available');
    expect(markup).toContain('onRuleMatchedDebug');
  });

  it('flags the polled path, its cost, and the remaining quota', () => {
    const markup = render(
      status({
        feed: 'polled',
        liveAvailable: false,
        quota: { callsInWindow: 5, maxCalls: 20, remaining: 15, resetsInMs: 0, windowMs: 600_000 },
      }),
    );
    expect(markup).toContain('mini-status warn');
    expect(markup).toContain('>Polled<');
    expect(markup).toContain('15 of 20 left');
    // The detail line has to say *why* a polled count is weaker than a live one.
    expect(markup).toContain('getMatchedRules');
    expect(markup).toContain('without the request URL');
  });

  it('reports an exhausted quota with its reset, not a bare zero', () => {
    const markup = render(
      status({
        feed: 'polled',
        liveAvailable: false,
        quota: { callsInWindow: 20, maxCalls: 20, remaining: 0, resetsInMs: 180_000, windowMs: 600_000 },
      }),
    );
    expect(markup).toContain('none left · next in 3m 00s');
  });

  it('calls out a browser that offers neither reporting path', () => {
    const markup = render(status({ feed: 'unavailable', liveAvailable: false, pollAvailable: false }));
    expect(markup).toContain('mini-status off');
    expect(markup).toContain('>Off<');
    expect(markup).toContain('None');
    expect(markup).toContain('nothing can fill the ledger');
  });
});
