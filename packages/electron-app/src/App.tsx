import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Legend,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';

import Settings from './Settings';
import type { FilterSource, ProcessingResult, ThemeType } from './types/';
import './index.css';

// --- Helper Function (applyTheme) ---
const applyTheme = (theme: ThemeType) => {
  const body = document.body;
  body.classList.remove('light-theme', 'dark-theme');

  if (theme === 'light') {
    body.classList.add('light-theme');
  } else if (theme === 'dark') {
    body.classList.add('dark-theme');
  } else {
    // System theme
    if (
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
      body.classList.add('dark-theme');
    } else {
      body.classList.add('light-theme');
    }
  }
};

// --- Helper Function (handleExternalLink) ---
const handleExternalLink = async (e: React.MouseEvent<HTMLAnchorElement, MouseEvent>, url: string) => {
  e.preventDefault();
  try {
    await window.electron.openExternal(url);
  } catch (error) {
    console.error('Failed to open link:', error);
  }
};

// --- BulkImportManager Component ---
interface BulkImportManagerProps {
  currentSources: FilterSource[];
  saveSources: (
    updatedSources: FilterSource[],
    successMsg?: string
  ) => Promise<void>;
  setError: (error: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
}

const BulkImportManager: React.FC<BulkImportManagerProps> = ({
  currentSources,
  saveSources,
  setError,
  setSuccessMessage,
}) => {
  const [bulkUrls, setBulkUrls] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleBulkImport = async () => {
    setError(null);
    setSuccessMessage(null);
    setIsImporting(true);

    const urls = bulkUrls
      .split('\n')
      .map((url) => url.trim())
      .filter((url) => url.length > 0 && !url.startsWith('#') && !url.startsWith('!'));
    if (urls.length === 0) {
      setError('No valid URLs entered in the bulk import field.');
      if (isMountedRef.current) setIsImporting(false);
      return;
    }

    const newSources: FilterSource[] = [];
    const importErrors: string[] = [];
    let skippedCount = 0;

    urls.forEach((url, lineIndex) => {
      try {
        const parsedUrl = new URL(url);
        if (
          currentSources.some((s) => s.url === url) ||
          newSources.some((s) => s.url === url)
        ) {
          skippedCount++;
          return;
        }

        let name = parsedUrl.hostname.replace(/^www\./, '');
        const originalName = name;
        let counter = 1;

        while (currentSources.concat(newSources).some((s) => s.name === name)) {
          name = `${originalName} (${++counter})`;
        }

        newSources.push({ name, url, enabled: true });
      } catch {
        importErrors.push(`Line ${lineIndex + 1}: Invalid URL "${url}"`);
      }
    });

    let finalSuccessMessage = '';
    let finalErrorMessage = '';

    if (newSources.length > 0) {
      const updatedSources = [...currentSources, ...newSources];
      try {
        await saveSources(updatedSources);
        finalSuccessMessage =
          `Imported ${newSources.length} new sources.` +
          (skippedCount > 0 ? ` Skipped ${skippedCount} duplicates.` : '');
        if (isMountedRef.current) setBulkUrls('');
      } catch (saveError) {
        finalErrorMessage = `Failed to save imported sources. ${saveError instanceof Error ? saveError.message : ''}`;
      }
    } else if (importErrors.length === 0 && skippedCount > 0) {
      finalSuccessMessage = `Skipped ${skippedCount} duplicate URLs. No new sources added.`;
    }

    if (importErrors.length > 0) {
      finalErrorMessage =
        (finalErrorMessage ? finalErrorMessage + '\n' : '') +
        `Bulk import errors:\n${importErrors.join('\n')}`;
    }

    if (finalSuccessMessage) setSuccessMessage(finalSuccessMessage);
    if (finalErrorMessage) setError(finalErrorMessage);

    if (isMountedRef.current) setIsImporting(false);
  };

  const lineCount = bulkUrls.split('\n').filter((l) => l.trim()).length;

  return (
    <div className="desktop-card">
      <div style={{ marginBottom: '16px' }}>
        <h3 style={{ margin: '0 0 6px 0', fontSize: '15px', fontWeight: 600, color: 'var(--heading-color)' }}>
          Paste Filter Feed URLs
        </h3>
        <p style={{ margin: 0, color: 'var(--secondary-color)', fontSize: '12.5px' }}>
          Enter one source URL per line. Duplicates based on URL will be detected and skipped automatically.
        </p>
      </div>

      <textarea
        value={bulkUrls}
        onChange={(e) => setBulkUrls(e.target.value)}
        placeholder={`https://example.com/filter-list-1.txt\nhttps://filters.adguard.com/extension/chromium/filters/2.txt\nhttps://easylist.to/easylist/easylist.txt`}
        rows={12}
        disabled={isImporting}
        style={{ minHeight: '220px' }}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '14px' }}>
        <span style={{ fontSize: '12px', color: 'var(--secondary-color)' }}>
          {lineCount} {lineCount === 1 ? 'URL' : 'URLs'} entered
        </span>
        <button
          className="process-primary-btn"
          onClick={handleBulkImport}
          disabled={!bulkUrls.trim() || isImporting}
        >
          {isImporting ? 'Importing Feeds...' : `Import ${lineCount > 0 ? `${lineCount} ` : ''}Feeds`}
        </button>
      </div>
    </div>
  );
};
// --- End BulkImportManager Component ---

