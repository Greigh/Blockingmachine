// --- Interfaces/Types ---

// Interface for the elements in the filterLists array
export interface FilterListInfo {
  name: string;
  url: string;
  enabled: boolean;
  scope?: SourceScope;
  category?: SourceCategory;
  description?: string;
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

export interface SourceInfo {
  category: string;
  trusted: boolean;
  priority: number;
}

export type SourceCategoryMap = Record<string, SourceInfo>;

// --- Advanced Source Taxonomy & Intelligence ---

export type SourceScope = "dns" | "browser" | "hybrid";

export type SourceCategory =
  | "ads"
  | "privacy"
  | "security"
  | "annoyances"
  | "social"
  | "mobile"
  | "unbreak"
  | "anti-circumvention"
  | "custom";

export interface SourceProfile {
  name: string;
  url: string;
  scope: SourceScope;
  category: SourceCategory;
  description: string;
  features: string[];
  targets: ("dns" | "browser")[];
  trusted: boolean;
  priority: number;
  recommendedFor: string;
  warning?: string;
}

// --- Curated Profiles Registry ---

export const CURATED_SOURCE_PROFILES: SourceProfile[] = [
  {
    name: "Blockingmachine Rules",
    url: "./filters/input/blockingmachine-rules.txt",
    scope: "hybrid",
    category: "custom",
    description:
      "Local repository override rules, curated custom whitelist exceptions, and personal domain blocks.",
    features: ["Local overrides", "Custom syntax", "Priority processing"],
    targets: ["dns", "browser"],
    trusted: true,
    priority: 0,
    recommendedFor: "Default baseline and repository-level rule overrides",
  },
  {
    name: "Base Ad Shield [Beta]",
    url: "./filters/modules/blockingmachine-base.txt",
    scope: "hybrid",
    category: "ads",
    description:
      "Native primary advertising network, video ad injection, banner exchange, and sponsored recommendation blocker.",
    features: ["Cross-web ad blocking", "Video ad suppression", "Programmatic bidding filter"],
    targets: ["dns", "browser"],
    trusted: true,
    priority: 0,
    recommendedFor: "Essential ad-blocking foundation for browsers and network-level sinkholes",
  },
  {
    name: "Privacy Engine [Beta]",
    url: "./filters/modules/blockingmachine-privacy.txt",
    scope: "hybrid",
    category: "privacy",
    description:
      "Native high-precision telemetry, fingerprinting, diagnostic beacon, and analytics blocker.",
    features: ["Zero telemetry", "OS diagnostic shielding", "Analytics suppression"],
    targets: ["dns", "browser"],
    trusted: true,
    priority: 0,
    recommendedFor: "All devices seeking maximum data privacy without breakage",
  },
  {
    name: "Smart TV & IoT Shield [Beta]",
    url: "./filters/modules/blockingmachine-smarttv.txt",
    scope: "dns",
    category: "privacy",
    description:
      "Targets aggressive smart TV tracking, ACR, telemetry pings, and in-app ads on Roku, Samsung Tizen, LG webOS, and FireTV.",
    features: ["Smart TV ACR blocking", "IoT telemetry shield", "Pure DNS rules"],
    targets: ["dns"],
    trusted: true,
    priority: 0,
    recommendedFor: "Home network DNS sinkholes, AdGuard Home, and Pi-hole",
  },
  {
    name: "Web Annoyances & Cookie Banners [Beta]",
    url: "./filters/modules/blockingmachine-annoyances.txt",
    scope: "browser",
    category: "annoyances",
    description:
      "Eliminates intrusive GDPR cookie banners, CMP modals, newsletter popups, and floating nag screens.",
    features: ["Cookie banner removal", "GDPR overlay suppression", "Element hiding"],
    targets: ["browser"],
    trusted: true,
    priority: 0,
    recommendedFor: "Browser extensions and content blockers",
    warning: "Contains cosmetic rules (##) that require DOM inspection; ineffective on pure DNS sinkholes",
  },
  {
    name: "Social Tracker Neutralizer [Beta]",
    url: "./filters/modules/blockingmachine-social.txt",
    scope: "hybrid",
    category: "social",
    description:
      "Neutralizes cross-site tracking beacons, embedded share widgets, and Meta/TikTok/X pixels across third-party websites.",
    features: ["Cross-site pixel blocking", "Third-party beacon neutralization", "Social widget hiding"],
    targets: ["browser", "dns"],
    trusted: true,
    priority: 0,
    recommendedFor: "Browser extensions, DNS sinkholes, and desktop ad-blockers",
  },
  {
    name: "Threat & Malicious Domain Defense [Beta]",
    url: "./filters/modules/blockingmachine-security.txt",
    scope: "dns",
    category: "security",
    description:
      "Proactive network-level blocking of phishing gateways, rogue redirects, drive-by malware, and in-browser cryptominers.",
    features: ["Anti-cryptomining", "Malicious redirect shield", "Phishing defense"],
    targets: ["dns"],
    trusted: true,
    priority: 0,
    recommendedFor: "Network firewalls, routers, Pi-hole, and AdGuard Home",
  },
  {
    name: "URL Tracking Stripper [Beta]",
    url: "./filters/modules/blockingmachine-url-tracking.txt",
    scope: "browser",
    category: "privacy",
    description:
      "Native query parameter stripper eliminating tracking tokens, click identifiers, and referral parameters across the web.",
    features: ["Click ID removal (fbclid/gclid)", "UTM parameter stripping", "Referral token sanitization"],
    targets: ["browser"],
    trusted: true,
    priority: 0,
    recommendedFor: "Browser extensions and content blockers supporting $removeparam rules",
  },
  {
    name: "Unbreak & Safe Exceptions [Beta]",
    url: "./filters/modules/blockingmachine-unbreak.txt",
    scope: "hybrid",
    category: "unbreak",
    description:
      "Hand-crafted exception allowlist rules for banking portals, SSO logins, delivery tracking, and essential services.",
    features: ["Banking portal fixes", "SSO allowlists", "Anti-breakage rules (@@)"],
    targets: ["dns", "browser"],
    trusted: true,
    priority: 0,
    recommendedFor: "Essential for all configurations to guarantee normal app functionality",
  },
  {
    name: "AdGuard DNS Filter",
    url: "https://filters.adtidy.org/extension/chromium/filters/15.txt",
    scope: "dns",
    category: "ads",
    description:
      "Network-level filter composed of AdGuard Base, Tracking, and Mobile filters, stripped of cosmetic rules for DNS sinkholes.",
    features: [
      "DNS sinkhole safe",
      "Network ad blocking",
      "Zero cosmetic rules",
      "No DOM overhead",
    ],
    targets: ["dns"],
    trusted: true,
    priority: 1,
    recommendedFor:
      "Pi-hole, AdGuard Home, router firewalls, and network-wide DNS resolvers",
  },
  {
    name: "uBlock Origin Filters",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt",
    scope: "hybrid",
    category: "ads",
    description:
      "Official uBlock Origin core list containing network request blocks, advanced cosmetic element-hiding, and procedural scriptlets.",
    features: [
      "Network request blocking",
      "Cosmetic element hiding",
      "Scriptlet injection",
      "Procedural selectors",
    ],
    targets: ["browser", "dns"],
    trusted: true,
    priority: 1,
    recommendedFor:
      "uBlock Origin, AdGuard Browser Extension, Brave Shields (cosmetic rules stripped on DNS export)",
    warning:
      "Contains cosmetic rules (##, #@#) that are ignored by network DNS resolvers",
  },
  {
    name: "uBlock Unbreak Filter",
    url: "https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/unbreak.txt",
    scope: "hybrid",
    category: "unbreak",
    description:
      "High-priority exception rules designed to prevent website breakage caused by strict ad-blocking lists.",
    features: [
      "Site compatibility fixes",
      "Exception rules (@@)",
      "Anti-breakage allowlists",
    ],
    targets: ["browser", "dns"],
    trusted: true,
    priority: 0,
    recommendedFor:
      "All setups to prevent broken web pages, logins, and checkout forms",
  },
  {
    name: "AdGuard Base Filter",
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt",
    scope: "hybrid",
    category: "ads",
    description:
      "Primary AdGuard list for blocking advertisements, banners, and video ads across desktop and mobile websites.",
    features: [
      "Banner blocking",
      "Video ad filtering",
      "Cosmetic element rules",
      "CSS injection",
    ],
    targets: ["browser", "dns"],
    trusted: true,
    priority: 1,
    recommendedFor:
      "Browser extensions and unified ad-blocking compilation pipelines",
  },
  {
    name: "AdGuard Annoyances Filter",
    url: "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_14_Annoyances/filter.txt",
    scope: "browser",
    category: "annoyances",
    description:
      "Hides irritating non-ad elements including cookie consent notices, GDPR modals, newsletter popups, and app banners.",
    features: [
      "Cookie banner hiding",
      "GDPR consent suppression",
      "Newsletter popup removal",
      "Floating nag screens",
    ],
    targets: ["browser"],
    trusted: true,
    priority: 3,
    recommendedFor:
      "Browser extensions (requires DOM/CSS inspection; ineffective on DNS sinkholes)",
    warning:
      "Purely cosmetic: cannot be enforced by network DNS sinkholes like Pi-hole",
  },
  {
    name: "Fanboy's Annoyance List",
    url: "https://secure.fanboy.co.nz/fanboy-annoyance.txt",
    scope: "browser",
    category: "annoyances",
    description:
      "Comprehensive cosmetic list blocking cookie warnings, social widgets, popups, and in-page nag screens.",
    features: [
      "Cookie notices",
      "Social buttons",
      "In-page popups",
      "Cosmetic element hiding",
    ],
    targets: ["browser"],
    trusted: true,
    priority: 3,
    recommendedFor:
      "Browser extensions (requires DOM/CSS inspection; ineffective on DNS sinkholes)",
    warning:
      "Purely cosmetic: cannot be enforced by network DNS sinkholes like Pi-hole",
  },
  {
    name: "AdGuard Social Media Filter",
    url: "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_4_Social/filter.txt",
    scope: "browser",
    category: "social",
    description:
      "Hides social media tracking widgets, Like/Share buttons, and comment modules across third-party websites.",
    features: [
      "Social widget hiding",
      "Facebook Pixel neutralization",
      "Like button removal",
      "Social tracker blocking",
    ],
    targets: ["browser"],
    trusted: true,
    priority: 3,
    recommendedFor:
      "Browser extensions (removes embedded social widgets from web layouts)",
  },
  {
    name: "AdGuard Mobile Filter",
    url: "https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/MobileFilter/sections/adservers.txt",
    scope: "hybrid",
    category: "mobile",
    description:
      "Filters mobile web advertisements, in-app ad SDK networks, and mobile-specific tracking beacons.",
    features: [
      "Mobile ad networks",
      "In-app tracker blocking",
      "Low memory footprint",
    ],
    targets: ["browser", "dns"],
    trusted: true,
    priority: 2,
    recommendedFor: "Mobile devices, mobile browsers, and home network DNS",
  },
  {
    name: "AWAvenue Ads Rule",
    url: "https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt",
    scope: "hybrid",
    category: "ads",
    description:
      "Specialized ad blocking rules targeting Asian and regional mobile application ad exchanges and tracking SDKs.",
    features: [
      "App ad SDKs",
      "Regional ad networks",
      "Mobile telemetry blocking",
    ],
    targets: ["browser", "dns"],
    trusted: true,
    priority: 2,
    recommendedFor: "Mobile apps and cross-platform ad blocking",
  },
  {
    name: "AdGuard DNS Popup Hosts filter",
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_59.txt",
    scope: "dns",
    category: "ads",
    description:
      "Network-level hosts list blocking advertising and popup domains for DNS sinkhole resolvers.",
    features: [
      "DNS hosts format",
      "Zero cosmetic rules",
      "Popup domain sinkhole",
    ],
    targets: ["dns"],
    trusted: true,
    priority: 2,
    recommendedFor: "Pi-hole, AdGuard Home, DNS resolvers",
  },
  {
    name: "GetAdmiral Domains",
    url: "https://raw.githubusercontent.com/LanikSJ/ubo-filters/main/filters/getadmiral-domains.txt",
    scope: "dns",
    category: "anti-circumvention",
    description:
      "Blocks domains associated with Admiral anti-adblock detection and paywall circumvention scripts.",
    features: [
      "Anti-adblock neutralization",
      "Domain-level blocking",
      "Low false-positive rate",
    ],
    targets: ["dns", "browser"],
    trusted: true,
    priority: 2,
    recommendedFor: "Bypassing anti-adblock paywalls and nags",
  },
  {
    name: "EasyList",
    url: "https://easylist.to/easylist/easylist.txt",
    scope: "hybrid",
    category: "ads",
    description:
      "The foundational open-source ad-blocking rule set removing adverts from international web pages.",
    features: [
      "Global ad rules",
      "Network blocking",
      "Cosmetic element hiding",
      "Standard ABP syntax",
    ],
    targets: ["browser", "dns"],
    trusted: true,
    priority: 1,
    recommendedFor: "General web ad blocking in browser extensions",
  },
  {
    name: "HaGeZi's Allowlist Referral",
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_45.txt",
    scope: "dns",
    category: "unbreak",
    description:
      "Allowlist referral domains ensuring shopping affiliate links, rebate trackers, and legitimate redirects work.",
    features: [
      "Shopping referral compatibility",
      "Affiliate link unbreak",
      "DNS-level allowlist",
    ],
    targets: ["dns"],
    trusted: true,
    priority: 0,
    recommendedFor:
      "Users who use cashback/affiliate links or shop online without broken checkouts",
  },
  {
    name: "HaGeZi's Windows/Office Tracker Blocklist",
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_63.txt",
    scope: "dns",
    category: "privacy",
    description:
      "Aggressively blocks Microsoft Windows and Office telemetry, diagnostic endpoints, and background data collection.",
    features: [
      "Windows telemetry blocking",
      "Office diagnostic beacons",
      "DNS sinkhole optimized",
    ],
    targets: ["dns"],
    trusted: true,
    priority: 2,
    recommendedFor:
      "Pi-hole, AdGuard Home, Windows desktop users seeking maximum OS privacy",
  },
  {
    name: "MrBukLau's Base Filters",
    url: "https://raw.githubusercontent.com/MrBukLau/filter-lists/master/filters/basefilters.txt",
    scope: "hybrid",
    category: "ads",
    description:
      "Community-curated base filter blocking invasive display advertising and promotional trackers.",
    features: ["Ad blocking", "Tracker mitigation", "ABP syntax"],
    targets: ["browser", "dns"],
    trusted: true,
    priority: 2,
    recommendedFor: "General browser ad blocking",
  },
  {
    name: "OISD Blocklist Small",
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_5.txt",
    scope: "dns",
    category: "security",
    description:
      "Renowned curated DNS blocklist focusing on high-confidence malware, phishing, and aggressive telemetry with zero false-positives.",
    features: [
      "Zero false positives",
      "High-confidence security",
      "Pure DNS domains",
      "Safe for home networks",
    ],
    targets: ["dns"],
    trusted: true,
    priority: 1,
    recommendedFor:
      "Every network DNS sinkhole (Pi-hole, AdGuard Home, router firewalls)",
  },
  {
    name: "Peter Lowes List",
    url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblock&showintro=0&mimetype=plaintext",
    scope: "dns",
    category: "privacy",
    description:
      "Pioneering, conservative blocklist targeting well-known ad servers, tracking beacons, and spyware domains.",
    features: [
      "Conservative blocking",
      "DNS hosts format",
      "Low false-positive rate",
      "Historical reliability",
    ],
    targets: ["dns", "browser"],
    trusted: true,
    priority: 1,
    recommendedFor: "Network-wide DNS sinkholes and ad blockers",
  },
];

const LEGACY_DEFENSE_MODULE_NAMES = [
  "Blockingmachine Base Ad Shield [Beta]",
  "Blockingmachine Privacy Engine [Beta]",
  "Blockingmachine Smart TV & IoT Shield [Beta]",
  "Blockingmachine Web Annoyances & Cookie Banners [Beta]",
  "Blockingmachine Social Tracker Neutralizer [Beta]",
  "Blockingmachine Threat & Malicious Domain Defense [Beta]",
  "Blockingmachine URL Tracking Stripper [Beta]",
  "Blockingmachine Unbreak & Safe Exceptions [Beta]",
  "Blockingmachine Defense Suite [Beta]",
];

export function displayFilterLabel(name: string): string {
  const trimmed = (name || "").trim();
  const legacy = LEGACY_DEFENSE_MODULE_NAMES.find(
    (entry) => entry.toLowerCase() === trimmed.toLowerCase(),
  );
  if (!legacy) return trimmed;
  return legacy.replace(/^Blockingmachine\s+/i, "");
}

// Profile map keyed by normalized name and normalized URL
const profileLookup = new Map<string, SourceProfile>();
for (const profile of CURATED_SOURCE_PROFILES) {
  profileLookup.set(profile.name.toLowerCase().trim(), profile);
  profileLookup.set(profile.url.toLowerCase().trim(), profile);
}

for (const legacyName of LEGACY_DEFENSE_MODULE_NAMES) {
  const currentName = legacyName.replace(/^Blockingmachine\s+/i, "");
  const profile = profileLookup.get(currentName.toLowerCase());
  if (profile) {
    profileLookup.set(legacyName.toLowerCase(), profile);
  }
}

// Aliases
profileLookup.set(
  "https://raw.githubusercontent.com/ublockorigin/uassets/refs/heads/master/filters/filters.txt",
  profileLookup.get("ublock origin filters")!,
);
profileLookup.set("ublock filters", profileLookup.get("ublock origin filters")!);

// --- Source Classification Intelligence Helpers ---

export function getSourceProfile(nameOrUrl: string): SourceProfile {
  const normalized = (nameOrUrl || "").trim().toLowerCase();
  if (profileLookup.has(normalized)) {
    return profileLookup.get(normalized)!;
  }
  return detectSourceClassification(nameOrUrl);
}

export function detectSourceClassification(
  urlOrName: string,
  sampleRules?: string[],
): SourceProfile {
  const normalized = (urlOrName || "").trim().toLowerCase();
  if (profileLookup.has(normalized)) {
    return profileLookup.get(normalized)!;
  }

  let scope: SourceScope = "hybrid";
  let category: SourceCategory = "ads";
  const features: string[] = [];
  const targets: ("dns" | "browser")[] = ["browser", "dns"];
  let warning: string | undefined;

  // 1. Inspect sample rules if provided
  if (sampleRules && sampleRules.length > 0) {
    let hasCosmetic = false;
    let hasHosts = false;
    let hasNetwork = false;

    for (const rule of sampleRules.slice(0, 100)) {
      const trimmed = rule.trim();
      if (!trimmed || trimmed.startsWith("!") || trimmed.startsWith("["))
        continue;
      if (
        trimmed.includes("##") ||
        trimmed.includes("#@#") ||
        trimmed.includes("#$#") ||
        trimmed.includes("#?#")
      ) {
        hasCosmetic = true;
      } else if (
        trimmed.startsWith("0.0.0.0 ") ||
        trimmed.startsWith("127.0.0.1 ")
      ) {
        hasHosts = true;
      } else if (
        trimmed.startsWith("||") ||
        trimmed.startsWith("|") ||
        trimmed.includes("^")
      ) {
        hasNetwork = true;
      }
    }

    if (hasCosmetic && !hasNetwork && !hasHosts) {
      scope = "browser";
      targets.length = 0;
      targets.push("browser");
      features.push("Cosmetic element-hiding (DOM/CSS)");
      warning =
        "Contains cosmetic rules (##, #@#) which cannot be blocked by DNS sinkholes like Pi-hole.";
    } else if (hasHosts && !hasCosmetic) {
      scope = "dns";
      targets.length = 0;
      targets.push("dns");
      features.push("DNS-level hosts format");
    } else if (hasNetwork && !hasCosmetic) {
      scope = "dns";
      targets.length = 0;
      targets.push("dns", "browser");
      features.push("Network request blocking");
    } else if (hasCosmetic && hasNetwork) {
      scope = "hybrid";
      features.push("Network & cosmetic filtering");
    }
  }

  // 2. Inspect name and URL keywords
  if (
    normalized.includes("cookie") ||
    normalized.includes("annoyance") ||
    normalized.includes("popup") ||
    normalized.includes("gdpr") ||
    normalized.includes("banner")
  ) {
    category = "annoyances";
    if (!sampleRules) {
      scope = "browser";
      targets.length = 0;
      targets.push("browser");
    }
    features.push("Cookie & annoyance suppression");
  } else if (
    normalized.includes("telemetry") ||
    normalized.includes("tracker") ||
    normalized.includes("tracking") ||
    normalized.includes("privacy") ||
    normalized.includes("spyware")
  ) {
    category = "privacy";
    features.push("Telemetry & tracking prevention");
  } else if (
    normalized.includes("malware") ||
    normalized.includes("phish") ||
    normalized.includes("security") ||
    normalized.includes("threat") ||
    normalized.includes("scam")
  ) {
    category = "security";
    features.push("Malware & security defense");
    if (!sampleRules) {
      scope = "dns";
      targets.length = 0;
      targets.push("dns");
    }
  } else if (
    normalized.includes("social") ||
    normalized.includes("facebook") ||
    normalized.includes("twitter")
  ) {
    category = "social";
    features.push("Social widget blocking");
  } else if (
    normalized.includes("mobile") ||
    normalized.includes("app-ads") ||
    normalized.includes("in-app")
  ) {
    category = "mobile";
    features.push("Mobile app ad filtering");
  } else if (
    normalized.includes("unbreak") ||
    normalized.includes("whitelist") ||
    normalized.includes("allowlist")
  ) {
    category = "unbreak";
    features.push("Exception rules & site unbreaking");
  } else if (
    normalized.includes("dns") ||
    normalized.includes("hosts") ||
    normalized.includes("pihole") ||
    normalized.includes("adguardhome")
  ) {
    scope = "dns";
    targets.length = 0;
    targets.push("dns");
    features.push("DNS sinkhole safe");
  }

  const categoryDescriptions: Record<SourceCategory, string> = {
    ads: "General advertisement and promotional content blocking.",
    privacy:
      "Cross-site tracking, device telemetry, and behavioral analytics mitigation.",
    security:
      "Protection against malicious domains, phishing, and scam servers.",
    annoyances:
      "Removal of cookie consent notices, GDPR popups, and floating nag screens.",
    social:
      "Blocking of social tracking beacons and embedded social media widgets.",
    mobile: "Filtering of mobile in-app advertisements and telemetry SDKs.",
    unbreak: "Essential allowlist rules to fix broken site functionality.",
    "anti-circumvention":
      "Defuses anti-adblock detection scripts and bypass mechanisms.",
    custom: "User-specified custom filter source.",
  };

  const scopeExplanations: Record<SourceScope, string> = {
    dns: "Network-level DNS sinkholes (Pi-hole, AdGuard Home, routers)",
    browser: "Browser extensions (uBlock Origin, AdGuard Browser Extension)",
    hybrid: "Browser extensions or DNS sinkholes (with cosmetic rules stripped)",
  };

  return {
    name: urlOrName || "Custom Source",
    url: urlOrName || "",
    scope,
    category,
    description: categoryDescriptions[category],
    features: features.length > 0 ? features : ["General filter rules"],
    targets,
    trusted: false,
    priority: category === "unbreak" ? 0 : 2,
    recommendedFor: scopeExplanations[scope],
    warning,
  };
}

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

export const filterLists: FilterListInfo[] = CURATED_SOURCE_PROFILES.map(
  (profile) => ({
    name: profile.name,
    url: profile.url,
    enabled: true,
    scope: profile.scope,
    category: profile.category,
    description: profile.description,
  }),
);

export const sourceCategories: SourceCategoryMap = Object.fromEntries(
  CURATED_SOURCE_PROFILES.map((p) => [
    p.name,
    {
      category: p.category,
      trusted: p.trusted,
      priority: p.priority,
    },
  ]),
);

// Backward compatibility aliases for sourceCategories
sourceCategories["uBlock Filters"] = {
  category: "ads",
  trusted: true,
  priority: 1,
};

for (const legacyName of LEGACY_DEFENSE_MODULE_NAMES) {
  const currentName = legacyName.replace(/^Blockingmachine\s+/i, "");
  if (sourceCategories[currentName]) {
    sourceCategories[legacyName] = sourceCategories[currentName];
  }
}

export const sourceValidation: SourceValidationMap = {
  updateFrequency: {
    "AdGuard DNS Filter": "24h",
    "uBlock Origin Filters": "24h",
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

export const sourceConfig: SourceConfig = {
  retries: 3,
  timeout: 30000,
  maxRedirects: 5,
  userAgent: "Blockingmachine/1.0",
  additionalHeaders: {},
};
