import React, { useState, useMemo } from 'react';
import type { FilterSource } from '../types/';

export interface NativeModuleItem {
  id: string;
  name: string;
  filename: string;
  url: string;
  scope: 'dns' | 'browser' | 'hybrid';
  category: 'Ads' | 'Privacy' | 'Security' | 'Annoyances' | 'Social' | 'Unbreak';
  description: string;
  features: string[];
  recommendedFor: string;
  warning?: string;
}

export const NATIVE_DEFENSE_MODULES: NativeModuleItem[] = [
  {
    id: 'base-ads',
    name: 'Blockingmachine Base Ad Shield [Beta]',
    filename: 'blockingmachine-base.txt',
    url: './filters/modules/blockingmachine-base.txt',
    scope: 'hybrid',
    category: 'Ads',
    description: 'Primary network-level and browser shield blocking banner ad exchanges, video ad injection, programmatic bidding, and sponsored recommendation networks.',
    features: ['Cross-web ad exchanges', 'Video ad injection suppression', 'Programmatic bidding filter', 'Cosmetic banner hiding'],
    recommendedFor: 'Essential ad-blocking foundation for browsers and network-level sinkholes',
  },
  {
    id: 'privacy-engine',
    name: 'Blockingmachine Privacy Engine [Beta]',
    filename: 'blockingmachine-privacy.txt',
    url: './filters/modules/blockingmachine-privacy.txt',
    scope: 'hybrid',
    category: 'Privacy',
    description: 'First-party high-precision telemetry, fingerprinting, diagnostic beacon, and analytics blocker.',
    features: ['Zero telemetry', 'OS diagnostic shielding', 'Product analytics suppression', 'APM beacon blocking'],
    recommendedFor: 'All devices and browsers seeking maximum privacy without site breakage',
  },
  {
    id: 'smart-tv',
    name: 'Blockingmachine Smart TV & IoT Shield [Beta]',
    filename: 'blockingmachine-smarttv.txt',
    url: './filters/modules/blockingmachine-smarttv.txt',
    scope: 'dns',
    category: 'Privacy',
    description: 'First-party blocker targeting smart TV ACR telemetry, diagnostics, and in-app ads on Roku, Samsung, LG, FireTV, and Android TV.',
    features: ['Smart TV ACR blocking', 'IoT telemetry shield', 'Pure DNS rules', 'Zero streaming video breakage'],
    recommendedFor: 'Home network DNS sinkholes, AdGuard Home, and Pi-hole',
  },
  {
    id: 'annoyances',
    name: 'Blockingmachine Web Annoyances & Cookie Banners [Beta]',
    filename: 'blockingmachine-annoyances.txt',
    url: './filters/modules/blockingmachine-annoyances.txt',
    scope: 'browser',
    category: 'Annoyances',
    description: 'First-party shield eliminating intrusive GDPR cookie banners, CMP modals, newsletter popups, and floating nag screens.',
    features: ['Cookie banner removal', 'GDPR overlay suppression', 'CMP blocker (OneTrust, Cookiebot)', 'Element hiding'],
    recommendedFor: 'Browser extensions and desktop content blockers',
    warning: 'Contains cosmetic rules (##) that require DOM inspection; ineffective on pure DNS sinkholes',
  },
  {
    id: 'social',
    name: 'Blockingmachine Social Tracker Neutralizer [Beta]',
    filename: 'blockingmachine-social.txt',
    url: './filters/modules/blockingmachine-social.txt',
    scope: 'hybrid',
    category: 'Social',
    description: 'First-party filter neutralizing cross-site tracking beacons, embedded share widgets, and Meta/TikTok/X pixels.',
    features: ['Cross-site pixel blocking', 'Third-party beacon neutralization', 'Social widget hiding', 'Direct social media site safe'],
    recommendedFor: 'Browser extensions, DNS sinkholes, and desktop ad-blockers',
  },
  {
    id: 'threats',
    name: 'Blockingmachine Threat & Malicious Domain Defense [Beta]',
    filename: 'blockingmachine-security.txt',
    url: './filters/modules/blockingmachine-security.txt',
    scope: 'dns',
    category: 'Security',
    description: 'First-party proactive network-level blocking of phishing gateways, rogue redirects, drive-by malware, and in-browser cryptominers.',
    features: ['Anti-cryptomining (Coinhive, Cryptoloot)', 'Malicious redirect shield', 'Phishing defense', 'Fake captcha blocker'],
    recommendedFor: 'Network firewalls, routers, Pi-hole, and AdGuard Home',
  },
  {
    id: 'url-tracking',
    name: 'Blockingmachine URL Tracking Stripper [Beta]',
    filename: 'blockingmachine-url-tracking.txt',
    url: './filters/modules/blockingmachine-url-tracking.txt',
    scope: 'browser',
    category: 'Privacy',
    description: 'Native query parameter stripper eliminating tracking tokens, click identifiers (fbclid, gclid), and marketing campaign parameters across the web.',
    features: ['Click ID removal (fbclid, gclid, msclkid)', 'UTM parameter stripping', 'Email tracking beacon cleanup', 'Referral token sanitization'],
    recommendedFor: 'Browser extensions and content blockers supporting $removeparam rules',
  },
  {
    id: 'unbreak',
    name: 'Blockingmachine Unbreak & Safe Exceptions [Beta]',
    filename: 'blockingmachine-unbreak.txt',
    url: './filters/modules/blockingmachine-unbreak.txt',
    scope: 'hybrid',
    category: 'Unbreak',
    description: 'First-party hand-crafted exception allowlist rules for banking portals, SSO logins, delivery tracking, and essential apps.',
    features: ['Banking portal fixes', 'SSO & OAuth allowlists', 'Streaming DRM & license safe', 'Anti-breakage rules (@@)'],
    recommendedFor: 'Essential for all configurations to guarantee normal app and payment functionality',
  },
];

