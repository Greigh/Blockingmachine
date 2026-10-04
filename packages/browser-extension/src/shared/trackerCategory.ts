import type { StaticTierId } from '@blockingmachine/core/tiers';
import type { TrackerDetection } from './types';

/**
 * What a blocked host gets called in the popup's tracker list.
 *
 * Every detection used to claim `tracker` regardless of which rule stopped it, so a consent
 * platform blocked by the annoyances tier read the same as an analytics beacon. The tiers
 * that name a family carry that family through; everything else — dynamic synced rules,
 * user rules, the catch-all core and unclassified tiers — keeps `tracker`, the label the
 * list has always used for "a block we cannot name more precisely".
 */
export function categoryForTier(tier: StaticTierId | null | undefined): TrackerDetection['category'] {
  switch (tier) {
    case 'tier_annoyances':
      return 'annoyance';
    case 'tier_ads':
      return 'advertising';
    case 'tier_privacy':
      return 'telemetry';
    case 'tier_security':
      return 'malware';
    case 'tier_unclassified':
      return 'unknown';
    default:
      return 'tracker';
  }
}
