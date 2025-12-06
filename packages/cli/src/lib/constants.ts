import type { FilterMetaConfig } from "../types.js";

export const defaultMetaConfig: FilterMetaConfig = {
  title: "Blockingmachine Filter List",
  description: "Combined filter list from multiple sources",
  madeby: "Blockingmachine",
  homepage: "https://github.com/greigh/blockingmachine",
  website: "https://github.com/greigh/blockingmachine",
  expires: "1 day",
  version: "3.0.0",
  license: "BSD-3-Clause",
  lastUpdated: new Date().toISOString(),
  stats: {
    totalRules: 0,
    blockingRules: 0,
    unblockingRules: 0,
  },
};
