/**
 * Turning the page into harvest records.
 *
 * Two rules decide whether this is worth having, and both are tested against the same fake
 * page the scanner and the snapshot builder are tested with — the real elements, the real
 * classifier, no mocks in between:
 *
 *  1. **A scan produces unlabelled records.** The model said something about these
 *     elements; nobody has. If capture invented a label here, the corpus would be graded
 *     against the model's own answers, and every number would be perfect and meaningless.
 *  2. **A decision produces a labelled one, from the element the person acted on** — which
 *     is usually something the scan never flagged, and is therefore the more valuable of
 *     the two captures.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { captureDecision, captureScannedElements, MAX_SCANNED_PER_SCAN } from '../content/elementHarvestCapture.js';
import { ElementAiScanner } from '../content/elementScanner.js';
import { installFakePage, type FakePage } from './helpers/fakePage.js';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const CONTEXT = { host: 'theguardian.com', now: NOW };

let page: FakePage;

beforeEach(() => {
  page = installFakePage([
    { tag: 'div', classes: ['adsbygoogle'], width: 300, height: 250 },
    { tag: 'div', classes: ['adsbygoogle'], width: 300, height: 250 },
    {
      tag: 'img',
      attributes: [{ name: 'src', value: 'https://metrics.example.net/p.gif' }],
      width: 1,
      height: 1,
    },
    { tag: 'div', id: 'onetrust-banner-sdk', classes: ['cookie-banner'], width: 1440, height: 200 },
    { tag: 'div', classes: ['hero'], width: 1440, height: 420, text: 'Welcome to our store' },
    { tag: 'div', classes: ['post-content'], text: 'Article copy '.repeat(40), width: 800, height: 1200 },
  ]);
});

afterEach(() => {
  page.destroy();
});

describe('captureScannedElements', () => {
  it('records what the model saw, with its verdict and nothing else', () => {
    const scanner = new ElementAiScanner();
    const result = scanner.scan();
    const records = captureScannedElements(result.candidates, CONTEXT);

    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.host).toBe('theguardian.com');
      expect(record.capturedAt).toBe(NOW);
      expect(typeof record.signature).toBe('string');
      expect(record.signature?.length).toBeGreaterThan(0);
      // The verdict is provenance. The absence of a decision is the point.
      expect(record.human).toBeUndefined();
      expect(['Ad', 'Tracker', 'Annoyance']).toContain(record.verdict.elementClass);
    }
  });

  it('keeps the host and not the URL, and carries no text it does not need', () => {
    const scanner = new ElementAiScanner();
    const records = captureScannedElements(scanner.scan().candidates, CONTEXT);
    const serialized = JSON.stringify(records);
    // The page's own article body must not ride along in a corpus artifact.
    expect(serialized).not.toContain('Article copy');
    expect(records.every((record) => !record.host.includes('/'))).toBe(true);
  });

  it('samples the most confident candidates rather than the first ones found', () => {
    const scanner = new ElementAiScanner();
    const result = scanner.scan();
    const records = captureScannedElements(result.candidates, CONTEXT, 1);
    expect(records).toHaveLength(1);
    const best = Math.max(...result.candidates.map((candidate) => candidate.prediction.confidence));
    expect(records[0].verdict.confidence).toBe(best);
  });

  it('caps a page that found hundreds of candidates', () => {
    // More candidates than the cap, to exercise the cap on its own: one shape repeated past
    // the limit, each with its own snapshot, which is what a page full of the same widget
    // looks like before the scanner de-duplicates it.
    const template = new ElementAiScanner().scan().candidates[0];
    const many = Array.from({ length: MAX_SCANNED_PER_SCAN + 20 }, (_unused, index) => ({
      ...template,
      snapshot: { tag: 'div', classes: [`adsbygoogle-${index}`] },
    }));
    expect(captureScannedElements(many, CONTEXT)).toHaveLength(MAX_SCANNED_PER_SCAN);
  });
});

describe('captureDecision', () => {
  it('attaches the decision the person made, which is the only label a candidate can carry', () => {
    const scanner = new ElementAiScanner();
    const element = page.elements[0] as unknown as Element;
    const record = captureDecision(element, scanner.classifyElement(element, false), 'keep', CONTEXT);
    expect(record.human).toEqual({ action: 'keep', at: NOW });
    expect(record.verdict.elementClass).toBe('Ad');
    // The model still thought it was an ad; the person overrode it. Both are recorded.
    expect(record.snapshot.classes).toContain('adsbygoogle');
  });

  it('captures an element the scan never flagged, which is the more interesting case', () => {
    const scanner = new ElementAiScanner();
    const scannerRecords = captureScannedElements(scanner.scan().candidates, CONTEXT);
    const element = page.elements[5] as unknown as Element;
    const record = captureDecision(element, scanner.classifyElement(element, false), 'keep', CONTEXT);
    // Nothing in the scan would have queued this shape: the person is the only source.
    expect(scannerRecords.some((entry) => entry.signature === record.signature)).toBe(false);
    expect(record.human?.action).toBe('keep');
  });
});
