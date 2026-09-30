/**
 * A rule's category, resolved from the URL the parser is actually handed.
 *
 * The bug this pins: `sourceCategories` was keyed by profile *name* while the parser is passed
 * the source *URL*, so `sourceCategories[url]` missed for every rule in a hub compilation and the
 * whole corpus was categorised `unknown`, untrusted, priority 0. The category was never missing
 * data — the key simply did not match — and it stayed invisible because nothing read it.
 *
 * The second half matters as much: a URL nobody in the catalog recognises must still come back
 * `unknown` rather than being guessed at from the shape of the string, because a wrong category
 * is now load-bearing. The hub writes these categories to disk and the tier compiler places
 * every host from them.
 */

import { describe, expect, test } from '@jest/globals';
import { resolveSourceInfo } from '../createMetadata.js';
import { parseFilterList } from '../RuleProcessor.js';
import { CURATED_SOURCE_PROFILES, sourceCategories, sourceNames } from '../sources.js';

describe('resolveSourceInfo', () => {
  test('every curated profile resolves by name and by URL alike', () => {
    for (const profile of CURATED_SOURCE_PROFILES) {
      expect([profile.name, profile.url, profile.category]).toBeDefined();
      expect([profile.name, core(resolveSourceInfo(profile.name))]).toEqual([
        profile.name,
        profile.category,
      ]);
      expect([profile.url, core(resolveSourceInfo(profile.url))]).toEqual([
        profile.url,
        profile.category,
      ]);
    }
  });

  test('trust and priority survive the resolution, so they are not a name-only accident', () => {
    const oisd = CURATED_SOURCE_PROFILES.find((p) => p.category === 'security' && p.url.startsWith('http'));
    expect(oisd).toBeDefined();
    expect(resolveSourceInfo(oisd!.url)).toEqual({
      category: 'security',
      trusted: oisd!.trusted,
      priority: oisd!.priority,
    });
  });

  test('a URL no catalog entry claims stays unknown rather than being guessed', () => {
    for (const stranger of [
      'https://example.invalid/some-list.txt',
      'https://not-in-the-catalog.example/filters/2.txt',
      './filters/modules/not-a-real-module.txt',
      '',
    ]) {
      expect(resolveSourceInfo(stranger)).toEqual({
        category: 'unknown',
        trusted: false,
        priority: 0,
      });
    }
  });

  test('the URL bridge does not depend on sourceNames being complete', () => {
    // `sourceNames` covers the remote list URLs, so the alias route alone would have worked for
    // those. It does not cover the nine curated modules the project ships locally, which are
    // addressed as `./filters/modules/...` and are exactly the lists whose descriptions are most
    // precise. The URL is registered in `sourceCategories` directly, so they resolve too.
    const profilesWithoutName = CURATED_SOURCE_PROFILES.filter((p) => !sourceNames[p.url]);
    expect(profilesWithoutName.length).toBeGreaterThan(0);
    for (const profile of profilesWithoutName) {
      expect(resolveSourceInfo(profile.url).category).toBe(profile.category);
    }
  });

  test('the map is keyed by both, and the URL alias carries the same record', () => {
    const profile = CURATED_SOURCE_PROFILES[0]!;
    expect(sourceCategories[profile.url]).toEqual(sourceCategories[profile.name]);
  });
});

describe('a parsed rule carries the category of the list it came from', () => {
  test('through the exact call the download path makes', () => {
    // `downloadAndParseSource` calls `parseFilterList(content, url)`. This is that call.
    const profile = CURATED_SOURCE_PROFILES.find((p) => p.url.startsWith('http'))!;
    const [rule] = parseFilterList('||ads.example.com^\n', profile.url);
    expect(rule?.metadata.sourceInfo.category).toBe(profile.category);
    expect(rule?.metadata.sourceInfo.trusted).toBe(profile.trusted);
  });

  test('and an unknown list is honestly unknown on the rule too', () => {
    const [rule] = parseFilterList('||ads.example.com^\n', 'https://example.invalid/list.txt');
    expect(rule?.metadata.sourceInfo.category).toBe('unknown');
  });
});

/** Narrow to just the category, so a failure names the category rather than the whole record. */
function core(info: { category: string }): string {
  return info.category;
}
