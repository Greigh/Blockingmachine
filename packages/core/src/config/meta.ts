export interface FilterMetaConfig {
  title: string;
  description: string;
  madeby: string;
  homepage: string;
  website: string;
  license: string;
  version: string;
  expires: string;
  lastUpdated: string;
  stats: {
    totalRules: number;
    blockingRules: number;
    unblockingRules: number;
  };
}

/** Create per-run metadata with fresh statistics and a generation timestamp. */
export function createFilterMeta(now: Date = new Date()): FilterMetaConfig {
  return {
    title: "Blockingmachine AdGuard List",
    description: "Combined filter list optimized for AdGuard",
    madeby: "Greigh Studios LLC",
    homepage: "https://github.com/greigh/blockingmachine",
    website: "https://greighstudios.com/",
    license: "BSD-3-Clause",
    version: "1.0.0-rc.5",
    expires: "1 day",
    lastUpdated: now.toISOString(),
    stats: {
      totalRules: 0,
      blockingRules: 0,
      unblockingRules: 0,
    },
  };
}

/** Compatibility snapshot; use createFilterMeta() for each new compilation. */
export const defaultFilterMeta: FilterMetaConfig = createFilterMeta();
