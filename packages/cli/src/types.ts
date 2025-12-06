import { Logger } from "./lib/logger.js";

// Categories
export enum CategoryType {
  ADVERTISING = "advertising",
  TRACKING = "tracking",
  MALICIOUS = "malicious",
  SOCIAL = "social",
  UTILITY = "utility",
  CUSTOM = "custom",
}

export type CategoryName =
  | keyof typeof CategoryType
  | "blockingmachine"
  | "privacy"
  | "security"
  | "mobile"
  | "gaming"
  | "dns"
  | "annoyances"
  | "custom";

export interface Category {
  name: CategoryName;
  description: string;
  priority: number;
  enabled: boolean;
}

export const CATEGORIES: Record<CategoryName, Category> = {
  ADVERTISING: {
    name: "ADVERTISING",
    description: "Advertising domains",
    priority: 10,
    enabled: true,
  },
  TRACKING: {
    name: "TRACKING",
    description: "Tracking and telemetry domains",
    priority: 20,
    enabled: true,
  },
  MALICIOUS: {
    name: "MALICIOUS",
    description: "Malware and phishing domains",
    priority: 0,
    enabled: true,
  },
  SOCIAL: {
    name: "SOCIAL",
    description: "Social media domains",
    priority: 30,
    enabled: false,
  },
  UTILITY: {
    name: "UTILITY",
    description: "Utility and functional domains",
    priority: 40,
    enabled: false,
  },
  CUSTOM: {
    name: "CUSTOM",
    description: "Custom user-defined domains",
    priority: 5,
    enabled: true,
  },
  // Add the missing string literal categories that your validators check
  blockingmachine: {
    name: "blockingmachine",
    description: "Blockingmachine list",
    priority: 5,
    enabled: true,
  },
  privacy: {
    name: "privacy",
    description: "Privacy protection domains",
    priority: 15,
    enabled: true,
  },
  security: {
    name: "security",
    description: "Security threats",
    priority: 0,
    enabled: true,
  },
  mobile: {
    name: "mobile",
    description: "Mobile app tracking",
    priority: 25,
    enabled: true,
  },
  gaming: {
    name: "gaming",
    description: "Gaming related ads",
    priority: 35,
    enabled: false,
  },
  dns: {
    name: "dns",
    description: "DNS related domains",
    priority: 45,
    enabled: true,
  },
  annoyances: {
    name: "annoyances",
    description: "Annoyances and popups",
    priority: 50,
    enabled: false,
  },
  custom: {
    name: "custom",
    description: "Custom domains",
    priority: 5,
    enabled: true,
  },
};

// Source definitions
export interface Source {
  name: string;
  url: string;
  category: CategoryName;
  enabled: boolean;
  priority?: number;
  trusted?: boolean;
}

// Extended source interface (used in import.js)
export interface FilterSource extends Source {
  trusted: boolean;
}

// Rule-related types
export type RuleType =
  | "domain"
  | "regex"
  | "exception"
  | "cosmetic"
  | "unknown";

// Simplified modifier type - just strings now
export type RuleModifier = string;

export interface RuleVariant {
  rule: string;
  source: string;
  dateAdded: Date;
  modifiers: string[]; // Changed from RuleModifier[] to string[]
  tags: string[];
}

export interface StoredRule {
  raw: string;
  type: RuleType;
  domain?: string;
  hash: string;
  metadata: {
    sources: string[];
    dateAdded: Date;
    lastUpdated: Date;
    enabled: boolean;
    sourceInfo: {
      category: CategoryName;
      trusted: boolean;
      url: string;
    };
    tags: string[];
  };
  variants?: RuleVariant[];
}

// Import statistics
export interface ImportStats {
  totalRules: number;
  uniqueRules: number;
  categories: Record<CategoryName, number>;
  sources: Record<string, number>;
}

// Meta configuration
export interface MetaConfig {
  title: string;
  description: string;
  madeby: string;
  homepage: string;
  website: string;
  expires: string;
  version: string;
  license: string;
  lastUpdated: string;
  stats: {
    totalRules: number;
    blockingRules: number;
    unblockingRules: number;
  };
}

// MongoDB configuration
export interface MongoConfig {
  uri: string;
  options: {
    maxPoolSize: number;
    // Add other MongoDB options as needed
  };
}

// Raw config from file
export interface RawConfig {
  baseDir?: string;
  meta?: Partial<MetaConfig>;
  debug?: boolean;
  mongodb?: MongoConfig;
  output?: {
    directory: string;
  };
  sources: Partial<Source>[];
}

// Processed config with defaults
export interface AppConfig {
  baseDir: string;
  meta: MetaConfig;
  debug: boolean;
  mongodb: MongoConfig;
  output: {
    directory: string;
  };
  sources: Source[];
}

// Command options
export interface CommandOptions {
  config: AppConfig;
  logger: Logger;
}

export interface ExportOptions {
  outputPath?: string;
  formats?: SupportedFormat[];
  categories?: CategoryName[];
  excludeCategories?: CategoryName[];
  minPriority?: number;
  tags?: string[];
}

// Make sure SupportedFormat is also defined
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

// Filter list metadata
export interface FilterMetaConfig {
  title: string;
  description: string;
  madeby: string;
  homepage: string;
  website: string;
  expires: string;
  version: string;
  license: string;
  lastUpdated: string;
  stats: {
    totalRules: number;
    blockingRules: number;
    unblockingRules: number;
  };
}

export interface FilterListMetadata {
  title: string;
  description: string;
  homepage: string;
  website?: string;
  madeby?: string;
  version: string;
  lastUpdated: string;
  expires?: string;
  license?: string;
  stats?: {
    totalRules: number;
    blockingRules: number;
    unblockingRules: number;
  };
}
