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

export const defaultFilterMeta = {
  title: "Blockingmachine AdGuard List",
  description: "Combined filter list optimized for AdGuard",
  madeby: "Daniel Hipskind",
  homepage: "https://github.com/greigh/blockingmachine",
  website: "http://danielhipskind.com/",
  license: "BSD-3-Clause",
  version: "3.0.0",
  expires: "1 day",
  lastUpdated: new Date().toISOString(),
  stats: {
    totalRules: 0,
    blockingRules: 0,
    unblockingRules: 0,
  },
};
