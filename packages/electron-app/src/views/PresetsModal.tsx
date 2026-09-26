import React, { useState } from 'react';
import type { FilterSource, SourceScope } from '../types';

export interface PresetItem {
  name: string;
  url: string;
  scope: SourceScope;
  category: string;
  description: string;
  features: string[];
  recommendedFor: string;
  warning?: string;
}

export const PRESET_CATALOG: PresetItem[] = [
  {
    name: 'AdGuard DNS Filter',
    url: 'https://filters.adtidy.org/extension/chromium/filters/15.txt',
    scope: 'dns',
    category: 'Advertising',
    description: 'Comprehensive network-level blocklist for advertising domains and popups, stripped of cosmetic rules.',
    features: ['DNS sinkhole safe', 'No DOM overhead', 'Ad blocking'],
    recommendedFor: 'Pi-hole, AdGuard Home, router firewalls, and network DNS resolvers',
  },
  {
    name: 'uBlock Origin Filters',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    scope: 'hybrid',
    category: 'Advertising',
    description: 'Official uBlock Origin core network request blocks, advanced cosmetic element-hiding, and procedural scriptlets.',
    features: ['Cosmetic element hiding', 'Scriptlet injection', 'Network blocking'],
    recommendedFor: 'uBlock Origin, AdGuard Browser Extension, Brave Shields',
    warning: 'Contains cosmetic rules (##, #@#) that are ignored by network DNS resolvers',
  },
  {
    name: 'EasyList',
    url: 'https://easylist.to/easylist/easylist.txt',
    scope: 'hybrid',
    category: 'Advertising',
    description: 'The foundational open-source ad-blocking rule set that removes adverts from international web pages.',
    features: ['Standard ABP syntax', 'Global ad rules', 'Element hiding'],
    recommendedFor: 'Browser extensions and unified ad-blocking pipelines',
  },
  {
    name: 'AdGuard Base Filter',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt',
    scope: 'hybrid',
    category: 'Advertising',
    description: 'Standard AdGuard base list for blocking banners, video ads, and popups across web pages.',
    features: ['Banner blocking', 'Video ad filtering', 'Cosmetic rules'],
    recommendedFor: 'Browser extensions and unified blocking engines',
  },
  {
    name: "HaGeZi's Windows/Office Tracker",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_63.txt',
    scope: 'dns',
    category: 'Privacy',
    description: 'Aggressively blocks telemetry, diagnostic beacons, and background trackers on Windows and Office.',
    features: ['Windows telemetry', 'Office diagnostics', 'Pure DNS domains'],
    recommendedFor: 'Pi-hole, AdGuard Home, Windows desktop users seeking maximum OS privacy',
  },
  {
    name: 'uBlock Unbreak Filter',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/unbreak.txt',
    scope: 'hybrid',
    category: 'Privacy',
    description: 'Crucial exception rules that fix web pages, logins, and checkouts broken by aggressive blocking.',
    features: ['Exception rules (@@)', 'Site unbreaking', 'Anti-breakage allowlists'],
    recommendedFor: 'All setups to prevent broken web pages, logins, and checkouts',
  },
  {
    name: "Peter Lowe's List",
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblock&showintro=0&mimetype=plaintext',
    scope: 'dns',
    category: 'Security',
    description: 'Hand-curated, low-false-positive list of tracking servers and malicious ad delivery networks.',
    features: ['Conservative blocking', 'DNS hosts format', 'Low false-positives'],
    recommendedFor: 'Network-wide DNS sinkholes and ad blockers',
  },
  {
    name: 'OISD Blocklist Small',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_5.txt',
    scope: 'dns',
    category: 'Security',
    description: 'Renowned curated blocklist focused on high-confidence malware, phishing, and aggressive tracking.',
    features: ['Zero false-positives', 'Pure DNS domains', 'Safe for home networks'],
    recommendedFor: 'Every network DNS sinkhole (Pi-hole, AdGuard Home, router firewalls)',
  },
  {
    name: 'AdGuard Annoyances Filter',
    url: 'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_14_Annoyances/filter.txt',
    scope: 'browser',
    category: 'Annoyances',
    description: 'Blocks cookie notices, floating GDPR popups, push notifications, and mobile app banners.',
    features: ['Cookie banner hiding', 'GDPR modal suppression', 'Floating nag removal'],
    recommendedFor: 'Browser extensions (requires DOM/CSS inspection; ineffective on DNS sinkholes)',
    warning: 'Purely cosmetic: cannot be enforced by network DNS sinkholes like Pi-hole',
  },
  {
    name: "Fanboy's Annoyance List",
    url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    scope: 'browser',
    category: 'Annoyances',
    description: 'Removes social widgets, in-page popups, newsletter overlays, and nag screens.',
    features: ['Cookie notices', 'Social buttons', 'In-page popups'],
    recommendedFor: 'Browser extensions (requires DOM/CSS inspection; ineffective on DNS sinkholes)',
    warning: 'Purely cosmetic: cannot be enforced by network DNS sinkholes like Pi-hole',
  },
  {
    name: 'AdGuard Social Media Filter',
    url: 'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_4_Social/filter.txt',
    scope: 'browser',
    category: 'Social',
    description: 'Blocks Like buttons, share widgets, and cross-site social tracking beacons.',
    features: ['Social widget hiding', 'Facebook Pixel neutralization', 'Like button removal'],
    recommendedFor: 'Browser extensions (removes embedded social widgets from web layouts)',
  },
  {
    name: 'Base Ad Shield [Beta]',
    url: './filters/modules/blockingmachine-base.txt',
    scope: 'hybrid',
    category: 'Advertising',
    description: 'Native primary advertising network, video ad injection, banner exchange, and sponsored recommendation blocker.',
    features: ['Cross-web ad blocking', 'Video ad suppression', 'Programmatic bidding filter'],
    recommendedFor: 'Essential ad-blocking foundation for browsers and network-level sinkholes',
  },
  {
    name: 'Privacy Engine [Beta]',
    url: './filters/modules/blockingmachine-privacy.txt',
    scope: 'hybrid',
    category: 'Privacy',
    description: 'First-party high-precision telemetry, fingerprinting, diagnostic beacon, and analytics blocker.',
    features: ['Zero telemetry', 'OS diagnostic shielding', 'Analytics suppression'],
    recommendedFor: 'All devices and browsers seeking maximum privacy without site breakage',
  },
  {
    name: 'Smart TV & IoT Shield [Beta]',
    url: './filters/modules/blockingmachine-smarttv.txt',
    scope: 'dns',
    category: 'Privacy',
    description: 'First-party blocker targeting smart TV ACR telemetry, diagnostics, and in-app ads on Roku, Samsung, LG, and FireTV.',
    features: ['Smart TV ACR blocking', 'IoT telemetry shield', 'Pure DNS rules'],
    recommendedFor: 'Home network DNS sinkholes, AdGuard Home, and Pi-hole',
  },
  {
    name: 'Web Annoyances & Cookie Banners [Beta]',
    url: './filters/modules/blockingmachine-annoyances.txt',
    scope: 'browser',
    category: 'Annoyances',
    description: 'First-party shield eliminating intrusive GDPR cookie banners, CMP modals, newsletter popups, and floating nag screens.',
    features: ['Cookie banner removal', 'GDPR overlay suppression', 'Element hiding'],
    recommendedFor: 'Browser extensions and desktop content blockers',
    warning: 'Contains cosmetic rules (##) that require DOM inspection; ineffective on pure DNS sinkholes',
  },
  {
    name: 'Social Tracker Neutralizer [Beta]',
    url: './filters/modules/blockingmachine-social.txt',
    scope: 'hybrid',
    category: 'Social',
    description: 'First-party filter neutralizing cross-site tracking beacons, embedded share widgets, and Meta/TikTok/X pixels.',
    features: ['Cross-site pixel blocking', 'Third-party beacon neutralization', 'Social widget hiding'],
    recommendedFor: 'Browser extensions, DNS sinkholes, and desktop ad-blockers',
  },
  {
    name: 'Threat & Malicious Domain Defense [Beta]',
    url: './filters/modules/blockingmachine-security.txt',
    scope: 'dns',
    category: 'Security',
    description: 'First-party proactive network-level blocking of phishing gateways, rogue redirects, and in-browser cryptominers.',
    features: ['Anti-cryptomining', 'Malicious redirect shield', 'Phishing defense'],
    recommendedFor: 'Network firewalls, routers, Pi-hole, and AdGuard Home',
  },
  {
    name: 'URL Tracking Stripper [Beta]',
    url: './filters/modules/blockingmachine-url-tracking.txt',
    scope: 'browser',
    category: 'Privacy',
    description: 'Native query parameter stripper eliminating tracking tokens, click identifiers, and referral parameters across the web.',
    features: ['Click ID removal (fbclid/gclid)', 'UTM parameter stripping', 'Referral token sanitization'],
    recommendedFor: 'Browser extensions and content blockers supporting $removeparam rules',
  },
  {
    name: 'Unbreak & Safe Exceptions [Beta]',
    url: './filters/modules/blockingmachine-unbreak.txt',
    scope: 'hybrid',
    category: 'Privacy',
    description: 'First-party hand-crafted exception allowlist rules for banking portals, SSO logins, delivery tracking, and essential apps.',
    features: ['Banking portal fixes', 'SSO allowlists', 'Anti-breakage rules (@@)'],
    recommendedFor: 'Essential for all configurations to guarantee normal app functionality',
  },
  {
    name: 'GetAdmiral Domains',
    url: 'https://raw.githubusercontent.com/LanikSJ/ubo-filters/main/filters/getadmiral-domains.txt',
    scope: 'dns',
    category: 'Advertising',
    description: 'Neutralizes and blocks hundreds of known dynamic and static domains associated with Admiral anti-adblock detection and paywall circumvention.',
    features: ['Admiral neutralization', 'Paywall circumvention bypass', 'Pure DNS domains'],
    recommendedFor: 'Bypassing anti-adblock paywalls and nag screens network-wide',
  },
  {
    name: 'Anti-Adblock & Ad-Recovery Defusers',
    url: 'https://raw.githubusercontent.com/greigh/blockingmachine/main/packages/database/sources/blockingmachine-rules.txt',
    scope: 'hybrid',
    category: 'Advertising',
    description: 'Multi-vendor circumvention mitigation neutralizing Admiral, Google Funding Choices, BlockThrough, AdInPlay, Ezoic, and Bait Defusers.',
    features: ['Scriptlet Defusers', 'Anti-Adblock Modal Suppression', 'Scroll-Lock Removal', 'Multi-Vendor Shield'],
    recommendedFor: 'Bypassing aggressive anti-adblock modals, game canvas locks, and paywall overlays',
  },
  // ─── Security & Malware ──────────────────────────────────────────────────────
  {
    name: 'URLhaus Malware Domains',
    url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-agh-online.txt',
    scope: 'dns',
    category: 'Security',
    description: 'Active malware URL intelligence from URLhaus (abuse.ch). Blocks domains actively distributing malware payloads in real time.',
    features: ['Real-time malware domains', 'DNS sinkhole safe', 'High-confidence IOCs', 'Abuse.ch intelligence'],
    recommendedFor: 'Pi-hole, AdGuard Home, router firewalls — home and enterprise networks',
  },
  {
    name: 'Phishing Army',
    url: 'https://phishing.army/download/phishing_army_blocklist_extended.txt',
    scope: 'dns',
    category: 'Security',
    description: 'Community-maintained phishing domain blocklist targeting credential harvesting pages, fake login portals, and brand impersonation sites.',
    features: ['Phishing domains', 'Brand spoof defense', 'Pure DNS', 'Frequent updates'],
    recommendedFor: 'All DNS sinkholes — especially family and corporate networks',
  },
  {
    name: 'Malicious URL Filter (RPiList)',
    url: 'https://raw.githubusercontent.com/RPiList/specials/master/Blocklisten/malware',
    scope: 'dns',
    category: 'Security',
    description: 'Curated blocklist of active malware, ransomware, botnet C2, and exploit kit delivery infrastructure.',
    features: ['C2 botnet domains', 'Ransomware infrastructure', 'Exploit kit domains', 'Pure DNS'],
    recommendedFor: 'Pi-hole, AdGuard Home, network firewalls',
  },
  {
    name: 'Hagezi DNS Blocklist — Multi-PRO',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_59.txt',
    scope: 'dns',
    category: 'Privacy',
    description: "HaGeZi's Multi-PRO: an aggressive all-in-one DNS blocklist covering ads, trackers, telemetry, malware, coin mining, and phishing.",
    features: ['Ads', 'Trackers', 'Malware', 'Coinminers', 'Phishing', 'Pure DNS'],
    recommendedFor: 'Pi-hole and AdGuard Home users wanting a single comprehensive list',
  },
  {
    name: 'Hagezi DNS Blocklist — Threat Intelligence',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_67.txt',
    scope: 'dns',
    category: 'Security',
    description: "HaGeZi's threat intelligence feed: active botnet C2, ransomware infrastructure, and live phishing sites curated from multiple threat intelligence sources.",
    features: ['Active C2 domains', 'Ransomware domains', 'Phishing sites', 'Pure DNS', 'Frequently updated'],
    recommendedFor: 'Network firewalls, Pi-hole, and AdGuard Home requiring threat-intelligence-grade blocking',
  },
  {
    name: 'Steven Black Unified Hosts (Ads + Malware)',
    url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
    scope: 'dns',
    category: 'Advertising',
    description: 'The most widely used merged hosts file combining adware and malware blocking from multiple community sources.',
    features: ['Unified hosts file', 'Adware blocking', 'Malware blocking', 'Industry standard'],
    recommendedFor: 'All DNS sinkholes — the baseline hosts file used by millions',
  },
  {
    name: 'OISD Full Blocklist',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_27.txt',
    scope: 'dns',
    category: 'Advertising',
    description: 'Full edition of the acclaimed OISD list. Covers ads, trackers, and malicious domains with aggressive blocking and minimal false positives.',
    features: ['Ads', 'Trackers', 'Malicious domains', 'Pure DNS', 'Low false-positive rate'],
    recommendedFor: 'All DNS sinkholes seeking a more comprehensive alternative to the OISD Small edition',
  },
  {
    name: 'NextDNS Privacy Essentials',
    url: 'https://raw.githubusercontent.com/nicktacular/nextdns-privacy-essentials/main/blocklist.txt',
    scope: 'dns',
    category: 'Privacy',
    description: 'Essential privacy-focused list targeting analytics, fingerprinting scripts, and invasive trackers without breaking popular sites.',
    features: ['Analytics blocking', 'Fingerprint scripts', 'DNS sinkhole safe', 'Low breakage'],
    recommendedFor: 'DNS sinkholes and users wanting privacy without site breakage',
  },
  // ─── Mobile Ads ──────────────────────────────────────────────────────────────
  {
    name: 'AdAway Hosts (Mobile Ad Blocking)',
    url: 'https://adaway.org/hosts.txt',
    scope: 'dns',
    category: 'Advertising',
    description: 'The classic Android AdAway hosts blocklist targeting mobile advertising networks, in-app ad SDKs, and mobile telemetry.',
    features: ['Mobile ad networks', 'In-app ad SDKs', 'DNS sinkhole safe', 'Android optimized'],
    recommendedFor: 'Pi-hole and AdGuard Home covering Android and mobile device traffic',
  },
  {
    name: 'Mobile Ad & Tracker Shield (RPiList)',
    url: 'https://raw.githubusercontent.com/RPiList/specials/master/Blocklisten/samsung',
    scope: 'dns',
    category: 'Privacy',
    description: 'Aggressively blocks Samsung analytics, Bixby telemetry, SmartHub ads, and mobile ad SDKs common on Android devices.',
    features: ['Samsung telemetry', 'Bixby diagnostics', 'In-app ads', 'Pure DNS'],
    recommendedFor: 'Pi-hole and AdGuard Home with Samsung and Android devices on the network',
  },
  // ─── Crypto / Gambling ───────────────────────────────────────────────────────
  {
    name: 'CoinMiner & Cryptojacking Blocker',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_50.txt',
    scope: 'dns',
    category: 'Security',
    description: 'Dedicated list blocking in-browser cryptomining scripts (Coinhive variants, cryptoloot) and background JavaScript miners.',
    features: ['Cryptojacking scripts', 'In-browser miners', 'DNS sinkhole safe', 'Auto-updated'],
    recommendedFor: 'All networks — prevents silent CPU drain from cryptomining injections',
  },
  {
    name: 'Gambling & Betting Domains',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_27.txt',
    scope: 'dns',
    category: 'Annoyances',
    description: 'Blocks known online gambling, sports betting, and casino domains for network-wide parental and policy controls.',
    features: ['Casino domains', 'Sports betting', 'Pure DNS', 'Family-safe'],
    recommendedFor: 'Family networks, schools, and corporate environments blocking gambling sites',
  },
  // ─── Annoyances / Cosmetic ───────────────────────────────────────────────────
  {
    name: 'uBlock Origin Annoyances (Cookie Notices)',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances.txt',
    scope: 'browser',
    category: 'Annoyances',
    description: 'uBlock Origin annoyances filter removing cookie consent dialogs, GDPR overlays, newsletter popups, and nag screens across thousands of sites.',
    features: ['Cookie notices', 'GDPR overlays', 'Push notification prompts', 'Newsletter popups'],
    recommendedFor: 'Browser extensions (uBlock Origin, AdGuard Browser)',
    warning: 'Cosmetic rules — not effective on DNS-only sinkholes like Pi-hole',
  },
  {
    name: 'Legitimate URL Shorteners',
    url: 'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/LegitimateURLShortener.txt',
    scope: 'browser',
    category: 'Privacy',
    description: 'Cleans and expands shortened URLs (bit.ly, t.co, shorturl.at) to reveal their true destinations and remove redirector tracking.',
    features: ['URL shortener expansion', 'Redirect tracking removal', 'Privacy protection'],
    recommendedFor: 'Browser extensions supporting $removeparam and URL expansion rules',
  },
  {
    name: 'DandelionSprout Anti-Malware',
    url: 'https://raw.githubusercontent.com/DandelionSprout/adfilt/master/Dandelion%20Sprout%27s%20Anti-Malware%20List.txt',
    scope: 'hybrid',
    category: 'Security',
    description: 'Comprehensive malware, scam, and potentially unwanted program (PUP) blocklist covering suspicious installers, fake cracks, and rogue sites.',
    features: ['Malware domains', 'Scam sites', 'PUP downloads', 'Fake installer blocks'],
    recommendedFor: 'Browser extensions and DNS sinkholes wanting stronger malware coverage',
  },
  // ─── Advanced ────────────────────────────────────────────────────────────────
  {
    name: 'NextDNS CNAME Cloaking Shield',
    url: 'https://raw.githubusercontent.com/nicktacular/nextdns-cname-cloaking/main/blocklist.txt',
    scope: 'dns',
    category: 'Privacy',
    description: 'Targets CNAME cloaking evasion techniques where trackers hide behind first-party subdomains to bypass standard DNS blocking.',
    features: ['CNAME cloaking', 'First-party tracker evasion', 'DNS resolver level', 'Advanced privacy'],
    recommendedFor: 'AdGuard Home and resolvers supporting CNAME flattening',
  },
  {
    name: 'The Big Block (1Hosts Pro)',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_44.txt',
    scope: 'dns',
    category: 'Advertising',
    description: '1Hosts Pro — a large consolidated blocklist covering advertising, tracking, and analytics with a focus on minimal false positives.',
    features: ['Ads', 'Trackers', 'Analytics', 'Pure DNS', 'Conservative false-positive rate'],
    recommendedFor: 'Pi-hole and AdGuard Home wanting a single large consolidated list',
  },
];

