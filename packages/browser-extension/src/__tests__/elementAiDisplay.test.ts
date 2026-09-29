import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MiniAiElementClassifier } from '@blockingmachine/core/element-ai';
import {
  elementAiBadge,
  elementAiEvidenceLine,
  elementAiEvidenceRows,
  elementAiLine,
  elementAiScanSummary,
  elementAiTone,
} from '../shared/elementAiDisplay.js';
import { loadElementFeedback, recordElementDecision, saveElementFeedback } from '../content/elementAiFeedback.js';
import { STORAGE_KEY_ELEMENT_AI_FEEDBACK } from '../shared/constants.js';

describe('element AI display', () => {
  it('maps classes onto tones', () => {
    expect(elementAiTone('Ad')).toBe('ad');
    expect(elementAiTone('Tracker')).toBe('tracker');
    expect(elementAiTone('Annoyance')).toBe('annoyance');
    expect(elementAiTone('Content')).toBe('content');
  });

  it('never overstates certainty', () => {
    const definite = elementAiBadge({
      elementClass: 'Ad',
      confidence: 98,
      action: 'hide',
      corroboration: 'corroborated',
    });
    expect(definite.label).toBe('Likely ad');
    expect(definite.actionLabel).toBe('Safe to hide');
    expect(definite.detail).toBe('98% · corroborated');

    const hint = elementAiBadge({
      elementClass: 'Ad',
      confidence: 52,
      action: 'suggest',
      corroboration: 'single-signal',
    });
    expect(hint.actionLabel).toBe('Possible — confirm first');

    const nothing = elementAiBadge({
      elementClass: 'Content',
      confidence: 0,
      action: 'leave',
      corroboration: 'model-only',
    });
    expect(nothing.detail).toBe('no independent evidence');
  });

  it('keeps the model\'s own reason in the one-line form', () => {
    expect(
      elementAiLine({
        elementClass: 'Tracker',
        confidence: 98,
        action: 'hide',
        corroboration: 'corroborated',
        reasons: ['Loads from a known measurement network (o1.ingest.sentry.io).'],
      }),
    ).toBe('Likely tracker · 98% · corroborated — Loads from a known measurement network (o1.ingest.sentry.io).');

    expect(
      elementAiLine({ elementClass: 'Content', confidence: 20, action: 'leave', corroboration: 'model-only' }),
    ).toBe('Content · 20% · no independent evidence');
  });

  it('summarizes a scan without inflating it', () => {
    expect(elementAiScanSummary({ hide: 0, suggest: 0 })).toBe('Nothing ad-like found on this page.');
    expect(elementAiScanSummary({ hide: 3, suggest: 0 })).toBe('3 likely');
    expect(elementAiScanSummary({ hide: 3, suggest: 2 })).toBe('3 likely · 2 possible');
  });
});

