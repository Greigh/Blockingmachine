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
