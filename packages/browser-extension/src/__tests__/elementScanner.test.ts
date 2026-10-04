import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ElementAiScanner } from '../content/elementScanner.js';
import { installFakePage, type FakePage } from './helpers/fakePage.js';

let page: FakePage;

/** A page with one real ad, one tracker pixel, one consent wall and plenty of content. */
function installRealisticPage(): FakePage {
  return installFakePage([
    { tag: 'div', classes: ['adsbygoogle'], width: 300, height: 250 },
    { tag: 'div', classes: ['adsbygoogle'], width: 300, height: 250 },
    { tag: 'div', classes: ['hero'], width: 1440, height: 420, text: 'Welcome to our store' },
    {
      tag: 'img',
      attributes: [{ name: 'src', value: 'https://metrics.example.net/p.gif' }],
      width: 1,
      height: 1,
    },
    {
      tag: 'div',
      id: 'onetrust-banner-sdk',
      classes: ['cookie-banner'],
      width: 1440,
      height: 200,
      text: 'We use cookies. Accept all cookies',
    },
    { tag: 'iframe', attributes: [{ name: 'src', value: 'https://www.youtube.com/embed/abc' }], width: 560, height: 315 },
    { tag: 'div', classes: ['post-content'], text: 'Article copy '.repeat(40), width: 800, height: 1200 },
    { tag: 'a', attributes: [{ name: 'href', value: '/cookie-policy' }], text: 'Cookie Policy' },
  ]);
}

beforeEach(() => {
  page = installRealisticPage();
});

afterEach(() => {
  page.destroy();
});

