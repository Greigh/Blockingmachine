/**
 * Renders the popup's element-scan panel and reads the markup.
 *
 * The panel was untestable where it lived: it was inline in `PopupApp`, which owns
 * `chrome.*` messaging and half a dozen pieces of state, so the only way to reach the
 * markup was to stand up a DOM and a mocked extension API. It is now a pure component,
 * and `react-dom/server` renders it with no DOM at all — `renderToStaticMarkup` runs the
 * real component and returns the real markup, so what these tests read is what the popup
 * paints.
 *
 * What this cannot check is clicks: a static render has no event loop. The handlers are
 * the popup's own callbacks, passed in and asserted as wiring, not fired here.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ElementScanPanel, type ElementScanResult } from '../popup/ElementScanPanel.js';

/** A scan result shaped exactly like the one the content script sends. */
function scanResult(overrides: Partial<ElementScanResult> = {}): ElementScanResult {
  return {
    scanned: 1019,
    hideCount: 2,
    suggestCount: 1,
    groups: [
      {
        selector: '.adsbygoogle',
        matches: 2,
        elementClass: 'Ad',
        count: 2,
        confidence: 98,
        label: 'Ad container markup ("adsbygoogle").',
        reason: 'Likely ad · 98% · corroborated — Ad container markup ("adsbygoogle").',
        evidence: [
          { id: 'ad-marker', label: 'Ad markup', detail: '"adsbygoogle"', strength: 'definitive' },
          { id: 'ad-size', label: 'Standard ad size', detail: '300x250', strength: 'supporting' },
        ],
      },
      {
        selector: '.top-fronts-banner-ad-container',
        matches: 8,
        elementClass: 'Content',
        count: 8,
        confidence: 84,
        label: 'Layout vocabulary that ads also use ("banner").',
        reason: 'Content · 84% · corroborated — Layout vocabulary that ads also use ("banner").',
        evidence: [
          { id: 'ad-weak-marker', label: 'Ad-shaped class', detail: '"ad"', strength: 'supporting' },
          { id: 'layout-marker', label: 'Layout word ads also use', detail: '"banner"', strength: 'supporting' },
        ],
      },
      {
        selector: 'a.SocialLinks-module__iconLink',
        matches: 7,
        elementClass: 'Tracker',
        count: 7,
        confidence: 58,
        label: 'Single weak signal.',
        reason: 'Likely tracker · 58% · one weak signal.',
        evidence: [
          { id: 'weak-marker', label: 'Social vocabulary', detail: '"social"', strength: 'supporting' },
          {
            id: 'instrumentation',
            label: 'Page analytics attribute',
            detail: 'data-analytics-event — instrumentation, not a tracker',
            strength: 'context',
          },
        ],
      },
    ],
    ...overrides,
  };
}

function render(
  scan: ElementScanResult | null,
  busy = false,
  harvest: { summary: string; filename: string; busy: boolean } | null = null,
): string {
  return renderToStaticMarkup(
    createElement(ElementScanPanel, {
      scan,
      busy,
      onScan: jest.fn(),
      onHide: jest.fn(),
      onHighlight: jest.fn(),
      harvest,
      onExportHarvest: jest.fn(),
    }),
  );
}

