import { describe, expect, test } from '@jest/globals';
import {
  checkSelectorSyntax,
  escapeAttributeValue,
  escapeIdentifier,
  isUtilityClass,
  looksDynamic,
  sanitizeCosmeticSelectors,
  validateCosmeticSelector,
} from '../shared/cosmeticRules.js';

describe('selector safety', () => {
  test('rejects selectors that would hide the whole page', () => {
    for (const selector of ['*', 'html', 'body', ':root', '  body  ', 'HTML']) {
      expect(checkSelectorSyntax(selector).ok).toBe(false);
    }
  });

  test('rejects bare tag names', () => {
    for (const selector of ['div', 'aside', 'header', 'iframe', 'section']) {
      const result = checkSelectorSyntax(selector);
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });

  test('rejects structural injection', () => {
    for (const selector of [
      '.ad { }',
      '.ad} body { display: none',
      'a; b',
      '@import url(x)',
      '</style><script>',
      '.ad /* comment */',
      'x'.repeat(500),
    ]) {
      expect(checkSelectorSyntax(selector).ok).toBe(false);
    }
  });

  test('accepts selectors with real specificity', () => {
    for (const selector of [
      '.ad-slot',
      '#sponsored',
      'div[data-ad-unit="x"]',
      'aside.ad.sidebar',
      'body > div:nth-child(2)',
      '#feed > div:nth-child(2)',
      '.ad:not(.content)',
      'div[class*="ad-slot"]',
    ]) {
      const result = checkSelectorSyntax(selector);
      expect({ selector, ok: result.ok, reason: result.reason }).toEqual({
        selector,
        ok: true,
        reason: undefined,
      });
    }
  });

  test('rejects non-strings and empty input', () => {
    expect(checkSelectorSyntax(undefined).ok).toBe(false);
    expect(checkSelectorSyntax(42).ok).toBe(false);
    expect(checkSelectorSyntax('   ').ok).toBe(false);
  });

  test('applies a match-count guard on top of the syntax check', () => {
    expect(validateCosmeticSelector('.ad-slot', 1).ok).toBe(true);
    expect(validateCosmeticSelector('.card', 3).ok).toBe(true);
    const tooMany = validateCosmeticSelector('.card', 5000);
    expect(tooMany.ok).toBe(false);
    expect(tooMany.reason).toContain('5000');
    expect(validateCosmeticSelector('.card', 5, { maxMatches: 3 }).ok).toBe(false);
  });
});

describe('sanitizeCosmeticSelectors', () => {
  test('keeps safe unique selectors, drops the rest, and de-duplicates', () => {
    const result = sanitizeCosmeticSelectors([
      '.ad-slot',
      'div',
      'body',
      '.ad-slot',
      '',
      42,
      '#promo',
      '.card { }',
    ]);
    expect(result).toEqual(['.ad-slot', '#promo']);
  });

  test('applies a caller-supplied match count', () => {
    const result = sanitizeCosmeticSelectors(['.huge', '.fine'], {
      matchCount: (selector) => (selector === '.huge' ? 9000 : 2),
      maxMatches: 250,
    });
    expect(result).toEqual(['.fine']);
  });

  test('returns an empty list for non-arrays', () => {
    expect(sanitizeCosmeticSelectors(undefined)).toEqual([]);
    expect(sanitizeCosmeticSelectors('.ad-slot')).toEqual([]);
  });
});

describe('escaping', () => {
  test('escapes attribute values for quoted selectors, not as identifiers', () => {
    // The old code used CSS.escape here, turning `Sign in` into `Sign\ in`,
    // which matches nothing at all.
    expect(escapeAttributeValue('Sign in')).toBe('Sign in');
    expect(escapeAttributeValue('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeAttributeValue('back\\slash')).toBe('back\\\\slash');
    expect(escapeAttributeValue('two\nlines')).toBe('two\\a lines');
  });

  test('escapes identifiers for use after # or .', () => {
    expect(escapeIdentifier('ad-slot')).toBe('ad-slot');
    expect(escapeIdentifier('ad slot')).toContain('\\');
    expect(escapeIdentifier('1st')).toContain('\\');
  });
});

describe('name quality heuristics', () => {
  test('flags machine-generated names', () => {
    for (const token of ['', 'css-1a2b3c4d', 'sc-bdVaJa', '12345', 'item-998877', 'a1b2c3d4e5f6']) {
      expect(looksDynamic(token)).toBe(true);
    }
    for (const token of ['ad-slot', 'sponsored', 'cookie-banner', 'leaderboard-1']) {
      expect(looksDynamic(token)).toBe(false);
    }
  });

  test('flags utility classes that carry no blocking intent', () => {
    for (const token of ['flex', 'hidden', 'relative', 'sr-only', 'md:flex', 'hover:block']) {
      expect(isUtilityClass(token)).toBe(true);
    }
    for (const token of ['ad-slot', 'sponsored', 'cookie-banner']) {
      expect(isUtilityClass(token)).toBe(false);
    }
  });
});