describe('ElementAiScanner', () => {
  it('finds the ad, tracker and consent clusters and ignores content', () => {
    const scanner = new ElementAiScanner();
    const result = scanner.scan();

    const classes = result.candidates.map((candidate) => candidate.prediction.elementClass);
    expect(classes).toContain('Ad');
    expect(classes).toContain('Tracker');
    expect(classes).toContain('Annoyance');
    // The hero banner, the article body and the cookie-policy link are page content.
    expect(result.candidates.every((candidate) => candidate.prediction.action !== 'leave')).toBe(true);
    expect(result.hideCount).toBeGreaterThanOrEqual(3);
  });

  it('groups a repeated widget into one blockable cluster', () => {
    const scanner = new ElementAiScanner();
    const result = scanner.scan();

    const adsense = result.groups.find((group) => group.selector === '.adsbygoogle');
    expect(adsense).toBeDefined();
    expect(adsense?.count).toBe(2);
    expect(adsense?.matches).toBe(2);
    expect(adsense?.elementClass).toBe('Ad');
    expect(adsense?.confidence).toBeGreaterThan(90);
    expect(adsense?.reason.length).toBeGreaterThan(10);
  });

  it('never proposes a selector that fails cosmetic validation', () => {
    const scanner = new ElementAiScanner();
    const result = scanner.scan();
    for (const group of result.groups) {
      expect(group.selector.startsWith('.')).toBe(true);
      expect(group.matches).toBeGreaterThan(0);
    }
    expect(result.groups.length).toBeLessThanOrEqual(12);
  });

  it('carries the signals behind each group, so the popup can show them', () => {
    const scanner = new ElementAiScanner();
    const result = scanner.scan();

    // The popup never sees the element, so every group has to arrive with its evidence,
    // worded and ranked, or the panel has nothing to show but the class name.
    expect(result.groups.length).toBeGreaterThan(0);
    for (const group of result.groups) {
      expect(group.evidence.length).toBeGreaterThan(0);
      for (const row of group.evidence) {
        expect(row.label.length).toBeGreaterThan(0);
      }
      // Definitive before supporting: the row order is the decision order.
      const strengths = group.evidence.map((row) => row.strength);
      expect(strengths.indexOf('definitive')).toBeLessThanOrEqual(strengths.indexOf('supporting'));
    }

    // And the strongest row names the identifier that said ad, not a bare atom.
    const ads = result.groups.find((group) => group.elementClass === 'Ad');
    const markup = ads?.evidence.find((row) => row.id === 'ad-marker');
    expect(markup?.label).toBe('Ad markup');
    expect(markup?.detail).toContain('adsbygoogle');
    expect(markup?.strength).toBe('definitive');
  });

  it('drops a candidate nested inside an already-kept one of the same class', () => {
    page.destroy();
    page = installFakePage([
      // Both are at ad dimensions on purpose. This test is about the *dedup* rule — a
      // candidate nested inside a kept one of the same class is noise — so the outer has
      // to be kept in the first place, and the only thing that guarantees that is real ad
      // evidence rather than a class word. It used to be 600x400, which had no ad size and
      // therefore left the outer resting on `ad-container` alone; see the next test for
      // what that now does.
      { tag: 'div', classes: ['ad-container'], width: 970, height: 250 },
      { tag: 'div', classes: ['ad-slot'], width: 300, height: 250 },
    ]);
    const container = page.elements[0];
    const child = page.elements[1];
    container.appendChild(child);

    const scanner = new ElementAiScanner();
    const result = scanner.scan();
    const adCandidates = result.candidates.filter((candidate) => candidate.prediction.elementClass === 'Ad');
    // The outer container is the thing worth acting on; the slot inside it is noise.
    expect(adCandidates.length).toBe(1);
    expect(adCandidates[0].element).toBe(container);
  });

  it('leaves a wrapper whose only evidence is a class word, and hides the slot inside it', () => {
    // The asymmetry is load-bearing and unintuitive enough to be worth its own test. A
    // wrapper with `ad-container` and nothing else — no ad size, no delivery attribute, no
    // network — is left alone, while a 300x250 child under it is hidden outright.
    //
    // This is the direct consequence of two corpus-driven rules, and it is the same rule
    // that stopped an empty `<hr class="ad-break">` being removed from the page at 98%
    // confidence. A bare ad token is no longer definitive on its own, and `ad-marker` plus
    // `ad-weak-marker` arriving from one identifier counts as the single hint it is rather
    // than as two independent ones. The wrapper has exactly one hint and no geometry, so it
    // stays.
    //
    // Hiding the inner slot rather than the wrapper is the behaviour that follows from that,
    // and it is the more conservative of the two: the wrapper may hold layout the page needs.
    // The scanner's nested-dedup has nothing to dedup in this shape, which is why the test
    // above uses an outer that is genuinely kept.
    page.destroy();
    page = installFakePage([
      { tag: 'div', classes: ['ad-container'], width: 600, height: 400 },
      { tag: 'div', classes: ['ad-slot'], width: 300, height: 250 },
    ]);
    const container = page.elements[0];
    const child = page.elements[1];
    container.appendChild(child);

    const scanner = new ElementAiScanner();
    const result = scanner.scan();

    expect(scanner.classifyElement(container).action).toBe('leave');
    expect(scanner.classifyElement(child).action).toBe('hide');

    const proposed = result.candidates.filter((candidate) => candidate.prediction.action !== 'leave');
    expect(proposed.map((candidate) => candidate.element)).toEqual([child]);
  });

  it('reports scanning statistics rather than pretending to be exhaustive', () => {
    const scanner = new ElementAiScanner({ maxNodes: 3 });
    const result = scanner.scan();
    expect(result.scanned).toBeLessThanOrEqual(3);
  });

  it('draws and clears highlights without touching the elements themselves', () => {
    const scanner = new ElementAiScanner();
    const result = scanner.scan();

    const drawn = scanner.highlight(result);
    expect(drawn).toBeGreaterThan(0);
    expect(page.documentElement.children.length).toBe(1);
    const container = page.documentElement.children[0];
    expect(container.id).toBe('bm-ai-highlights');
    // One outline per highlighted candidate, each with a label chip.
    expect(container.children.length).toBe(drawn);
    expect(container.children[0].children.length).toBe(1);

    scanner.clearHighlights();
    expect(page.documentElement.children.length).toBe(0);
  });

  it('keeps the classifier it was given, so feedback and scans agree', () => {
    const scanner = new ElementAiScanner();
    const classifier = scanner.getClassifier();
    expect(classifier).toBeDefined();

    const element = page.elements.find((candidate) => candidate.classList.includes('hero'));
    expect(element).toBeDefined();
    if (!element) return;

    // Untuned, a hero banner is page copy the model leaves alone.
    expect(scanner.classifyElement(element).action).toBe('leave');

    // Teaching the shared classifier changes what the next scan proposes.
    classifier.tuneElementFeedback(
      { tag: 'div', classes: ['hero'], width: 100, height: 100 },
      'hide',
    );
    const after = scanner.classifyElement(element);
    expect(after.action).toBe('hide');

    // The class is deliberately *not* pinned to one of the three. A `user-choice` verdict
    // weights Ad, Tracker and Annoyance identically, so which one wins is decided by the
    // residual evidence — and a hero banner is not really any of them. Pinning it made this
    // test a pin on the shipped weight table, not on the property it is named for
    // (cross-validating the prior moved it from Ad to Annoyance without changing the action).
    expect(['Ad', 'Tracker', 'Annoyance']).toContain(after.elementClass);

    // The property itself: the decision came through the *shared* classifier. A scanner
    // with its own classifier never saw the feedback and still leaves the element alone.
    const fresh = new ElementAiScanner();
    expect(fresh.classifyElement(element).action).toBe('leave');
  });

  it('remembers the last scan so blocking actions can reuse it', () => {
    const scanner = new ElementAiScanner();
    expect(scanner.lastScan()).toBeNull();
    const result = scanner.scan();
    expect(scanner.lastScan()).toBe(result);
  });
});
