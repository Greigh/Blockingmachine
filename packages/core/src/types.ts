import type { StoredRule, RuleStore } from "./RuleStore.js";

/** Concrete output formats. `all` is the multi-export selection shorthand. */
export const EXPORT_FORMATS = [
  "hosts", "dnsmasq", "unbound", "bind", "privoxy", "shadowrocket",
  "adguard", "abp", "domains", "plain",
] as const;

export type OutputFormat = (typeof EXPORT_FORMATS)[number];
export type SupportedFormat = OutputFormat | "all";

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
  /** Defaults to all concrete formats; an empty array writes no files. */
  formats?: SupportedFormat[];
  categories?: string[];
  excludeCategories?: string[];
  minPriority?: number;
  tags?: string[];
}

// Re-export RuleStore types with explicit file extension
export type { RuleType, StoredRule, RuleMetadata } from "./RuleStore.js";
