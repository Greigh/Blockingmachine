import React, { useState, useEffect, useRef } from 'react';
import './index.css';
import type { ThemeType, FilterFormat } from './types/';

interface SettingsProps {
  currentTheme: ThemeType;
  onThemeChange: (theme: ThemeType) => void;
}

const Settings: React.FC<SettingsProps> = ({ currentTheme, onThemeChange }) => {
  // Existing state variables
  const [exportFormat, setExportFormat] = useState('');
  const [isLoadingFormat, setIsLoadingFormat] = useState(true);
  const [isSavingFormat, setIsSavingFormat] = useState(false);
  const [formatMessage, setFormatMessage] = useState<{
    text: string;
    type: 'success' | 'error' | null;
  }>({ text: '', type: null });

  // Multi-format simultaneous export state
  const [additionalFormats, setAdditionalFormats] = useState<FilterFormat[]>([]);

  // Automation & Webhook state
  const [autoSchedule, setAutoSchedule] = useState<'disabled' | '12h' | '24h' | 'weekly'>('disabled');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookMessage, setWebhookMessage] = useState('');
  const [isSavingWebhook, setIsSavingWebhook] = useState(false);

  // Network Sinkholes state
  const [sinkholeConfig, setSinkholeConfig] = useState({
    piholeUrl: '',
    piholeApiKey: '',
    adguardHomeUrl: '',
    adguardHomeUser: '',
    adguardHomePassword: '',
    syncOnCompile: false,
  });
  const [isSavingSinkhole, setIsSavingSinkhole] = useState(false);
  const [isSyncingSinkhole, setIsSyncingSinkhole] = useState(false);
  const [sinkholeMessage, setSinkholeMessage] = useState('');
  const [syncResults, setSyncResults] = useState<Array<{ service: string; status: 'success' | 'error' | 'skipped'; message: string }>>([]);

  // Path state variables
  const [savePath, setSavePath] = useState('');
  const [isLoadingPath, setIsLoadingPath] = useState(true);
  const [isSavingPath, setIsSavingPath] = useState(false);
  const [pathMessage, setPathMessage] = useState('');

  // Timer tracking to prevent memory leaks on unmount
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, []);

  const safeSetTimeout = (fn: () => void, delay: number) => {
    const id = setTimeout(() => {
      timersRef.current = timersRef.current.filter((t) => t !== id);
      fn();
    }, delay);
    timersRef.current.push(id);
    return id;
  };

  useEffect(() => {
    let isMounted = true;

    // Load export format & additional formats
    const loadExportFormat = async () => {
      try {
        const format = await window.electron.getExportFormat();
        if (isMounted) setExportFormat(format);
        const additionals = await window.electron.getAdditionalFormats();
        if (isMounted) setAdditionalFormats(additionals || []);
      } catch (error) {
        console.error('Error loading format:', error);
      } finally {
        if (isMounted) setIsLoadingFormat(false);
      }
    };

    // Load save path
    const loadSavePath = async () => {
      try {
        const path = await window.electron.getSavePath();
        if (isMounted) setSavePath(path);
      } catch (error) {
        console.error('Error loading path:', error);
      } finally {
        if (isMounted) setIsLoadingPath(false);
      }
    };

    // Load automation schedule & webhook
    window.electron.getAutoSchedule().then((schedule) => {
      if (isMounted) setAutoSchedule(schedule || 'disabled');
    }).catch(console.error);

    window.electron.getWebhookUrl().then((url) => {
      if (isMounted) setWebhookUrl(url || '');
    }).catch(console.error);

    window.electron.getSinkholeConfig().then((cfg) => {
      if (isMounted && cfg) setSinkholeConfig(cfg);
    }).catch(console.error);

    loadExportFormat();
    loadSavePath();

    return () => {
      isMounted = false;
    };
  }, []);

  const handleExternalLink = async (
    e: React.MouseEvent<HTMLAnchorElement, MouseEvent>,
    url: string
  ) => {
    e.preventDefault();
    try {
      await window.electron.openExternal(url);
    } catch (error) {
      console.error('Failed to open link:', error);
    }
  };

  const handleFormatChange = async (
    e: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const format = e.target.value as FilterFormat;
    setExportFormat(format);
    setIsSavingFormat(true);

    try {
      const res = await window.electron.setExportFormat(format);
      if (res && !res.success) {
        throw new Error(res.error || 'Failed to save format');
      }
      showTemporaryMessage('Format updated successfully', 'success', setFormatMessage);
    } catch (error) {
      console.error('Error saving format:', error);
      const msg = error instanceof Error ? error.message : 'Failed to save format';
      showTemporaryMessage(msg, 'error', setFormatMessage);
    } finally {
      setIsSavingFormat(false);
    }
  };

  const handleToggleAdditionalFormat = async (targetFormat: FilterFormat) => {
    let next: FilterFormat[];
    if (additionalFormats.includes(targetFormat)) {
      next = additionalFormats.filter((f) => f !== targetFormat);
    } else {
      next = [...additionalFormats, targetFormat];
    }
    setAdditionalFormats(next);
    try {
      await window.electron.setAdditionalFormats(next);
      showTemporaryMessage('Simultaneous export targets updated', 'success', setFormatMessage);
    } catch (err) {
      console.error('Failed to update additional formats:', err);
    }
  };

  const handleScheduleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as 'disabled' | '12h' | '24h' | 'weekly';
    setAutoSchedule(val);
    try {
      await window.electron.setAutoSchedule(val);
    } catch (err) {
      console.error('Failed to update auto schedule:', err);
    }
  };

  const handleSaveWebhook = async () => {
    setIsSavingWebhook(true);
    try {
      await window.electron.setWebhookUrl(webhookUrl);
      setWebhookMessage('Webhook endpoint URL saved successfully.');
      safeSetTimeout(() => setWebhookMessage(''), 3000);
    } catch (err) {
      console.error('Failed to save webhook URL:', err);
      setWebhookMessage('Failed to save webhook URL.');
    } finally {
      setIsSavingWebhook(false);
    }
  };

  const handlePathChange = async () => {
    setIsSavingPath(true);
    try {
      const selectedPath = await window.electron.selectSavePath();
      if (selectedPath && typeof selectedPath === 'string') {
        setSavePath(selectedPath);
        const res = await window.electron.setSavePath(selectedPath);
        if (res && !res.success) {
          throw new Error(res.error || 'Failed to set save path');
        }
        setPathMessage('Path updated successfully!');
        safeSetTimeout(() => {
          setPathMessage('');
        }, 3000);
      } else {
        setPathMessage('No path selected.');
      }
    } catch (error) {
      console.error('Error saving path:', error);
      setPathMessage('Failed to update save path.');
      safeSetTimeout(() => {
        setPathMessage('');
      }, 3000);
    } finally {
      setIsSavingPath(false);
    }
  };

  const handleRevealPath = async () => {
    if (savePath) {
      try {
        await window.electron.showItemInFolder(savePath);
      } catch (error) {
        console.error('Failed to reveal path:', error);
      }
    }
  };

  // Helper for showing temporary success/error messages
  const showTemporaryMessage = (
    text: string,
    type: 'success' | 'error',
    setMessage: React.Dispatch<
      React.SetStateAction<{ text: string; type: 'success' | 'error' | null }>
    >
  ) => {
    setMessage({ text, type });
    safeSetTimeout(() => {
      setMessage({ text: '', type: null });
    }, 3000);
  };

  const handleSaveSinkhole = async () => {
    setIsSavingSinkhole(true);
    try {
      await window.electron.setSinkholeConfig(sinkholeConfig);
      setSinkholeMessage('Sinkhole integration settings saved!');
      safeSetTimeout(() => setSinkholeMessage(''), 3000);
    } catch (err: any) {
      setSinkholeMessage(`Failed to save: ${err.message}`);
      safeSetTimeout(() => setSinkholeMessage(''), 4000);
    } finally {
      setIsSavingSinkhole(false);
    }
  };

  const handleTriggerSync = async () => {
    setIsSyncingSinkhole(true);
    try {
      const res = await window.electron.syncSinkholes();
      setSyncResults(res.results || []);
    } catch (err: any) {
      console.error('Sinkhole sync failed:', err);
    } finally {
      setIsSyncingSinkhole(false);
    }
  };

  return (
    <div className="settings-container">
      <div className="settings-grid">
        {/* Theme Setting */}
        <div className="setting-card">
          <div className="setting-card-header">
            <h3>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z" />
                </svg>
              </span>
              Theme Appearance
            </h3>
            <span className="setting-badge secondary">Display</span>
          </div>
          <p>Choose how Blockingmachine appears on your system</p>

          <div className="theme-preview-container">
            <div
              className={`theme-preview theme-preview-light ${currentTheme === 'light' ? 'selected' : ''}`}
              onClick={() => onThemeChange('light')}
            >
              <div className="theme-preview-label">Light</div>
            </div>
            <div
              className={`theme-preview theme-preview-dark ${currentTheme === 'dark' ? 'selected' : ''}`}
              onClick={() => onThemeChange('dark')}
            >
              <div className="theme-preview-label">Dark</div>
            </div>
            <div
              className={`theme-preview theme-preview-system ${currentTheme === 'system' ? 'selected' : ''}`}
              onClick={() => onThemeChange('system')}
            >
              <div className="theme-preview-label">System</div>
            </div>
          </div>
        </div>

        {/* Export Format Setting */}
        <div className="setting-card">
          <div className="setting-card-header">
            <h3>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </span>
              Default Export Format
            </h3>
            <span className="setting-badge secondary">Output</span>
          </div>
          <p>Select how rules and modifiers are formatted during compilation</p>

          {isLoadingFormat ? (
            <div className="loading-path">
              <div className="path-loader"></div>
              <span>Loading format preferences...</span>
            </div>
          ) : (
            <>
              <div className="select-container">
                <select
                  className="styled-select"
                  value={exportFormat}
                  onChange={handleFormatChange}
                  disabled={isSavingFormat}
                >
                  <option value="adguard">AdGuard (Adblock Plus & uBlock Origin format)</option>
                  <option value="abp">AdBlock Plus (Standard browser extension syntax)</option>
                  <option value="hosts">Hosts File (Standard 0.0.0.0 domain syntax for DNS)</option>
                  <option value="dnsmasq">DNSMasq (Router and Pi-hole address syntax)</option>
                  <option value="unbound">Unbound (Local DNS resolver block syntax)</option>
                  <option value="domains">Domain List (One clean domain per line)</option>
                  <option value="plain">Plain Text (Raw line-by-line rules)</option>
                </select>
              </div>

              {formatMessage.text && (
                <div className={`setting-message ${formatMessage.type}`}>
                  {formatMessage.text}
                </div>
              )}

              <p className="setting-help-text">
                The selected format determines preprocessor directives, exception rules, and modifier compatibility when compiling blocklists.
              </p>

              {/* Simultaneous Multi-Format Export */}
              <div className="additional-formats-section">
                <span className="additional-formats-title">Simultaneous Additional Output Formats</span>
                <p className="setting-help-text">
                  Automatically generate these complementary blocklist formats in your output directory whenever you compile:
                </p>
                <div className="format-checkbox-grid">
                  {[
                    { id: 'hosts', label: 'Hosts File (0.0.0.0 for DNS/Pi-hole)' },
                    { id: 'dnsmasq', label: 'DNSMasq (server address syntax)' },
                    { id: 'adguard', label: 'AdGuard / uBlock format' },
                    { id: 'domains', label: 'Plain Domain List (one per line)' },
                    { id: 'unbound', label: 'Unbound DNS Resolver' },
                  ]
                    .filter((item) => item.id !== exportFormat)
                    .map((item) => (
                      <label key={item.id} className="format-checkbox-label">
                        <input
                          type="checkbox"
                          checked={additionalFormats.includes(item.id as FilterFormat)}
                          onChange={() => handleToggleAdditionalFormat(item.id as FilterFormat)}
                        />
                        <span>{item.label}</span>
                      </label>
                    ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Save Path Setting */}
        <div className="setting-card">
          <div className="setting-card-header">
            <h3>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.227 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                </svg>
              </span>
              Save Location
            </h3>
            <span className="setting-badge primary">File System</span>
          </div>
          <p>Choose where to save generated filter lists and export logs</p>

          {isLoadingPath ? (
            <div className="loading-path">
              <div className="path-loader"></div>
              <span>Loading path settings...</span>
            </div>
          ) : (
            <div>
              <div className="path-input-container">
                <input
                  type="text"
                  className="path-input"
                  value={savePath}
                  readOnly
                  placeholder="No directory selected"
                />
                <button
                  className="browse-button"
                  onClick={handlePathChange}
                  disabled={isSavingPath}
                  title="Choose new output directory"
                >
                  {isSavingPath ? 'Selecting...' : 'Browse...'}
                </button>
                {savePath && (
                  <button
                    className="browse-button secondary"
                    onClick={handleRevealPath}
                    title="Reveal output directory in Finder"
                  >
                    Reveal
                  </button>
                )}
              </div>

              {pathMessage && <p className="setting-message success">{pathMessage}</p>}

              <p className="setting-help-text">
                Output files (<code className="inline-code">hosts.txt</code>, <code className="inline-code">adguard.txt</code>, <code className="inline-code">dnsmasq.txt</code>) are written directly to this directory.
              </p>
            </div>
          )}
        </div>

        {/* Automation & Background Scheduling */}
        <div className="setting-card">
          <div className="setting-card-header">
            <h3>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </span>
              Automation & Scheduling
            </h3>
            <span className="setting-badge secondary">Background Tasks</span>
          </div>
          <p>Keep your network blocklists up-to-date automatically</p>

          <div className="setting-control-group">
            <label className="setting-label">Automatic Compilation Schedule</label>
            <div className="select-container">
              <select
                className="setting-select"
                value={autoSchedule}
                onChange={handleScheduleChange}
              >
                <option value="disabled">Disabled (Manual Compilation Only)</option>
                <option value="12h">Every 12 Hours</option>
                <option value="24h">Daily (Every 24 Hours)</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <p className="setting-help-text">
              When enabled, Blockingmachine fetches and compiles your enabled feeds in the background and delivers a native desktop notification upon completion.
            </p>
          </div>

          <div className="setting-control-group" style={{ marginTop: '16px' }}>
            <label className="setting-label">Post-Compilation Webhook Endpoint (Optional)</label>
            <div className="path-input-container">
              <input
                type="text"
                className="path-input"
                placeholder="https://pi.hole/admin/api.php?action=restart or webhook URL"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
              />
              <button
                className="browse-button"
                onClick={handleSaveWebhook}
                disabled={isSavingWebhook}
              >
                {isSavingWebhook ? 'Saving…' : 'Save'}
              </button>
            </div>
            {webhookMessage && <p className="setting-message success">{webhookMessage}</p>}
            <p className="setting-help-text">
              Sends an HTTP POST payload with compilation statistics whenever blocklists are updated, allowing Pi-hole, AdGuard Home, or DNS servers to reload automatically.
            </p>
          </div>
        </div>

        {/* Network Sinkholes & DNS Integration Card */}
        <div className="setting-card">
          <div className="setting-card-header">
            <h3>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-.778.099-1.533.284-2.253" />
                </svg>
              </span>
              Network Sinkholes (Pi-hole & AdGuard Home)
            </h3>
            <span className="setting-badge primary">DNS Sync</span>
          </div>
          <p>Automatically push compiled blocklists and trigger gravity updates on local DNS appliances</p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '14px' }}>
            {/* Pi-hole Section */}
            <div style={{ background: 'var(--bg-tertiary, rgba(255,255,255,0.03))', padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color, rgba(255,255,255,0.06))' }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>🥧</span> Pi-hole Integration
              </div>
              <div style={{ marginBottom: '10px' }}>
                <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>API Endpoint URL</label>
                <input
                  type="text"
                  className="path-input"
                  style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                  placeholder="http://pi.hole/admin/api.php"
                  value={sinkholeConfig.piholeUrl}
                  onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, piholeUrl: e.target.value })}
                />
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Auth API Token</label>
                <input
                  type="password"
                  className="path-input"
                  style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                  placeholder="Pi-hole web password hash"
                  value={sinkholeConfig.piholeApiKey}
                  onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, piholeApiKey: e.target.value })}
                />
              </div>
            </div>

            {/* AdGuard Home Section */}
            <div style={{ background: 'var(--bg-tertiary, rgba(255,255,255,0.03))', padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color, rgba(255,255,255,0.06))' }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>🛡️</span> AdGuard Home Integration
              </div>
              <div style={{ marginBottom: '10px' }}>
                <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Instance URL</label>
                <input
                  type="text"
                  className="path-input"
                  style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                  placeholder="http://192.168.1.1:3000"
                  value={sinkholeConfig.adguardHomeUrl}
                  onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: e.target.value })}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div>
                  <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Username</label>
                  <input
                    type="text"
                    className="path-input"
                    style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                    placeholder="admin"
                    value={sinkholeConfig.adguardHomeUser}
                    onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUser: e.target.value })}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Password</label>
                  <input
                    type="password"
                    className="path-input"
                    style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                    placeholder="••••••••"
                    value={sinkholeConfig.adguardHomePassword}
                    onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomePassword: e.target.value })}
                  />
                </div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem' }}>
              <input
                type="checkbox"
                checked={sinkholeConfig.syncOnCompile}
                onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, syncOnCompile: e.target.checked })}
              />
              <span>Trigger sinkhole reload automatically on every compilation</span>
            </label>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="browse-button secondary"
                onClick={handleTriggerSync}
                disabled={isSyncingSinkhole}
              >
                {isSyncingSinkhole ? 'Syncing...' : 'Sync Now'}
              </button>
              <button
                className="browse-button"
                onClick={handleSaveSinkhole}
                disabled={isSavingSinkhole}
              >
                {isSavingSinkhole ? 'Saving...' : 'Save Sinkholes'}
              </button>
            </div>
          </div>

          {sinkholeMessage && (
            <p className="setting-message success" style={{ marginTop: '10px' }}>
              {sinkholeMessage}
            </p>
          )}

          {syncResults.length > 0 && (
            <div style={{ marginTop: '12px', padding: '10px', background: 'var(--bg-tertiary, rgba(255,255,255,0.03))', borderRadius: '8px', fontSize: '0.8rem' }}>
              {syncResults.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: i < syncResults.length - 1 ? '6px' : 0 }}>
                  <span style={{ fontWeight: 600 }}>{r.service}:</span>
                  <span style={{ color: r.status === 'success' ? '#10b981' : r.status === 'error' ? '#ef4444' : 'inherit', opacity: r.status === 'skipped' ? 0.6 : 1 }}>
                    {r.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* About & Contact Section */}
        <div className="setting-card">
          <div className="setting-card-header">
            <h3>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                </svg>
              </span>
              About & Community
            </h3>
            <span className="setting-badge secondary">v1.0.0-beta.9</span>
          </div>

          <div className="about-app-banner">
            <div className="about-app-icon">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
            </div>
            <div className="about-app-meta">
              <h4>Blockingmachine</h4>
              <p>High-performance adblock compiler and DNS rule deduplicator. Created by Daniel Hipskind.</p>
            </div>
          </div>

          <div className="about-links-grid">
            <a
              href="https://danielhipskind.com"
              onClick={(e) => handleExternalLink(e, 'https://danielhipskind.com')}
              className="about-link-item"
              rel="noopener noreferrer"
            >
              <div className="about-link-left">
                <span className="about-link-icon">
                  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                </span>
                <div className="about-link-texts">
                  <span className="about-link-title">Personal Website</span>
                  <span className="about-link-subtitle">danielhipskind.com</span>
                </div>
              </div>
              <span className="about-link-arrow">↗</span>
            </a>

            <a
              href="https://github.com/greigh/blockingmachine"
              onClick={(e) => handleExternalLink(e, 'https://github.com/greigh/blockingmachine')}
              className="about-link-item"
              rel="noopener noreferrer"
            >
              <div className="about-link-left">
                <span className="about-link-icon">
                  <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.5 2.87 8.32 6.84 9.67.5.09.68-.22.68-.48 0-.24-.01-.87-.01-1.7-2.78.62-3.37-1.36-3.37-1.36-.45-1.18-1.1-1.5-1.1-1.5-.9-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05A9.38 9.38 0 0 1 12 6.84c.85.004 1.7.12 2.5.35 1.9-1.33 2.74-1.05 2.74-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.8 0 .26.18.57.69.47A10.01 10.01 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z" />
                  </svg>
                </span>
                <div className="about-link-texts">
                  <span className="about-link-title">GitHub Repository</span>
                  <span className="about-link-subtitle">greigh/blockingmachine</span>
                </div>
              </div>
              <span className="about-link-arrow">↗</span>
            </a>

            <a
              href="https://bsky.app/profile/danielhipskind.com"
              onClick={(e) => handleExternalLink(e, 'https://bsky.app/profile/danielhipskind.com')}
              className="about-link-item"
              rel="noopener noreferrer"
            >
              <div className="about-link-left">
                <span className="about-link-icon" style={{ color: '#0091FF' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566 1.01 0 1.88 0 5.6c0 1.04.148 4.79.52 6.01.69 2.27 3.23 3.03 5.48 2.59-3.23 1.07-4.14 3.73-2.33 5.56 3.44 3.47 7.07-.86 8.33-4.04 1.26 3.18 4.89 7.51 8.33 4.04 1.81-1.83.9-4.49-2.33-5.56 2.25.44 4.79-.32 5.48-2.59.372-1.22.52-4.97.52-6.01 0-3.72-2.566-4.59-5.202-2.795C16.046 4.747 13.087 8.686 12 10.8z" />
                  </svg>
                </span>
                <div className="about-link-texts">
                  <span className="about-link-title">Bluesky</span>
                  <span className="about-link-subtitle">@danielhipskind.com</span>
                </div>
              </div>
              <span className="about-link-arrow">↗</span>
            </a>

            <a
              href="https://mastodon.social/@danielhipskind"
              onClick={(e) => handleExternalLink(e, 'https://mastodon.social/@danielhipskind')}
              className="about-link-item"
              rel="me noopener noreferrer"
            >
              <div className="about-link-left">
                <span className="about-link-icon" style={{ color: '#6364FF' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M21.327 8.566c0-4.339-2.843-5.61-2.843-5.61C17.067 2.247 14.156 2 12 2s-5.067.247-6.484.956c0 0-2.843 1.271-2.843 5.61 0 .993-.015 2.186.045 3.518.23 5.106 2.898 9.542 7.822 9.878 2.235.152 4.195-.394 4.195-.394l-.09-1.84s-1.57.49-3.327.433c-1.743-.056-3.585-.306-3.83-2.378a3.67 3.67 0 0 1-.05-.595s1.86.452 4.225.565c1.458.07 2.83-.07 4.21-.24 2.89-.356 5.4-2.193 5.72-5.185.34-3.176.35-6.198.35-6.726zM17.43 13.68h-2.188V9.167c0-1.745-.738-2.63-2.213-2.63-1.63 0-2.445 1.053-2.445 3.16v2.983H8.416V9.697c0-2.107-.815-3.16-2.445-3.16-1.475 0-2.213.885-2.213 2.63v4.513H1.57V8.922c0-1.745.445-3.13 1.335-4.155C3.795 3.742 5.04 3.22 6.64 3.22c1.868 0 3.267.717 4.197 2.15.93-1.433 2.33-2.15 4.197-2.15 1.6 0 2.845.522 3.735 1.547.89 1.025 1.335 2.41 1.335 4.155v4.758z" />
                  </svg>
                </span>
                <div className="about-link-texts">
                  <span className="about-link-title">Mastodon</span>
                  <span className="about-link-subtitle">@danielhipskind@mastodon.social</span>
                </div>
              </div>
              <span className="about-link-arrow">↗</span>
            </a>

            <a
              href="https://twitter.com/danielhipskind_"
              onClick={(e) => handleExternalLink(e, 'https://twitter.com/danielhipskind_')}
              className="about-link-item"
              rel="noopener noreferrer"
            >
              <div className="about-link-left">
                <span className="about-link-icon">
                  <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                </span>
                <div className="about-link-texts">
                  <span className="about-link-title">X / Twitter</span>
                  <span className="about-link-subtitle">@danielhipskind_</span>
                </div>
              </div>
              <span className="about-link-arrow">↗</span>
            </a>

            <a
              href="mailto:me@danielhipskind.com"
              onClick={(e) => handleExternalLink(e, 'mailto:me@danielhipskind.com')}
              className="about-link-item"
            >
              <div className="about-link-left">
                <span className="about-link-icon" style={{ color: '#007aff' }}>
                  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="M22 6l-10 7L2 6" />
                  </svg>
                </span>
                <div className="about-link-texts">
                  <span className="about-link-title">Email Contact</span>
                  <span className="about-link-subtitle">me@danielhipskind.com</span>
                </div>
              </div>
              <span className="about-link-arrow">↗</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
