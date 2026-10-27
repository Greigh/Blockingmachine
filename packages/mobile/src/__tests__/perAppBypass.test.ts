/**
 * Per-app bypass helpers (flag 128): the package-name grammar the native
 * bridge mirrors before persisting the disallowed set, and the free-text
 * list parsing the settings card applies (separators, dedupe, cap, rejects).
 */
import {
  isValidPackageName,
  MAX_BYPASS_PACKAGES,
  parsePackageList,
  SELF_PACKAGE,
} from '../filter/perAppBypass';

describe('isValidPackageName', () => {
  it('accepts manifest-shaped package names', () => {
    for (const ok of [
      'com.blockingmachine.mobile',
      'com.example',
      'a.b',
      'org.foo_bar.baz9',
      'A.B2',
      'com.x',
    ]) {
      expect(isValidPackageName(ok)).toBe(true);
    }
    expect(isValidPackageName(SELF_PACKAGE)).toBe(true);
  });

  it('rejects shapes that cannot be a package', () => {
    for (const bad of [
      '',
      '   ',
      '9com.example',
      'com.9example',
      'com..app',
      '.com.app',
      'com.app.',
      'com.exa mple',
      'com.example-app',
      'com/example',
      'com.example:app',
      'com.example.app.',
      'a'.repeat(256),
    ]) {
      expect(isValidPackageName(bad)).toBe(false);
    }
  });
});

describe('parsePackageList', () => {
  it('splits on commas, whitespace, and semicolons', () => {
    const { packages, rejected } = parsePackageList(
      'com.one.app, com.two.app\norg.three; net.four.app ,  com.five.app  ',
    );
    expect(packages).toEqual([
      'com.one.app',
      'com.two.app',
      'org.three',
      'net.four.app',
      'com.five.app',
    ]);
    expect(rejected).toEqual([]);
  });

  it('dedupes keeping first order and rejects invalid tokens by name', () => {
    const { packages, rejected } = parsePackageList(
      'com.one.app, bogus-name, com.one.app, com.two.app, 9bad',
    );
    expect(packages).toEqual(['com.one.app', 'com.two.app']);
    expect(rejected).toEqual(['bogus-name', '9bad']);
  });

  it('returns an empty set for an empty input', () => {
    expect(parsePackageList('')).toEqual({ packages: [], rejected: [] });
    expect(parsePackageList('   \n , ; ')).toEqual({ packages: [], rejected: [] });
  });

  it('caps the list at max and reports overflow as rejected', () => {
    const input = Array.from({ length: 5 }, (_, i) => `com.app${i}.x`).join(',');
    const { packages, rejected } = parsePackageList(input, 3);
    expect(packages).toEqual(['com.app0.x', 'com.app1.x', 'com.app2.x']);
    expect(rejected).toEqual(['com.app3.x', 'com.app4.x']);
    expect(MAX_BYPASS_PACKAGES).toBeGreaterThan(0);
  });
});
