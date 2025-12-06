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

// Add the missing properties to the interface
export interface FilterListMetadata {
  title: string;
  description: string;
  homepage: string;
  version: string;
  lastUpdated: string;

  // Add these new properties
  license?: string;
  generatorVersion?: string;
  stats?: {
    totalRules?: number;
    blockingRules?: number;
    exceptionRules?: number;
  };
}

export interface ExportOptions {
  formats?: SupportedFormat[];
  categories?: string[];
  excludeCategories?: string[];
  minPriority?: number;
  tags?: string[];
}

// Re-export RuleStore types with explicit file extension
export type { RuleType, StoredRule, RuleMetadata } from "./RuleStore.js";
