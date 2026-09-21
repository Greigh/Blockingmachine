import React, { useState, useEffect, useRef } from 'react';
import { BrandLogo } from './components/BrandLogo';
import type {
  ThemeType,
  FilterFormat,
  SinkholeConfig,
  SinkholeTestResult,
  AiProviderConfig,
  AiWatchdogConfig,
} from './types/';
import {
  ACCENT_PALETTE,
  applyAccentColor,
  type AccentColorOption,
} from './theme';

export { ACCENT_PALETTE, applyAccentColor, type AccentColorOption };

interface SettingsProps {
  currentTheme: ThemeType;
  onThemeChange: (theme: ThemeType) => void;
  onLaunchOnboarding?: () => void;
}

const Settings: React.FC<SettingsProps> = ({
  currentTheme,
  onThemeChange,
  onLaunchOnboarding,
}) => {
  const [accentColor, setAccentColor] = useState<string>(() => {
    try {
      return localStorage.getItem('bm-accent-color') || 'blue';
    } catch {
      return 'blue';
    }
  });

  const handleAccentChange = (id: string) => {
    setAccentColor(id);
    applyAccentColor(id);
  };

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
  const [sinkholeConfig, setSinkholeConfig] = useState<SinkholeConfig>({
    piholeUrl: '',
    piholeApiKey: '',
    adguardHomeUrl: '',
    adguardHomeUser: '',
    adguardHomePassword: '',
    syncOnCompile: false,
    adguardMode: 'direct',
    haToken: '',
    haWebhookUrl: '',
    customWebhookUrl: '',
  });
  const [isSavingSinkhole, setIsSavingSinkhole] = useState(false);
  const [isSyncingSinkhole, setIsSyncingSinkhole] = useState(false);
  const [sinkholeMessage, setSinkholeMessage] = useState('');
  const [syncResults, setSyncResults] = useState<Array<{ service: string; status: 'success' | 'error' | 'skipped'; message: string }>>([]);
  const [showPiholeKey, setShowPiholeKey] = useState(false);
  const [showAdguardPass, setShowAdguardPass] = useState(false);
  const [showHaToken, setShowHaToken] = useState(false);
  const [testingService, setTestingService] = useState<'pihole' | 'adguard' | 'webhook' | null>(null);
  const [testResults, setTestResults] = useState<{ [key: string]: SinkholeTestResult }>({});

  // AI & Threat Intelligence state
  const [aiConfig, setAiConfig] = useState<AiProviderConfig>({
    provider: 'mini-ai',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.2',
    apiKey: '',
    apiEndpoint: 'https://api.openai.com/v1',
    modelName: 'gpt-4o-mini',
  });
  const [watchdogConfig, setWatchdogConfig] = useState<AiWatchdogConfig>({
    enabled: false,
    intervalMinutes: 60,
    service: 'adguard',
  });
  const [isSavingAi, setIsSavingAi] = useState(false);
  const [isTestingAi, setIsTestingAi] = useState(false);
  const [aiMessage, setAiMessage] = useState<{ text: string; type: 'success' | 'error' | null }>({ text: '', type: null });
  const [aiTestResult, setAiTestResult] = useState<{ success: boolean; latencyMs?: number; message: string } | null>(null);
  const [showAiKey, setShowAiKey] = useState(false);
  const [learnedFeedbackCount, setLearnedFeedbackCount] = useState<number>(0);

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

    if (window.electron?.getAiConfig) {
      window.electron.getAiConfig().then((cfg) => {
        if (isMounted && cfg) setAiConfig(cfg);
      }).catch(console.error);
    }

    if (window.electron?.getAiWatchdogConfig) {
      window.electron.getAiWatchdogConfig().then((wCfg) => {
        if (isMounted && wCfg) setWatchdogConfig(wCfg);
      }).catch(console.error);
    }

    if (window.electron?.getMiniAiFeedbackStats) {
      window.electron.getMiniAiFeedbackStats().then((stats) => {
        if (isMounted && stats) setLearnedFeedbackCount(stats.count || 0);
      }).catch(console.error);
    }

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
      await window.electron.setSinkholeConfig(sinkholeConfig);
      const res = await window.electron.syncSinkholes();
      setSyncResults(res.results || []);
    } catch (err: any) {
      console.error('Sinkhole sync failed:', err);
    } finally {
      setIsSyncingSinkhole(false);
    }
  };

  const handleTestService = async (service: 'pihole' | 'adguard' | 'webhook') => {
    setTestingService(service);
    try {
      await window.electron.setSinkholeConfig(sinkholeConfig);
      const res = await window.electron.testSinkholeConnection(service);
      setTestResults((prev) => ({ ...prev, [service]: res }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [service]: { success: false, service, message: err?.message || 'Connection test failed' },
      }));
    } finally {
      setTestingService(null);
    }
  };

  const handleSaveAiSettings = async () => {
    setIsSavingAi(true);
    setAiMessage({ text: '', type: null });
    try {
      if (window.electron?.setAiConfig) {
        await window.electron.setAiConfig(aiConfig);
      }
      if (window.electron?.setAiWatchdogConfig) {
        await window.electron.setAiWatchdogConfig(watchdogConfig);
      }
      setAiMessage({ text: 'AI engine & Sentinel Watchdog settings saved successfully!', type: 'success' });
      safeSetTimeout(() => setAiMessage({ text: '', type: null }), 3500);
    } catch (err: any) {
      console.error('Failed to save AI settings:', err);
      setAiMessage({ text: err?.message || 'Failed to save AI configuration.', type: 'error' });
    } finally {
      setIsSavingAi(false);
    }
  };

  const handleTestAiConnection = async () => {
    setIsTestingAi(true);
    setAiTestResult(null);
    try {
      if (window.electron?.testAiConnection) {
        const res = await window.electron.testAiConnection(aiConfig);
        setAiTestResult(res);
      }
    } catch (err: any) {
      setAiTestResult({
        success: false,
        message: err?.message || 'Connection test failed',
      });
    } finally {
      setIsTestingAi(false);
    }
  };

  const handleResetAiFeedback = async () => {
    if (!window.electron?.tuneMiniAiFeedback) return;
    try {
      await window.electron.tuneMiniAiFeedback('', 'reset');
      setLearnedFeedbackCount(0);
      setAiMessage({ text: 'Mini-AI learned feedback database reset successfully.', type: 'success' });
      safeSetTimeout(() => setAiMessage({ text: '', type: null }), 3000);
    } catch (err: any) {
      setAiMessage({ text: err?.message || 'Failed to reset feedback.', type: 'error' });
    }
  };

  return (
    <div className="settings-container">
      <div className="settings-grid">
        {/* Onboarding & Guide Setting Card */}
        <div className="setting-card">
          <div className="setting-card-header">
            <h3>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
                </svg>
              </span>
              Welcome & Onboarding Tour
            </h3>
            <span className="setting-badge">Guide</span>
          </div>
          <p>
            Replay the initial onboarding wizard to change your protection profile, starter feeds, and setup.
          </p>
          <div style={{ marginTop: '14px' }}>
            <button
              type="button"
              className="primary-button"
              onClick={onLaunchOnboarding}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
            >
              <span>Launch Onboarding Tour</span>
              <span style={{ fontSize: '13px' }}>→</span>
            </button>
          </div>
        </div>

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

          {/* Accent Color Palette Customizer */}
          <div className="accent-palette-section">
            <h4 className="accent-palette-title">Accent Color Palette</h4>
            <p className="accent-palette-subtitle">
              Choose an accent tint to customize highlights, active controls, and focus glows.
            </p>
            <div className="accent-palette-grid">
              {ACCENT_PALETTE.map((accent) => (
                <button
                  key={accent.id}
                  className={`accent-color-swatch ${accentColor === accent.id ? 'selected' : ''}`}
                  onClick={() => handleAccentChange(accent.id)}
                  title={accent.name}
                  type="button"
                >
                  <span
                    className="accent-swatch-circle"
                    style={{ backgroundColor: accent.primary }}
                  />
                  <span className="accent-swatch-name">{accent.name}</span>
                </button>
              ))}
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

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px', marginTop: '14px' }}>
            {/* Pi-hole Section */}
            <div style={{ background: 'var(--bg-tertiary, rgba(255,255,255,0.03))', padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color, rgba(255,255,255,0.06))' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                    <rect x="9" y="9" width="6" height="6" />
                    <line x1="9" y1="1" x2="9" y2="4" />
                    <line x1="15" y1="1" x2="15" y2="4" />
                    <line x1="9" y1="20" x2="9" y2="23" />
                    <line x1="15" y1="20" x2="15" y2="23" />
                    <line x1="20" y1="9" x2="23" y2="9" />
                    <line x1="20" y1="14" x2="23" y2="14" />
                    <line x1="1" y1="9" x2="4" y2="9" />
                    <line x1="1" y1="14" x2="4" y2="14" />
                  </svg>
                  <span>Pi-hole Integration</span>
                </div>
                <button
                  type="button"
                  className="browse-button secondary"
                  style={{ padding: '4px 10px', fontSize: '0.75rem', height: '28px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                  onClick={() => handleTestService('pihole')}
                  disabled={testingService === 'pihole'}
                >
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  <span>{testingService === 'pihole' ? 'Testing…' : 'Test Connection'}</span>
                </button>
              </div>

              {/* Pi-hole Presets */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>Presets:</span>
                <button
                  type="button"
                  style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                  onClick={() => setSinkholeConfig({ ...sinkholeConfig, piholeUrl: 'http://pi.hole/admin/api.php' })}
                >
                  pi.hole
                </button>
                <button
                  type="button"
                  style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                  onClick={() => setSinkholeConfig({ ...sinkholeConfig, piholeUrl: 'http://homeassistant.local:8080/admin/api.php' })}
                >
                  HA Add-on (8080)
                </button>
                <button
                  type="button"
                  style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                  onClick={() => setSinkholeConfig({ ...sinkholeConfig, piholeUrl: 'http://localhost/admin/api.php' })}
                >
                  Docker (Port 80)
                </button>
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <label style={{ fontSize: '0.75rem', opacity: 0.8 }}>Auth API Token</label>
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: 'inherit', opacity: 0.6, fontSize: '0.7rem', cursor: 'pointer', padding: 0 }}
                    onClick={() => setShowPiholeKey(!showPiholeKey)}
                  >
                    {showPiholeKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <input
                  type={showPiholeKey ? 'text' : 'password'}
                  className="path-input"
                  style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                  placeholder="Pi-hole web password hash"
                  value={sinkholeConfig.piholeApiKey}
                  onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, piholeApiKey: e.target.value })}
                />
              </div>

              {testResults['pihole'] && (
                <div style={{ marginTop: '8px', padding: '8px', borderRadius: '6px', fontSize: '0.75rem', background: testResults['pihole'].success ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: testResults['pihole'].success ? '#10b981' : '#ef4444' }}>
                  <div><strong>{testResults['pihole'].success ? '✓' : '✗'} {testResults['pihole'].message}</strong></div>
                  {testResults['pihole'].details && <div style={{ marginTop: '4px', opacity: 0.85, fontSize: '0.7rem' }}>{testResults['pihole'].details}</div>}
                </div>
              )}
            </div>

            {/* AdGuard Home Section */}
            <div style={{ background: 'var(--bg-tertiary, rgba(255,255,255,0.03))', padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color, rgba(255,255,255,0.06))' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div style={{ fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                  <span>AdGuard Home Integration</span>
                </div>
                <button
                  type="button"
                  className="browse-button secondary"
                  style={{ padding: '4px 10px', fontSize: '0.75rem', height: '28px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                  onClick={() => handleTestService('adguard')}
                  disabled={testingService === 'adguard'}
                >
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  <span>{testingService === 'adguard' ? 'Testing…' : 'Test Connection'}</span>
                </button>
              </div>

              {/* Mode Selector */}
              <div style={{ marginBottom: '10px' }}>
                <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Integration Method</label>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`env-pill-btn ${(!sinkholeConfig.adguardMode || sinkholeConfig.adguardMode === 'direct') ? 'active' : ''}`}
                    style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                    onClick={() => setSinkholeConfig({ ...sinkholeConfig, adguardMode: 'direct' })}
                  >
                    Direct (Port 3000)
                  </button>
                  <button
                    type="button"
                    className={`env-pill-btn ${sinkholeConfig.adguardMode === 'ha-api' ? 'active' : ''}`}
                    style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                    onClick={() => setSinkholeConfig({ ...sinkholeConfig, adguardMode: 'ha-api' })}
                  >
                    HA API (Port 8123)
                  </button>
                  <button
                    type="button"
                    className={`env-pill-btn ${sinkholeConfig.adguardMode === 'webhook' ? 'active' : ''}`}
                    style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                    onClick={() => setSinkholeConfig({ ...sinkholeConfig, adguardMode: 'webhook' })}
                  >
                    HA Webhook
                  </button>
                </div>
              </div>

              {/* Quick Presets Row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>Presets:</span>
                <button
                  type="button"
                  style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                  onClick={() => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: 'http://homeassistant.local:3000', adguardMode: 'direct' })}
                >
                  HA Port 3000
                </button>
                <button
                  type="button"
                  style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                  onClick={() => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: 'http://homeassistant.local:8123', adguardMode: 'ha-api' })}
                >
                  HA Port 8123 API
                </button>
                <button
                  type="button"
                  style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                  onClick={() => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: 'http://localhost:3000', adguardMode: 'direct' })}
                >
                  Docker 3000
                </button>
                <button
                  type="button"
                  style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                  onClick={() => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: 'http://192.168.8.1:3000', adguardMode: 'direct' })}
                >
                  GL.iNet 3000
                </button>
                <button
                  type="button"
                  style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: 'https://your-instance.ui.nabu.casa', adguardMode: 'ha-api' })}
                >
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                  </svg>
                  <span>Nabu Casa Cloud</span>
                </button>
                <button
                  type="button"
                  style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => setSinkholeConfig({ ...sinkholeConfig, haWebhookUrl: 'https://hooks.nabu.casa/...', adguardMode: 'webhook' })}
                >
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                  </svg>
                  <span>Nabu Casa Webhook</span>
                </button>
              </div>

              {/* Direct Mode Fields */}
              {(!sinkholeConfig.adguardMode || sinkholeConfig.adguardMode === 'direct') && (
                <>
                  <div style={{ marginBottom: '10px' }}>
                    <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Instance URL (AdGuard Port 3000)</label>
                    <input
                      type="text"
                      className="path-input"
                      style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                      placeholder="http://homeassistant.local:3000 or http://192.168.1.1:3000"
                      value={sinkholeConfig.adguardHomeUrl}
                      onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: e.target.value })}
                    />
                    {sinkholeConfig.adguardHomeUrl?.includes(':8123') && (
                      <div style={{ marginTop: '6px', padding: '6px 8px', background: 'rgba(245, 158, 11, 0.15)', border: '1px solid rgba(245, 158, 11, 0.3)', borderRadius: '6px', fontSize: '0.72rem', color: '#f59e0b', display: 'flex', alignItems: 'flex-start', gap: '5px' }}>
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: '2px' }}>
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                          <line x1="12" y1="9" x2="12" y2="13" />
                          <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <span>Port 8123 is Home Assistant&rsquo;s frontend. For direct AdGuard API, expose and use port 3000 in Add-on Network settings, or switch to &quot;HA API&quot; mode above.</span>
                      </div>
                    )}
                    {sinkholeConfig.adguardHomeUrl?.includes('nabu.casa') && (
                      <div style={{ marginTop: '6px', padding: '6px 8px', background: 'rgba(245, 158, 11, 0.15)', border: '1px solid rgba(245, 158, 11, 0.3)', borderRadius: '6px', fontSize: '0.72rem', color: '#f59e0b', display: 'flex', alignItems: 'flex-start', gap: '5px' }}>
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: '2px' }}>
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                          <line x1="12" y1="9" x2="12" y2="13" />
                          <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <span>Nabu Casa does not proxy AdGuard direct port 3000. Switch mode to &quot;HA API&quot; or &quot;HA Webhook&quot; above to reload AdGuard over Nabu Casa remotely.</span>
                      </div>
                    )}
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
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <label style={{ fontSize: '0.75rem', opacity: 0.8 }}>Password</label>
                        <button
                          type="button"
                          style={{ background: 'none', border: 'none', color: 'inherit', opacity: 0.6, fontSize: '0.7rem', cursor: 'pointer', padding: 0 }}
                          onClick={() => setShowAdguardPass(!showAdguardPass)}
                        >
                          {showAdguardPass ? 'Hide' : 'Show'}
                        </button>
                      </div>
                      <input
                        type={showAdguardPass ? 'text' : 'password'}
                        className="path-input"
                        style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                        placeholder="••••••••"
                        value={sinkholeConfig.adguardHomePassword}
                        onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomePassword: e.target.value })}
                      />
                    </div>
                  </div>
                </>
              )}

              {/* Home Assistant REST API Mode Fields */}
              {sinkholeConfig.adguardMode === 'ha-api' && (
                <>
                  <div style={{ marginBottom: '10px' }}>
                    <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Home Assistant URL (Port 8123 / Nabu Casa)</label>
                    <input
                      type="text"
                      className="path-input"
                      style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                      placeholder="http://homeassistant.local:8123 or https://your-instance.ui.nabu.casa"
                      value={sinkholeConfig.adguardHomeUrl}
                      onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: e.target.value })}
                    />
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <label style={{ fontSize: '0.75rem', opacity: 0.8 }}>Long-Lived Access Token</label>
                      <button
                        type="button"
                        style={{ background: 'none', border: 'none', color: 'inherit', opacity: 0.6, fontSize: '0.7rem', cursor: 'pointer', padding: 0 }}
                        onClick={() => setShowHaToken(!showHaToken)}
                      >
                        {showHaToken ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <input
                      type={showHaToken ? 'text' : 'password'}
                      className="path-input"
                      style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                      placeholder="eyJhbGciOi..."
                      value={sinkholeConfig.haToken || ''}
                      onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, haToken: e.target.value })}
                    />
                    <p style={{ fontSize: '0.7rem', opacity: 0.6, marginTop: '4px', marginBottom: 0 }}>
                      Generate in HA: Profile → Security → Long-Lived Access Tokens. Calls service <code>adguard.refresh</code>. (Works with local port 8123 or Nabu Casa Cloud).
                    </p>
                  </div>
                </>
              )}

              {/* Home Assistant Automation Webhook Mode Fields */}
              {sinkholeConfig.adguardMode === 'webhook' && (
                <div>
                  <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Home Assistant Webhook URL (Local / Nabu Casa)</label>
                  <input
                    type="text"
                    className="path-input"
                    style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                    placeholder="http://homeassistant.local:8123/api/webhook/... or https://hooks.nabu.casa/..."
                    value={sinkholeConfig.haWebhookUrl || ''}
                    onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, haWebhookUrl: e.target.value })}
                  />
                  <p style={{ fontSize: '0.7rem', opacity: 0.6, marginTop: '4px', marginBottom: 0 }}>
                    Triggered without credentials. Set an Automation in HA with a Webhook Trigger (local or Nabu Casa Cloud Webhook) calling the action <code>adguard.refresh</code>.
                  </p>
                </div>
              )}

              {testResults['adguard'] && (
                <div style={{ marginTop: '8px', padding: '8px', borderRadius: '6px', fontSize: '0.75rem', background: testResults['adguard'].success ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: testResults['adguard'].success ? '#10b981' : '#ef4444' }}>
                  <div><strong>{testResults['adguard'].success ? '✓' : '✗'} {testResults['adguard'].message}</strong></div>
                  {testResults['adguard'].details && <div style={{ marginTop: '4px', opacity: 0.85, fontSize: '0.7rem' }}>{testResults['adguard'].details}</div>}
                </div>
              )}
            </div>
          </div>

          {/* Homelab & Custom Webhook Endpoint ("Or Any Other Thing") */}
          <div style={{ marginTop: '14px', background: 'var(--bg-tertiary, rgba(255,255,255,0.03))', padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color, rgba(255,255,255,0.06))' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                <span>Homelab &amp; Custom Automation Webhook (&quot;Or Any Other Thing&quot;)</span>
              </div>
              <button
                type="button"
                className="browse-button secondary"
                style={{ padding: '4px 10px', fontSize: '0.75rem', height: '28px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                onClick={() => handleTestService('webhook')}
                disabled={testingService === 'webhook'}
              >
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                <span>{testingService === 'webhook' ? 'Testing…' : 'Test Webhook'}</span>
              </button>
            </div>
            <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '8px' }}>
              For Technitium DNS, pfSense, OPNsense, Blocky, Node-RED, or n8n: sends an HTTP POST event with compilation statistics whenever blocklists update.
            </p>
            <input
              type="text"
              className="path-input"
              style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
              placeholder="http://technitium.lan:5380/api/reload or http://pfsense.lan/api/hook"
              value={sinkholeConfig.customWebhookUrl || ''}
              onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, customWebhookUrl: e.target.value })}
            />
            {testResults['webhook'] && (
              <div style={{ marginTop: '8px', padding: '8px', borderRadius: '6px', fontSize: '0.75rem', background: testResults['webhook'].success ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: testResults['webhook'].success ? '#10b981' : '#ef4444' }}>
                <div><strong>{testResults['webhook'].success ? '✓' : '✗'} {testResults['webhook'].message}</strong></div>
                {testResults['webhook'].details && <div style={{ marginTop: '4px', opacity: 0.85, fontSize: '0.7rem' }}>{testResults['webhook'].details}</div>}
              </div>
            )}
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

        {/* AI & Threat Intelligence Engine Card */}
        <div className="setting-card">
          <div className="setting-card-header">
            <h3>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
                </svg>
              </span>
              AI & Threat Intelligence Engine
            </h3>
            <span className="setting-badge primary">Intelligence</span>
          </div>
          <p>
            Configure on-device neural classification, local LLMs, or cloud AI providers to detect algorithmic ad trackers, cloaked CNAMEs, and anomalous queries.
          </p>

          {/* Provider Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px', marginTop: '14px', marginBottom: '14px' }}>
            <button
              type="button"
              className={`provider-option-btn ${aiConfig.provider === 'mini-ai' ? 'active' : ''}`}
              onClick={() => setAiConfig({ ...aiConfig, provider: 'mini-ai' })}
              style={{ position: 'relative' }}
            >
              <span style={{ position: 'absolute', top: 8, right: 8, fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#10b981', color: '#fff', fontWeight: 700 }}>RECOMMENDED</span>
              <span className="opt-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <rect x="9" y="9" width="6" height="6" />
                  <line x1="9" y1="2" x2="9" y2="4" />
                  <line x1="15" y1="2" x2="15" y2="4" />
                  <line x1="9" y1="20" x2="9" y2="22" />
                  <line x1="15" y1="20" x2="15" y2="22" />
                  <line x1="2" y1="9" x2="4" y2="9" />
                  <line x1="2" y1="14" x2="4" y2="14" />
                  <line x1="20" y1="9" x2="22" y2="9" />
                  <line x1="20" y1="14" x2="22" y2="14" />
                </svg>
                <span>Mini-AI Classifier (Built-in)</span>
              </span>
              <span className="opt-desc">Embedded 25-feature mathematical neural network. &lt;0.05ms execution, zero daemons, zero network calls.</span>
            </button>

            <button
              type="button"
              className={`provider-option-btn ${aiConfig.provider === 'local-heuristics' ? 'active' : ''}`}
              onClick={() => setAiConfig({ ...aiConfig, provider: 'local-heuristics' })}
            >
              <span className="opt-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                <span>Local Heuristics</span>
              </span>
              <span className="opt-desc">Shannon entropy, lexical token boundaries, and CNAME uncloaking. 0ms latency, pure offline math.</span>
            </button>

            <button
              type="button"
              className={`provider-option-btn ${aiConfig.provider === 'ollama' ? 'active' : ''}`}
              onClick={() => setAiConfig({ ...aiConfig, provider: 'ollama' })}
            >
              <span className="opt-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                  <line x1="6" y1="6" x2="6.01" y2="6" />
                  <line x1="6" y1="18" x2="6.01" y2="18" />
                </svg>
                <span>Ollama Local LLM</span>
              </span>
              <span className="opt-desc">Private on-device large language model (e.g. llama3.2). Highly accurate reasoning without cloud telemetry.</span>
            </button>

            <button
              type="button"
              className={`provider-option-btn ${aiConfig.provider === 'gemini' ? 'active' : ''}`}
              onClick={() => setAiConfig({ ...aiConfig, provider: 'gemini' })}
            >
              <span className="opt-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                <span>Google Gemini Flash</span>
              </span>
              <span className="opt-desc">Gemini 2.0 Flash reasoning for deep pattern synthesis and evasive ad script detection.</span>
            </button>

            <button
              type="button"
              className={`provider-option-btn ${aiConfig.provider === 'openai' ? 'active' : ''}`}
              onClick={() => setAiConfig({ ...aiConfig, provider: 'openai' })}
            >
              <span className="opt-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                <span>OpenAI / Compatible</span>
              </span>
              <span className="opt-desc">OpenAI, Groq, LM Studio, Mistral, or any standard OpenAI-compatible API endpoint.</span>
            </button>
          </div>

          {/* Subform for selected provider */}
          <div style={{ background: 'var(--bg-tertiary, rgba(255,255,255,0.03))', padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color, rgba(255,255,255,0.06))', marginBottom: '14px' }}>
            {aiConfig.provider === 'mini-ai' && (
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary, #fff)', marginBottom: '4px' }}>
                  Built-in Embedded Mini-AI Active
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary, #9ca3af)', margin: '0 0 10px 0', lineHeight: 1.4 }}>
                  The Mini-AI classifier extracts 25 domain features (Shannon entropy, consonant clustering, hex string density, brand squatting, vowel ratios) directly on your device without sending any data over the network.
                </p>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--bg-secondary, rgba(255,255,255,0.04))', borderRadius: '6px', border: '1px solid var(--border-color, rgba(255,255,255,0.08))' }}>
                  <span style={{ fontSize: '0.78rem' }}>
                    Learned Feedback Corrections: <strong>{learnedFeedbackCount}</strong> {learnedFeedbackCount === 1 ? 'entry' : 'entries'} stored
                  </span>
                  {learnedFeedbackCount > 0 && (
                    <button
                      type="button"
                      className="browse-button secondary"
                      style={{ padding: '3px 8px', fontSize: '0.72rem', height: '24px' }}
                      onClick={handleResetAiFeedback}
                    >
                      Reset Learned Memory
                    </button>
                  )}
                </div>
              </div>
            )}

            {aiConfig.provider === 'local-heuristics' && (
              <div>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary, #fff)', marginBottom: '4px' }}>
                  Mathematical Heuristics Engine Active
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary, #9ca3af)', margin: 0, lineHeight: 1.4 }}>
                  Evaluates target domains using algorithmic Shannon entropy analysis, subdomain depth thresholds, top-level domain risk scoring, and asynchronous CNAME resolution.
                </p>
              </div>
            )}

            {aiConfig.provider === 'ollama' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>Model Presets:</span>
                  {['llama3.2', 'mistral', 'qwen2.5', 'deepseek-r1'].map((m) => (
                    <button
                      key={m}
                      type="button"
                      style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                      onClick={() => setAiConfig({ ...aiConfig, ollamaModel: m })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Ollama Host URL</label>
                    <input
                      type="text"
                      className="path-input"
                      style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                      value={aiConfig.ollamaUrl || 'http://127.0.0.1:11434'}
                      onChange={(e) => setAiConfig({ ...aiConfig, ollamaUrl: e.target.value })}
                      placeholder="http://127.0.0.1:11434"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Model Name</label>
                    <input
                      type="text"
                      className="path-input"
                      style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                      value={aiConfig.ollamaModel || 'llama3.2'}
                      onChange={(e) => setAiConfig({ ...aiConfig, ollamaModel: e.target.value })}
                      placeholder="llama3.2"
                    />
                  </div>
                </div>
              </div>
            )}

            {aiConfig.provider === 'gemini' && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <label style={{ fontSize: '0.75rem', opacity: 0.8 }}>Google Gemini API Key</label>
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: 'inherit', opacity: 0.6, fontSize: '0.7rem', cursor: 'pointer', padding: 0 }}
                    onClick={() => setShowAiKey(!showAiKey)}
                  >
                    {showAiKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <input
                  type={showAiKey ? 'text' : 'password'}
                  className="path-input"
                  style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                  value={aiConfig.apiKey || ''}
                  onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })}
                  placeholder="AIzaSy..."
                />
              </div>
            )}

            {aiConfig.provider === 'openai' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>Presets:</span>
                  <button
                    type="button"
                    style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                    onClick={() => setAiConfig({ ...aiConfig, apiEndpoint: 'https://api.openai.com/v1', modelName: 'gpt-4o-mini' })}
                  >
                    OpenAI (gpt-4o-mini)
                  </button>
                  <button
                    type="button"
                    style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                    onClick={() => setAiConfig({ ...aiConfig, apiEndpoint: 'https://api.groq.com/openai/v1', modelName: 'llama-3.3-70b-versatile' })}
                  >
                    Groq (Llama 3.3 70B)
                  </button>
                  <button
                    type="button"
                    style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                    onClick={() => setAiConfig({ ...aiConfig, apiEndpoint: 'http://localhost:1234/v1', modelName: 'local-model' })}
                  >
                    LM Studio (Local 1234)
                  </button>
                  <button
                    type="button"
                    style={{ background: 'var(--bg-secondary, rgba(255,255,255,0.06))', border: '1px solid var(--border-color, rgba(255,255,255,0.1))', borderRadius: '4px', color: 'inherit', fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                    onClick={() => setAiConfig({ ...aiConfig, apiEndpoint: 'https://openrouter.ai/api/v1', modelName: 'meta-llama/llama-3.2-3b-instruct' })}
                  >
                    OpenRouter
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '12px', marginBottom: '10px' }}>
                  <div>
                    <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>API Endpoint URL</label>
                    <input
                      type="text"
                      className="path-input"
                      style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                      value={aiConfig.apiEndpoint || 'https://api.openai.com/v1'}
                      onChange={(e) => setAiConfig({ ...aiConfig, apiEndpoint: e.target.value })}
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Model Name</label>
                    <input
                      type="text"
                      className="path-input"
                      style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                      value={aiConfig.modelName || 'gpt-4o-mini'}
                      onChange={(e) => setAiConfig({ ...aiConfig, modelName: e.target.value })}
                      placeholder="gpt-4o-mini"
                    />
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <label style={{ fontSize: '0.75rem', opacity: 0.8 }}>API Key</label>
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: 'inherit', opacity: 0.6, fontSize: '0.7rem', cursor: 'pointer', padding: 0 }}
                      onClick={() => setShowAiKey(!showAiKey)}
                    >
                      {showAiKey ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <input
                    type={showAiKey ? 'text' : 'password'}
                    className="path-input"
                    style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                    value={aiConfig.apiKey || ''}
                    onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })}
                    placeholder="sk-..."
                  />
                </div>
              </div>
            )}

            {aiTestResult && (
              <div style={{ marginTop: '10px', padding: '8px 10px', borderRadius: '6px', fontSize: '0.75rem', background: aiTestResult.success ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: aiTestResult.success ? '#10b981' : '#ef4444' }}>
                <strong>{aiTestResult.success ? '✓' : '✗'} {aiTestResult.message}</strong> {aiTestResult.latencyMs ? `(${aiTestResult.latencyMs}ms)` : ''}
              </div>
            )}
          </div>

          {/* Sentinel Watchdog Automation */}
          <div style={{ background: 'var(--bg-tertiary, rgba(255,255,255,0.03))', padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color, rgba(255,255,255,0.06))', marginBottom: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span>Sentinel Watchdog (Background Threat Sweep)</span>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.78rem' }}>
                <input
                  type="checkbox"
                  checked={watchdogConfig.enabled}
                  onChange={(e) => setWatchdogConfig({ ...watchdogConfig, enabled: e.target.checked })}
                />
                <span>Enable Watchdog</span>
              </label>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #9ca3af)', margin: '0 0 10px 0', lineHeight: 1.4 }}>
              Periodically queries your local sinkhole query logs in the background, flags emerging ad/tracker hostnames with the selected AI engine, and records them in the Quarantine Ledger.
            </p>

            {watchdogConfig.enabled && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Sweep Interval</label>
                  <select
                    className="styled-select"
                    style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                    value={watchdogConfig.intervalMinutes}
                    onChange={(e) => setWatchdogConfig({ ...watchdogConfig, intervalMinutes: parseInt(e.target.value, 10) || 60 })}
                  >
                    <option value={15}>Every 15 Minutes</option>
                    <option value={30}>Every 30 Minutes</option>
                    <option value={60}>Every 1 Hour</option>
                    <option value={120}>Every 2 Hours</option>
                    <option value={360}>Every 6 Hours</option>
                    <option value={720}>Every 12 Hours</option>
                    <option value={1440}>Every 24 Hours</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: '0.75rem', opacity: 0.8, display: 'block', marginBottom: '4px' }}>Sinkhole Query Target</label>
                  <select
                    className="styled-select"
                    style={{ width: '100%', height: '34px', fontSize: '0.8rem' }}
                    value={watchdogConfig.service}
                    onChange={(e) => setWatchdogConfig({ ...watchdogConfig, service: e.target.value as 'adguard' | 'pihole' })}
                  >
                    <option value="adguard">AdGuard Home</option>
                    <option value="pihole">Pi-hole</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* Action Footer */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
            <button
              type="button"
              className="browse-button secondary"
              onClick={handleTestAiConnection}
              disabled={isTestingAi}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
              <span>{isTestingAi ? 'Testing Connection...' : 'Test AI Connection'}</span>
            </button>

            <button
              type="button"
              className="browse-button"
              onClick={handleSaveAiSettings}
              disabled={isSavingAi}
            >
              {isSavingAi ? 'Saving...' : 'Save AI Settings'}
            </button>
          </div>

          {aiMessage.text && (
            <p className={`setting-message ${aiMessage.type}`} style={{ marginTop: '10px' }}>
              {aiMessage.text}
            </p>
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
            <span className="setting-badge secondary">v1.0.0-rc.1</span>
          </div>

          <div className="about-app-banner">
            <div className="about-app-icon">
              <BrandLogo size={36} glow />
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
