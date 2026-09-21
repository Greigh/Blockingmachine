import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { FilterSource, FeedDiagnostic, SourceScope } from '../types';
import { getSourceProfile, detectSourceClassification } from '@blockingmachine/core/sources';
import { PresetsModal } from './PresetsModal';

interface SourcesViewProps {
  sources: FilterSource[];
  saveSources: (
    updatedSources: FilterSource[],
    successMsg?: string
  ) => Promise<void>;
  setError: (error: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
}

export const SourcesView: React.FC<SourcesViewProps> = ({
  sources,
  saveSources,
  setError,
  setSuccessMessage: _setSuccessMessage,
}) => {
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
            🌐 DNS Safe
          </span>
        );
      case 'browser':
        return (
          <span
            className="source-scope-badge scope-browser"
            title="Browser Only: contains DOM cosmetic element-hiding (##, #@#) and scriptlets; requires browser extension"
          >
            🖥️ Browser Only
          </span>
        );
      case 'hybrid':
      default:
        return (
          <span
            className="source-scope-badge scope-hybrid"
            title="Hybrid: contains both network request blocks and browser cosmetic element-hiding"
          >
            ⚡ Hybrid
          </span>
        );
    }
  };

  const renderCategoryBadge = (category: string) => {
    const cat = (category || 'custom').toLowerCase();
    switch (cat) {
      case 'ads':
        return <span className="source-category-badge cat-ads">🛡️ Ads</span>;
      case 'privacy':
        return <span className="source-category-badge cat-privacy">🕵️ Privacy</span>;
      case 'security':
        return <span className="source-category-badge cat-security">🚨 Security</span>;
      case 'annoyances':
        return <span className="source-category-badge cat-annoyances">🍪 Annoyances</span>;
      case 'social':
        return <span className="source-category-badge cat-social">💬 Social</span>;
      case 'mobile':
        return <span className="source-category-badge cat-mobile">📱 Mobile</span>;
      case 'unbreak':
        return <span className="source-category-badge cat-unbreak">🩹 Unbreak</span>;
      case 'anti-circumvention':
        return <span className="source-category-badge cat-circumvention">🔓 Anti-Circumvention</span>;
      case 'custom':
      default:
        return <span className="source-category-badge cat-custom">⚙️ Custom</span>;
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
      s.url.toLowerCase().includes(query) ||
      profile.category.toLowerCase().includes(query) ||
      profile.description.toLowerCase().includes(query);
    return matchesScope && matchesSearch;
  });

  const enabledCount = sources.filter((s) => s.enabled).length;

  return (
    <div className="sources-view-container">
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
          🌐 DNS Safe ({scopeCounts.dns})
        </button>
        <button
          className={`scope-filter-pill scope-browser-btn ${selectedScopeFilter === 'browser' ? 'active' : ''}`}
          onClick={() => setSelectedScopeFilter('browser')}
          title="Filter browser cosmetic & element-hiding sources"
        >
          🖥️ Browser Only ({scopeCounts.browser})
        </button>
        <button
          className={`scope-filter-pill scope-hybrid-btn ${selectedScopeFilter === 'hybrid' ? 'active' : ''}`}
          onClick={() => setSelectedScopeFilter('hybrid')}
          title="Filter hybrid network + cosmetic sources"
        >
          ⚡ Hybrid ({scopeCounts.hybrid})
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
              <span className="source-intelligence-target">
                🎯 <strong>Recommended for:</strong> {detectedProfile.recommendedFor}
              </span>
              {detectedProfile.warning && (
                <span className="source-intelligence-warning">
                  ⚠️ {detectedProfile.warning}
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
                  <span className="source-name">{source.name}</span>
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
                  <span className="source-target-hint">🎯 {profile.recommendedFor}</span>
                </div>

                {profile.warning && (
                  <div className="source-warning-notice">
                    <span>⚠️ {profile.warning}</span>
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