export interface PresetBundle {
  id: string;
  name: string;
  description: string;
  badge: string;
  category: string;
  items: PresetItem[];
}

export const PRESET_BUNDLES: PresetBundle[] = (() => {
  const byName = (name: string): PresetItem => {
    const found = PRESET_CATALOG.find((p) => p.name === name);
    if (!found) throw new Error(`Preset not found: ${name}`);
    return found;
  };

  return [
    {
      id: 'blockingmachine-suite',
      name: 'Defense Suite [Beta]',
      description: 'Our complete 8-part native modular defense suite: Base Ads, Privacy Engine, Smart TV & IoT Shield, Web Annoyances, Social Neutralizer, Threat Defense, URL Tracking Stripper, and Safe Exceptions.',
      badge: 'First-Party Beta',
      category: 'Full Defense [Beta]',
      items: PRESET_CATALOG.filter((p) => p.url.startsWith('./filters/modules/blockingmachine-') && p.name.includes('[Beta]')),
    },
    {
      id: 'essential',
      name: 'Essential Shield Pack',
      description: 'The definitive baseline: blocks network ads, malware trackers, and intrusive beacons without breaking websites.',
      badge: 'Recommended',
      category: 'Advertising & Security',
      items: [
        byName('AdGuard DNS Filter'),
        byName('uBlock Origin Filters'),
        byName("Peter Lowe's List"),
        byName('OISD Blocklist Small'),
      ],
    },
    {
      id: 'threat-intelligence',
      name: 'Threat Intelligence & Malware Defense',
      description: 'Multi-source threat intelligence blocking active malware delivery domains, phishing portals, C2 botnet infrastructure, and cryptojacking scripts in real time.',
      badge: 'Security',
      category: 'Security',
      items: [
        byName('URLhaus Malware Domains'),
        byName('Phishing Army'),
        byName('Hagezi DNS Blocklist — Threat Intelligence'),
        byName('CoinMiner & Cryptojacking Blocker'),
      ],
    },
    {
      id: 'privacy-fortress',
      name: 'Privacy & Anti-Telemetry Fortress',
      description: 'High-rigor telemetry neutralization for Windows/Office background tracking, aggressive trackers, and fingerprinting scripts, plus unbreak fixes.',
      badge: 'Max Privacy',
      category: 'Privacy',
      items: [
        byName("HaGeZi's Windows/Office Tracker"),
        byName('Hagezi DNS Blocklist — Multi-PRO'),
        byName('uBlock Unbreak Filter'),
      ],
    },
    {
      id: 'anti-adblock-defuser',
      name: 'Anti-Adblock & Paywall Defuser',
      description: 'Comprehensive circumvention mitigation neutralizing Admiral, Google Funding Choices, BlockThrough, AdInPlay, and aggressive anti-adblock nag screens.',
      badge: 'Anti-Circumvention',
      category: 'Anti-Adblock Mitigation',
      items: [
        byName('GetAdmiral Domains'),
        byName('Anti-Adblock & Ad-Recovery Defusers'),
        byName('AdGuard Annoyances Filter'),
      ],
    },
    {
      id: 'distraction-free',
      name: 'Distraction-Free Web Pack',
      description: 'Eliminates annoying GDPR cookie notices, floating popups, newsletter walls, cross-site social tracking buttons, and push notification nags.',
      badge: 'Clean Browsing',
      category: 'Annoyances & Social',
      items: [
        byName('AdGuard Annoyances Filter'),
        byName("Fanboy's Annoyance List"),
        byName('AdGuard Social Media Filter'),
        byName('uBlock Origin Annoyances (Cookie Notices)'),
      ],
    },
    {
      id: 'mobile-shield',
      name: 'Mobile & Smart Device Shield',
      description: 'Network-wide blocking of mobile ad SDKs, in-app advertising networks, Samsung/Bixby telemetry, and Android tracking — covering all devices on your network.',
      badge: 'Mobile',
      category: 'Privacy & Advertising',
      items: [
        byName('AdAway Hosts (Mobile Ad Blocking)'),
        byName('Mobile Ad & Tracker Shield (RPiList)'),
        byName('AdGuard DNS Filter'),
      ],
    },
  ];
})();

