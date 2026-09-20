import React, { useState } from 'react';
import type { FilterSource } from '../types';

interface PresetItem {
  name: string;
  url: string;
  category: string;
  description: string;
}

const PRESET_CATALOG: PresetItem[] = [
  {
    name: 'AdGuard DNS Filter',
    url: 'https://filters.adtidy.org/extension/chromium/filters/15.txt',
    category: 'Advertising',
    description: 'Comprehensive DNS-level blocklist for advertising domains and popups.',
  },
  {
    name: 'uBlock Origin Filters',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    category: 'Advertising',
    description: 'Official uBlock Origin core network and cosmetic filter rules.',
  },
  {
    name: 'EasyList',
    url: 'https://easylist.to/easylist/easylist.txt',
    category: 'Advertising',
    description: 'The standard ad-blocking list that removes adverts from web pages.',
  },
  {
    name: 'AdGuard Base Filter',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt',
    category: 'Advertising',
    description: 'Standard AdGuard base list for blocking banners, video ads, and popups.',
  },
  {
    name: "HaGeZi's Windows/Office Tracker",
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_63.txt',
    category: 'Privacy',
    description: 'Blocks telemetry, diagnostic beacons, and background trackers on Windows and Office.',
  },
  {
    name: 'uBlock Unbreak Filter',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/unbreak.txt',
    category: 'Privacy',
    description: 'Crucial exception rules that fix web pages broken by aggressive blocking.',
  },
  {
    name: "Peter Lowe's List",
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblock&showintro=0&mimetype=plaintext',
    category: 'Security',
    description: 'Hand-curated, low-false-positive list of tracking and malicious ad servers.',
  },
  {
    name: 'OISD Blocklist Small',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_5.txt',
    category: 'Security',
    description: 'Popular aggregated blocklist focused on high-confidence malware and phishing domains.',
  },
  {
    name: 'AdGuard Annoyances Filter',
    url: 'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_14_Annoyances/filter.txt',
    category: 'Annoyances',
    description: 'Blocks cookie notices, floating GDPR popups, push notifications, and app banners.',
  },
  {
    name: "Fanboy's Annoyance List",
    url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    category: 'Annoyances',
    description: 'Removes social widgets, in-page popups, newsletter overlays, and nag screens.',
  },
  {
    name: 'AdGuard Social Media Filter',
    url: 'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_4_Social/filter.txt',
    category: 'Social',
    description: 'Blocks Like buttons, share widgets, and cross-site social tracking beacons.',
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
    id: 'essential',
    name: 'Essential Shield Pack',
    description: 'The definitive baseline: blocks network ads, malware trackers, and intrusive beacons without breaking websites.',
    badge: 'Recommended',
    category: 'Advertising & Security',
    items: [
      PRESET_CATALOG[0], // AdGuard DNS
      PRESET_CATALOG[1], // uBlock Origin
      PRESET_CATALOG[6], // Peter Lowe
    ],
  },
  {
    id: 'privacy-fortress',
    name: 'Privacy & Anti-Telemetry Fortress',
    description: 'High-rigor telemetry neutralization for Windows/Office background tracking and aggressive trackers, plus unbreak fixes.',
    badge: 'Max Privacy',
    category: 'Privacy',
    items: [
      PRESET_CATALOG[4], // HaGeZi Windows/Office
      PRESET_CATALOG[5], // uBlock Unbreak
      PRESET_CATALOG[7], // OISD Blocklist Small
    ],
  },
  {
    id: 'distraction-free',
    name: 'Distraction-Free Web Pack',
    description: 'Eliminates annoying GDPR cookie notices, floating popups, newsletter walls, and cross-site social tracking buttons.',
    badge: 'Clean Browsing',
    category: 'Annoyances & Social',
    items: [
      PRESET_CATALOG[8], // AdGuard Annoyances
      PRESET_CATALOG[9], // Fanboy's Annoyance
      PRESET_CATALOG[10], // AdGuard Social
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
  const [search, setSearch] = useState<string>('');

  if (!isOpen) return null;

  const categories = ['All', 'Advertising', 'Privacy', 'Security', 'Annoyances', 'Social'];

  const filteredPresets = PRESET_CATALOG.filter((item) => {
    const matchesCategory =
      selectedCategory === 'All' || item.category === selectedCategory;
    const matchesSearch =
      item.name.toLowerCase().includes(search.toLowerCase()) ||
      item.description.toLowerCase().includes(search.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const handleSubscribeBundle = (bundle: PresetBundle) => {
    const toAdd = bundle.items.map((item) => ({
      name: item.name,
      url: item.url,
      enabled: true,
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog presets-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-wrap">
            <h2 className="modal-title">Recommended Filter Feeds</h2>
            <p className="modal-subtitle">
              Quickly subscribe to curated, high-reputation adblock and privacy blocklists.
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
                          {item.name}
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
                        <span className={`preset-category-badge cat-${preset.category.toLowerCase()}`}>
                          {preset.category}
                        </span>
                      </div>
                      <p className="preset-desc">{preset.description}</p>
                      <span className="preset-url" title={preset.url}>
                        {preset.url}
                      </span>
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
