import type { StoredRule, RuleStore } from "./RuleStore.js";

export type SupportedFormat =
  | "hosts"
  | "dnsmasq"
  | "unbound"
  | "bind"
  | "privoxy"
  | "shadowrocket"
  | "adguard"
  | "abp"
  | "all";

export interface FilterListMetadata {
  title: string;
  description: string;
  homepage: string;
  version: string;
  lastUpdated: string;
  expires?: string;
  author?: string;
  license?: string;
  generatorVersion?: string;
  stats?: {
    totalRules?: number;
    uniqueRules?: number;
    blockingRules?: number;
    exceptionRules?: number;
    duplicatesRemoved?: number;
  };
}

export interface ExportOptions {
  rules?: StoredRule[];
  store?: RuleStore;
  formats?: SupportedFormat[];
  categories?: string[];
  excludeCategories?: string[];
  minPriority?: number;
  tags?: string[];
}

// Re-export RuleStore types with explicit file extension
export type { RuleType, StoredRule, RuleMetadata } from "./RuleStore.js";
