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
    name: 'Blockingmachine Privacy Engine [Beta]',
    url: './filters/modules/blockingmachine-privacy.txt',
    scope: 'hybrid',
    category: 'Privacy',
    description: 'First-party high-precision telemetry, fingerprinting, diagnostic beacon, and analytics blocker.',
    features: ['Zero telemetry', 'OS diagnostic shielding', 'Analytics suppression'],
    recommendedFor: 'All devices and browsers seeking maximum privacy without site breakage',
  },
  {
    name: 'Blockingmachine Smart TV & IoT Shield [Beta]',
    url: './filters/modules/blockingmachine-smarttv.txt',
    scope: 'dns',
    category: 'Privacy',
    description: 'First-party blocker targeting smart TV ACR telemetry, diagnostics, and in-app ads on Roku, Samsung, LG, and FireTV.',
    features: ['Smart TV ACR blocking', 'IoT telemetry shield', 'Pure DNS rules'],
    recommendedFor: 'Home network DNS sinkholes, AdGuard Home, and Pi-hole',
  },
  {
    name: 'Blockingmachine Web Annoyances & Cookie Banners [Beta]',
    url: './filters/modules/blockingmachine-annoyances.txt',
    scope: 'browser',
    category: 'Annoyances',
    description: 'First-party shield eliminating intrusive GDPR cookie banners, CMP modals, newsletter popups, and floating nag screens.',
    features: ['Cookie banner removal', 'GDPR overlay suppression', 'Element hiding'],
    recommendedFor: 'Browser extensions and desktop content blockers',
    warning: 'Contains cosmetic rules (##) that require DOM inspection; ineffective on pure DNS sinkholes',
  },
  {
    name: 'Blockingmachine Social Tracker Neutralizer [Beta]',
    url: './filters/modules/blockingmachine-social.txt',
    scope: 'hybrid',
    category: 'Social',
    description: 'First-party filter neutralizing cross-site tracking beacons, embedded share widgets, and Meta/TikTok/X pixels.',
    features: ['Cross-site pixel blocking', 'Third-party beacon neutralization', 'Social widget hiding'],
    recommendedFor: 'Browser extensions, DNS sinkholes, and desktop ad-blockers',
  },
  {
    name: 'Blockingmachine Threat & Malicious Domain Defense [Beta]',
    url: './filters/modules/blockingmachine-security.txt',
    scope: 'dns',
    category: 'Security',
    description: 'First-party proactive network-level blocking of phishing gateways, rogue redirects, and in-browser cryptominers.',
    features: ['Anti-cryptomining', 'Malicious redirect shield', 'Phishing defense'],
    recommendedFor: 'Network firewalls, routers, Pi-hole, and AdGuard Home',
  },
  {
    name: 'Blockingmachine Unbreak & Safe Exceptions [Beta]',
    url: './filters/modules/blockingmachine-unbreak.txt',
    scope: 'hybrid',
    category: 'Privacy',
    description: 'First-party hand-crafted exception allowlist rules for banking portals, SSO logins, delivery tracking, and essential apps.',
    features: ['Banking portal fixes', 'SSO allowlists', 'Anti-breakage rules (@@)'],
    recommendedFor: 'Essential for all configurations to guarantee normal app functionality',
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

export const PRESET_BUNDLES: PresetBundle[] = [
  {
    id: 'blockingmachine-suite',
    name: 'Blockingmachine Defense Suite [Beta]',
    description: 'Our complete native modular defense suite: Privacy Engine, Smart TV & IoT Shield, Web Annoyances, Social Neutralizer, Threat Defense, and Safe Exceptions.',
    badge: '★ First-Party Beta',
    category: 'Full Defense [Beta]',
    items: [
      PRESET_CATALOG[11], // Privacy Engine [Beta]
      PRESET_CATALOG[12], // Smart TV & IoT Shield [Beta]
      PRESET_CATALOG[13], // Web Annoyances [Beta]
      PRESET_CATALOG[14], // Social Tracker Neutralizer [Beta]
      PRESET_CATALOG[15], // Threat Defense [Beta]
      PRESET_CATALOG[16], // Unbreak & Exceptions [Beta]
    ],
  },
  {
    id: 'essential',
    name: 'Essential Shield Pack',
    description: 'The definitive baseline: blocks network ads, malware trackers, and intrusive beacons without breaking websites.',
    badge: 'Recommended',
    category: 'Advertising & Security',
    items: [
      PRESET_CATALOG[0], // AdGuard DNS (dns)
      PRESET_CATALOG[1], // uBlock Origin (hybrid)
      PRESET_CATALOG[6], // Peter Lowe (dns)
    ],
  },
  {
    id: 'privacy-fortress',
    name: 'Privacy & Anti-Telemetry Fortress',
    description: 'High-rigor telemetry neutralization for Windows/Office background tracking and aggressive trackers, plus unbreak fixes.',
    badge: 'Max Privacy',
    category: 'Privacy',
    items: [
      PRESET_CATALOG[4], // HaGeZi Windows/Office (dns)
      PRESET_CATALOG[5], // uBlock Unbreak (hybrid)
      PRESET_CATALOG[7], // OISD Blocklist Small (dns)
    ],
  },
  {
    id: 'distraction-free',
    name: 'Distraction-Free Web Pack',
    description: 'Eliminates annoying GDPR cookie notices, floating popups, newsletter walls, and cross-site social tracking buttons.',
    badge: 'Clean Browsing',
    category: 'Annoyances & Social',
    items: [
      PRESET_CATALOG[8], // AdGuard Annoyances (browser)
      PRESET_CATALOG[9], // Fanboy's Annoyance (browser)
      PRESET_CATALOG[10], // AdGuard Social (browser)
    ],
  },
];

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
        return <span className="source-scope-badge scope-dns">🌐 DNS Safe</span>;
      case 'browser':
        return <span className="source-scope-badge scope-browser">🖥️ Browser Only</span>;
      case 'hybrid':
      default:
        return <span className="source-scope-badge scope-hybrid">⚡ Hybrid</span>;
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
            ✕
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
                  🌐 DNS Safe
                </button>
                <button
                  className={`scope-filter-pill scope-browser-btn ${selectedScope === 'browser' ? 'active' : ''}`}
                  onClick={() => setSelectedScope('browser')}
                  title="Filter browser cosmetic & element-hiding feeds"
                >
                  🖥️ Browser Only
                </button>
                <button
                  className={`scope-filter-pill scope-hybrid-btn ${selectedScope === 'hybrid' ? 'active' : ''}`}
                  onClick={() => setSelectedScope('hybrid')}
                  title="Filter hybrid network + cosmetic feeds"
                >
                  ⚡ Hybrid
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
                        <span className="preset-target-hint">🎯 {preset.recommendedFor}</span>
                      </div>

                      {preset.warning && (
                        <div className="preset-warning-notice">
                          <span>⚠️ {preset.warning}</span>
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

