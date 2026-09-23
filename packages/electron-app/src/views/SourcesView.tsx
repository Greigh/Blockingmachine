import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { FilterSource, FeedDiagnostic, SourceScope } from '../types';
import { getSourceProfile, detectSourceClassification, displayFilterLabel } from '@blockingmachine/core/sources';
import { PresetsModal } from './PresetsModal';
import { BulkImportView } from './BulkImportView';

interface SourcesViewProps {
  sources: FilterSource[];
  saveSources: (
    updatedSources: FilterSource[],
    successMsg?: string
  ) => Promise<void>;
  setError: (error: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
  onNavigate?: (view: string) => void;
  initialTab?: 'list' | 'bulk';
}

export const SourcesView: React.FC<SourcesViewProps> = ({
  sources,
  saveSources,
  setError,
  setSuccessMessage: _setSuccessMessage,
  onNavigate: _onNavigate,
  initialTab = 'list',
}) => {
  const [activeTab, setActiveTab] = useState<'list' | 'bulk'>(initialTab);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);
  const [newSourceName, setNewSourceName] = useState('');
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedScopeFilter, setSelectedScopeFilter] = useState<'all' | SourceScope>('all');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [isPresetsOpen, setIsPresetsOpen] = useState(false);
  const [feedHealth, setFeedHealth] = useState<Record<string, FeedDiagnostic>>({});
  const [testingUrls, setTestingUrls] = useState<Record<string, boolean>>({});

  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Real-time source intelligence preview as the user types/pastes URL
  const detectedProfile = useMemo(() => {
    if (!newSourceUrl.trim() && !newSourceName.trim()) return null;
    return detectSourceClassification(newSourceUrl.trim() || newSourceName.trim());
  }, [newSourceUrl, newSourceName]);

  const handleAddSource = () => {
    if (!newSourceName.trim() || !newSourceUrl.trim()) {
      setError('Source name and URL cannot be empty.');
      return;
    }

    try {
      const parsed = new URL(newSourceUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setError('URL must use http: or https: protocol.');
        return;
      }
    } catch {
      setError('Invalid URL format. Please provide a valid HTTP or HTTPS URL.');
      return;
    }

    if (
      sources.some(
        (s) =>
          s.name.trim().toLowerCase() === newSourceName.trim().toLowerCase() ||
          s.url.trim().toLowerCase() === newSourceUrl.trim().toLowerCase()
      )
    ) {
      setError('A source with this name or URL already exists.');
      return;
    }

    const profile = detectSourceClassification(newSourceUrl.trim());

    const newSource: FilterSource = {
      name: newSourceName.trim(),
      url: newSourceUrl.trim(),
      enabled: true,
      scope: profile.scope,
      category: profile.category,
      description: profile.description,
      recommendedFor: profile.recommendedFor,
    };

    const updated = [...sources, newSource];
    saveSources(updated, `Source "${newSource.name}" added successfully.`)
      .then(() => {
        if (isMountedRef.current) {
          setNewSourceName('');
          setNewSourceUrl('');
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to add source.');
      });
  };

  const handleRemoveSource = (indexToRemove: number) => {
    const sourceName = sources[indexToRemove]?.name || 'Source';
    const updated = sources.filter((_, idx) => idx !== indexToRemove);
    saveSources(updated, `"${sourceName}" removed.`).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to remove source.');
    });
  };

  const handleToggleEnabled = (indexToToggle: number) => {
    const updated = sources.map((source, idx) => {
      if (idx === indexToToggle) {
        return { ...source, enabled: !source.enabled };
      }
      return source;
    });
    saveSources(updated).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to update source.');
    });
  };

  const handleToggleAll = (enable: boolean) => {
    const updated = sources.map((s) => ({ ...s, enabled: enable }));
    saveSources(updated, `${enable ? 'Enabled' : 'Disabled'} all ${sources.length} sources.`).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to update sources.');
    });
  };

  const handleStartEdit = (index: number) => {
    setEditingIndex(index);
    setEditName(sources[index].name);
    setEditUrl(sources[index].url);
  };

  const handleCancelEdit = () => {
    setEditingIndex(null);
    setEditName('');
    setEditUrl('');
  };

  const handleSaveEdit = () => {
    if (editingIndex === null) return;
    if (!editName.trim() || !editUrl.trim()) {
      setError('Source name and URL cannot be empty.');
      return;
    }
    try {
      const parsed = new URL(editUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setError('URL must use http: or https: protocol.');
        return;
      }
    } catch {
      setError('Invalid URL format. Please provide a valid HTTP or HTTPS URL.');
      return;
    }

    const reProfile = detectSourceClassification(editUrl.trim());

    const updated = sources.map((s, idx) => {
      if (idx === editingIndex) {
        return {
          ...s,
          name: editName.trim(),
          url: editUrl.trim(),
          scope: reProfile.scope,
          category: reProfile.category,
          description: reProfile.description,
          recommendedFor: reProfile.recommendedFor,
        };
      }
      return s;
    });

    saveSources(updated, `Source "${editName.trim()}" updated.`)
      .then(() => {
        if (isMountedRef.current) {
          setEditingIndex(null);
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to update source.');
      });
  };

  const handleTestFeed = async (url: string) => {
    setTestingUrls((prev) => ({ ...prev, [url]: true }));
    try {
      const diag = await window.electron.testFeedUrl(url);
      if (isMountedRef.current) {
        setFeedHealth((prev) => ({ ...prev, [url]: diag }));
      }
    } catch (err) {
      if (isMountedRef.current) {
        setFeedHealth((prev) => ({
          ...prev,
          [url]: {
            url,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    } finally {
      if (isMountedRef.current) {
        setTestingUrls((prev) => ({ ...prev, [url]: false }));
      }
    }
  };

  const renderScopeBadge = (scope: SourceScope) => {
    switch (scope) {
      case 'dns':
        return (
          <span
            className="source-scope-badge scope-dns"
            title="DNS Sinkhole Safe: pure domain & IP rules; compatible with Pi-hole, AdGuard Home, router firewalls"
          >
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
          <span
            className="source-scope-badge scope-browser"
            title="Browser Only: contains DOM cosmetic element-hiding (##, #@#) and scriptlets; requires browser extension"
          >
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
          <span
            className="source-scope-badge scope-hybrid"
            title="Hybrid: contains both network request blocks and browser cosmetic element-hiding"
          >
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            Hybrid
          </span>
        );
    }
  };

  const renderCategoryBadge = (category: string) => {
    const cat = (category || 'custom').toLowerCase();
    switch (cat) {
      case 'ads':
        return (
          <span className="source-category-badge cat-ads">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            Ads
          </span>
        );
      case 'privacy':
        return (
          <span className="source-category-badge cat-privacy">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Privacy
          </span>
        );
      case 'security':
        return (
          <span className="source-category-badge cat-security">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Security
          </span>
        );
      case 'annoyances':
        return (
          <span className="source-category-badge cat-annoyances">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
            Annoyances
          </span>
        );
      case 'social':
        return (
          <span className="source-category-badge cat-social">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
            Social
          </span>
        );
      case 'mobile':
        return (
          <span className="source-category-badge cat-mobile">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
              <line x1="12" y1="18" x2="12.01" y2="18" />
            </svg>
            Mobile
          </span>
        );
      case 'unbreak':
        return (
          <span className="source-category-badge cat-unbreak">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            Unbreak
          </span>
        );
      case 'anti-circumvention':
        return (
          <span className="source-category-badge cat-circumvention">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 9.9-1" />
            </svg>
            Anti-Circumvention
          </span>
        );
      case 'custom':
      default:
        return (
          <span className="source-category-badge cat-custom">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Custom
          </span>
        );
    }
  };

  // Scope counts for quick filter buttons
  const scopeCounts = useMemo(() => {
    let dns = 0;
    let browser = 0;
    let hybrid = 0;
    for (const s of sources) {
      const p = getSourceProfile(s.url || s.name);
      if (p.scope === 'dns') dns++;
      else if (p.scope === 'browser') browser++;
      else hybrid++;
    }
    return { dns, browser, hybrid, all: sources.length };
  }, [sources]);

  const filteredSources = sources.filter((s) => {
    const profile = getSourceProfile(s.url || s.name);
    const matchesScope =
      selectedScopeFilter === 'all' || profile.scope === selectedScopeFilter;
    const query = searchQuery.toLowerCase();
    const matchesSearch =
      s.name.toLowerCase().includes(query) ||
      displayFilterLabel(s.name).toLowerCase().includes(query) ||
      s.url.toLowerCase().includes(query) ||
      profile.category.toLowerCase().includes(query) ||
      profile.description.toLowerCase().includes(query);
    return matchesScope && matchesSearch;
  });

  const enabledCount = sources.filter((s) => s.enabled).length;

  return (
    <div className="sources-view-container">
      {/* Top Segmented Navigation Tabs */}
      <div className="sources-nav-tabs-wrapper">
        <div className="sources-segmented-tabs">
          <button
            type="button"
            className={`sources-tab-item ${activeTab === 'list' ? 'active' : ''}`}
            onClick={() => setActiveTab('list')}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
            <span>Subscribed Feeds ({sources.length})</span>
          </button>
          <button
            type="button"
            className={`sources-tab-item ${activeTab === 'bulk' ? 'active' : ''}`}
            onClick={() => setActiveTab('bulk')}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            <span>Bulk Import / Drop Files</span>
          </button>
          <button
            type="button"
            className="sources-tab-item"
            onClick={() => setIsPresetsOpen(true)}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span>Preset Packs</span>
          </button>
        </div>
      </div>

      {activeTab === 'bulk' ? (
        <BulkImportView
          currentSources={sources}
          saveSources={saveSources}
          setError={setError}
          setSuccessMessage={_setSuccessMessage}
          onNavigateList={() => setActiveTab('list')}
        />
      ) : (
        <>
          {/* Top Toolbar */}
          <div className="sources-toolbar-row">
        <div className="sources-search-wrap">
          <svg
            className="sources-search-icon"
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
            />
          </svg>
          <input
            type="text"
            className="search-input"
            placeholder="Search subscribed feeds by name, URL, or category..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="sources-toolbar-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => handleToggleAll(true)}
            title="Enable all sources"
          >
            Enable All
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => handleToggleAll(false)}
            title="Disable all sources"
          >
            Disable All
          </button>
          <button
            type="button"
            className="primary-button presets-btn"
            onClick={() => setIsPresetsOpen(true)}
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span>Curated Feeds</span>
          </button>
        </div>
      </div>

      {/* Scope Filter Bar */}
      <div className="sources-scope-filter-bar">
        <span className="scope-filter-label">Filter by Layer:</span>
        <button
          className={`scope-filter-pill ${selectedScopeFilter === 'all' ? 'active' : ''}`}
          onClick={() => setSelectedScopeFilter('all')}
        >
          All ({scopeCounts.all})
        </button>
        <button
          className={`scope-filter-pill scope-dns-btn ${selectedScopeFilter === 'dns' ? 'active' : ''}`}
          onClick={() => setSelectedScopeFilter('dns')}
          title="Filter pure DNS-level sinkhole sources"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5 }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          DNS Safe ({scopeCounts.dns})
        </button>
        <button
          className={`scope-filter-pill scope-browser-btn ${selectedScopeFilter === 'browser' ? 'active' : ''}`}
          onClick={() => setSelectedScopeFilter('browser')}
          title="Filter browser cosmetic & element-hiding sources"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5 }}>
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          Browser Only ({scopeCounts.browser})
        </button>
        <button
          className={`scope-filter-pill scope-hybrid-btn ${selectedScopeFilter === 'hybrid' ? 'active' : ''}`}
          onClick={() => setSelectedScopeFilter('hybrid')}
          title="Filter hybrid network + cosmetic sources"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5 }}>
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          Hybrid ({scopeCounts.hybrid})
        </button>
      </div>

      {/* Add New Source Card */}
      <div className="desktop-card add-source-card">
        <div className="add-source-header-row">
          <div>
            <h4 className="add-source-title">Add Custom Source Feed</h4>
            <span className="add-source-subtitle">
              Subscribe to any remote HTTP(S) blocklist, ABP feed, or hosts file
            </span>
          </div>
        </div>

        <div className="add-source-form-grid">
          <input
            type="text"
            placeholder="Source Name (e.g. My Custom Tracker Block)"
            value={newSourceName}
            onChange={(e) => setNewSourceName(e.target.value)}
            className="form-input"
          />
          <input
            type="text"
            placeholder="Feed URL (https://...)"
            value={newSourceUrl}
            onChange={(e) => setNewSourceUrl(e.target.value)}
            className="form-input"
          />
          <button
            type="button"
            className="primary-button add-source-submit-btn"
            onClick={handleAddSource}
            disabled={!newSourceName.trim() || !newSourceUrl.trim()}
          >
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span>Add Source</span>
          </button>
        </div>

        {/* Live Source Intelligence Preview */}
        {detectedProfile && (
          <div className="source-intelligence-preview-box">
            <div className="source-intelligence-header">
              <span className="source-intelligence-badge-title">Source Intelligence:</span>
              <div className="source-intelligence-tags">
                {renderScopeBadge(detectedProfile.scope)}
                {renderCategoryBadge(detectedProfile.category)}
              </div>
            </div>
            <p className="source-intelligence-desc">{detectedProfile.description}</p>
            <div className="source-intelligence-meta">
              <span className="source-intelligence-target" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="12" r="6" />
                  <circle cx="12" cy="12" r="2" />
                </svg>
                <strong>Recommended for:</strong> {detectedProfile.recommendedFor}
              </span>
              {detectedProfile.warning && (
                <span className="source-intelligence-warning" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  {detectedProfile.warning}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sources List Header */}
      <div className="sources-list-meta-bar">
        <span>
          Showing <strong>{filteredSources.length}</strong> of <strong>{sources.length}</strong> sources (
          {enabledCount} active)
        </span>
      </div>

      {/* Sources List Grid */}
      <div className="sources-grid">
        {filteredSources.map((source) => {
          const originalIndex = sources.findIndex((s) => s.url === source.url);
          const isEditing = editingIndex === originalIndex;
          const health = feedHealth[source.url];
          const isTesting = testingUrls[source.url];
          const profile = getSourceProfile(source.url || source.name);

          if (isEditing) {
            return (
              <div key={source.url} className="source-item-card editing">
                <div className="edit-form-row">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="form-input"
                    placeholder="Source Name"
                  />
                  <input
                    type="text"
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    className="form-input"
                    placeholder="Feed URL"
                  />
                </div>
                <div className="edit-actions-row">
                  <button className="secondary-button" onClick={handleCancelEdit}>
                    Cancel
                  </button>
                  <button className="primary-button" onClick={handleSaveEdit}>
                    Save
                  </button>
                </div>
              </div>
            );
          }

          return (
            <div
              key={source.url}
              className={`source-item-card ${source.enabled ? 'is-enabled' : 'is-disabled'}`}
            >
              <div className="source-toggle-col">
                <label
                  className="mac-switch"
                  title={source.enabled ? 'Disable source' : 'Enable source'}
                >
                  <input
                    type="checkbox"
                    checked={source.enabled}
                    onChange={() => handleToggleEnabled(originalIndex)}
                  />
                  <span className="mac-slider" />
                </label>
              </div>

              <div className="source-info-col">
                <div className="source-title-row">
                  <span className="source-name">{displayFilterLabel(source.name)}</span>
                  <div className="source-badges-group">
                    {renderScopeBadge(profile.scope)}
                    {renderCategoryBadge(profile.category)}
                  </div>
                  {health && (
                    <span className={`health-pill status-${health.status}`}>
                      {health.status === 'ok' ? (
                        <>
                          ● {health.latencyMs}ms • {health.ruleCount?.toLocaleString()} rules
                        </>
                      ) : (
                        <>● {health.error || 'Failed'}</>
                      )}
                    </span>
                  )}
                </div>

                <p className="source-description-text">{profile.description}</p>

                <div className="source-meta-row">
                  <span className="source-url" title={source.url}>
                    {source.url}
                  </span>
                  <span className="source-target-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <circle cx="12" cy="12" r="6" />
                      <circle cx="12" cy="12" r="2" />
                    </svg>
                    {profile.recommendedFor}
                  </span>
                </div>

                {profile.warning && (
                  <div className="source-warning-notice">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                      {profile.warning}
                    </span>
                  </div>
                )}
              </div>

              <div className="source-actions-col">
                <button
                  className="icon-action-btn"
                  onClick={() => handleTestFeed(source.url)}
                  disabled={isTesting}
                  title="Test feed connectivity and rule count"
                >
                  {isTesting ? (
                    <span className="loading-spinner-micro" />
                  ) : (
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
                      />
                    </svg>
                  )}
                </button>
                <button
                  className="icon-action-btn"
                  onClick={() => handleStartEdit(originalIndex)}
                  title="Edit source name and URL"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125"
                    />
                  </svg>
                </button>
                <button
                  className="icon-action-btn danger"
                  onClick={() => handleRemoveSource(originalIndex)}
                  title="Remove this source"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                    />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>
      </>
      )}

      {/* Presets Modal */}
      <PresetsModal
        isOpen={isPresetsOpen}
        onClose={() => setIsPresetsOpen(false)}
        currentSources={sources}
        onAddPreset={(preset) => {
          saveSources([...sources, preset], `Subscribed to "${preset.name}".`);
        }}
        onAddMultiplePresets={(newPresets) => {
          const existingUrls = new Set(
            sources.map((s) => s.url.trim().toLowerCase())
          );
          const toAdd = newPresets.filter(
            (p) => !existingUrls.has(p.url.trim().toLowerCase())
          );
          if (toAdd.length > 0) {
            saveSources(
              [...sources, ...toAdd],
              `Subscribed to ${toAdd.length} curated feed${toAdd.length > 1 ? 's' : ''}.`
            );
          }
        }}
      />
    </div>
  );
};