// --- SourcesManager Component ---
interface SourcesManagerProps {
  sources: FilterSource[];
  saveSources: (
    updatedSources: FilterSource[],
    successMsg?: string
  ) => Promise<void>;
  setError: (error: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
}

const SourcesManager: React.FC<SourcesManagerProps> = ({
  sources,
  saveSources,
  setError,
  setSuccessMessage,
}) => {
  const [newSourceName, setNewSourceName] = useState('');
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // --- Handlers ---
  const handleAddSource = () => {
    if (!newSourceName.trim() || !newSourceUrl.trim()) {
      setError('Source name and URL cannot be empty.');
      return;
    }

    // Basic URL validation (consider a more robust library if needed)
    try {
      new URL(newSourceUrl);
    } catch {
      setError('Invalid URL format.');
      return;
    }

    // Check for duplicate name or URL before adding
    if (
      sources.some(
        (s) => s.name === newSourceName.trim() || s.url === newSourceUrl.trim()
      )
    ) {
      setError('Source with this name or URL already exists.');
      return;
    }

    const newSource: FilterSource = {
      name: newSourceName.trim(),
      url: newSourceUrl.trim(),
      enabled: true, // Default to enabled
    };

    const updatedSources = [...sources, newSource];
    saveSources(updatedSources, `Source "${newSource.name}" added.`)
      .then(() => {
        // Clear input fields only on successful save
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
    const updatedSources = sources.filter(
      (_, index) => index !== indexToRemove
    );
    saveSources(updatedSources, `"${sourceName}" removed.`).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to remove source.');
    });
  };

  const handleToggleEnabled = (indexToToggle: number) => {
    const updatedSources = sources.map((source, index) => {
      if (index === indexToToggle) {
        return { ...source, enabled: !source.enabled };
      }
      return source;
    });
    saveSources(updatedSources).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to update source status.');
    });
  };

  // vvv Handlers for editing vvv
  const handleStartEdit = (index: number) => {
    setEditingIndex(index);
    setEditName(sources[index].name);
    setEditUrl(sources[index].url);
    setError(null); // Clear errors when starting edit
    setSuccessMessage(null);
  };

  const handleCancelEdit = () => {
    setEditingIndex(null);
    setEditName('');
    setEditUrl('');
  };

  const handleSaveEdit = () => {
    if (editingIndex === null) return;
    if (!editName.trim() || !editUrl.trim()) {
      setError('Source name and URL cannot be empty during edit.');
      return;
    }
    try {
      new URL(editUrl); // Validate URL
    } catch {
      setError('Invalid URL format.');
      return;
    }

    // Check if name/URL conflicts with *other* existing sources
    if (
      sources.some(
        (s, i) =>
          i !== editingIndex &&
          (s.name === editName.trim() || s.url === editUrl.trim())
      )
    ) {
      setError('Edited name or URL conflicts with another existing source.');
      return;
    }

    const updatedSources = sources.map((source, index) => {
      if (index === editingIndex) {
        return { ...source, name: editName.trim(), url: editUrl.trim() };
      }
      return source;
    });

    saveSources(updatedSources, `Source "${editName.trim()}" updated.`)
      .then(() => {
        // Exit edit mode only on successful save
        if (isMountedRef.current) {
          setEditingIndex(null);
          setEditName('');
          setEditUrl('');
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to update source.');
      });
  };
  // ^^^ Handlers for editing ^^^

  const filteredSources = sources.filter(
    (s) =>
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.url.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="section">
      {/* Add New Source Card */}
      <div className="desktop-card" style={{ marginBottom: '18px' }}>
        <h3 style={{ margin: '0 0 6px 0', fontSize: '14.5px', fontWeight: 600, color: 'var(--heading-color)' }}>
          Add Filter Feed
        </h3>
        <p style={{ margin: '0 0 12px 0', color: 'var(--secondary-color)', fontSize: '12px' }}>
          Subscribe to a new remote blocklist feed by providing a descriptive name and HTTPS URL.
        </p>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Feed Name (e.g. AdGuard Base)"
            value={newSourceName}
            onChange={(e) => setNewSourceName(e.target.value)}
            style={{ flex: 1 }}
          />
          <input
            type="url"
            placeholder="https://example.com/filter.txt"
            value={newSourceUrl}
            onChange={(e) => setNewSourceUrl(e.target.value)}
            style={{ flex: 2 }}
          />
          <button
            className="process-primary-btn"
            onClick={handleAddSource}
            disabled={!newSourceName.trim() || !newSourceUrl.trim()}
            style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}
          >
            + Add Feed
          </button>
        </div>
      </div>

      {/* Filter / Search Bar */}
      {sources.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', gap: '12px' }}>
          <input
            type="search"
            placeholder="Search configured feeds by name or URL..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ maxWidth: '380px' }}
          />
          <span style={{ fontSize: '12px', color: 'var(--secondary-color)', whiteSpace: 'nowrap' }}>
            {filteredSources.length} of {sources.length} feeds
          </span>
        </div>
      )}

      {/* List existing sources */}
      {filteredSources.length > 0 && (
        <div className="source-list">
          {filteredSources.map((source) => {
            const realIndex = sources.findIndex((s) => s.url === source.url);
            const isEditing = editingIndex === realIndex;

            return (
              <div className="source-list-item" key={source.url}>
                {isEditing ? (
                  <div
                    className="source-edit-form"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      width: '100%',
                      padding: '8px 0',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'center',
                      }}
                    >
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Source Name"
                        style={{ flex: 1 }}
                      />
                      <input
                        type="url"
                        value={editUrl}
                        onChange={(e) => setEditUrl(e.target.value)}
                        placeholder="https://example.com/filter.txt"
                        style={{ flex: 2 }}
                      />
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: '8px',
                        justifyContent: 'flex-end',
                      }}
                    >
                      <button
                        className="source-action-btn primary"
                        onClick={handleSaveEdit}
                      >
                        Save
                      </button>
                      <button
                        className="source-action-btn secondary"
                        onClick={handleCancelEdit}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <label className="toggle-switch" title={source.enabled ? 'Enabled' : 'Disabled'}>
                      <input
                        type="checkbox"
                        checked={source.enabled}
                        onChange={() => handleToggleEnabled(realIndex)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                    <div className="source-list-content">
                      <div className="source-name">{source.name}</div>
                      <div className="source-url">{source.url}</div>
                    </div>
                    <div className="source-actions">
                      <button
                        className="source-action-btn secondary"
                        onClick={() => handleStartEdit(realIndex)}
                      >
                        Edit
                      </button>
                      <button
                        className="source-action-btn danger"
                        onClick={() => handleRemoveSource(realIndex)}
                      >
                        Remove
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {sources.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">🛡️</div>
          <div className="empty-state-title">No Feeds Configured</div>
          <div className="empty-state-description">
            Add filter list feeds above to start generating your blocklist.
          </div>
        </div>
      )}
    </div>
  );
};
// --- End SourcesManager Component ---

// --- CustomRulesEditor Component ---
const CustomRulesEditor = () => {
  const [rules, setRules] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'success' | 'error'
  >('idle');

  // Load custom rules on mount
  useEffect(() => {
    let isMounted = true;
    const loadRules = async () => {
      setError(null);
      setSaveStatus('idle');
      setIsLoading(true);
      try {
        const loadedRules = await window.electron.getCustomRules();
        if (isMounted) {
          setRules(loadedRules || '');
        }
      } catch (err) {
        console.error('Failed to load custom rules:', err);
        if (isMounted) {
          setError(
            err instanceof Error ? err.message : 'Failed to load custom rules.'
          );
        }
      } finally {
        if (isMounted) {
          setIsLoading(false); // Set loading false after load attempt
        }
      }
    };
    loadRules();
    return () => {
      isMounted = false;
    };
  }, []); // Empty dependency array means run once on mount

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Add handler to save custom rules
  const handleSaveCustomRules = async () => {
    setError(null);
    setSaveStatus('saving');
    try {
      const res = await window.electron.setCustomRules(rules);
      if (res && !res.success) {
        throw new Error(res.error || 'Failed to save custom rules.');
      }
      setSaveStatus('success');
      // Clear success message after a delay safely
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to save custom rules:', err);
      setError(
        err instanceof Error ? err.message : 'Failed to save custom rules.'
      );
      setSaveStatus('error');
    }
  };

  const activeRuleCount = rules.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;

  return (
    <div className="desktop-card">
      <div style={{ marginBottom: '14px' }}>
        <h3 style={{ margin: '0 0 6px 0', fontSize: '15px', fontWeight: 600, color: 'var(--heading-color)' }}>
          Manual Filter Rules
        </h3>
        <p style={{ margin: 0, color: 'var(--secondary-color)', fontSize: '12.5px' }}>
          Enter manual adblock and DNS blocking rules. One rule per line.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <span className="setting-badge primary" style={{ textTransform: 'none', fontFamily: 'monospace' }}>
          ||example.com^ (Block Domain)
        </span>
        <span className="setting-badge secondary" style={{ textTransform: 'none', fontFamily: 'monospace' }}>
          @@||example.com^ (Allow Domain)
        </span>
        <span className="setting-badge secondary" style={{ textTransform: 'none', fontFamily: 'monospace' }}>
          example.com##.ad-banner (Cosmetic Rule)
        </span>
      </div>

      {isLoading && <p style={{ color: 'var(--secondary-color)', fontSize: '12.5px' }}>Loading custom rules...</p>}
      {!isLoading && error && saveStatus !== 'saving' && (
        <p style={{ color: 'var(--danger-color)', fontSize: '12.5px' }}>Error: {error}</p>
      )}

      <textarea
        placeholder={`||example.com^\n@@||allowed-service.com^\nexample.org##.sponsored-post`}
        value={rules}
        onChange={(e) => {
          setRules(e.target.value);
          if (saveStatus === 'success' || saveStatus === 'error') {
            setSaveStatus('idle');
            setError(null);
          }
        }}
        rows={14}
        style={{ minHeight: '260px' }}
        disabled={isLoading || saveStatus === 'saving'}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '14px' }}>
        <span style={{ fontSize: '12px', color: 'var(--secondary-color)' }}>
          {activeRuleCount} active {activeRuleCount === 1 ? 'rule' : 'rules'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {saveStatus === 'success' && (
            <span style={{ color: 'var(--success-color)', fontSize: '12.5px', fontWeight: 500 }}>
              ✓ Rules saved
            </span>
          )}
          {saveStatus === 'error' && (
            <span style={{ color: 'var(--danger-color)', fontSize: '12.5px', fontWeight: 500 }}>
              ✕ Save failed
            </span>
          )}
          <button
            className="process-primary-btn"
            onClick={handleSaveCustomRules}
            disabled={isLoading || saveStatus === 'saving'}
          >
            {saveStatus === 'saving' ? 'Saving...' : 'Save Rules'}
          </button>
        </div>
      </div>
    </div>
  );
};
// --- End CustomRulesEditor Component ---

// --- CustomTooltip Component ---
const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  return (
    <div className="custom-tooltip">
      <p className="tooltip-label">{label}</p>
      {payload.map((entry: any, index: number) => (
        <div className="tooltip-item" key={`item-${index}`}>
          <div
            className="tooltip-color"
            style={{ backgroundColor: entry.color }}
          />
          <span className="tooltip-name">{entry.name}:</span>
          <span className="tooltip-value">{entry.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
};
// --- End CustomTooltip Component ---

// --- ProcessingControls Component ---
interface ProcessingControlsProps {
  savePath: string;
}

const ProcessingControls: React.FC<ProcessingControlsProps> = ({
  savePath,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ProcessingResult | null>(null);
  const [progress, setProgress] = useState<{
    status: string;
    percent: number;
  } | null>(null);
  const [dashboardStats, setDashboardStats] = useState<{
    enabledSources: number;
    totalSources: number;
    customRulesCount: number;
    lastProcessedTime: string | null;
  }>({
    enabledSources: 0,
    totalSources: 0,
    customRulesCount: 0,
    lastProcessedTime: null,
  });
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Load dashboard stats
  useEffect(() => {
    let isMounted = true;
    const loadStats = async () => {
      try {
        // Get current sources
        const sources = await window.electron.getSources();
        const enabledSources = sources.filter(
          (s: FilterSource) => s.enabled
        ).length;

        // Get custom rules
        const customRules = await window.electron.getCustomRules();
        const customRulesCount = customRules
          .split('\n')
          .filter(
            (line: string) => line.trim() && !line.trim().startsWith('#')
          ).length;

        // Get last process time
        const lastProcessTime = await window.electron.getLastProcessTime();

        if (isMounted) {
          setDashboardStats({
            enabledSources,
            totalSources: sources.length,
            customRulesCount,
            lastProcessedTime: lastProcessTime,
          });
        }
      } catch (err) {
        console.error('Failed to load dashboard stats:', err);
      }
    };

    loadStats();
    return () => {
      isMounted = false;
    };
  }, []);

  // Listen for progress updates
  useEffect(() => {
    const onProgressUpdate = (data: { status: string; percent: number }) => {
      if (isMountedRef.current) {
        setProgress(data);
      }
    };

    const unsubscribe = window.electron.onProcessProgress(onProgressUpdate);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      } else {
        window.electron.removeProcessProgressListener();
      }
    };
  }, []);

  const handleRunProcess = async () => {
    setIsLoading(true);
    setError(null);
    setLastResult(null);
    setProgress({ status: 'Initializing process...', percent: 0 });

    try {
      const result = await window.electron.runImportProcess();
      if (isMountedRef.current) {
        setLastResult(result);
      }

      // Refresh dashboard stats after processing
      const sources = await window.electron.getSources();
      const lastProcessTime = await window.electron.getLastProcessTime();
      if (isMountedRef.current) {
        setDashboardStats((prev) => ({
          ...prev,
          enabledSources: sources.filter((s: FilterSource) => s.enabled).length,
          totalSources: sources.length,
          lastProcessedTime: lastProcessTime,
        }));
      }

      if (!result.success && isMountedRef.current) {
        setError(
          result.error || 'An unknown error occurred during processing.'
        );
      }
    } catch (err) {
      console.error('Error running process:', err);
      const message =
        err instanceof Error ? err.message : 'An unexpected error occurred.';
      if (isMountedRef.current) {
        setError(message);
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
        setProgress(null);
      }
    }
  };

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        if (!isLoading) {
          handleRunProcess();
        }
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [isLoading]);

  // Derived metrics
  const totalProcessed = lastResult?.processedRuleCount ?? 0;
  const uniqueCount = lastResult?.uniqueRuleCount ?? 0;
  const exceptionCount = lastResult?.exceptionRuleCount ?? 0;
  const blockingCount = Math.max(0, uniqueCount - exceptionCount);
  const duplicatesRemoved = Math.max(0, totalProcessed - uniqueCount);
  const dedupRate =
    totalProcessed > 0
      ? ((duplicatesRemoved / totalProcessed) * 100).toFixed(1)
      : '0';
  const blockingPercent =
    uniqueCount > 0 ? ((blockingCount / uniqueCount) * 100).toFixed(1) : '0';
  const exceptionPercent =
    uniqueCount > 0 ? ((exceptionCount / uniqueCount) * 100).toFixed(1) : '0';

  return (
    <div className="section">
      {/* Modern Desktop Action Banner */}
      <div className="process-banner-card">
        <div className="process-banner-content">
          <div className="banner-badge-row">
            <span className="banner-status-pill">
              <span className="status-dot" />
              Engine Ready
            </span>
            {dashboardStats.lastProcessedTime && (
              <span className="banner-time-sub">
                Last run: {dashboardStats.lastProcessedTime}
              </span>
            )}
          </div>
          <h3>Compile & Export Filter Lists</h3>
          <p>
            Fetches enabled filter feeds, parses rules, runs deduplication, and writes clean blocklists to disk.
          </p>
          {savePath && (
            <div className="banner-dest-row">
              <span className="dest-label">Output Directory:</span>
              <button
                className="dest-path-pill"
                onClick={() => window.electron.showItemInFolder(savePath)}
                title="Click to reveal folder in Finder"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                </svg>
                <code>{savePath}</code>
              </button>
            </div>
          )}
        </div>
        <button
          onClick={handleRunProcess}
          disabled={isLoading}
          className="process-primary-btn"
          title="Compile and export blocklists (Cmd+R)"
        >
          {isLoading ? (
            <>
              <span className="spinner-icon">⟳</span> Compiling...
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
              </svg>
              Run Processor
              <span style={{ opacity: 0.75, fontSize: 11, marginLeft: 4 }}>⌘R</span>
            </>
          )}
        </button>
      </div>

      {/* Live Compilation Progress */}
      {isLoading && progress && (
        <div className="progress-section">
          <div className="progress-info">
            <span style={{ fontWeight: 600, color: 'var(--heading-color)' }}>{progress.status}</span>
            <span>{progress.percent}%</span>
          </div>
          <div className="progress-bar-container">
            <div
              className="progress-bar-fill"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}

      {/* When Compilation Results Exist */}
      {lastResult && lastResult.success && (
        <div className="results-panel">
          {/* Results Bar Header */}
          <div className="results-panel-header">
            <div className="results-panel-title-area">
              <span className="results-success-pill">
                <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                </svg>
                Compilation Complete
              </span>
              <span className="results-timestamp">{lastResult.timestamp}</span>
            </div>
            {savePath && (
              <button
                className="header-action-btn"
                onClick={() => window.electron.showItemInFolder(savePath)}
                title="Reveal exported blocklists in Finder"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                </svg>
                Reveal in Finder
              </button>
            )}
          </div>

          {/* 4-Column KPI Grid */}
          <div className="results-kpi-grid">
            <div className="kpi-card">
              <div className="kpi-card-top">
                <span className="kpi-icon-wrap" style={{ color: '#5856d6', background: 'rgba(88, 86, 214, 0.12)' }}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
                  </svg>
                </span>
                <span className="kpi-label">Total Ingested</span>
              </div>
              <div className="kpi-value">{totalProcessed.toLocaleString()}</div>
              <div className="kpi-subtext">From {dashboardStats.enabledSources} active feeds</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-card-top">
                <span className="kpi-icon-wrap" style={{ color: '#0a84ff', background: 'rgba(10, 132, 255, 0.12)' }}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                  </svg>
                </span>
                <span className="kpi-label">Unique Rules</span>
              </div>
              <div className="kpi-value">{uniqueCount.toLocaleString()}</div>
              <div className="kpi-badge">+{dedupRate}% deduplicated</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-card-top">
                <span className="kpi-icon-wrap" style={{ color: '#30d158', background: 'rgba(48, 209, 88, 0.12)' }}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                </span>
                <span className="kpi-label">Blocking Rules</span>
              </div>
              <div className="kpi-value">{blockingCount.toLocaleString()}</div>
              <div className="kpi-subtext">{blockingPercent}% domain & cosmetic</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-card-top">
                <span className="kpi-icon-wrap" style={{ color: '#ff9f0a', background: 'rgba(255, 159, 10, 0.12)' }}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                  </svg>
                </span>
                <span className="kpi-label">Exception Rules</span>
              </div>
              <div className="kpi-value">{exceptionCount.toLocaleString()}</div>
              <div className="kpi-subtext">{exceptionPercent}% whitelist rules</div>
            </div>
          </div>

          {/* Deduplication Efficiency Card */}
          <div className="dedup-efficiency-card">
            <div className="dedup-card-header">
              <div className="dedup-title-area">
                <h4>Deduplication & Engine Efficiency</h4>
                <p>Eliminated redundant rules across subscribed lists to maximize blocking performance</p>
              </div>
              <span className="dedup-rate-badge">{dedupRate}% Efficiency</span>
            </div>
            <div className="dedup-bar-container">
              <div
                className="dedup-bar-active"
                style={{ width: `${Math.max(10, 100 - Number(dedupRate))}%` }}
                title={`Active Rules: ${uniqueCount.toLocaleString()}`}
              />
              <div
                className="dedup-bar-removed"
                style={{ width: `${Math.min(90, Number(dedupRate))}%` }}
                title={`Duplicate Rules Removed: ${duplicatesRemoved.toLocaleString()}`}
              />
            </div>
            <div className="dedup-stats-pills">
              <div className="dedup-stat-pill">
                <span className="pill-dot active" />
                <span>Unique Output: <strong>{uniqueCount.toLocaleString()}</strong></span>
              </div>
              <div className="dedup-stat-pill">
                <span className="pill-dot duplicate" />
                <span>Duplicates Purged: <strong>{duplicatesRemoved.toLocaleString()}</strong></span>
              </div>
              <div className="dedup-stat-pill">
                <span className="pill-icon">⚡</span>
                <span>Deduplication Ratio: <strong>{dedupRate}%</strong></span>
              </div>
            </div>
          </div>

          {/* 2-Column Split Analytics Grid */}
          <div className="analytics-split-grid">
            {/* Donut Chart Card */}
            <div className="analytics-card">
              <div className="analytics-card-header">
                <h4>Rule Composition</h4>
                <p>Distribution of blocking vs exception rules</p>
              </div>
              <div className="donut-chart-wrapper">
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={[
                        { name: 'Blocking Rules', value: blockingCount },
                        { name: 'Exception Rules', value: exceptionCount },
                      ]}
                      cx="50%"
                      cy="50%"
                      innerRadius={65}
                      outerRadius={88}
                      paddingAngle={4}
                      dataKey="value"
                      stroke="none"
                    >
                      <Cell fill="#0a84ff" />
                      <Cell fill="#ff9f0a" />
                    </Pie>
                    <Tooltip content={<CustomTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="donut-center-overlay">
                  <span className="donut-center-num">
                    {uniqueCount >= 1000 ? `${(uniqueCount / 1000).toFixed(1)}k` : uniqueCount}
                  </span>
                  <span className="donut-center-lbl">Active Rules</span>
                </div>
              </div>
              <div className="donut-legend-row">
                <div className="legend-item">
                  <span className="legend-color-dot" style={{ backgroundColor: '#0a84ff' }} />
                  <span className="legend-name">Blocking:</span>
                  <span className="legend-val">{blockingCount.toLocaleString()}</span>
                  <span className="legend-pct">({blockingPercent}%)</span>
                </div>
                <div className="legend-item">
                  <span className="legend-color-dot" style={{ backgroundColor: '#ff9f0a' }} />
                  <span className="legend-name">Exceptions:</span>
                  <span className="legend-val">{exceptionCount.toLocaleString()}</span>
                  <span className="legend-pct">({exceptionPercent}%)</span>
                </div>
              </div>
            </div>

            {/* Generated Blocklists Card */}
            <div className="analytics-card">
              <div className="analytics-card-header">
                <h4>Exported Formats</h4>
                <p>Compiled files ready for DNS and browser integration</p>
              </div>
              <div className="export-files-list">
                <div className="export-file-row">
                  <div className="export-file-icon">📄</div>
                  <div className="export-file-info">
                    <span className="export-file-name">hosts.txt</span>
                    <span className="export-file-desc">Standard Hosts format • {blockingCount.toLocaleString()} rules</span>
                  </div>
                  {savePath && (
                    <button
                      className="header-action-btn"
                      onClick={() => window.electron.showItemInFolder(savePath)}
                      title="Reveal hosts.txt in Finder"
                    >
                      Reveal
                    </button>
                  )}
                </div>

                <div className="export-file-row">
                  <div className="export-file-icon">🛡️</div>
                  <div className="export-file-info">
                    <span className="export-file-name">adguard.txt</span>
                    <span className="export-file-desc">Adblock Plus syntax • {uniqueCount.toLocaleString()} rules</span>
                  </div>
                  {savePath && (
                    <button
                      className="header-action-btn"
                      onClick={() => window.electron.showItemInFolder(savePath)}
                      title="Reveal adguard.txt in Finder"
                    >
                      Reveal
                    </button>
                  )}
                </div>

                <div className="export-file-row">
                  <div className="export-file-icon">🌐</div>
                  <div className="export-file-info">
                    <span className="export-file-name">dnsmasq.txt</span>
                    <span className="export-file-desc">Router format • {blockingCount.toLocaleString()} rules</span>
                  </div>
                  {savePath && (
                    <button
                      className="header-action-btn"
                      onClick={() => window.electron.showItemInFolder(savePath)}
                      title="Reveal dnsmasq.txt in Finder"
                    >
                      Reveal
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Bar Chart Comparison Card */}
          <div className="analytics-card comparison-chart-card">
            <div className="analytics-card-header">
              <h4>Filter Pipeline Comparison</h4>
              <p>Total processed vs unique compiled rules</p>
            </div>
            <div className="chart-container" style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart
                  data={[
                    {
                      name: 'Rules',
                      Processed: totalProcessed,
                      Unique: uniqueCount,
                      Blocking: blockingCount,
                      Exceptions: exceptionCount,
                    },
                  ]}
                  margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                  <XAxis dataKey="name" stroke="var(--secondary-color)" fontSize={12} />
                  <YAxis stroke="var(--secondary-color)" fontSize={11} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  <Bar dataKey="Processed" fill="#5856d6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Unique" fill="#0a84ff" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Blocking" fill="#30d158" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Exceptions" fill="#ff9f0a" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Initial state (before compilation) */}
      {!lastResult && !isLoading && (
        <>
          <div className="dashboard-grid">
            <div className="dashboard-card">
              <div className="dashboard-icon">🛡️</div>
              <div className="dashboard-stat-content">
                <span className="dashboard-stat-value">
                  {dashboardStats.enabledSources}/{dashboardStats.totalSources}
                </span>
                <span className="dashboard-stat-label">Active Sources</span>
              </div>
            </div>

            <div className="dashboard-card">
              <div className="dashboard-icon">✍️</div>
              <div className="dashboard-stat-content">
                <span className="dashboard-stat-value">
                  {dashboardStats.customRulesCount}
                </span>
                <span className="dashboard-stat-label">Custom Rules</span>
              </div>
            </div>

            <div className="dashboard-card">
              <div className="dashboard-icon">🕒</div>
              <div className="dashboard-stat-content">
                <span className="dashboard-stat-value" style={{ fontSize: '1.05rem', marginTop: 3 }}>
                  {dashboardStats.lastProcessedTime ? dashboardStats.lastProcessedTime.split(',')[0] || 'Recently' : 'Never'}
                </span>
                <span className="dashboard-stat-label">
                  {dashboardStats.lastProcessedTime ? 'Last Compilation' : 'Not yet compiled'}
                </span>
              </div>
            </div>
          </div>

          <div className="empty-state-desktop">
            <div className="empty-state-icon-shield">
              <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
            </div>
            <h4>Ready to Compile Blocklists</h4>
            <p>
              Click <strong>Run Processor</strong> above or press <kbd>⌘R</kbd> to fetch all {dashboardStats.enabledSources} active sources and build your unified filter lists.
            </p>
          </div>
        </>
      )}

      {/* Error Card */}
      {error && (
        <div className="process-card error-card" style={{ marginTop: 16 }}>
          <div className="card-content">
            <h3 className="error-icon" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>⚠️</span> Compilation Error
            </h3>
            <p style={{ margin: 0, color: 'var(--danger-color)', fontSize: 13 }}>{error}</p>
          </div>
        </div>
      )}
    </div>
  );
};
// --- End ProcessingControls Component ---

// --- Main App Component ---
function App() {
  const [currentView, setCurrentView] = useState('process');
  const [selectedTheme, setSelectedTheme] = useState<ThemeType>('system');
  const [isThemeLoading, setIsThemeLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [sources, setSources] = useState<FilterSource[]>([]);
  const [isLoadingSources, setIsLoadingSources] = useState(true); // Specific loading for sources
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalSuccessMessage, setGlobalSuccessMessage] = useState<
    string | null
  >(null);
  const [savePath, setSavePath] = useState<string>('');

  useEffect(() => {
    window.electron.getSavePath().then(setSavePath);
  }, [currentView]);

  // Memoize applyTheme (existing)
  const memoizedApplyTheme = useCallback(applyTheme, []);

  // On mount, load and apply the user's theme preference
  useEffect(() => {
    let isMounted = true;
    const loadAndApplyTheme = async () => {
      try {
        const storedTheme = await window.electron.getTheme() as ThemeType;
        if (isMounted) {
          setSelectedTheme(storedTheme);
          memoizedApplyTheme(storedTheme);
        }
      } catch {
        if (isMounted) memoizedApplyTheme('system');
      } finally {
        if (isMounted) setIsThemeLoading(false);
      }
    };
    loadAndApplyTheme();
    return () => {
      isMounted = false;
    };
  }, [memoizedApplyTheme]);

  // When the user changes the theme
  const handleThemeChange = useCallback(
    async (newTheme: ThemeType) => {
      setSelectedTheme(newTheme);
      memoizedApplyTheme(newTheme);
      try {
        await window.electron.setTheme(newTheme);
      } catch (error) {
        console.error('Failed to set theme:', error);
      }
    },
    [memoizedApplyTheme]
  );

  // vvv Load sources on mount (moved from SourcesManager) vvv
  useEffect(() => {
    let isMounted = true;
    const loadSources = async () => {
      setGlobalError(null); // Clear previous errors
      setIsLoadingSources(true);
      try {
        const loadedSources = await window.electron.getSources();
        if (isMounted) {
          setSources(loadedSources || []); // Handle null/undefined case
        }
      } catch (err) {
        console.error('Failed to load sources:', err);
        if (isMounted) {
          setGlobalError(
            err instanceof Error ? err.message : 'Failed to load sources.'
          );
        }
      } finally {
        if (isMounted) {
          setIsLoadingSources(false);
        }
      }
    };
    loadSources();
    return () => {
      isMounted = false;
    }; // Cleanup on unmount
  }, []);
  // ^^^ Load sources on mount ^^^

  // vvv Clear global success/error messages after a delay vvv
  useEffect(() => {
    if (globalSuccessMessage || globalError) {
      const timer = setTimeout(() => {
        setGlobalSuccessMessage(null);
        setGlobalError(null);
      }, 3000); // Clear after 3 seconds
      return () => clearTimeout(timer);
    }
  }, [globalSuccessMessage, globalError]);
  // ^^^ Clear global messages ^^^

  // vvv Save sources function (moved from SourcesManager) vvv
  const saveSources = useCallback(
    async (updatedSources: FilterSource[], successMsg?: string) => {
      // Reset messages before attempting save
      setGlobalError(null);
      setGlobalSuccessMessage(null);
      try {
        const result = await window.electron.saveSources(updatedSources);
        if (!result.success) {
          throw new Error(result.error || 'Unknown error saving sources');
        }
        setSources(updatedSources); // Update global state on successful save
        if (successMsg) {
          setGlobalSuccessMessage(successMsg);
        }
      } catch (err) {
        console.error('Failed to save sources:', err);
        const errorMsg =
          err instanceof Error ? err.message : 'Failed to save sources.';
        setGlobalError(errorMsg);
        // Re-throw the error so calling components know the save failed
        throw err;
      }
    },
    []
  ); // Empty dependency array
  // ^^^ Save sources function ^^^

  // ResizeObserver Effect (existing)
  useEffect(() => {
    const containerElement = containerRef.current;
    if (!containerElement) return; // Exit if ref is not attached yet

    let resizeTimeout: NodeJS.Timeout | null = null;

    const observer = new ResizeObserver((entries) => {
      // We only observe one element, so entries[0] is fine
      if (!entries || entries.length === 0) return;

      // Use contentRect for size excluding padding/border if needed,
      // or boundingBoxRect for overall size. Let's stick with offsetWidth/Height for now.
      const width = containerElement.offsetWidth;
      const height = containerElement.offsetHeight;

      // Clear previous timeout
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }

      // Debounce the notification to main process
      resizeTimeout = setTimeout(() => {
        window.electron.notifyResize(width, height);
      }, 250);
    });

    // Start observing the container element
    observer.observe(containerElement);

    // Cleanup function: disconnect the observer when component unmounts
    return () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout); // Clear pending timeout on unmount
      }
      observer.disconnect();
    };
  }, [isThemeLoading]); // Re-run only when theme loading finishes (initial setup)
  // ^^^ ResizeObserver Effect ^^^

  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number>(0);
  const [updateAvailable, setUpdateAvailable] = useState<boolean>(false);

  // Listen for update events
  useEffect(() => {
    const unsubStatus = window.electron.onUpdateStatus((status) => {
      if (typeof status === 'string') {
        setUpdateStatus(status);
        if (status.includes('Update available')) {
          setUpdateAvailable(true);
        }
      }
    });

    const unsubProgress = window.electron.onUpdateProgress((progress) => {
      setUpdateProgress(progress);
    });

    const unsubDownloaded = window.electron.onUpdateDownloaded(() => {
      setUpdateStatus('Update downloaded. Ready to install.');
    });

    return () => {
      unsubStatus?.();
      unsubProgress?.();
      unsubDownloaded?.();
    };
  }, []);

  useEffect(() => {
    if (window.electron.onOpenSettings) {
      const unsubSettings = window.electron.onOpenSettings(() => setCurrentView('settings'));
      return () => {
        unsubSettings();
      };
    }
    if (window.electron.receive) {
      window.electron.receive('open-settings', () => setCurrentView('settings'));
      return () => {
        window.electron.removeAllListeners?.('open-settings');
      };
    }
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') {
      const handler = (e: KeyboardEvent) => {
        if (
          e.key === 'F12' ||
          (e.metaKey && e.altKey && e.key.toLowerCase() === 'i') ||
          (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i')
        ) {
          e.preventDefault();
        }
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }
  }, []);

  useEffect(() => {
    // Only auto-switch if theme is set to 'system'
    if (selectedTheme === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = () => {
        document.body.classList.toggle('dark-theme', media.matches);
      };
      handleChange(); // Set on mount
      media.addEventListener('change', handleChange);
      return () => media.removeEventListener('change', handleChange);
    }
  }, [selectedTheme]);

  useEffect(() => {
    const handleGlobalShortcuts = (e: KeyboardEvent) => {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (isCmdOrCtrl && !e.shiftKey && !e.altKey) {
        if (e.key === '1') {
          e.preventDefault();
          setCurrentView('process');
        } else if (e.key === '2') {
          e.preventDefault();
          setCurrentView('sources');
        } else if (e.key === '3') {
          e.preventDefault();
          setCurrentView('bulkImport');
        } else if (e.key === '4') {
          e.preventDefault();
          setCurrentView('custom');
        } else if (e.key === '5' || e.key === ',') {
          e.preventDefault();
          setCurrentView('settings');
        }
      }
    };
    window.addEventListener('keydown', handleGlobalShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
  }, []);

  if (isThemeLoading) {
    return <div className="app-shell" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading application...</div>;
  }

  return (
    <div className="app-shell" ref={containerRef}>
      {/* Native macOS Sidebar */}
      <aside className="app-sidebar">
        {/* Top window drag region & traffic light spacer */}
        <div className="sidebar-traffic-lights" />

        {/* App Branding */}
        <div className="sidebar-brand">
          <div className="brand-icon-shield">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
          </div>
          <div className="brand-info">
            <span className="brand-title">Blockingmachine</span>
            <span className="brand-version">v1.0.0-beta.9</span>
          </div>
        </div>

        {/* Sidebar Navigation Items */}
        <nav className="sidebar-nav">
          <div className="sidebar-section-label">Features</div>

          <button
            className={`sidebar-nav-item ${currentView === 'process' ? 'active' : ''}`}
            onClick={() => setCurrentView('process')}
            title="Dashboard & Filter Processor (Cmd+1)"
          >
            <span className="sidebar-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
              </svg>
            </span>
            <span className="sidebar-label">Process & Stats</span>
            <span className="sidebar-shortcut">⌘1</span>
          </button>

          <button
            className={`sidebar-nav-item ${currentView === 'sources' ? 'active' : ''}`}
            onClick={() => setCurrentView('sources')}
            title="Filter Feeds & Subscriptions (Cmd+2)"
          >
            <span className="sidebar-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
              </svg>
            </span>
            <span className="sidebar-label">Sources</span>
            <span className="sidebar-badge">{sources.filter((s) => s.enabled).length}/{sources.length}</span>
          </button>

          <button
            className={`sidebar-nav-item ${currentView === 'bulkImport' ? 'active' : ''}`}
            onClick={() => setCurrentView('bulkImport')}
            title="Bulk Import (Cmd+3)"
          >
            <span className="sidebar-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
            </span>
            <span className="sidebar-label">Bulk Import</span>
            <span className="sidebar-shortcut">⌘3</span>
          </button>

          <button
            className={`sidebar-nav-item ${currentView === 'custom' ? 'active' : ''}`}
            onClick={() => setCurrentView('custom')}
            title="Custom Rules (Cmd+4)"
          >
            <span className="sidebar-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
              </svg>
            </span>
            <span className="sidebar-label">Custom Rules</span>
            <span className="sidebar-shortcut">⌘4</span>
          </button>

          <div className="sidebar-section-label" style={{ marginTop: '14px' }}>Preferences</div>
          <button
            className={`sidebar-nav-item ${currentView === 'settings' ? 'active' : ''}`}
            onClick={() => setCurrentView('settings')}
            title="Settings (Cmd+5 or Cmd+,)"
          >
            <span className="sidebar-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </span>
            <span className="sidebar-label">Settings</span>
            {updateAvailable && <span className="update-dot" title="Update Available">●</span>}
          </button>
        </nav>

        {/* Native macOS Sidebar Footer */}
        <footer className="sidebar-footer">
          <div className="sidebar-status-row">
            <div className="engine-status-indicator">
              <span className="status-dot pulse" />
              <span className="engine-status-label">Core Engine</span>
            </div>
            <span className="engine-status-badge">Ready</span>
          </div>

          <div className="sidebar-meta-row">
            <a
              href="#"
              onClick={(e) => handleExternalLink(e, 'https://danielhipskind.bio')}
              className="sidebar-meta-btn"
              title="Developer Profile: Daniel Hipskind"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
              </svg>
              <span>Daniel Hipskind</span>
            </a>
            <a
              href="#"
              onClick={(e) => handleExternalLink(e, 'https://github.com/greigh/Blockingmachine')}
              className="sidebar-meta-btn"
              title="GitHub Repository: greigh/Blockingmachine"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
              <span>GitHub</span>
            </a>
          </div>
        </footer>
      </aside>

      {/* Main Workspace Pane */}
      <main className="app-main-pane">
        <header className="main-header">
          <div className="header-left">
            <h1 className="view-title">
              {currentView === 'process' && 'Filter Processor'}
              {currentView === 'sources' && 'Filter Sources'}
              {currentView === 'bulkImport' && 'Bulk Import'}
              {currentView === 'custom' && 'Custom Rules'}
              {currentView === 'settings' && 'Settings'}
            </h1>
            <span className="view-subtitle">
              {currentView === 'process' && 'Generate, deduplicate, and compile your blocklists'}
              {currentView === 'sources' && 'Manage remote filter subscriptions and feeds'}
              {currentView === 'bulkImport' && 'Add multiple filter list URLs quickly'}
              {currentView === 'custom' && 'Manual Adblock Plus and DNS rules'}
              {currentView === 'settings' && 'Export formats, output directory, and theme'}
            </span>
          </div>

          <div className="header-right">
            {currentView === 'sources' && (
              <span className="header-badge">{sources.length} feeds configured</span>
            )}
            {savePath && (
              <button
                className="header-action-btn"
                onClick={() => window.electron.showItemInFolder(savePath)}
                title="Show export output folder in Finder"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776" />
                </svg>
                Output Folder
              </button>
            )}
          </div>
        </header>

        {/* Global Floating Feedback Toasts */}
        {(globalError || globalSuccessMessage || updateStatus) && (
          <div className="toast-banner-container">
            {globalError && (
              <div className="desktop-toast toast-error">
                <span className="toast-icon">⚠️</span>
                <span className="toast-msg">{globalError}</span>
                <button className="toast-close" onClick={() => setGlobalError(null)}>✕</button>
              </div>
            )}
            {globalSuccessMessage && !globalError && (
              <div className="desktop-toast toast-success">
                <span className="toast-icon">✓</span>
                <span className="toast-msg">{globalSuccessMessage}</span>
                <button className="toast-close" onClick={() => setGlobalSuccessMessage(null)}>✕</button>
              </div>
            )}
            {updateStatus && !globalError && !globalSuccessMessage && (
              <div className="desktop-toast toast-info">
                <span className="toast-icon">ℹ</span>
                <span className="toast-msg">
                  {updateStatus}
                  {updateProgress > 0 && updateProgress < 100
                    ? ` (${Math.round(updateProgress)}%)`
                    : ''}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Scrollable View Content */}
        <div className="main-content-scroll">
          {currentView === 'sources' &&
            (isLoadingSources ? (
              <p>Loading sources...</p>
            ) : (
              <SourcesManager
                sources={sources}
                saveSources={saveSources}
                setError={setGlobalError}
                setSuccessMessage={setGlobalSuccessMessage}
              />
            ))}
          {currentView === 'bulkImport' && (
            <BulkImportManager
              currentSources={sources}
              saveSources={saveSources}
              setError={setGlobalError}
              setSuccessMessage={setGlobalSuccessMessage}
            />
          )}
          {currentView === 'custom' && <CustomRulesEditor />}
          {currentView === 'process' && (
            <ProcessingControls savePath={savePath} />
          )}
          {currentView === 'settings' && (
            <Settings
              currentTheme={selectedTheme}
              onThemeChange={handleThemeChange}
            />
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