interface ModulesViewProps {
  sources: FilterSource[];
  saveSources: (sources: FilterSource[]) => Promise<void>;
  onTriggerCompile?: () => void;
  onNavigateDeploy?: () => void;
  setError?: (err: string | null) => void;
  setSuccessMessage?: (msg: string | null) => void;
}

export const ModulesView: React.FC<ModulesViewProps> = ({
  sources,
  saveSources,
  onTriggerCompile,
  onNavigateDeploy,
  setError,
  setSuccessMessage,
}) => {
  const [scopeFilter, setScopeFilter] = useState<'all' | 'hybrid' | 'dns' | 'browser'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [viewingModule, setViewingModule] = useState<NativeModuleItem | null>(null);
  const [moduleRawContent, setModuleRawContent] = useState<string | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [ruleSearchQuery, setRuleSearchQuery] = useState('');
  const [copiedNotification, setCopiedNotification] = useState(false);

  // Map module enabled status from active sources
  const moduleStatusMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const mod of NATIVE_DEFENSE_MODULES) {
      const match = sources.find((s) => s.url === mod.url || s.name === mod.name);
      map.set(mod.id, match ? match.enabled : false);
    }
    return map;
  }, [sources]);

  const activeCount = useMemo(() => {
    return Array.from(moduleStatusMap.values()).filter(Boolean).length;
  }, [moduleStatusMap]);

  // Filter modules based on search and filters
  const filteredModules = useMemo(() => {
    return NATIVE_DEFENSE_MODULES.filter((mod) => {
      if (scopeFilter !== 'all' && mod.scope !== scopeFilter) return false;
      if (categoryFilter !== 'all' && mod.category !== categoryFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = mod.name.toLowerCase().includes(q);
        const matchesDesc = mod.description.toLowerCase().includes(q);
        const matchesFeatures = mod.features.some((f) => f.toLowerCase().includes(q));
        if (!matchesName && !matchesDesc && !matchesFeatures) return false;
      }
      return true;
    });
  }, [scopeFilter, categoryFilter, searchQuery]);

  // Toggle single module
  const handleToggleModule = async (mod: NativeModuleItem) => {
    try {
      const isCurrentlyEnabled = moduleStatusMap.get(mod.id) || false;
      const targetState = !isCurrentlyEnabled;

      let nextSources: FilterSource[];
      const existingIndex = sources.findIndex((s) => s.url === mod.url || s.name === mod.name);

      if (existingIndex >= 0) {
        nextSources = sources.map((s, idx) =>
          idx === existingIndex ? { ...s, enabled: targetState } : s
        );
      } else {
        nextSources = [
          ...sources,
          {
            name: mod.name,
            url: mod.url,
            enabled: true,
            scope: mod.scope,
            category: mod.category.toLowerCase(),
            description: mod.description,
            recommendedFor: mod.recommendedFor,
          },
        ];
      }

      await saveSources(nextSources);
      setSuccessMessage?.(
        `${mod.name} ${targetState ? 'activated' : 'deactivated'}.`
      );
    } catch (err) {
      console.error('Failed to toggle module:', err);
      setError?.(err instanceof Error ? err.message : 'Failed to update module state.');
    }
  };

  // Enable all 8 modules (Defense Suite)
  const handleEnableDefenseSuite = async () => {
    try {
      const nextSources = [...sources];

      for (const mod of NATIVE_DEFENSE_MODULES) {
        const existingIndex = nextSources.findIndex((s) => s.url === mod.url || s.name === mod.name);
        if (existingIndex >= 0) {
          nextSources[existingIndex] = { ...nextSources[existingIndex], enabled: true };
        } else {
          nextSources.push({
            name: mod.name,
            url: mod.url,
            enabled: true,
            scope: mod.scope,
            category: mod.category.toLowerCase(),
            description: mod.description,
            recommendedFor: mod.recommendedFor,
          });
        }
      }

      await saveSources(nextSources);
      setSuccessMessage?.('All 8 Blockingmachine Defense Modules [Beta] have been activated.');
    } catch (err) {
      console.error('Failed to enable Defense Suite:', err);
      setError?.(err instanceof Error ? err.message : 'Failed to enable Defense Suite.');
    }
  };

  // Disable all modules
  const handleDisableAllModules = async () => {
    try {
      const moduleUrls = new Set(NATIVE_DEFENSE_MODULES.map((m) => m.url));
      const moduleNames = new Set(NATIVE_DEFENSE_MODULES.map((m) => m.name));

      const nextSources = sources.map((s) => {
        if (moduleUrls.has(s.url) || moduleNames.has(s.name)) {
          return { ...s, enabled: false };
        }
        return s;
      });

      await saveSources(nextSources);
      setSuccessMessage?.('All Blockingmachine Defense Modules deactivated.');
    } catch (err) {
      console.error('Failed to disable modules:', err);
      setError?.(err instanceof Error ? err.message : 'Failed to disable modules.');
    }
  };

  // Open raw rule viewer for a module
  const handleOpenRuleViewer = async (mod: NativeModuleItem) => {
    setViewingModule(mod);
    setModuleRawContent(null);
    setRuleSearchQuery('');
    setIsLoadingContent(true);

    try {
      if (window.electron?.getModuleContent) {
        const content = await window.electron.getModuleContent(mod.filename);
        setModuleRawContent(content || '! No rules found for this module file.');
      } else {
        setModuleRawContent('! Module content reader unavailable.');
      }
    } catch (err) {
      console.error('Error loading module content:', err);
      setModuleRawContent('! Error reading module rules.');
    } finally {
      setIsLoadingContent(false);
    }
  };

  const handleCopyRules = () => {
    if (!moduleRawContent) return;
    navigator.clipboard.writeText(moduleRawContent);
    setCopiedNotification(true);
    setTimeout(() => setCopiedNotification(false), 2000);
  };

  // Filter rules inside the viewer modal
  const parsedRules = useMemo(() => {
    if (!moduleRawContent) return [];
    const lines = moduleRawContent.split('\n');
    if (!ruleSearchQuery.trim()) return lines;
    const q = ruleSearchQuery.toLowerCase();
    return lines.filter((l) => l.toLowerCase().includes(q));
  }, [moduleRawContent, ruleSearchQuery]);

  return (
    <div className="modules-view-container">
      {/* Top Banner / Hero */}
      <div className="modules-hero-card">
        <div className="modules-hero-left">
          <div className="modules-badge-pill">
            <span className="modules-pulse-dot" />
            <span>First-Party Beta Architecture</span>
          </div>
          <h2 className="modules-hero-title">Native Defense Modules [Beta]</h2>
          <p className="modules-hero-subtitle">
            Modular, high-performance filter lists crafted natively for Blockingmachine.
            Mix and match granular shields for DNS sinkholes, Home Assistant, routers, and desktop browsers.
          </p>
        </div>

        <div className="modules-hero-stats">
          <div className="modules-stat-box">
            <span className="modules-stat-value">{activeCount} / {NATIVE_DEFENSE_MODULES.length}</span>
            <span className="modules-stat-label">Active Modules</span>
          </div>
          <div className="modules-hero-actions">
            <button
              className="modules-primary-btn"
              onClick={handleEnableDefenseSuite}
              title="Activate all 8 native defense modules"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              <span>Enable Defense Suite</span>
            </button>
            <button
              className="modules-secondary-btn"
              onClick={handleDisableAllModules}
              title="Disable all native modules"
            >
              <span>Disable All</span>
            </button>
            {onNavigateDeploy && (
              <button
                className="modules-secondary-btn"
                onClick={onNavigateDeploy}
                title="Open Deploy Hub to connect active modules to AdGuard Home, Pi-hole, and routers"
              >
                <span>📡 Deploy & Sync</span>
              </button>
            )}
            {onTriggerCompile && (
              <button
                className="modules-compile-btn"
                onClick={onTriggerCompile}
                title="Compile and deduplicate active rules"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                </svg>
                <span>Compile Now</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="modules-control-bar">
        <div className="modules-search-wrapper">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            className="modules-search-input"
            placeholder="Search defense modules, features, or keywords..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="modules-search-clear" onClick={() => setSearchQuery('')}>×</button>
          )}
        </div>

        {/* Scope Filter Segment */}
        <div className="modules-filter-pills">
          <button
            className={`modules-pill-btn ${scopeFilter === 'all' ? 'active' : ''}`}
            onClick={() => setScopeFilter('all')}
          >
            All Scopes ({NATIVE_DEFENSE_MODULES.length})
          </button>
          <button
            className={`modules-pill-btn ${scopeFilter === 'hybrid' ? 'active' : ''}`}
            onClick={() => setScopeFilter('hybrid')}
          >
            ⚡ Hybrid (5)
          </button>
          <button
            className={`modules-pill-btn ${scopeFilter === 'dns' ? 'active' : ''}`}
            onClick={() => setScopeFilter('dns')}
          >
            🌐 DNS Only (2)
          </button>
          <button
            className={`modules-pill-btn ${scopeFilter === 'browser' ? 'active' : ''}`}
            onClick={() => setScopeFilter('browser')}
          >
            💻 Browser (2)
          </button>
        </div>

        {/* Category Filter */}
        <div className="modules-category-select-wrapper">
          <select
            className="modules-category-select"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="all">All Categories</option>
            <option value="Ads">Advertising</option>
            <option value="Privacy">Privacy & Tracking</option>
            <option value="Security">Security & Malware</option>
            <option value="Annoyances">Web Annoyances</option>
            <option value="Social">Social Media</option>
            <option value="Unbreak">Unbreak Allowlist</option>
          </select>
        </div>
      </div>

      {/* Modules Card Grid */}
      <div className="modules-grid">
        {filteredModules.map((mod) => {
          const isEnabled = moduleStatusMap.get(mod.id) || false;

          return (
            <div
              key={mod.id}
              className={`module-card ${isEnabled ? 'module-card-active' : ''}`}
            >
              <div className="module-card-header">
                <div className="module-title-group">
                  <span className="module-name">{mod.name}</span>
                  <div className="module-tag-row">
                    <span className={`module-scope-tag scope-${mod.scope}`}>
                      {mod.scope === 'dns' && '🌐 DNS Sinkhole'}
                      {mod.scope === 'browser' && '💻 Browser Layer'}
                      {mod.scope === 'hybrid' && '⚡ Hybrid (DNS + Browser)'}
                    </span>
                    <span className="module-category-tag">{mod.category}</span>
                  </div>
                </div>

                {/* Switch Toggle */}
                <label className="module-switch" title={isEnabled ? 'Click to disable' : 'Click to enable'}>
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={() => handleToggleModule(mod)}
                  />
                  <span className="module-slider" />
                </label>
              </div>

              <p className="module-description">{mod.description}</p>

              {mod.warning && (
                <div className="module-warning-callout">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                  <span>{mod.warning}</span>
                </div>
              )}

              {/* Feature Highlights */}
              <div className="module-features-list">
                {mod.features.map((feat, idx) => (
                  <span key={idx} className="module-feature-chip">
                    ✓ {feat}
                  </span>
                ))}
              </div>

              {/* Card Footer */}
              <div className="module-card-footer">
                <div className="module-status-indicator">
                  <span className={`status-dot ${isEnabled ? 'dot-active' : 'dot-inactive'}`} />
                  <span className="status-text">{isEnabled ? 'Active in Output' : 'Disabled'}</span>
                </div>

                <div className="module-footer-actions">
                  <button
                    className="module-view-rules-btn"
                    onClick={() => handleOpenRuleViewer(mod)}
                    title="Inspect rules contained in this module"
                  >
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    <span>View Rules</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Raw Rule Viewer Modal */}
      {viewingModule && (
        <div className="module-viewer-backdrop" onClick={() => setViewingModule(null)}>
          <div className="module-viewer-modal" onClick={(e) => e.stopPropagation()}>
            <div className="module-viewer-header">
              <div className="module-viewer-title-group">
                <span className="module-viewer-badge">★ First-Party Module [Beta]</span>
                <h3>{viewingModule.name}</h3>
                <span className="module-viewer-sub">{viewingModule.filename}</span>
              </div>
              <button
                className="module-viewer-close-btn"
                onClick={() => setViewingModule(null)}
                title="Close viewer"
              >
                ✕
              </button>
            </div>

            {/* Modal search and copy bar */}
            <div className="module-viewer-toolbar">
              <div className="module-viewer-search">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35" />
                </svg>
                <input
                  type="text"
                  placeholder="Filter rules in this module..."
                  value={ruleSearchQuery}
                  onChange={(e) => setRuleSearchQuery(e.target.value)}
                />
                {ruleSearchQuery && (
                  <button onClick={() => setRuleSearchQuery('')}>×</button>
                )}
              </div>

              <div className="module-viewer-actions">
                <button
                  className="module-viewer-copy-btn"
                  onClick={handleCopyRules}
                  title="Copy module rules to clipboard"
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                  </svg>
                  <span>{copiedNotification ? 'Copied!' : 'Copy Rules'}</span>
                </button>
              </div>
            </div>

            {/* Rules Code Container */}
            <div className="module-viewer-content">
              {isLoadingContent ? (
                <div className="module-viewer-loading">Loading module rules...</div>
              ) : (
                <div className="module-viewer-code-block">
                  {parsedRules.map((line, idx) => {
                    const isComment = line.trim().startsWith('!');
                    const isException = line.trim().startsWith('@@');
                    const isCosmetic = line.includes('##') || line.includes('#@#');

                    let lineClass = 'code-line-normal';
                    if (isComment) lineClass = 'code-line-comment';
                    else if (isException) lineClass = 'code-line-exception';
                    else if (isCosmetic) lineClass = 'code-line-cosmetic';

                    return (
                      <div key={idx} className={`module-code-row ${lineClass}`}>
                        <span className="code-line-num">{idx + 1}</span>
                        <span className="code-line-text">{line || ' '}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="module-viewer-footer">
              <span className="module-viewer-count">
                Showing {parsedRules.length} lines
              </span>
              <button
                className="module-viewer-done-btn"
                onClick={() => setViewingModule(null)}
              >
                Close Viewer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
