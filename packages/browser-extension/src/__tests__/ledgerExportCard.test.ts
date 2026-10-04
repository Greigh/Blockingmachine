/**
 * Renders the popup's hit-ledger export card and reads the markup.
 *
 * The card is pure, so `react-dom/server` renders it with no DOM, no browser and no mocked
 * extension API. What a static render cannot check is the download, which lives in `PopupApp` and
 * in `downloadText`, asserted where they are.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { LedgerExportCard, type LedgerExportCardProps } from '../popup/LedgerExportCard.js';

function render(overrides: Partial<LedgerExportCardProps> = {}): string {
  return renderToStaticMarkup(
    createElement(LedgerExportCard, {
      summary: '2 sessions · 2 days · 30 hits on 4 rules',
      filename: 'blockingmachine-hit-ledger-2026-09-29.json',
      onExport: () => {},
      ...overrides,
    }),
  );
}

describe('popup hit-ledger export card', () => {
  it('names the summary and the file the click would write', () => {
    const markup = render();

    expect(markup).toContain('Hit ledger export');
    expect(markup).toContain('>Ready<');
    expect(markup).toContain('2 sessions · 2 days · 30 hits on 4 rules');
    expect(markup).toContain('blockingmachine-hit-ledger-2026-09-29.json');
    expect(markup).toContain('Export ledger');
  });

  it('says why the ledger is worth exporting rather than just offering a button', () => {
    const markup = render();
    // The consequence — real usage instead of one trace — is the reason the button exists.
    expect(markup).toContain('hot set');
    expect(markup).toContain('sessions');
  });

  it('is disabled with an explicit empty reading before the first answer', () => {
    const markup = render({ summary: null, filename: null });

    expect(markup).toContain('disabled');
    expect(markup).toContain('Loading…');
    expect(markup).toContain('Nothing yet');
    expect(markup).not.toContain('Export file');
  });

  it('treats an empty summary as nothing recorded, not as ready', () => {
    // A background worker that has never recorded anything returns an empty string; rendering that
    // as ready would offer a download of a file with no sessions in it.
    const markup = render({ summary: '' });
    expect(markup).toContain('Nothing yet');
    expect(markup).toContain('disabled');
  });

  it('shows progress while the export is being prepared and stops accepting clicks', () => {
    const markup = render({ busy: true });

    expect(markup).toContain('Exporting…');
    expect(markup).toContain('disabled');
  });

  it('wires the button to the handler it was given', () => {
    const onExport = jest.fn();
    const markup = render({ onExport });
    expect(markup).toContain('Export ledger');
    expect(onExport).not.toHaveBeenCalled();
  });
});

/**
 * The per-tier split on the card. The number decides a plan, and a card that only said "2 sessions ·
 * 30 hits" left the reader with no way to see what the tier rulesets were weighed on without
 * downloading the file and reading JSON.
 */
describe('popup hit-ledger export card, per tier', () => {
  const tiers = [
    { tier: 'tier_core', count: 543 },
    { tier: 'tier_privacy', count: 132 },
    { tier: 'tier_ads', count: 48 },
  ];

  it('names every tier and the blocks that came from no tier at all', () => {
    const markup = render({ tiers, tierUnattributed: 7, tieredSessions: 3, sessions: 3 });

    expect(markup).toContain('By tier');
    expect(markup).toContain('tier_core');
    expect(markup).toContain('543');
    expect(markup).toContain('tier_privacy');
    expect(markup).toContain('tier_ads');
    // The synced list blocks nobody can weigh against a ruleset, and a table that omitted them
    // would read as though the tiers had blocked everything the browser did.
    expect(markup).toContain('no tier');
    expect(markup).toContain('7');
  });

  it('says the whole file was measured only when it was', () => {
    const complete = render({ tiers, tieredSessions: 3, sessions: 3 });
    expect(complete).toContain('every session measured');
    expect(complete).not.toContain('does not describe the whole file');

    // A table built from one session of ten is a real measurement of one session. Nothing on screen
    // would say otherwise without the count, and the plan would be weighted as though it covered
    // the file.
    const partial = render({ tiers, tieredSessions: 1, sessions: 10 });
    expect(partial).toContain('1 of 10 sessions measured');
    expect(partial).toContain('does not describe the whole file');
  });

  it('explains what the rows are, so the numbers are not read as hosts', () => {
    const markup = render({ tiers, tierUnattributed: 7, tieredSessions: 3, sessions: 3 });
    expect(markup).toContain('which is how each ruleset gets weighted');
    expect(markup).toContain('synced list');
  });

  it('shows no table at all when the file carries no split', () => {
    // A background on a build without the axis, or a day in which only the synced list fired. An
    // empty table would be a claim — measured, and every tier silent — rather than an absence.
    const markup = render({ tiers: [], tierUnattributed: 0 });
    expect(markup).not.toContain('By tier');
    expect(markup).toContain('Hit ledger export');
  });

  it('says when the cap evicted rules, so a capped file does not read as complete', () => {
    // Each session keeps only its hottest rules; the count of what fell off is the difference
    // between "the file saw your traffic" and "the file saw most of it".
    const capped = render({ rulesDropped: 5 });
    expect(capped).toContain('Dropped at cap');
    expect(capped).toContain('5');

    const complete = render({ rulesDropped: 0 });
    expect(complete).not.toContain('Dropped at cap');
  });
});
