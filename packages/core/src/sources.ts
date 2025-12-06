// --- Interfaces/Types ---

// Interface for the elements in the filterLists array
export interface FilterListInfo {
  name: string;
  url: string;
  enabled: boolean;
}

// Type for the sourceNames object (URL -> Friendly Name mapping)
export type SourceNameMap = Record<string, string>;

// Type for sourceValidation (Validation Type -> Friendly Name -> Value mapping)
export type SourceValidationMap = Record<string, Record<string, string>>;

// Type for sourceConfig
export interface SourceConfig {
  retries: number;
  timeout: number;
  maxRedirects: number;
  userAgent: string;
  additionalHeaders: Record<string, string>;
}

// Add these interfaces
export interface SourceInfo {
  category: string;
  trusted: boolean;
  priority: number;
}

export type SourceCategoryMap = Record<string, SourceInfo>;

// --- Exports with Types ---

export const sourceNames: SourceNameMap = {
  "https://filters.adtidy.org/extension/chromium/filters/15.txt":
    "AdGuard DNS Filter",
  "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt":
    "uBlock Filters",
  "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt":
    "AdGuard Base Filter",
  "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_14_Annoyances/filter.txt":
    "AdGuard Annoyances Filter",
  "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_4_Social/filter.txt":
    "AdGuard Social Media Filter",
  "https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/MobileFilter/sections/adservers.txt":
    "AdGuard Mobile Filter",
  "https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt":
    "AWAvenue Ads Rule",
  "https://adguardteam.github.io/HostlistsRegistry/assets/filter_59.txt":
    "AdGuard DNS Popup Hosts filter",
  "https://raw.githubusercontent.com/LanikSJ/ubo-filters/main/filters/getadmiral-domains.txt":
    "GetAdmiral Domains",
  "https://easylist.to/easylist/easylist.txt": "EasyList",
  "https://secure.fanboy.co.nz/fanboy-annoyance.txt": "Fanboy's Annoyance List",
  "https://adguardteam.github.io/HostlistsRegistry/assets/filter_45.txt":
    "HaGeZi's Allowlist Referral",
  "https://adguardteam.github.io/HostlistsRegistry/assets/filter_63.txt":
    "HaGeZi's Windows/Office Tracker Blocklist",
  "https://raw.githubusercontent.com/MrBukLau/filter-lists/master/filters/basefilters.txt":
    "MrBukLau's Base Filters",
  "https://adguardteam.github.io/HostlistsRegistry/assets/filter_5.txt":
    "OISD Blocklist Small",
  "https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/filters.txt":
    "uBlock Origin Filters",
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblock&showintro=0&mimetype=plaintext":
    "Peter Lowes List",
  "./filters/input/blockingmachine-rules.txt": "Blockingmachine Rules",
  "https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/unbreak.txt":
    "uBlock Unbreak Filter",
};

// Add type annotation to the array
export const filterLists: FilterListInfo[] = [
  {
    name: "Blockingmachine Rules",
    url: "./filters/input/blockingmachine-rules.txt",
    enabled: true,
  },
  {
    name: "AdGuard DNS Filter",
    url: "https://filters.adtidy.org/extension/chromium/filters/15.txt",
    enabled: true,
  },
  {
    name: "uBlock Origin Filters", // Using 'uBlock Origin Filters' name
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt",
    enabled: true,
  },
  {
    name: "uBlock Unbreak Filter",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/unbreak.txt",
    enabled: true,
  },
  {
    name: "AdGuard Base Filter",
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt",
    enabled: true,
  },
  {
    name: "AdGuard Annoyances Filter",
    url: "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_14_Annoyances/filter.txt",
    enabled: true,
  },
  {
    name: "AdGuard Social Media Filter",
    url: "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_4_Social/filter.txt",
    enabled: true,
  },
  {
    name: "AdGuard Mobile Filter",
    url: "https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/MobileFilter/sections/adservers.txt",
    enabled: true,
  },
  {
    name: "AWAvenue Ads Rule",
    url: "https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt",
    enabled: true,
  },
  {
    name: "AdGuard DNS Popup Hosts filter",
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_59.txt",
    enabled: true,
  },
  {
    name: "GetAdmiral Domains",
    url: "https://raw.githubusercontent.com/LanikSJ/ubo-filters/main/filters/getadmiral-domains.txt",
    enabled: true,
  },
  {
    name: "EasyList",
    url: "https://easylist.to/easylist/easylist.txt",
    enabled: true,
  },
  {
    name: "Fanboy's Annoyance List",
    url: "https://secure.fanboy.co.nz/fanboy-annoyance.txt",
    enabled: true,
  },
  {
    name: "HaGeZi's Allowlist Referral",
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_45.txt",
    enabled: true,
  },
  {
    name: "HaGeZi's Windows/Office Tracker Blocklist",
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_63.txt",
    enabled: true,
  },
  {
    name: "MrBukLau's Base Filters",
    url: "https://raw.githubusercontent.com/MrBukLau/filter-lists/master/filters/basefilters.txt",
    enabled: true,
  },
  {
    name: "OISD Blocklist Small",
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_5.txt",
    enabled: true,
  },
  {
    name: "uBlock Origin Filters",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/filters.txt",
    enabled: true,
  },
  {
    name: "Peter Lowes List",
    url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblock&showintro=0&mimetype=plaintext",
    enabled: true,
  },
];

