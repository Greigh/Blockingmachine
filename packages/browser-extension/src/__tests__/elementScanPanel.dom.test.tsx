/**
 * The element-scan panel's behaviour, in a real DOM.
 *
 * `elementScanPanel.test.ts` already renders this component with
 * `react-dom/server.renderToStaticMarkup` and covers the markup thoroughly: the summary
 * line, the group list, the evidence rows, the strength classes, the five-group cap, the
 * button labels and the `disabled` attributes. That suite is worth keeping — it is fast and
 * it pins the exact markup the stylesheet and the picker HUD key off.
 *
 * What it cannot do is press anything, and it says so itself. A static render has no event
 * loop, so every handler in the panel is passed in as `jest.fn()` and asserted as *wiring*
 * only. That leaves the most consequential contract in the component untested: `onHide`
 * takes an optional selector list, and **omitting it means "hide everything the scan
 * found"** — real elements on a real page, with no confirmation and no undo in this
 * component. A panel that passed every markup assertion and called `onHide(['.ad-slot-0'])`
 * from the "Hide all 7" button would have been completely green.
 *
 * So these tests fire the buttons. They query the way a person would — by role and
 * accessible name — so they also check the panel is operable without a CSS selector, and
 * they assert the *arguments*, because for the bulk action the argument is the whole point.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ElementScanPanel, type ElementScanResult } from '../popup/ElementScanPanel.js';

afterEach(cleanup);

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
        label: 'Ad container markup.',
        reason: 'Likely ad · 98% · corroborated.',
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
        reason: 'Content · 84% · corroborated.',
        evidence: [
          { id: 'layout-marker', label: 'Layout word ads also use', detail: '"banner"', strength: 'supporting' },
        ],
      },
    ],
    ...overrides,
  };
}

function renderPanel(
  overrides: {
    scan?: ElementScanResult | null;
    busy?: boolean;
    harvest?: { summary: string; filename: string; busy: boolean } | null;
  } = {},
) {
  const props = {
    scan: overrides.scan ?? null,
    busy: overrides.busy ?? false,
    harvest: overrides.harvest ?? null,
    onScan: jest.fn(),
    onHide: jest.fn(),
    onHighlight: jest.fn(),
    onExportHarvest: jest.fn(),
  };
  return { ...render(<ElementScanPanel {...props} />), props };
}

describe('element scan panel — what the buttons do', () => {
  it('asks for a scan, and asks again on rescan', () => {
    const first = renderPanel();
    screen.getByRole('button', { name: 'Scan page' }).click();
    expect(first.props.onScan).toHaveBeenCalledTimes(1);

    cleanup();

    const second = renderPanel({ scan: scanResult() });
    screen.getByRole('button', { name: 'Rescan' }).click();
    expect(second.props.onScan).toHaveBeenCalledTimes(1);
  });

  it('hides one group by its own selector, not the first one every time', () => {
    // The regression this guards is quiet and total: if every group's button closed over
    // the same selector, the panel would still look perfect and would hide the wrong thing
    // on every group after the first. Found by name rather than by reaching into `.ai-group`,
    // because the name is what a screen-reader user navigates by \u2014 a test that reaches past it
    // works around the very thing it should be checking.
    const { props } = renderPanel({ scan: scanResult() });
    const groups = document.querySelectorAll('.ai-group');
    expect(groups).toHaveLength(2);

    const secondHide = screen.getByRole('button', { name: /top-fronts-banner-ad-container/ });
    secondHide.click();

    expect(props.onHide).toHaveBeenCalledTimes(1);
    expect(props.onHide).toHaveBeenCalledWith(['.top-fronts-banner-ad-container']);
  });

  it('names every group\u2019s Hide button after what it removes', () => {
    // N groups used to render N buttons whose entire accessible name was "Hide", on the one action
    // in the panel that takes content off the page. Visible text is still "Hide" \u2014 the row above
    // already shows the selector to anyone who can see it \u2014 so this is invisible to exactly the
    // people it is for, which is why it has to be asserted.
    const { props } = renderPanel({ scan: scanResult() });
    expect(screen.getByRole('button', { name: 'Hide 2 elements matching .adsbygoogle' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Hide 8 elements matching .top-fronts-banner-ad-container' }),
    ).toBeTruthy();
    // One per group, and none of them the bare "Hide" the markup used to render.
    expect(screen.getAllByRole('button', { name: /^Hide \d+ elements? matching / })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull();

    // And the label is not decoration: it still acts on the group it names.
    screen.getByRole('button', { name: 'Hide 2 elements matching .adsbygoogle' }).click();
    expect(props.onHide).toHaveBeenCalledWith(['.adsbygoogle']);
  });

  it('hides everything the scan found when the bulk button is pressed', () => {
    // The whole reason `onHide`'s selector list is optional. "Hide all 2" must call
    // `onHide()` with no argument: an empty array would read as "hide nothing" to a caller
    // written as `selectors ?? everything`, and a list of the listed selectors would hide
    // five groups of a cap rather than the page.
    const { props } = renderPanel({ scan: scanResult() });
    screen.getByRole('button', { name: 'Hide all 2' }).click();

    expect(props.onHide).toHaveBeenCalledTimes(1);
    expect(props.onHide).toHaveBeenCalledWith();
  });

  it('counts the hides it offers in the button, so the number is confirmed before the click', () => {
    // `hideCount` is what production decided, not what the panel chose to list — with the
    // five-group cap that is usually a bigger number than the rows on screen, so the label
    // is the only place the person learns the bulk action is wider than it looks.
    const many: ElementScanResult = {
      scanned: 10,
      hideCount: 7,
      suggestCount: 0,
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
    const { props } = renderPanel({ scan: many });
    // Eight groups exist, five are listed, and the button still says seven.
    expect(document.querySelectorAll('.ai-group')).toHaveLength(5);
    screen.getByRole('button', { name: 'Hide all 7' }).click();
    expect(props.onHide).toHaveBeenCalledWith();
  });

  it('locates the elements on the page, and hides nothing while doing it', () => {
    const { props } = renderPanel({ scan: scanResult() });
    screen.getByRole('button', { name: 'Show me where' }).click();
    expect(props.onHighlight).toHaveBeenCalledTimes(1);
    expect(props.onHide).not.toHaveBeenCalled();
  });

  it('does nothing at all while a scan is running', () => {
    // The static suite can see `disabled=""` in the markup. Only a DOM can prove the
    // consequence: a scan in flight and a hide issued from the same sweep would race, and
    // the hide would act on a page the scan is still reading.
    const { props } = renderPanel({ scan: scanResult(), busy: true });
    expect(screen.getByRole('button', { name: 'Scanning…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Hide all 2' })).toBeDisabled();

    for (const button of screen.getAllByRole('button', { name: /^Hide \d+ elements? matching / })) {
      expect(button).toBeDisabled();
      button.click();
    }
    expect(props.onHide).not.toHaveBeenCalled();
    expect(props.onScan).not.toHaveBeenCalled();
  });

  it('exports the captured elements on request, and not while an export is in flight', () => {
    const harvest = { summary: '7 element(s) from 3 site(s), 2 with a decision from you.', filename: 'x.jsonl', busy: false };
    const { props } = renderPanel({ scan: scanResult(), harvest });

    screen.getByRole('button', { name: 'Export captured elements' }).click();
    expect(props.onExportHarvest).toHaveBeenCalledTimes(1);

    cleanup();

    // The export drains the buffer, so pressing it twice exports the second time from an
    // empty buffer and loses the first file. The lock is the only guard.
    const busyProps = {
      scan: scanResult(),
      busy: false,
      harvest: { ...harvest, busy: true },
      onScan: jest.fn(),
      onHide: jest.fn(),
      onHighlight: jest.fn(),
      onExportHarvest: jest.fn(),
    };
    render(<ElementScanPanel {...busyProps} />);
    const exporting = screen.getByRole('button', { name: 'Exporting…' });
    expect(exporting).toBeDisabled();
    exporting.click();
    expect(busyProps.onExportHarvest).not.toHaveBeenCalled();
  });
});

describe('element scan panel — what a person can reach', () => {
  it('offers the same three actions in the same place whatever the scan found', () => {
    // A scan that found nothing actionable must not rearrange the panel: the controls stay
    // where they were, and only the "hide everything" one is absent because there is
    // nothing to hide.
    renderPanel({ scan: scanResult({ groups: [], hideCount: 0, suggestCount: 0 }) });
    expect(screen.getByRole('button', { name: 'Rescan' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Show me where' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^Hide all/ })).toBeNull();
  });

  it('leaves a scan in progress unable to start a second one', () => {
    // A double press would run two scans and the second result would overwrite the first,
    // so the person would act on a page state the model never read.
    const { props } = renderPanel({ busy: true });
    const button = screen.getByRole('button', { name: 'Scanning…' });
    button.click();
    expect(props.onScan).not.toHaveBeenCalled();
  });

  it('gives every group its own row, with the class and confidence the verdict rests on', () => {
    // Structure rather than strings: a group is a `.ai-group` carrying a tone class the
    // stylesheet colours by, and the copy inside it is what the decision was based on.
    renderPanel({ scan: scanResult() });
    const groups = Array.from(document.querySelectorAll('.ai-group'));
    expect(groups.map((group) => group.className)).toEqual([
      expect.stringContaining('tone-'),
      expect.stringContaining('tone-'),
    ]);
    expect(groups[0]).toHaveTextContent('.adsbygoogle');
    expect(groups[0]).toHaveTextContent('Ad · 98% · 2 elements');
    expect(groups[1]).toHaveTextContent('Content · 84% · 8 elements');
    // The evidence is inside the group it explains, not pooled at the bottom of the list.
    expect(within(groups[0] as HTMLElement).getByText('Ad markup')).toBeInTheDocument();
    expect(within(groups[1] as HTMLElement).queryByText('Ad markup')).toBeNull();
  });
});
