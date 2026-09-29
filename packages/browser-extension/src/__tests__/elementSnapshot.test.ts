import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { isCandidateElement, snapshotElement } from '../content/elementSnapshot.js';
import { createFakeElement, installFakePage, type FakePage } from './helpers/fakePage.js';

let page: FakePage;

beforeEach(() => {
  page = installFakePage([
    { tag: 'div', id: 'div-gpt-ad-1', classes: ['ad-slot'], width: 728, height: 90, text: '  Advert  ' },
    { tag: 'p', classes: ['post-content'], text: 'x'.repeat(5000), width: 800, height: 400 },
  ]);
});

afterEach(() => {
  page.destroy();
});

describe('snapshotElement', () => {
  it('reports only what the element actually has', () => {
    const [slot] = page.elements;
    const snapshot = snapshotElement(slot, { computed: false });

    expect(snapshot.tag).toBe('div');
    expect(snapshot.id).toBe('div-gpt-ad-1');
    expect(snapshot.classes).toEqual(['ad-slot']);
    expect(snapshot.width).toBe(728);
    expect(snapshot.height).toBe(90);
    expect(snapshot.text).toBe('Advert');
    expect(snapshot.viewportWidth).toBe(1440);
    expect(snapshot.href).toBeUndefined();
    expect(snapshot.src).toBeUndefined();
  });

  it('caps text so a whole-page scan cannot drag a document through the model', () => {
    const [, paragraph] = page.elements;
    const snapshot = snapshotElement(paragraph, { computed: false });
    expect(snapshot.text?.length).toBe(1200);
  });

  it('drops attributes that carry no signal', () => {
    const element = createFakeElement({
      tag: 'div',
      classes: ['x'],
      attributes: [
        { name: 'style', value: 'color: red' },
        { name: 'class', value: 'x' },
        { name: 'data-ad-slot', value: '1234' },
      ],
    });
    const snapshot = snapshotElement(element, { computed: false });
    expect(snapshot.attributes?.map((attribute) => attribute.name)).toEqual(['data-ad-slot']);
  });

  it('passes the first resource attribute through, and never resolves it', () => {
    const frame = createFakeElement({
      tag: 'iframe',
      attributes: [{ name: 'src', value: 'https://securepubads.g.doubleclick.net/x' }],
      width: 300,
      height: 250,
    });
    expect(snapshotElement(frame, { computed: false }).src).toBe('https://securepubads.g.doubleclick.net/x');

    const relative = createFakeElement({ tag: 'a', attributes: [{ name: 'href', value: '/pricing' }] });
    // Resolving this against the page origin would manufacture a same-site source.
    expect(snapshotElement(relative, { computed: false }).href).toBe('/pricing');
  });

  it('reports visibility from geometry when computed style is skipped', () => {
    const hidden = createFakeElement({ tag: 'div', width: 0, height: 0 });
    expect(snapshotElement(hidden, { computed: false }).visible).toBe(false);
  });

  it('survives an element with no useful surface at all', () => {
    const bare = createFakeElement({ tag: 'span' });
    const snapshot = snapshotElement(bare, { computed: false });
    expect(snapshot.tag).toBe('span');
    expect(snapshot.classes).toEqual([]);
  });
});

describe('isCandidateElement', () => {
  it('always considers resource-bearing elements', () => {
    for (const tag of ['iframe', 'img', 'ins', 'script', 'embed', 'object']) {
      expect(isCandidateElement(createFakeElement({ tag }))).toBe(true);
    }
  });

  it('prefilters by identifier vocabulary', () => {
    expect(isCandidateElement(createFakeElement({ tag: 'div', classes: ['ad-slot'] }))).toBe(true);
    expect(isCandidateElement(createFakeElement({ tag: 'div', classes: ['cookie-banner'] }))).toBe(true);
    expect(isCandidateElement(createFakeElement({ tag: 'div', classes: ['gtm-script'] }))).toBe(true);
    expect(isCandidateElement(createFakeElement({ tag: 'div', classes: ['hero'] }))).toBe(false);
    expect(isCandidateElement(createFakeElement({ tag: 'p', classes: ['lede'] }))).toBe(false);
  });

  it('catches ad slots that are declared only in attributes', () => {
    const element = createFakeElement({ tag: 'div', attributes: [{ name: 'data-ad-client', value: 'ca-pub-1' }] });
    expect(isCandidateElement(element)).toBe(true);
  });
});