// Update sourceCategories to use SourceInfo objects
export const sourceCategories: SourceCategoryMap = {
  "AdGuard DNS Filter": {
    category: "primary",
    trusted: true,
    priority: 1,
  },
  "uBlock Origin Filters": {
    category: "primary",
    trusted: true,
    priority: 1,
  },
  "Peter Lowes List": {
    category: "privacy",
    trusted: true,
    priority: 2,
  },
  "OISD Blocklist Small": {
    category: "privacy",
    trusted: true,
    priority: 2,
  },
  "Fanboy's Annoyance List": {
    category: "annoyance",
    trusted: true,
    priority: 3,
  },
  "AdGuard Annoyances Filter": {
    category: "annoyance",
    trusted: true,
    priority: 3,
  },
  "AdGuard Social Media Filter": {
    category: "social",
    trusted: true,
    priority: 3,
  },
  "AdGuard Mobile Filter": {
    category: "mobile",
    trusted: true,
    priority: 2,
  },
  "AWAvenue Ads Rule": {
    category: "mobile",
    trusted: true,
    priority: 2,
  },
  "Blockingmachine Rules": {
    category: "custom",
    trusted: true,
    priority: 0,
  },
};

// Add type annotation
export const sourceValidation: SourceValidationMap = {
  updateFrequency: {
    "AdGuard DNS Filter": "24h",
    "uBlock Origin Filters": "24h", // Ensure names match
    "OISD Blocklist Small": "1h",
    "Fanboy's Annoyance List": "24h",
    "GetAdmiral Domains": "24h",
    "Peter Lowes List": "24h",
    "AdGuard Base Filter": "24h",
    "AdGuard Annoyances Filter": "24h",
    "AdGuard Social Media Filter": "24h",
    "AdGuard Mobile Filter": "24h",
    "Blockingmachine Rules": "24h",
    "AdGuard DNS Popup Hosts filter": "24h",
    "HaGeZi's Allowlist Referral": "24h",
    "HaGeZi's Windows/Office Tracker Blocklist": "24h",
    "MrBukLau's Base Filters": "24h",
    "uBlock Filters": "24h",
    "AWAvenue Ads Rule": "24h",
  },
  trustLevel: {
    "Blockingmachine Rules": "trusted",
    "AdGuard DNS Filter": "verified",
    "uBlock Origin Filters": "verified",
    "AdGuard Base Filter": "verified",
    "AdGuard Annoyances Filter": "verified",
    "AdGuard Social Media Filter": "verified",
    "AdGuard Mobile Filter": "verified",
    "AdGuard DNS Popup Hosts filter": "verified",
    EasyList: "verified",
    "Fanboy's Annoyance List": "verified",
    "Peter Lowes List": "verified",
    "OISD Blocklist Small": "verified",
    "GetAdmiral Domains": "verified",
    "HaGeZi's Allowlist Referral": "verified",
    "HaGeZi's Windows/Office Tracker Blocklist": "verified",
    "MrBukLau's Base Filters": "verified",
    "AWAvenue Ads Rule": "verified",
    "uBlock Filters": "verified",
  },
};

// Add type annotation
export const sourceConfig: SourceConfig = {
  retries: 3,
  timeout: 30000,
  maxRedirects: 5,
  userAgent: "Blockingmachine/1.0",
  additionalHeaders: {},
};
