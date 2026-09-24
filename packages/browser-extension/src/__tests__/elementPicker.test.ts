import { describe, test, expect, beforeEach } from '@jest/globals';
import { ElementPicker } from '../content/elementPicker.js';

describe('ElementPicker', () => {
  beforeEach(() => {
    if (!globalThis.CSS) {
      (globalThis as any).CSS = {
        escape: (s: string) => s.replace(/[^\w-]/g, (ch) => '\\' + ch),
      };
    }
  });

  test('generates unique ID selector when available', () => {
    const picker = new ElementPicker();
    const mockEl = {
      tagName: 'DIV',
      id: 'sponsored-top-banner',
      classList: ['ad', 'banner'],
      getAttribute: () => null,
      parentElement: null,
    } as any;

    (globalThis as any).document = {
      querySelectorAll: (sel: string) => (sel === '#sponsored-top-banner' ? [mockEl] : []),
      documentElement: { appendChild: () => {}, removeChild: () => {} },
      body: { style: {} },
    };

    const selector = picker.generateSelector(mockEl);
    expect(selector).toBe('#sponsored-top-banner');
  });

  test('generates attribute selector for data-testid or ad slots', () => {
    const picker = new ElementPicker();
    const mockEl = {
      tagName: 'DIV',
      id: '',
      classList: ['promo'],
      getAttribute: (attr: string) => (attr === 'data-ad-unit' ? 'leaderboard-1' : null),
      parentElement: null,
    } as any;

    (globalThis as any).document = {
      querySelectorAll: (sel: string) =>
        sel === 'div[data-ad-unit="leaderboard-1"]' ? [mockEl] : [],
      documentElement: { appendChild: () => {}, removeChild: () => {} },
      body: { style: {} },
    };

    const selector = picker.generateSelector(mockEl);
    expect(selector).toBe('div[data-ad-unit="leaderboard-1"]');
  });

  test('falls back to semantic class name if unique', () => {
    const picker = new ElementPicker();
    const mockEl = {
      tagName: 'ASIDE',
      id: '',
      classList: ['ad-sidebar', 'promoted'],
      getAttribute: () => null,
      parentElement: null,
    } as any;

    (globalThis as any).document = {
      querySelectorAll: (sel: string) => (sel === '.ad-sidebar' ? [mockEl] : []),
      documentElement: { appendChild: () => {}, removeChild: () => {} },
      body: { style: {} },
    };

    const selector = picker.generateSelector(mockEl);
    expect(selector).toBe('.ad-sidebar');
  });
});