describe('element AI feedback persistence', () => {
  let stored: Record<string, unknown>;

  beforeEach(() => {
    stored = {};
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: jest.fn(async (key: string) => ({ [key]: stored[key] })),
          set: jest.fn(async (patch: Record<string, unknown>) => {
            Object.assign(stored, patch);
          }),
        },
      },
    };
  });

  it('round-trips a decision through storage', async () => {
    const classifier = new MiniAiElementClassifier();
    const snapshot = { tag: 'aside', classes: ['sidebar-unit'] };

    const result = await recordElementDecision(classifier, snapshot, 'hide');
    expect(result.stored).toBe(true);
    expect(classifier.getElementFeedback(snapshot)).toBe(1);

    const restored = new MiniAiElementClassifier();
    expect(await loadElementFeedback(restored)).toBeGreaterThan(0);
    expect(restored.getElementFeedback(snapshot)).toBe(1);
    expect(restored.classify({ tag: 'aside', classes: ['sidebar-unit'] }).action).toBe('hide');
  });

  it('ignores a poisoned storage payload', async () => {
    stored[STORAGE_KEY_ELEMENT_AI_FEEDBACK] = {
      __proto__: 1,
      constructor: 1,
      'div|ad': 'not-a-number',
      'span|cookie': 0.5,
    };
    const classifier = new MiniAiElementClassifier();
    await loadElementFeedback(classifier);
    expect(classifier.exportElementFeedback()).toEqual({ 'span|cookie': 0.5 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('reports failure instead of throwing when storage is unavailable', async () => {
    (globalThis as Record<string, unknown>).chrome = {};
    const classifier = new MiniAiElementClassifier();
    expect(await loadElementFeedback(classifier)).toBe(0);
    expect(await saveElementFeedback(classifier)).toBe(false);
  });
});

describe('element AI evidence rows', () => {
  // Real predictions, not hand-written fixtures: a fixture that drifts from the
  // classifier would make these tests pass while the panel showed something else.
  const predict = (snapshot: Record<string, unknown>): ReturnType<MiniAiElementClassifier['classify']> =>
    new MiniAiElementClassifier().classify(snapshot as never);

  it('names each signal behind an ad verdict, strongest first', () => {
    const rows = elementAiEvidenceRows(
      predict({
        tag: 'aside',
        classes: ['ad-slot-container'],
        attributes: [{ name: 'data-ad-slot', value: 'top' }],
        width: 300,
        height: 250,
      }),
    );

    // Every signal, in the classifier's own precedence: what could act alone first,
    // then the corroboration, and the bare `ad` atom in the class name last.
    expect(rows.map((row) => [row.id, row.strength])).toEqual([
      ['ad-marker', 'definitive'],
      ['ad-attribute', 'definitive'],
      ['ad-size', 'supporting'],
      ['ad-weak-marker', 'supporting'],
    ]);
    expect(rows[0].label).toBe('Ad markup');
    // The class that said ad, not the two-letter atom the rule matched inside it.
    expect(rows[0].detail).toBe('"ad-slot-container"');
    expect(rows[1].label).toBe('Ad delivery attribute');
    expect(rows[1].detail).toBe('data-ad-slot');
    expect(rows[2].detail).toBe('300x250');
    expect(rows[3].label).toBe('Ad-shaped class');
  });

  it('reports a beacon as geometry, with the box it actually measured', () => {
    const rows = elementAiEvidenceRows(predict({ tag: 'img', src: 'https://metrics.example.net/p.gif', width: 1, height: 1 }));
    expect(rows[0].id).toBe('pixel-shape');
    expect(rows[0].label).toBe('Beacon geometry');
    expect(rows[0].detail).toBe('1×1');
    expect(rows[0].strength).toBe('definitive');
  });

  it('shows weak vocabulary as corroboration rather than as a conclusion', () => {
    const rows = elementAiEvidenceRows(predict({ tag: 'div', classes: ['top-fronts-banner-ad-container'], width: 0, height: 0 }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.strength === 'supporting')).toBe(true);
    expect(rows.map((row) => row.id)).toContain('ad-weak-marker');
  });

  it('says why an analytics attribute is not a tracking verdict', () => {
    const prediction = predict({
      tag: 'a',
      classes: ['SocialLinks-module__iconLink'],
      attributes: [{ name: 'data-analytics-event', value: 'click' }],
      href: 'https://www.linkedin.com/company/x',
    });
    const rows = elementAiEvidenceRows(prediction);
    const instrumentation = rows.find((row) => row.id === 'instrumentation');

    expect(prediction.elementClass).toBe('Content');
    expect(instrumentation).toBeDefined();
    expect(instrumentation?.strength).toBe('context');
    expect(instrumentation?.detail).toContain('instrumentation, not a tracker');
    // Context rows come last: they explain what was ruled out, not what was found.
    expect(rows[rows.length - 1]).toBe(instrumentation);
  });

  it('does not guess a strength it was not told', () => {
    // A payload from a content script that shipped the families without their weight.
    const rows = elementAiEvidenceRows({ evidenceFamilies: ['ad-marker', 'url-path'] });
    expect(rows.map((row) => [row.id, row.strength])).toEqual([
      ['ad-marker', 'context'],
      ['url-path', 'context'],
    ]);
  });

  it('survives a prediction with nothing in it, and an unknown family', () => {
    expect(elementAiEvidenceRows({})).toEqual([]);
    expect(elementAiEvidenceRows({ defensiveFamilies: [] } as never)).toEqual([]);
    const unknown = elementAiEvidenceRows({ definitiveFamilies: ['brand-new-signal'] });
    expect(unknown).toEqual([
      { id: 'brand-new-signal', label: 'brand new signal', detail: '', strength: 'definitive' },
    ]);
  });

  it('summarises the rows on one line, dropping what was ruled out', () => {
    const prediction = predict({
      tag: 'div',
      id: 'dfp-ad--inline1',
      classes: ['ad-slot'],
      width: 300,
      height: 250,
      attributes: [{ name: 'data-ad-slot', value: 'inline' }],
    });
    const line = elementAiEvidenceLine(prediction, 2);
    expect(line).toContain('ad markup');
    expect(line).toContain('ad delivery attribute data-ad-slot');
    // Two shown of four signals, and the count of what did not fit.
    expect(line).toContain('+2 more');
    expect(elementAiEvidenceLine({}, 2)).toBe('');
  });
});
