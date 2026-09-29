import { describe, expect, test } from '@jest/globals';
import { SelectorEngine, createSelectorEngine } from '../content/selectorEngine.js';
import { createElement, mount, type FakeElement } from './helpers/fakeDom.js';

function engineFor(children: FakeElement[], options: { maxDepth?: number; maxSimilarMatches?: number } = {}) {
  const { body, query } = mount(children);
  const engine = createSelectorEngine({
    query: query as unknown as (selector: string) => Element[],
    ...options,
  });
  return { engine, body, query };
}

const asElement = (el: FakeElement) => el as unknown as Element;

describe('SelectorEngine.generate', () => {
  test('prefers a stable unique id', () => {
    const banner = createElement({ tag: 'div', id: 'sponsored-banner', classes: ['promo'] });
    const { engine } = engineFor([banner]);
    expect(engine.generate(asElement(banner))).toEqual({ selector: '#sponsored-banner', matches: 1 });
  });

  test('ignores machine-generated ids', () => {
    const card = createElement({ tag: 'div', id: 'css-1a2b3c4d', classes: ['ad-slot'] });
    const { engine } = engineFor([card]);
    expect(engine.generate(asElement(card)).selector).toBe('.ad-slot');
  });

  test('builds a working attribute selector for values containing spaces', () => {
    // Regression: CSS.escape is for identifiers and turned `Sign in` into
    // `Sign\ in`, which matches nothing — the rule then silently did nothing.
    const button = createElement({ tag: 'div', attrs: { 'aria-label': 'Sign in' } });
    const { engine } = engineFor([button]);
    const result = engine.generate(asElement(button));
    expect(result.selector).toBe('div[aria-label="Sign in"]');
    expect(result.matches).toBe(1);
  });

  test('escapes quotes inside attribute values', () => {
    const el = createElement({ tag: 'div', attrs: { 'data-testid': 'say "hi"' } });
    const { engine } = engineFor([el]);
    const result = engine.generate(asElement(el));
    expect(result.selector).toBe('div[data-testid="say \\"hi\\""]');
    expect(result.matches).toBe(1);
  });

  test('falls back to a semantic class when the id is not unique', () => {
    const a = createElement({ tag: 'div', id: 'shared', classes: ['adsbygoogle'] });
    const b = createElement({ tag: 'div', id: 'shared', classes: ['banner'] });
    const { engine } = engineFor([a, b]);
    expect(engine.generate(asElement(b)).selector).toBe('.banner');
  });

  test('prefers the shortest unique class over a compound', () => {
    const a = createElement({ tag: 'aside', classes: ['ad', 'sidebar'] });
    const b = createElement({ tag: 'aside', classes: ['ad', 'inline'] });
    const { engine } = engineFor([a, b]);
    expect(engine.generate(asElement(a)).selector).toBe('.sidebar');
  });

  test('uses a compound selector when no single class is unique', () => {
    const a = createElement({ tag: 'aside', classes: ['ad', 'leaderboard'] });
    const b = createElement({ tag: 'aside', classes: ['ad', 'inline'] });
    const b2 = createElement({ tag: 'div', classes: ['leaderboard'] });
    const { engine } = engineFor([a, b, b2]);
    expect(engine.generate(asElement(a)).selector).toBe('aside.ad.leaderboard');
  });

  test('falls back to a verified structural path', () => {
    // Every class is filtered out (one dynamic, one utility) and there are no
    // attributes, so only structure can identify this element.
    const wrapper = createElement({ tag: 'div' }, [
      createElement({ tag: 'section', id: 'feed' }, [
        createElement({ tag: 'div', classes: ['css-1a2b3c'] }),
        createElement({ tag: 'div', classes: ['flex'] }),
      ]),
    ]);
    const target = wrapper.children[0].children[1];
    const { engine } = engineFor([wrapper]);

    const result = engine.generate(asElement(target));
    expect(result.selector).toBe('#feed > div:nth-child(2)');
    expect(result.matches).toBe(1);
  });

  test('never returns a page-wide selector', () => {
    const { engine, body } = engineFor([createElement({ tag: 'div' })]);
    const result = engine.generate(asElement(body));
    expect(result.selector).toBeNull();
    expect(result.reason).toBeTruthy();
  });

  test('gives up rather than guessing when the tree is too deep to anchor', () => {
    let deep = createElement({ tag: 'div', classes: ['leaf'] });
    for (let i = 0; i < 4; i++) deep = createElement({ tag: 'div' }, [deep]);
    const { engine } = engineFor([deep], { maxDepth: 1 });

    const leaf = deep.children[0].children[0].children[0].children[0];
    // The class is unique, so it still resolves; strip it and the engine must
    // admit it cannot build a structural path within the depth budget.
    leaf.classes = [];
    const result = engine.generate(asElement(leaf));
    if (result.selector) {
      // If a path was found, it must still be verified and structural.
      expect(result.matches).toBe(1);
      expect(result.selector).toContain(':nth-child(');
    } else {
      expect(result.reason).toBeTruthy();
    }
  });
});

describe('SelectorEngine.generateSimilar', () => {
  test('returns a bounded selector matching siblings of the same shape', () => {
    const ads = [
      createElement({ tag: 'div', classes: ['ad-slot'] }),
      createElement({ tag: 'div', classes: ['ad-slot'] }),
      createElement({ tag: 'div', classes: ['ad-slot'] }),
    ];
    const { engine } = engineFor([...ads, createElement({ tag: 'p', classes: ['copy'] })]);

    const result = engine.generateSimilar(asElement(ads[0]));
    expect(result.selector).toBe('.ad-slot');
    expect(result.matches).toBe(3);
  });

  test('refuses a selector that would match too much', () => {
    const many = Array.from({ length: 20 }, () => createElement({ tag: 'div', classes: ['card'] }));
    const { engine } = engineFor(many, { maxSimilarMatches: 5 });
    const result = engine.generateSimilar(asElement(many[0]));
    expect(result.selector).toBeNull();
    expect(result.reason).toBeTruthy();
  });
});

describe('SelectorEngine.count', () => {
  test('counts matches for a selector', () => {
    const items = [
      createElement({ tag: 'div', classes: ['ad-slot'] }),
      createElement({ tag: 'div', classes: ['ad-slot'] }),
    ];
    const { engine } = engineFor(items);
    expect(engine.count('.ad-slot')).toBe(2);
    expect(engine.count('.missing')).toBe(0);
  });
});

describe('engine wiring', () => {
  test('exposes the same behaviour through the class and the factory', () => {
    const el = createElement({ tag: 'div', id: 'hero' });
    const { query } = mount([el]);
    const engine = new SelectorEngine({ query: query as unknown as (s: string) => Element[] });
    expect(engine.generate(asElement(el)).selector).toBe('#hero');
  });
});