interface PresetsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentSources: FilterSource[];
  onAddPreset: (preset: FilterSource) => void;
  onAddMultiplePresets?: (presets: FilterSource[]) => void;
}

export const PresetsModal: React.FC<PresetsModalProps> = ({
  isOpen,
  onClose,
  currentSources,
  onAddPreset,
  onAddMultiplePresets,
}) => {
  const [activeTab, setActiveTab] = useState<'feeds' | 'packs'>('packs');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [selectedScope, setSelectedScope] = useState<'all' | SourceScope>('all');
  const [search, setSearch] = useState<string>('');

  if (!isOpen) return null;

  const categories = ['All', 'Advertising', 'Privacy', 'Security', 'Annoyances', 'Social'];

  const filteredPresets = PRESET_CATALOG.filter((item) => {
    const matchesCategory =
      selectedCategory === 'All' || item.category === selectedCategory;
    const matchesScope =
      selectedScope === 'all' || item.scope === selectedScope;
    const matchesSearch =
      item.name.toLowerCase().includes(search.toLowerCase()) ||
      item.description.toLowerCase().includes(search.toLowerCase()) ||
      item.recommendedFor.toLowerCase().includes(search.toLowerCase());
    return matchesCategory && matchesScope && matchesSearch;
  });

  const handleSubscribeBundle = (bundle: PresetBundle) => {
    const toAdd: FilterSource[] = bundle.items.map((item) => ({
      name: item.name,
      url: item.url,
      enabled: true,
      scope: item.scope,
      category: item.category,
      description: item.description,
      recommendedFor: item.recommendedFor,
    }));

    if (onAddMultiplePresets) {
      onAddMultiplePresets(toAdd);
    } else {
      toAdd.forEach((preset) => {
        const alreadyHas = currentSources.some(
          (s) => s.url.trim().toLowerCase() === preset.url.trim().toLowerCase(),
        );
        if (!alreadyHas) {
          onAddPreset(preset);
        }
      });
    }
  };

  const renderScopePill = (scope: SourceScope) => {
    switch (scope) {
      case 'dns':
        return (
          <span className="source-scope-badge scope-dns">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            DNS Safe
          </span>
        );
      case 'browser':
        return (
          <span className="source-scope-badge scope-browser">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            Browser Only
          </span>
        );
      case 'hybrid':
      default:
        return (
          <span className="source-scope-badge scope-hybrid">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            Hybrid
          </span>
        );
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog presets-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-wrap">
            <h2 className="modal-title">Recommended Filter Feeds & Packs</h2>
            <p className="modal-subtitle">
              Quickly subscribe to curated, high-reputation adblock and privacy blocklists with full layer & scope intelligence.
            </p>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close modal">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Subnav Tabs */}
        <div className="presets-modal-tabs">
          <button
            className={`presets-modal-tab ${activeTab === 'packs' ? 'active' : ''}`}
            onClick={() => setActiveTab('packs')}
          >
            Curated Defense Packs ({PRESET_BUNDLES.length})
          </button>
          <button
            className={`presets-modal-tab ${activeTab === 'feeds' ? 'active' : ''}`}
            onClick={() => setActiveTab('feeds')}
          >
            Individual Feeds ({PRESET_CATALOG.length})
          </button>
        </div>

        {activeTab === 'packs' ? (
          <div className="preset-bundles-container">
            {PRESET_BUNDLES.map((bundle) => {
              const totalItems = bundle.items.length;
              const subscribedItems = bundle.items.filter((item) =>
                currentSources.some(
                  (s) => s.url.trim().toLowerCase() === item.url.trim().toLowerCase(),
                ),
              ).length;
              const isAllSubscribed = subscribedItems === totalItems;
              const unaddedCount = totalItems - subscribedItems;

              return (
                <div key={bundle.id} className="preset-bundle-card">
                  <div className="preset-bundle-header">
                    <div>
                      <div className="preset-bundle-title-row">
                        <span className="preset-bundle-title">{bundle.name}</span>
                        <span className="preset-bundle-badge">{bundle.badge}</span>
                      </div>
                      <span className="preset-bundle-cat">{bundle.category}</span>
                    </div>
                    <div>
                      {isAllSubscribed ? (
                        <span className="preset-subscribed-badge">✓ Active ({totalItems}/{totalItems})</span>
                      ) : (
                        <button
                          className="primary-button preset-bundle-btn"
                          onClick={() => handleSubscribeBundle(bundle)}
                        >
                          + Subscribe Pack ({unaddedCount} new)
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="preset-bundle-desc">{bundle.description}</p>
                  <div className="preset-bundle-items-list">
                    {bundle.items.map((item) => {
                      const isItemAdded = currentSources.some(
                        (s) => s.url.trim().toLowerCase() === item.url.trim().toLowerCase(),
                      );
                      return (
                        <span
                          key={item.url}
                          className={`preset-bundle-feed-tag ${isItemAdded ? 'added' : ''}`}
                        >
                          {isItemAdded ? '✓ ' : '+ '}
                          {item.name} ({item.scope.toUpperCase()})
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <>
            {/* Filter and Search Bar */}
            <div className="presets-controls-stack">
              <div className="presets-scope-bar">
                <span className="scope-filter-label">Layer Scope:</span>
                <button
                  className={`scope-filter-pill ${selectedScope === 'all' ? 'active' : ''}`}
                  onClick={() => setSelectedScope('all')}
                >
                  All Scopes
                </button>
                <button
                  className={`scope-filter-pill scope-dns-btn ${selectedScope === 'dns' ? 'active' : ''}`}
                  onClick={() => setSelectedScope('dns')}
                  title="Filter pure DNS-level sinkhole feeds"
                >
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                  DNS Safe
                </button>
                <button
                  className={`scope-filter-pill scope-browser-btn ${selectedScope === 'browser' ? 'active' : ''}`}
                  onClick={() => setSelectedScope('browser')}
                  title="Filter browser cosmetic & element-hiding feeds"
                >
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                  Browser Only
                </button>
                <button
                  className={`scope-filter-pill scope-hybrid-btn ${selectedScope === 'hybrid' ? 'active' : ''}`}
                  onClick={() => setSelectedScope('hybrid')}
                  title="Filter hybrid network + cosmetic feeds"
                >
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  Hybrid
                </button>
              </div>

              <div className="presets-controls-row">
                <div className="category-pills">
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      className={`category-pill ${selectedCategory === cat ? 'active' : ''}`}
                      onClick={() => setSelectedCategory(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  className="search-input presets-search"
                  placeholder="Search curated feeds..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            {/* Presets List */}
            <div className="presets-list-scroll">
              {filteredPresets.map((preset) => {
                const isAlreadyAdded = currentSources.some(
                  (s) => s.url.trim().toLowerCase() === preset.url.trim().toLowerCase(),
                );

                return (
                  <div key={preset.url} className="preset-card">
                    <div className="preset-card-main">
                      <div className="preset-title-row">
                        <span className="preset-name">{preset.name}</span>
                        <div className="preset-badges-group">
                          {renderScopePill(preset.scope)}
                          <span className={`preset-category-badge cat-${preset.category.toLowerCase()}`}>
                            {preset.category}
                          </span>
                        </div>
                      </div>

                      <p className="preset-desc">{preset.description}</p>

                      <div className="preset-features-row">
                        {preset.features.map((feat) => (
                          <span key={feat} className="preset-feature-pill">
                            • {feat}
                          </span>
                        ))}
                      </div>

                      <div className="preset-meta-footer">
                        <span className="preset-url" title={preset.url}>
                          {preset.url}
                        </span>
                        <span className="preset-target-hint">
                          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                            <circle cx="12" cy="12" r="10" />
                            <circle cx="12" cy="12" r="6" />
                            <circle cx="12" cy="12" r="2" />
                          </svg>
                          {preset.recommendedFor}
                        </span>
                      </div>

                      {preset.warning && (
                        <div className="preset-warning-notice">
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                          </svg>
                          <span>{preset.warning}</span>
                        </div>
                      )}
                    </div>

                    <div className="preset-card-action">
                      {isAlreadyAdded ? (
                        <span className="preset-subscribed-badge">✓ Subscribed</span>
                      ) : (
                        <button
                          className="primary-button preset-add-btn"
                          onClick={() =>
                            onAddPreset({
                              name: preset.name,
                              url: preset.url,
                              enabled: true,
                              scope: preset.scope,
                              category: preset.category,
                              description: preset.description,
                              recommendedFor: preset.recommendedFor,
                            })
                          }
                        >
                          + Add
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

