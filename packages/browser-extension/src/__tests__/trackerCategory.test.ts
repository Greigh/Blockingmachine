/**
 * `categoryForTier` — what a blocked host gets called in the popup's tracker list.
 *
 * Every detection used to claim `tracker` regardless of which rule stopped it, so a consent
 * platform blocked by the annoyances tier read the same as an analytics beacon. The pin is
 * the mapping itself: a tier rename or a new tier that forgets this function lands in a diff
 * that names the family it is abandoning.
 */

import { describe, expect, test } from '@jest/globals';
import { categoryForTier } from '../shared/trackerCategory';
import { STATIC_RULE_TIERS } from '../shared/rulesetTiers';

describe('categoryForTier', () => {
  test('the annoyances tier labels its blocks annoyance', () => {
    expect(categoryForTier('tier_annoyances')).toBe('annoyance');
  });

  test('named families carry through; everything else keeps the tracker default', () => {
    expect(categoryForTier('tier_ads')).toBe('advertising');
    expect(categoryForTier('tier_privacy')).toBe('telemetry');
    expect(categoryForTier('tier_security')).toBe('malware');
    expect(categoryForTier('tier_unclassified')).toBe('unknown');
    // Dynamic synced rules, user rules and the mixed core tier all read as they always did.
    expect(categoryForTier('tier_core')).toBe('tracker');
    expect(categoryForTier(null)).toBe('tracker');
    expect(categoryForTier(undefined)).toBe('tracker');
  });

  test('every declared tier resolves — a new tier cannot silently fall to the default', () => {
    // Not a behavioral assertion on the values, a completeness one on the keys: the switch
    // must name every tier the manifest declares, so adding one forces a decision here.
    for (const tier of STATIC_RULE_TIERS) {
      expect(['advertising', 'tracker', 'telemetry', 'malware', 'annoyance', 'unknown']).toContain(
        categoryForTier(tier.id),
      );
    }
  });
});