describe('popup element scan panel', () => {
  it('renders the summary and the blank state before a scan', () => {
    const before = render(null);
    expect(before).toContain('Scan page');
    expect(before).not.toContain('ai-summary');
    expect(before).not.toContain('ai-group');
  });

  it('lists each group with its class, confidence and match count', () => {
    const markup = render(scanResult());
    expect(markup).toContain('2 likely · 1 possible');
    expect(markup).toContain('1,019 elements examined');
    expect(markup).toContain('.adsbygoogle');
    expect(markup).toContain('Ad · 98% · 2 elements');
    expect(markup).toContain('Content · 84% · 8 elements');

    // A single match reads in the singular.
    const single = render(
      scanResult({
        groups: [{ ...scanResult().groups[0], selector: '.single-ad', matches: 1 }],
      }),
    );
    expect(single).toContain('Ad · 98% · 1 element<');
  });

  it('renders the evidence rows the verdict rests on', () => {
    const markup = render(scanResult());
    expect(markup).toContain('Ad markup');
    expect(markup).toContain('&quot;adsbygoogle&quot;');
    expect(markup).toContain('Standard ad size');
    expect(markup).toContain('300x250');
  });

  it('carries the evidence weight into the markup, not just the words', () => {
    const markup = render(scanResult());
    // The class names are what the CSS colours and what a reader scans for, and the
    // marker is the same one the picker HUD draws.
    expect(markup).toContain('ai-evidence-row strength-definitive');
    expect(markup).toContain('ai-evidence-row strength-supporting');
    expect(markup).toContain('ai-evidence-row strength-context');
    expect(markup).toContain('●');
    expect(markup).toContain('○');
  });

  it('shows the analytics attribute as context, worded as not-a-tracker', () => {
    const markup = render(scanResult());
    expect(markup).toContain('Page analytics attribute');
    expect(markup).toContain('instrumentation, not a tracker');
    // And it comes after the real evidence for that group.
    expect(markup.indexOf('Page analytics attribute')).toBeGreaterThan(markup.indexOf('Social vocabulary'));
  });

  it('renders a group with no evidence without an empty list', () => {
    const markup = render(
      scanResult({
        groups: [
          {
            selector: '.hero',
            matches: 1,
            elementClass: 'Content',
            count: 1,
            confidence: 45,
            label: 'Page copy.',
            reason: 'Content · 45% — Page copy.',
          },
        ],
      }),
    );
    expect(markup).toContain('.hero');
    expect(markup).not.toContain('ai-group-evidence');
  });

  it('lists at most five groups, and only offers to hide when there is something to hide', () => {
    const many: ElementScanResult = {
      scanned: 10,
      hideCount: 0,
      suggestCount: 3,
      groups: Array.from({ length: 8 }, (_, index) => ({
        selector: `.ad-slot-${index}`,
        matches: 1,
        elementClass: 'Annoyance' as const,
        count: 1,
        confidence: 52,
        label: 'Shape.',
        reason: 'Likely annoyance · 52% · one weak signal.',
      })),
    };
    const markup = render(many);
    expect(markup).toContain('.ad-slot-4');
    expect(markup).not.toContain('.ad-slot-5');
    // Nothing to hide means no "Hide all" button, but "Show me where" always applies.
    expect(markup).not.toContain('Hide all');
    expect(markup).toContain('Show me where');
  });

  it('labels the scan button for the state it is in, and locks it while running', () => {
    // Nothing scanned yet: the first action is a scan.
    expect(render(null)).toContain('>Scan page<');
    // Scanned, idle: the action is to do it again.
    expect(render(scanResult())).toContain('>Rescan<');
    // Running: the button says so and cannot be pressed twice. The group and "Hide all"
    // buttons lock with it, so a scan cannot race a hide.
    const busy = render(scanResult(), true);
    expect(busy).toContain('Scanning…');
    expect(busy).toContain('<button class="chip-btn" disabled="">Scanning…</button>');
    expect(busy).toContain('<button class="chip-btn primary" disabled="">Hide all 2</button>');
  });

  it('offers the harvest export with its count, and says what happens to the buffer', () => {
    // No readout yet (the background has not answered): no offer, because a button that
    // cannot say what it would export is a button nobody can consent to.
    expect(render(scanResult())).not.toContain('Export captured elements');

    const withHarvest = render(scanResult(), false, {
      summary: '7 element(s) from 3 site(s), 2 with a decision from you.',
      filename: 'blockingmachine-element-harvest-2026-09-30.jsonl',
      busy: false,
    });
    expect(withHarvest).toContain('Export captured elements');
    expect(withHarvest).toContain('7 element(s) from 3 site(s), 2 with a decision from you.');
    // The export is destructive, so the title says so rather than leaving it to be found
    // out after the fact.
    expect(withHarvest).toContain('clears this buffer');
    expect(withHarvest).toContain('ai-harvest');

    const busy = render(scanResult(), false, {
      summary: '7 element(s) from 3 site(s), 2 with a decision from you.',
      filename: 'x.jsonl',
      busy: true,
    });
    expect(busy).toContain('Exporting…');
    expect(busy).toContain('disabled=""');
  });
});
