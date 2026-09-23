import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { FilterFormat, FeedServerStatus, SinkholeTestResult, SinkholeConfig } from '../types/';
import { ServiceMismatchBanner } from '../components/ServiceMismatchBanner';
import { isServiceMismatch } from '../sinkholeIdentity';
import { separateAdguardUrls } from '../queryLogScout';
import {
  DEFAULT_ADGUARD_DIRECT_PORT,
  directModeWarning,
  localTlsBypassNote,
  normalizeAdguardDirectPort,
  replaceMatchingExplicitPort,
  resolveAdguardDirectUrl,
} from '../sinkholeNet';

interface DeployHubViewProps {
  savePath: string;
  onNavigateSettings?: () => void;
  onTriggerCompile?: () => void;
}

type PlatformTab = 'adguard-home' | 'pihole' | 'adguard-desktop' | 'hosts' | 'dnsmasq';

export const DeployHubView: React.FC<DeployHubViewProps> = ({
  savePath,
  onNavigateSettings,
  onTriggerCompile,
}) => {
  const isMountedRef = useRef(true);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const directPortFocusRef = useRef(DEFAULT_ADGUARD_DIRECT_PORT);

  const safeSetTimeout = useCallback((fn: () => void, delayMs: number) => {
    const id = setTimeout(() => {
      if (isMountedRef.current) {
        fn();
      }
    }, delayMs);
    timersRef.current.push(id);
    return id;
  }, []);

  const [activeTab, setActiveTab] = useState<PlatformTab>('adguard-home');
  const [exportFormat, setExportFormat] = useState<FilterFormat>('adguard');
  const [serverStatus, setServerStatus] = useState<FeedServerStatus | null>(null);
  const [isServerLoading, setIsServerLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [lastProcessTime, setLastProcessTime] = useState<string | null>(null);
  const [uniqueRulesCount, setUniqueRulesCount] = useState<number | null>(null);

  // Connection tester states
  const [testingService, setTestingService] = useState<'pihole' | 'adguard' | 'webhook' | null>(null);
  const [testResult, setTestResult] = useState<SinkholeTestResult | null>(null);

  // Environment presets
  const [adguardEnv, setAdguardEnv] = useState<'homeassistant' | 'docker' | 'router' | 'standalone'>('homeassistant');
  const [showHaToken, setShowHaToken] = useState(false);
  const [customWebhookUrl, setCustomWebhookUrl] = useState('');

  // Sinkhole live sync configuration & monitoring
  const [sinkholeConfig, setSinkholeConfig] = useState<SinkholeConfig>({
    piholeUrl: '',
    piholeApiKey: '',
    adguardHomeUrl: '',
    adguardHomeUser: '',
    adguardHomePassword: '',
    syncOnCompile: false,
    adguardMode: 'direct',
    adguardDirectPort: DEFAULT_ADGUARD_DIRECT_PORT,
    adguardDirectUrl: '',
    allowInsecureLocalTls: false,
    haToken: '',
    haWebhookUrl: '',
    customWebhookUrl: '',
  });
  const [isSavingSinkhole, setIsSavingSinkhole] = useState(false);
  const [isSyncingSinkhole, setIsSyncingSinkhole] = useState(false);
  const [sinkholeMessage, setSinkholeMessage] = useState<string | null>(null);
  const [lastSyncResult, setLastSyncResult] = useState<{
    service: string;
    status: 'success' | 'error' | 'skipped';
    message: string;
    details?: string;
    timestamp?: string;
  } | null>(null);
  const [showAdguardPass, setShowAdguardPass] = useState(false);
  const [showPiholeKey, setShowPiholeKey] = useState(false);

  // Load configuration & server status on mount
  useEffect(() => {
    isMountedRef.current = true;

    if (window.electron?.getExportFormat) {
      window.electron.getExportFormat().then((fmt) => {
        if (isMountedRef.current && fmt) setExportFormat(fmt);
      });
    }

    if (window.electron?.getFeedServerStatus) {
      window.electron.getFeedServerStatus().then((status) => {
        if (isMountedRef.current) setServerStatus(status);
      });
    }

    if (window.electron?.getLastProcessTime) {
      window.electron.getLastProcessTime().then((time) => {
        if (isMountedRef.current) setLastProcessTime(time);
      });
    }

    if (window.electron?.getCompiledRules) {
      window.electron.getCompiledRules({ limit: 1 }).then((res) => {
        if (isMountedRef.current && res?.total) setUniqueRulesCount(res.total);
      });
    }

    if (window.electron?.getSinkholeConfig) {
      window.electron.getSinkholeConfig().then((cfg) => {
        if (isMountedRef.current && cfg) {
          setSinkholeConfig({
            ...cfg,
            adguardMode: cfg.adguardMode || 'direct',
            adguardDirectPort: normalizeAdguardDirectPort(cfg.adguardDirectPort),
            allowInsecureLocalTls: Boolean(cfg.allowInsecureLocalTls),
            adguardDirectUrl: cfg.adguardDirectUrl || '',
            haToken: cfg.haToken || '',
            haWebhookUrl: cfg.haWebhookUrl || '',
            customWebhookUrl: cfg.customWebhookUrl || '',
          });
          if (cfg.customWebhookUrl) {
            setCustomWebhookUrl(cfg.customWebhookUrl);
          }
          if (cfg.adguardMode === 'ha-api' || cfg.adguardHomeUrl?.includes('homeassistant')) {
            setAdguardEnv('homeassistant');
          }
        }
      });
    }

    return () => {
      isMountedRef.current = false;
      for (const t of timersRef.current) {
        clearTimeout(t);
      }
      timersRef.current = [];
    };
  }, []);

  const handleCopy = useCallback((text: string, key: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      if (isMountedRef.current) {
        setCopiedKey(key);
        safeSetTimeout(() => setCopiedKey(null), 2400);
      }
    }
  }, [safeSetTimeout]);

  const handleToggleFeedServer = async () => {
    if (!window.electron) return;
    setIsServerLoading(true);
    try {
      if (serverStatus?.isRunning) {
        const updated = await window.electron.stopFeedServer();
        setServerStatus(updated);
      } else {
        const updated = await window.electron.startFeedServer(9191);
        setServerStatus(updated);
      }
    } catch (err) {
      console.error('Failed to toggle feed server:', err);
    } finally {
      setIsServerLoading(false);
    }
  };

  const handleTestConnection = async (service: 'pihole' | 'adguard' | 'webhook') => {
    if (!window.electron?.testSinkholeConnection) return;
    setTestingService(service);
    setTestResult(null);
    try {
      if (window.electron?.setSinkholeConfig) {
        await window.electron.setSinkholeConfig({
          ...sinkholeConfig,
          customWebhookUrl,
        });
      }
      const res = await window.electron.testSinkholeConnection(service);
      setTestResult(res);
    } catch (err: any) {
      setTestResult({
        service,
        success: false,
        message: err?.message || 'Connection test failed',
      });
    } finally {
      setTestingService(null);
    }
  };

  const handleToggleSyncOnCompile = async (enabled: boolean) => {
    const updated = { ...sinkholeConfig, syncOnCompile: enabled };
    setSinkholeConfig(updated);
    if (window.electron?.setSinkholeConfig) {
      try {
        await window.electron.setSinkholeConfig(updated);
        if (isMountedRef.current) {
          setSinkholeMessage(enabled ? '✓ Auto-push on compile enabled' : 'Auto-push disabled');
          safeSetTimeout(() => setSinkholeMessage(null), 3000);
        }
      } catch (err: any) {
        console.error('Failed to update sync on compile:', err);
      }
    }
  };

  const handleSaveSinkholeConfig = async (service: 'adguard' | 'pihole') => {
    if (!window.electron?.setSinkholeConfig) return;
    setIsSavingSinkhole(true);
    setSinkholeMessage(null);
    try {
      await window.electron.setSinkholeConfig(sinkholeConfig);
      if (isMountedRef.current) {
        setSinkholeMessage('✓ Connection settings saved successfully!');
        safeSetTimeout(() => setSinkholeMessage(null), 3500);
      }

      // Trigger instant connection test to confirm credentials work
      handleTestConnection(service);
    } catch (err: any) {
      if (isMountedRef.current) {
        setSinkholeMessage(`Failed to save: ${err?.message || err}`);
        safeSetTimeout(() => setSinkholeMessage(null), 4000);
      }
    } finally {
      if (isMountedRef.current) {
        setIsSavingSinkhole(false);
      }
    }
  };

  const handleTriggerLiveSync = async (service: 'adguard' | 'pihole') => {
    if (!window.electron?.syncSinkholes) return;
    setIsSyncingSinkhole(true);
    setSinkholeMessage(null);
    try {
      await window.electron.setSinkholeConfig(sinkholeConfig);
      const res = await window.electron.syncSinkholes();
      const match = res.results?.find((r: any) =>
        service === 'adguard'
          ? r.service.toLowerCase().includes('adguard')
          : r.service.toLowerCase().includes('pi-hole')
      );
      if (match) {
        setLastSyncResult({
          ...match,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
        });
      }
    } catch (err: any) {
      setLastSyncResult({
        service: service === 'adguard' ? 'AdGuard Home' : 'Pi-hole',
        status: 'error',
        message: err?.message || 'Sync failed',
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      });
    } finally {
      setIsSyncingSinkhole(false);
    }
  };

  const selectAdguardMode = (mode: 'direct' | 'ha-api' | 'webhook', patch: Partial<SinkholeConfig> = {}) => {
    const separated = separateAdguardUrls(sinkholeConfig, { ...patch, adguardMode: mode });
    setSinkholeConfig({
      ...sinkholeConfig,
      ...patch,
      adguardMode: mode,
      adguardDirectUrl: patch.adguardDirectUrl ?? separated.adguardDirectUrl ?? sinkholeConfig.adguardDirectUrl ?? '',
    });
  };

  const applyDetectedMode = async (mode: 'direct' | 'ha-api') => {
    const separated = separateAdguardUrls(sinkholeConfig, { adguardMode: mode });
    const updated = {
      ...sinkholeConfig,
      adguardMode: mode,
      adguardDirectUrl: separated.adguardDirectUrl ?? sinkholeConfig.adguardDirectUrl ?? '',
    };
    setSinkholeConfig(updated);
    setTestResult(null);
    setLastSyncResult(null);
    if (window.electron?.setSinkholeConfig) {
      try {
        await window.electron.setSinkholeConfig(updated);
        setSinkholeMessage(
          mode === 'direct'
            ? 'Switched to Direct AdGuard. The address is unchanged. Use AdGuard credentials — a Home Assistant token is not required in this mode.'
            : 'Switched to Home Assistant REST API. The address is unchanged.',
        );
        safeSetTimeout(() => setSinkholeMessage(null), 5000);
      } catch (err) {
        console.error('Failed to switch AdGuard mode:', err);
      }
    }
  };

  const directPort = normalizeAdguardDirectPort(sinkholeConfig.adguardDirectPort);
  const directWarning = directModeWarning(sinkholeConfig.adguardHomeUrl || '', directPort);
  const activeTlsUrl = sinkholeConfig.adguardMode === 'webhook'
    ? (sinkholeConfig.haWebhookUrl || '')
    : (sinkholeConfig.adguardHomeUrl || '');
  const tlsScopeNote = localTlsBypassNote(activeTlsUrl, Boolean(sinkholeConfig.allowInsecureLocalTls));
  const directEndpointLabel = (() => {
    if (!sinkholeConfig.adguardHomeUrl) return 'Not Configured';
    const resolved = resolveAdguardDirectUrl(sinkholeConfig.adguardHomeUrl, directPort);
    return resolved.ok ? resolved.target.display : sinkholeConfig.adguardHomeUrl;
  })();

  const fileUrl = savePath ? `file://${savePath}` : '';
  const fileName = savePath ? savePath.split(/[/\\]/).pop() || 'rules.txt' : 'rules.txt';
  const lanFeedUrl = serverStatus?.lanUrl ? `${serverStatus.lanUrl}/${fileName}` : `http://<your-mac-ip>:9191/${fileName}`;
  const localHttpUrl = serverStatus?.localUrl ? `${serverStatus.localUrl}/${fileName}` : `http://localhost:9191/${fileName}`;

  return (
    <div className="deploy-hub-container">
      {/* Top Overview Split Grid */}
      <div className="deploy-status-grid">
        {/* Active Export File Card */}
        <div className="deploy-card export-file-card">
          <div className="deploy-card-header">
            <div className="deploy-card-title-group">
              <span className="deploy-card-icon">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <div>
                <h4 className="deploy-card-title">Compiled Target List</h4>
                <span className="deploy-card-subtitle">
                  {uniqueRulesCount ? `${uniqueRulesCount.toLocaleString()} active rules` : 'Ready to deploy'}
                  {lastProcessTime ? ` • Updated ${new Date(lastProcessTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
                </span>
              </div>
            </div>
            <span className="format-badge-pill">{exportFormat.toUpperCase()}</span>
          </div>

          <div className="file-path-display-box">
            <span className="file-path-text" title={savePath}>{savePath || 'No save path configured'}</span>
          </div>

          <div className="deploy-card-buttons">
            {onTriggerCompile && (
              <button
                className="mini-action-btn"
                onClick={onTriggerCompile}
                title="Recompile blocklists now"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                <span>Compile Rules</span>
              </button>
            )}

            <button
              className={`mini-action-btn ${copiedKey === 'local-path' ? 'copied' : ''}`}
              onClick={() => handleCopy(savePath, 'local-path')}
              title="Copy absolute filesystem path"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
              <span>{copiedKey === 'local-path' ? 'Copied Path!' : 'Copy Path'}</span>
            </button>

            <button
              className={`mini-action-btn ${copiedKey === 'file-url' ? 'copied' : ''}`}
              onClick={() => handleCopy(fileUrl, 'file-url')}
              title="Copy file:// URL format for browser/adblock subscriptions"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
              </svg>
              <span>{copiedKey === 'file-url' ? 'Copied file:// URL!' : 'Copy file:// URL'}</span>
            </button>

            {window.electron?.showItemInFolder && (
              <button
                className="mini-action-btn"
                onClick={() => window.electron.showItemInFolder(savePath)}
                title="Show in Finder / File Explorer"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                </svg>
                <span>Reveal in Finder</span>
              </button>
            )}

            {onNavigateSettings && (
              <button
                className="mini-action-btn"
                onClick={onNavigateSettings}
                title="Open Settings to adjust export formats and paths"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span>Format Settings</span>
              </button>
            )}
          </div>
        </div>

        {/* Embedded Local HTTP Feed Server Card */}
        <div className="deploy-card server-feed-card">
          <div className="deploy-card-header">
            <div className="deploy-card-title-group">
              <span className="deploy-card-icon">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 11a9 9 0 0 1 9 9" />
                  <path d="M4 4a16 16 0 0 1 16 16" />
                  <circle cx="5" cy="19" r="1" />
                </svg>
              </span>
              <div>
                <h4 className="deploy-card-title">Local Network Feed Server</h4>
                <span className="deploy-card-subtitle">
                  Serve lists directly over HTTP to devices on your LAN or Docker containers
                </span>
              </div>
            </div>

            <div className="server-toggle-wrap">
              <span className={`server-status-pill ${serverStatus?.isRunning ? 'online' : 'offline'}`}>
                {serverStatus?.isRunning ? '● LIVE ON LAN' : 'OFFLINE'}
              </span>
              <button
                className={`server-toggle-btn ${serverStatus?.isRunning ? 'active' : ''}`}
                onClick={handleToggleFeedServer}
                disabled={isServerLoading}
              >
                {isServerLoading ? '…' : serverStatus?.isRunning ? 'Stop Server' : 'Start Server'}
              </button>
            </div>
          </div>

          <div className="server-url-display-box">
            <div className="server-url-row">
              <span className="server-url-label">LAN Feed URL:</span>
              <code className="server-url-code">{lanFeedUrl}</code>
              <button
                className={`copy-icon-btn ${copiedKey === 'lan-url' ? 'copied' : ''}`}
                onClick={() => handleCopy(lanFeedUrl, 'lan-url')}
                title="Copy LAN subscription URL"
              >
                {copiedKey === 'lan-url' ? '✓' : 'Copy'}
              </button>
            </div>
            {serverStatus?.isRunning && (
              <div className="server-url-row secondary">
                <span className="server-url-label">Localhost URL:</span>
                <code className="server-url-code">{localHttpUrl}</code>
                <button
                  className={`copy-icon-btn ${copiedKey === 'local-http' ? 'copied' : ''}`}
                  onClick={() => handleCopy(localHttpUrl, 'local-http')}
                  title="Copy localhost URL"
                >
                  {copiedKey === 'local-http' ? '✓' : 'Copy'}
                </button>
              </div>
            )}
          </div>

          <p className="server-help-hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {serverStatus?.isRunning ? (
              <>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-success, #10b981)', flexShrink: 0 }}>
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                <span>Server is active on port 9191. Any device on your local Wi-Fi/Ethernet network can subscribe to this URL.</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent-primary, #6366f1)', flexShrink: 0 }}>
                  <path d="M9 18h6m-4 4h2m-1-18a7 7 0 0 0-7 7c0 3 2 5 3 6v2h8v-2c1-1 3-3 3-6a7 7 0 0 0-7-7z" />
                </svg>
                <span>Turn on this server if Pi-hole or AdGuard Home is running on a Raspberry Pi or Docker container that cannot access local files directly.</span>
              </>
            )}
          </p>
        </div>
      </div>

      {/* Platform Tabs Navigation */}
      <div className="deploy-platform-tabs" role="tablist" aria-label="Deployment Platforms">
        <button
          role="tab"
          aria-selected={activeTab === 'adguard-home'}
          className={`platform-tab-btn ${activeTab === 'adguard-home' ? 'active' : ''}`}
          onClick={() => setActiveTab('adguard-home')}
        >
          <span className="platform-tab-icon">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </span>
          <span className="platform-tab-label">AdGuard Home</span>
        </button>

        <button
          role="tab"
          aria-selected={activeTab === 'pihole'}
          className={`platform-tab-btn ${activeTab === 'pihole' ? 'active' : ''}`}
          onClick={() => setActiveTab('pihole')}
        >
          <span className="platform-tab-icon">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="4" width="16" height="16" rx="2" />
              <rect x="9" y="9" width="6" height="6" />
              <line x1="9" y1="1" x2="9" y2="4" />
              <line x1="15" y1="1" x2="15" y2="4" />
              <line x1="9" y1="20" x2="9" y2="23" />
              <line x1="15" y1="20" x2="15" y2="23" />
            </svg>
          </span>
          <span className="platform-tab-label">Pi-hole</span>
        </button>

        <button
          role="tab"
          aria-selected={activeTab === 'adguard-desktop'}
          className={`platform-tab-btn ${activeTab === 'adguard-desktop' ? 'active' : ''}`}
          onClick={() => setActiveTab('adguard-desktop')}
        >
          <span className="platform-tab-icon">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </span>
          <span className="platform-tab-label">AdGuard App</span>
        </button>

        <button
          role="tab"
          aria-selected={activeTab === 'hosts'}
          className={`platform-tab-btn ${activeTab === 'hosts' ? 'active' : ''}`}
          onClick={() => setActiveTab('hosts')}
        >
          <span className="platform-tab-icon">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </span>
          <span className="platform-tab-label">System Hosts</span>
        </button>

        <button
          role="tab"
          aria-selected={activeTab === 'dnsmasq'}
          className={`platform-tab-btn ${activeTab === 'dnsmasq' ? 'active' : ''}`}
          onClick={() => setActiveTab('dnsmasq')}
        >
          <span className="platform-tab-icon">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </span>
          <span className="platform-tab-label">Routers & DNS</span>
        </button>
      </div>

      {/* Platform Instructions Body */}
      <div className="deploy-guide-panel">
        {/* TAB 1: AdGuard Home */}
        {activeTab === 'adguard-home' && (
          <div className="guide-section">
            <div className="guide-hero-banner">
              <div className="guide-hero-text">
                <h3>Connecting to AdGuard Home</h3>
                <p>
                  Deploy your compiled lists as an active DNS blocklist in AdGuard Home with zero-touch automated API reload whenever you compile.
                </p>
              </div>
              <div className="guide-quick-test">
                <button
                  className="tester-btn"
                  onClick={() => handleTestConnection('adguard')}
                  disabled={testingService === 'adguard'}
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  <span>{testingService === 'adguard' ? 'Testing Connection…' : 'Test AdGuard Connection'}</span>
                </button>
                {testResult?.service === 'adguard' && !isServiceMismatch(testResult.details) && (
                  <span className={`test-status-pill ${testResult.success ? 'success' : 'error'}`}>
                    {testResult.message}
                  </span>
                )}
              </div>
            </div>

            <ServiceMismatchBanner
              details={testResult?.service === 'adguard' ? testResult.details : undefined}
              message={testResult?.service === 'adguard' ? testResult.message : undefined}
              onUseDirect={() => { void applyDetectedMode('direct'); }}
              onUseHaApi={() => { void applyDetectedMode('ha-api'); }}
            />

            {/* Environment Selection Segment */}
            <div className="guide-env-selector">
              <span className="env-selector-title">Environment Setup:</span>
              <div className="env-pill-group">
                <button
                  type="button"
                  className={`env-pill-btn ${adguardEnv === 'homeassistant' ? 'active' : ''}`}
                  onClick={() => {
                    setAdguardEnv('homeassistant');
                    if (!sinkholeConfig.adguardHomeUrl || sinkholeConfig.adguardHomeUrl.includes('192.168.1.100')) {
                      setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: `http://homeassistant.local:${directPort}` });
                    }
                  }}
                >
                  <span className="env-pill-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                      <polyline points="9 22 9 12 15 12 15 22" />
                    </svg>
                  </span>
                  <span className="env-pill-label">Home Assistant Add-on</span>
                </button>

                <button
                  type="button"
                  className={`env-pill-btn ${adguardEnv === 'docker' ? 'active' : ''}`}
                  onClick={() => setAdguardEnv('docker')}
                >
                  <span className="env-pill-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                      <line x1="12" y1="22.08" x2="12" y2="12" />
                    </svg>
                  </span>
                  <span className="env-pill-label">Docker & NAS (Unraid / Synology)</span>
                </button>

                <button
                  type="button"
                  className={`env-pill-btn ${adguardEnv === 'router' ? 'active' : ''}`}
                  onClick={() => {
                    setAdguardEnv('router');
                    if (!sinkholeConfig.adguardHomeUrl) {
                      setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: `http://192.168.8.1:${directPort}` });
                    }
                  }}
                >
                  <span className="env-pill-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="2" y1="12" x2="22" y2="12" />
                      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                    </svg>
                  </span>
                  <span className="env-pill-label">GL.iNet & Routers</span>
                </button>

                <button
                  type="button"
                  className={`env-pill-btn ${adguardEnv === 'standalone' ? 'active' : ''}`}
                  onClick={() => setAdguardEnv('standalone')}
                >
                  <span className="env-pill-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                  </span>
                  <span className="env-pill-label">Standalone / Linux / Pi</span>
                </button>
              </div>
            </div>

            {/* Home Assistant Specific Guidance Callout */}
            {adguardEnv === 'homeassistant' && (
              <div className="ha-callout-card">
                <div className="ha-callout-header">
                  <span className="ha-callout-badge">Home Assistant Integration</span>
                  <h4>Setting Up with Home Assistant Add-on</h4>
                </div>
                <div className="ha-callout-grid">
                  <div className="ha-callout-item">
                    <div>
                      <strong>Expose the AdGuard port</strong>
                      <p>
                        In the AdGuard Home add-on, open Configuration, then Network. Map the web interface port (usually <code>{directPort}</code>), save, and restart.
                      </p>
                    </div>
                  </div>

                  <div className="ha-callout-item">
                    <div>
                      <strong>Subscribe with the LAN feed</strong>
                      <p>
                        Home Assistant cannot open files on this Mac. Copy the LAN Feed URL from the steps below into AdGuard&rsquo;s DNS blocklists.
                      </p>
                    </div>
                  </div>

                  <div className="ha-callout-item">
                    <div>
                      <strong>Match the URL to the mode</strong>
                      <p>
                        Direct AdGuard uses AdGuard&rsquo;s own address and password, for example <code>http://homeassistant.local:{directPort}</code>. Home Assistant REST API mode belongs on the Home Assistant URL, often port 8123, with a long-lived token.
                      </p>
                    </div>
                  </div>

                  <div className="ha-callout-item">
                    <div>
                      <strong>Remote reloads</strong>
                      <p>
                        Blocklist downloads stay on the LAN feed. Nabu Casa can ask Home Assistant to reload AdGuard, and it does not proxy AdGuard&rsquo;s direct port.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="guide-procedure-head">
              <h4>Subscribe the blocklist</h4>
              <p>Follow these steps in AdGuard Home. The notes above are reference, not a second numbered list.</p>
            </div>

            <div className="guide-steps-flow">
              <div className="guide-step-card">
                <div className="step-num-pill">1</div>
                <div className="step-content">
                  <h4>Open AdGuard Home Web Interface</h4>
                  {adguardEnv === 'homeassistant' ? (
                    <p>
                      In Home Assistant, click <strong>AdGuard Home</strong> in the left sidebar, or open your browser directly to <code>http://homeassistant.local:{directPort}</code> (once port {directPort} is enabled).
                    </p>
                  ) : adguardEnv === 'router' ? (
                    <p>
                      Open your router web portal (e.g. <code>http://192.168.8.1:{directPort}</code> on GL.iNet routers or <code>http://192.168.1.1:{directPort}</code> on OpenWrt).
                    </p>
                  ) : (
                    <p>
                      Open your browser and navigate to your AdGuard Home dashboard (default: <code>http://&lt;ip&gt;:{directPort}</code>).
                    </p>
                  )}
                </div>
              </div>

              <div className="guide-step-card">
                <div className="step-num-pill">2</div>
                <div className="step-content">
                  <h4>Navigate to DNS Blocklists</h4>
                  <p>In the top navigation menu, click on <strong>Filters</strong>, then select <strong>DNS blocklists</strong>.</p>
                </div>
              </div>

              <div className="guide-step-card">
                <div className="step-num-pill">3</div>
                <div className="step-content">
                  <h4>Add Custom Blocklist</h4>
                  <p>Click the <strong>Add blocklist</strong> button at the bottom and choose <strong>Add a custom list</strong>.</p>
                </div>
              </div>

              <div className="guide-step-card highlight">
                <div className="step-num-pill">4</div>
                <div className="step-content">
                  <h4>Enter Name & Subscription URL</h4>
                  <p>Set the name to <code>Blockingmachine Compiled</code>. For the subscription URL:</p>
                  
                  <div className="snippet-choice-group">
                    <div className="snippet-box">
                      <div className="snippet-header">
                        <span>Option A: Over Local Network ({adguardEnv === 'homeassistant' ? 'Required for Home Assistant' : 'Recommended for Remote / Docker / Routers'})</span>
                        <button
                          className="copy-snippet-btn"
                          onClick={() => handleCopy(lanFeedUrl, 'agh-lan')}
                        >
                          {copiedKey === 'agh-lan' ? 'Copied!' : 'Copy LAN URL'}
                        </button>
                      </div>
                      <code>{lanFeedUrl}</code>
                    </div>

                    <div className="snippet-box">
                      <div className="snippet-header">
                        <span>Option B: Local File Path (Only if AdGuard Home runs natively on this Mac)</span>
                        <button
                          className="copy-snippet-btn"
                          onClick={() => handleCopy(fileUrl, 'agh-file')}
                        >
                          {copiedKey === 'agh-file' ? 'Copied!' : 'Copy File URL'}
                        </button>
                      </div>
                      <code>{fileUrl}</code>
                    </div>

                    {adguardEnv === 'homeassistant' && (
                      <div className="remote-access-note">
                        <span>ℹ️</span>
                        <div>
                          <strong>Nabu Casa &amp; Remote Access:</strong> Even if you view Home Assistant remotely using Nabu Casa (<code>*.ui.nabu.casa</code>), AdGuard Home itself runs locally on your home network. Use this <strong>LAN URL</strong> inside AdGuard&rsquo;s blocklist settings so it downloads over your local Wi-Fi.
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Inline Feed Server status check */}
                  {!serverStatus?.isRunning && (
                    <div className="inline-feed-alert">
                      <div className="inline-feed-alert-text">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                          <line x1="12" y1="9" x2="12" y2="13" />
                          <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <span>
                          <strong>Feed Server is Offline:</strong> Devices on your network ({adguardEnv === 'homeassistant' ? 'Home Assistant' : 'Pi / Router / Docker'}) cannot download your blocklists until this server is started.
                        </span>
                      </div>
                      <button
                        type="button"
                        className="inline-feed-start-btn"
                        onClick={handleToggleFeedServer}
                        disabled={isServerLoading}
                      >
                        {isServerLoading ? 'Starting…' : '▶ Start Feed Server Now'}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="guide-step-card live-sync-step-card">
                <div className="step-num-pill">5</div>
                <div className="step-content">
                  <div className="step-header-row">
                    <div>
                      <h4>Automated Live API Reload & Monitoring</h4>
                      <p>
                        Enable zero-touch automatic reloads: whenever you compile rules in Blockingmachine,
                        it will immediately signal AdGuard Home or Home Assistant to reload without touching the web browser.
                      </p>
                    </div>

                    <div className="live-sync-header-actions">
                      <label className="sync-toggle-label" title="Trigger automated sync after each rule compile">
                        <input
                          type="checkbox"
                          checked={sinkholeConfig.syncOnCompile}
                          onChange={(e) => handleToggleSyncOnCompile(e.target.checked)}
                        />
                        <span>Auto-Push on Compile</span>
                      </label>

                      <button
                        className="live-push-btn"
                        onClick={() => handleTriggerLiveSync('adguard')}
                        disabled={isSyncingSinkhole || (!sinkholeConfig.adguardHomeUrl && !sinkholeConfig.haWebhookUrl)}
                        title="Send immediate API reload signal"
                      >
                        {isSyncingSinkhole ? (
                          <>
                            <span className="loading-spinner mini" />
                            <span>Pushing…</span>
                          </>
                        ) : (
                          <>
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                            </svg>
                            <span>Push Live Reload Now</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Live Status & Watch Monitor */}
                  <div className="live-sync-monitor-box">
                    <div className="monitor-status-line">
                      <div className="monitor-indicator-group">
                        <span className={`monitor-dot ${sinkholeConfig.adguardHomeUrl ? 'active' : 'idle'}`} />
                        <span className="monitor-target-name">
                          {sinkholeConfig.adguardMode === 'ha-api'
                            ? `Home Assistant API: ${sinkholeConfig.adguardHomeUrl || 'Not Configured'}`
                            : sinkholeConfig.adguardMode === 'webhook'
                            ? `Webhook: ${sinkholeConfig.haWebhookUrl || 'Not Configured'}`
                            : `AdGuard Direct: ${directEndpointLabel}`}
                        </span>
                      </div>

                      <div className="monitor-badges">
                        {testResult?.service === 'adguard' && !isServiceMismatch(testResult.details) && (
                          <span className={`test-status-pill ${testResult.success ? 'success' : 'error'}`}>
                            {testResult.message}
                          </span>
                        )}
                        {lastSyncResult?.service?.toLowerCase().includes('adguard') && !isServiceMismatch(lastSyncResult.details) && (
                          <span className={`test-status-pill ${lastSyncResult.status === 'success' ? 'success' : 'error'}`}>
                            Last Push: {lastSyncResult.message} ({lastSyncResult.timestamp})
                          </span>
                        )}
                      </div>
                    </div>

                    <ServiceMismatchBanner
                      details={lastSyncResult?.service?.toLowerCase().includes('adguard') ? lastSyncResult.details : undefined}
                      message={lastSyncResult?.service?.toLowerCase().includes('adguard') ? lastSyncResult.message : undefined}
                      onUseDirect={() => { void applyDetectedMode('direct'); }}
                      onUseHaApi={() => { void applyDetectedMode('ha-api'); }}
                    />

                    {/* Connection Method Selector */}
                    <div className="connection-mode-selector">
                      <span className="mode-selector-label">Integration Method:</span>
                      <div className="mode-options-row">
                        <label className={`mode-option-btn ${(!sinkholeConfig.adguardMode || sinkholeConfig.adguardMode === 'direct') ? 'active' : ''}`}>
                          <input
                            type="radio"
                            name="adguardMode"
                            checked={!sinkholeConfig.adguardMode || sinkholeConfig.adguardMode === 'direct'}
                            onChange={() => selectAdguardMode('direct')}
                          />
                          <span>Direct AdGuard Port {directPort} (Recommended)</span>
                        </label>

                        <label className={`mode-option-btn ${sinkholeConfig.adguardMode === 'ha-api' ? 'active' : ''}`}>
                          <input
                            type="radio"
                            name="adguardMode"
                            checked={sinkholeConfig.adguardMode === 'ha-api'}
                            onChange={() => selectAdguardMode('ha-api')}
                          />
                          <span>Home Assistant REST API (HA port + token)</span>
                        </label>

                        <label className={`mode-option-btn ${sinkholeConfig.adguardMode === 'webhook' ? 'active' : ''}`}>
                          <input
                            type="radio"
                            name="adguardMode"
                            checked={sinkholeConfig.adguardMode === 'webhook'}
                            onChange={() => selectAdguardMode('webhook')}
                          />
                          <span>Home Assistant Webhook</span>
                        </label>
                      </div>
                    </div>

                    {/* Quick Fast-Fill Preset Buttons */}
                    <div className="quick-presets-row">
                      <span className="quick-presets-label">Fast Fill:</span>
                      <button
                        type="button"
                        className="preset-fill-pill"
                        onClick={() =>
                          selectAdguardMode('direct', { adguardHomeUrl: `http://homeassistant.local:${directPort}` })
                        }
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <polyline points="9 22 9 12 15 12 15 22" />
                        </svg>
                        homeassistant.local:{directPort}
                      </button>
                      <button
                        type="button"
                        className="preset-fill-pill"
                        onClick={() =>
                          selectAdguardMode('direct', { adguardHomeUrl: `http://homeassistant:${directPort}` })
                        }
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <polyline points="9 22 9 12 15 12 15 22" />
                        </svg>
                        homeassistant:{directPort}
                      </button>
                      <button
                        type="button"
                        className="preset-fill-pill"
                        onClick={() =>
                          selectAdguardMode('ha-api', { adguardHomeUrl: 'http://homeassistant.local:8123' })
                        }
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <polyline points="9 22 9 12 15 12 15 22" />
                        </svg>
                        HA API (port 8123)
                      </button>
                      <button
                        type="button"
                        className="preset-fill-pill"
                        onClick={() =>
                          selectAdguardMode('direct', { adguardHomeUrl: `http://192.168.8.1:${directPort}` })
                        }
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                          <circle cx="12" cy="12" r="10" />
                          <line x1="2" y1="12" x2="22" y2="12" />
                          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                        </svg>
                        GL.iNet (192.168.8.1)
                      </button>
                      <button
                        type="button"
                        className="preset-fill-pill"
                        onClick={() =>
                          selectAdguardMode('direct', { adguardHomeUrl: `http://localhost:${directPort}` })
                        }
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                          <line x1="12" y1="22.08" x2="12" y2="12" />
                        </svg>
                        Docker (localhost:{directPort})
                      </button>
                      <button
                        type="button"
                        className="preset-fill-pill"
                        onClick={() =>
                          selectAdguardMode('ha-api', { adguardHomeUrl: 'https://your-instance.ui.nabu.casa' })
                        }
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                        </svg>
                        Nabu Casa Cloud
                      </button>
                      <button
                        type="button"
                        className="preset-fill-pill"
                        onClick={() =>
                          selectAdguardMode('webhook', { haWebhookUrl: 'https://hooks.nabu.casa/...' })
                        }
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                        </svg>
                        Nabu Casa Webhook
                      </button>
                    </div>

                    {/* Nabu Casa Direct Mode Warning Banner */}
                    {sinkholeConfig.adguardMode === 'direct' &&
                      sinkholeConfig.adguardHomeUrl?.includes('nabu.casa') && (
                        <div className="nabu-warning-banner">
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                          </svg>
                          <div>
                            <strong>Nabu Casa does not proxy AdGuard direct port {directPort}!</strong>
                            <div>
                              Nabu Casa (<code>*.ui.nabu.casa</code>) only exposes Home Assistant itself. To reload AdGuard remotely through Nabu Casa, switch mode to <strong>Home Assistant REST API</strong> (port 8123 + token) or <strong>Webhook</strong>.
                            </div>
                            <div style={{ marginTop: '6px' }}>
                              <button
                                type="button"
                                className="secondary-button"
                                style={{ fontSize: '11px', padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                                onClick={() =>
                                  selectAdguardMode('ha-api')
                                }
                              >
                                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                                </svg>
                                <span>Switch to Home Assistant REST API</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                    {(!sinkholeConfig.adguardMode || sinkholeConfig.adguardMode === 'direct') &&
                      directWarning?.code === 'ha_frontend' && (
                        <div className="nabu-warning-banner">
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                          </svg>
                          <div>{directWarning.message}</div>
                        </div>
                      )}

                    {/* Quick In-Place Credentials & Endpoint Editor */}
                    <div className="inline-config-editor">
                      {sinkholeConfig.adguardMode === 'ha-api' ? (
                        /* Home Assistant REST API Mode */
                        <div className="inline-fields-row">
                          <div className="inline-field-group url-field">
                            <label>Home Assistant Instance URL</label>
                            <input
                              type="text"
                              placeholder="http://homeassistant.local:8123 or https://your-instance.ui.nabu.casa"
                              value={sinkholeConfig.adguardHomeUrl || ''}
                              onChange={(e) =>
                                setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: e.target.value })
                              }
                            />
                          </div>

                          <div className="inline-field-group" style={{ flex: 2 }}>
                            <label>Home Assistant Long-Lived Access Token</label>
                            <div className="inline-input-with-eye">
                              <input
                                type={showHaToken ? 'text' : 'password'}
                                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6..."
                                value={sinkholeConfig.haToken || ''}
                                onChange={(e) =>
                                  setSinkholeConfig({ ...sinkholeConfig, haToken: e.target.value })
                                }
                              />
                              <button
                                type="button"
                                className="eye-toggle-btn"
                                onClick={() => setShowHaToken(!showHaToken)}
                                title={showHaToken ? 'Hide token' : 'Show token'}
                              >
                                {showHaToken ? (
                                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                  </svg>
                                ) : (
                                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                    <line x1="1" y1="1" x2="23" y2="23" />
                                  </svg>
                                )}
                              </button>
                            </div>
                          </div>

                          <div className="method-note" style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2, color: 'var(--accent-primary, #6366f1)' }}>
                              <path d="M9 18h6m-4 4h2m-1-18a7 7 0 0 0-7 7c0 3 2 5 3 6v2h8v-2c1-1 3-3 3-6a7 7 0 0 0-7-7z" />
                            </svg>
                            <div>
                              In Home Assistant, open your profile, then Security, and create a long-lived access token. Reloads call <code>adguard.refresh</code> on the Home Assistant URL, often <code>http://homeassistant.local:8123</code> or Nabu Casa.
                            </div>
                          </div>

                          <div className="inline-field-group url-field">
                            <label>AdGuard Direct URL</label>
                            <input
                              type="text"
                              placeholder="https://homeassistant.local:8124"
                              value={sinkholeConfig.adguardDirectUrl || ''}
                              onChange={(e) =>
                                setSinkholeConfig({ ...sinkholeConfig, adguardDirectUrl: e.target.value })
                              }
                            />
                          </div>
                          <div className="inline-field-group user-field">
                            <label>AdGuard username</label>
                            <input
                              type="text"
                              placeholder="admin"
                              value={sinkholeConfig.adguardHomeUser || ''}
                              onChange={(e) =>
                                setSinkholeConfig({ ...sinkholeConfig, adguardHomeUser: e.target.value })
                              }
                            />
                          </div>
                          <div className="inline-field-group pass-field">
                            <label>AdGuard password</label>
                            <input
                              type={showAdguardPass ? 'text' : 'password'}
                              placeholder="••••••••"
                              value={sinkholeConfig.adguardHomePassword || ''}
                              onChange={(e) =>
                                setSinkholeConfig({ ...sinkholeConfig, adguardHomePassword: e.target.value })
                              }
                            />
                          </div>
                          <div className="method-note">
                            Query log and Radar use this AdGuard address and these credentials. Home Assistant REST API mode does not send the token here.
                          </div>
                        </div>
                      ) : sinkholeConfig.adguardMode === 'webhook' ? (
                        /* Home Assistant Webhook Mode */
                        <div className="inline-fields-row">
                          <div className="inline-field-group url-field" style={{ flex: 1 }}>
                            <label>Home Assistant Webhook URL</label>
                            <input
                              type="text"
                              placeholder="http://homeassistant.local:8123/api/webhook/... or https://hooks.nabu.casa/..."
                              value={sinkholeConfig.haWebhookUrl || ''}
                              onChange={(e) =>
                                setSinkholeConfig({ ...sinkholeConfig, haWebhookUrl: e.target.value })
                              }
                            />
                          </div>
                          <div className="method-note" style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2, color: 'var(--accent-primary, #6366f1)' }}>
                              <path d="M9 18h6m-4 4h2m-1-18a7 7 0 0 0-7 7c0 3 2 5 3 6v2h8v-2c1-1 3-3 3-6a7 7 0 0 0-7-7z" />
                            </svg>
                            <div>
                              In Home Assistant: create an Automation with a <strong>Webhook Trigger</strong> (local or Nabu Casa Cloud Webhook) and an action that calls <code>adguard.refresh</code>. No passwords required!
                            </div>
                          </div>
                          <div className="inline-field-group url-field">
                            <label>AdGuard Direct URL</label>
                            <input
                              type="text"
                              placeholder="https://homeassistant.local:8124"
                              value={sinkholeConfig.adguardDirectUrl || ''}
                              onChange={(e) =>
                                setSinkholeConfig({ ...sinkholeConfig, adguardDirectUrl: e.target.value })
                              }
                            />
                          </div>
                          <div className="inline-field-group user-field">
                            <label>AdGuard username</label>
                            <input
                              type="text"
                              placeholder="admin"
                              value={sinkholeConfig.adguardHomeUser || ''}
                              onChange={(e) =>
                                setSinkholeConfig({ ...sinkholeConfig, adguardHomeUser: e.target.value })
                              }
                            />
                          </div>
                          <div className="inline-field-group pass-field">
                            <label>AdGuard password</label>
                            <input
                              type={showAdguardPass ? 'text' : 'password'}
                              placeholder="••••••••"
                              value={sinkholeConfig.adguardHomePassword || ''}
                              onChange={(e) =>
                                setSinkholeConfig({ ...sinkholeConfig, adguardHomePassword: e.target.value })
                              }
                            />
                          </div>
                          <div className="method-note">
                            The webhook reloads Home Assistant. Query log and Radar use this AdGuard address and these credentials.
                          </div>
                        </div>
                      ) : (
                        /* Direct AdGuard Home Mode */
                        <div className="inline-fields-row">
                          <div className="inline-field-group url-field">
                            <label>AdGuard Home URL</label>
                            <input
                              type="text"
                              placeholder={`http://homeassistant.local:${directPort} or http://192.168.1.100:${directPort}`}
                              value={sinkholeConfig.adguardHomeUrl || ''}
                              onChange={(e) =>
                                setSinkholeConfig({
                                  ...sinkholeConfig,
                                  adguardHomeUrl: e.target.value,
                                  adguardDirectUrl: e.target.value,
                                })
                              }
                            />
                          </div>

                          <div className="inline-field-group port-field">
                            <label>API port</label>
                            <input
                              type="number"
                              min={1}
                              max={65535}
                              value={sinkholeConfig.adguardDirectPort ?? ''}
                              onFocus={() => {
                                directPortFocusRef.current = directPort;
                              }}
                              onChange={(e) => {
                                const raw = e.target.value;
                                if (raw === '') {
                                  setSinkholeConfig({ ...sinkholeConfig, adguardDirectPort: undefined });
                                  return;
                                }
                                const next = Number.parseInt(raw, 10);
                                if (Number.isInteger(next)) {
                                  setSinkholeConfig({ ...sinkholeConfig, adguardDirectPort: next });
                                }
                              }}
                              onBlur={(e) => {
                                const previous = directPortFocusRef.current;
                                const next = normalizeAdguardDirectPort(e.target.value);
                                const nextUrl = replaceMatchingExplicitPort(sinkholeConfig.adguardHomeUrl || '', previous, next);
                                setSinkholeConfig({
                                  ...sinkholeConfig,
                                  adguardDirectPort: next,
                                  adguardHomeUrl: nextUrl,
                                  adguardDirectUrl: replaceMatchingExplicitPort(sinkholeConfig.adguardDirectUrl || nextUrl, previous, next),
                                });
                              }}
                            />
                          </div>

                          <div className="inline-field-group user-field">
                            <label>Username</label>
                            <input
                              type="text"
                              placeholder="admin"
                              value={sinkholeConfig.adguardHomeUser || ''}
                              onChange={(e) =>
                                setSinkholeConfig({ ...sinkholeConfig, adguardHomeUser: e.target.value })
                              }
                            />
                          </div>

                          <div className="inline-field-group pass-field">
                            <label>Password</label>
                            <div className="inline-input-with-eye">
                              <input
                                type={showAdguardPass ? 'text' : 'password'}
                                placeholder="••••••••"
                                value={sinkholeConfig.adguardHomePassword || ''}
                                onChange={(e) =>
                                  setSinkholeConfig({ ...sinkholeConfig, adguardHomePassword: e.target.value })
                                }
                              />
                              <button
                                type="button"
                                className="eye-toggle-btn"
                                onClick={() => setShowAdguardPass(!showAdguardPass)}
                                title={showAdguardPass ? 'Hide password' : 'Show password'}
                              >
                                {showAdguardPass ? (
                                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                  </svg>
                                ) : (
                                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                    <line x1="1" y1="1" x2="23" y2="23" />
                                  </svg>
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="tls-opt-in">
                        <label className="tls-opt-in-label">
                          <input
                            type="checkbox"
                            checked={Boolean(sinkholeConfig.allowInsecureLocalTls)}
                            onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, allowInsecureLocalTls: e.target.checked })}
                          />
                          <span>Allow untrusted TLS certificates (local only)</span>
                        </label>
                        <p>
                          For a Home Assistant or AdGuard host on your LAN with a self-signed certificate.
                          Applies to localhost, .local names, and private LAN addresses when you test or push. Public hosts still require a trusted certificate.
                        </p>
                        {tlsScopeNote && <p>{tlsScopeNote}</p>}
                      </div>

                      <div className="inline-actions-row">
                        <div className="inline-actions-left">
                          <button
                            type="button"
                            className="primary-button save-config-btn"
                            onClick={() => handleSaveSinkholeConfig('adguard')}
                            disabled={isSavingSinkhole}
                          >
                            {isSavingSinkhole ? 'Saving…' : 'Save Connection Details'}
                          </button>

                          <button
                            type="button"
                            className="secondary-button test-inline-btn"
                            onClick={() => handleTestConnection('adguard')}
                            disabled={testingService === 'adguard' || (!sinkholeConfig.adguardHomeUrl && !sinkholeConfig.haWebhookUrl)}
                          >
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5 }}>
                              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                            </svg>
                            <span>{testingService === 'adguard' ? 'Testing…' : 'Test Connection'}</span>
                          </button>
                        </div>

                        {sinkholeMessage && (
                          <span className="sinkhole-feedback-msg">{sinkholeMessage}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: Pi-hole */}
        {activeTab === 'pihole' && (
          <div className="guide-section">
            <div className="guide-hero-banner">
              <div className="guide-hero-text">
                <h3>Connecting to Pi-hole (v5 & v6)</h3>
                <p>
                  Ingest your deduplicated rules into Pi-hole&rsquo;s adlist database and trigger Gravity
                  updates automatically over API.
                </p>
              </div>
              <div className="guide-quick-test">
                <button
                  className="tester-btn"
                  onClick={() => handleTestConnection('pihole')}
                  disabled={testingService === 'pihole'}
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  <span>{testingService === 'pihole' ? 'Testing Connection…' : 'Test Pi-hole Connection'}</span>
                </button>
                {testResult?.service === 'pihole' && (
                  <span className={`test-status-pill ${testResult.success ? 'success' : 'error'}`}>
                    {testResult.message}
                  </span>
                )}
              </div>
            </div>

            <div className="guide-steps-flow">
              <div className="guide-step-card">
                <div className="step-num-pill">1</div>
                <div className="step-content">
                  <h4>Open Pi-hole Admin Console</h4>
                  <p>Open your browser and navigate to <code>http://pi.hole/admin</code> (or your Pi-hole&rsquo;s IP address).</p>
                </div>
              </div>

              <div className="guide-step-card">
                <div className="step-num-pill">2</div>
                <div className="step-content">
                  <h4>Go to Adlists</h4>
                  <p>In the left sidebar menu, click on <strong>Adlists</strong>.</p>
                </div>
              </div>

              <div className="guide-step-card highlight">
                <div className="step-num-pill">3</div>
                <div className="step-content">
                  <h4>Add Subscription Address</h4>
                  <p>Paste the HTTP feed URL into the <strong>Address</strong> field and click <strong>Add</strong>:</p>

                  <div className="snippet-box">
                    <div className="snippet-header">
                      <span>Pi-hole Adlist Subscription URL (LAN HTTP)</span>
                      <button
                        className="copy-snippet-btn"
                        onClick={() => handleCopy(lanFeedUrl, 'pi-lan')}
                      >
                        {copiedKey === 'pi-lan' ? 'Copied!' : 'Copy URL'}
                      </button>
                    </div>
                    <code>{lanFeedUrl}</code>
                  </div>
                  {/* Inline Feed Server status check */}
                  {!serverStatus?.isRunning && (
                    <div className="inline-feed-alert">
                      <div className="inline-feed-alert-text">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                          <line x1="12" y1="9" x2="12" y2="13" />
                          <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <span>
                          <strong>Feed Server is Offline:</strong> Pi-hole (including Home Assistant Pi-hole Add-on) cannot download lists until this server is started.
                        </span>
                      </div>
                      <button
                        type="button"
                        className="inline-feed-start-btn"
                        onClick={handleToggleFeedServer}
                        disabled={isServerLoading}
                      >
                        {isServerLoading ? 'Starting…' : '▶ Start Feed Server Now'}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="guide-step-card">
                <div className="step-num-pill">4</div>
                <div className="step-content">
                  <h4>Update Gravity Database</h4>
                  <p>
                    Navigate to <strong>Tools</strong> → <strong>Update Gravity</strong> in the web console and click <strong>Update</strong>,
                    or run the following in your Pi-hole terminal:
                  </p>
                  <div className="code-command-snippet">
                    <code>pihole -g</code>
                    <button
                      className="copy-snippet-btn"
                      onClick={() => handleCopy('pihole -g', 'pi-cmd')}
                    >
                      {copiedKey === 'pi-cmd' ? 'Copied!' : 'Copy Command'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="guide-step-card live-sync-step-card">
                <div className="step-num-pill">5</div>
                <div className="step-content">
                  <div className="step-header-row">
                    <div>
                      <h4>Automated Gravity Sync & Monitoring (Pi-hole API)</h4>
                      <p>
                        Enable zero-touch automatic Gravity updates: whenever rules are compiled in Blockingmachine,
                        it will signal Pi-hole&rsquo;s API to reload Gravity (`pihole -g`) automatically.
                      </p>
                    </div>

                    <div className="live-sync-header-actions">
                      <label className="sync-toggle-label" title="Trigger automated sync after each rule compile">
                        <input
                          type="checkbox"
                          checked={sinkholeConfig.syncOnCompile}
                          onChange={(e) => handleToggleSyncOnCompile(e.target.checked)}
                        />
                        <span>Auto-Push on Compile</span>
                      </label>

                      <button
                        className="live-push-btn"
                        onClick={() => handleTriggerLiveSync('pihole')}
                        disabled={isSyncingSinkhole || !sinkholeConfig.piholeUrl}
                        title="Trigger immediate Gravity update on Pi-hole"
                      >
                        {isSyncingSinkhole ? (
                          <>
                            <span className="loading-spinner mini" />
                            <span>Reloading…</span>
                          </>
                        ) : (
                          <>
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                            </svg>
                            <span>Trigger Gravity Reload Now</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Live Status & Watch Monitor */}
                  <div className="live-sync-monitor-box">
                    <div className="monitor-status-line">
                      <div className="monitor-indicator-group">
                        <span className={`monitor-dot ${sinkholeConfig.piholeUrl ? 'active' : 'idle'}`} />
                        <span className="monitor-target-name">
                          {sinkholeConfig.piholeUrl
                            ? `Target: ${sinkholeConfig.piholeUrl}`
                            : 'Target: Not Configured'}
                        </span>
                      </div>

                      <div className="monitor-badges">
                        {testResult?.service === 'pihole' && (
                          <span className={`test-status-pill ${testResult.success ? 'success' : 'error'}`}>
                            {testResult.message}
                          </span>
                        )}
                        {lastSyncResult?.service?.toLowerCase().includes('pi-hole') && (
                          <span className={`test-status-pill ${lastSyncResult.status === 'success' ? 'success' : 'error'}`}>
                            Last Gravity Reload: {lastSyncResult.message} ({lastSyncResult.timestamp})
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Quick Fast-Fill Preset Buttons */}
                    <div className="quick-presets-row">
                      <span className="quick-presets-label">Fast Fill:</span>
                      <button
                        type="button"
                        className="preset-fill-pill"
                        onClick={() =>
                          setSinkholeConfig({
                            ...sinkholeConfig,
                            piholeUrl: 'http://homeassistant.local:8080/admin',
                          })
                        }
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <polyline points="9 22 9 12 15 12 15 22" />
                        </svg>
                        HA Add-on (port 8080)
                      </button>
                      <button
                        type="button"
                        className="preset-fill-pill"
                        onClick={() =>
                          setSinkholeConfig({
                            ...sinkholeConfig,
                            piholeUrl: 'http://homeassistant:8080/admin',
                          })
                        }
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <polyline points="9 22 9 12 15 12 15 22" />
                        </svg>
                        homeassistant:8080
                      </button>
                      <button
                        type="button"
                        className="preset-fill-pill"
                        onClick={() =>
                          setSinkholeConfig({
                            ...sinkholeConfig,
                            piholeUrl: 'http://pi.hole/admin',
                          })
                        }
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
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
                        pi.hole/admin
                      </button>
                      <button
                        type="button"
                        className="preset-fill-pill"
                        onClick={() =>
                          setSinkholeConfig({
                            ...sinkholeConfig,
                            piholeUrl: 'http://localhost:80/admin',
                          })
                        }
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                          <line x1="12" y1="22.08" x2="12" y2="12" />
                        </svg>
                        Docker (port 80)
                      </button>
                    </div>

                    {/* Quick In-Place Credentials & Endpoint Editor */}
                    <div className="inline-config-editor">
                      <div className="inline-fields-row">
                        <div className="inline-field-group url-field" style={{ flex: 1.5 }}>
                          <label>Pi-hole Web/API URL</label>
                          <input
                            type="text"
                            placeholder="http://pi.hole/admin/api.php or http://192.168.1.50/admin"
                            value={sinkholeConfig.piholeUrl || ''}
                            onChange={(e) =>
                              setSinkholeConfig({ ...sinkholeConfig, piholeUrl: e.target.value })
                            }
                          />
                        </div>

                        <div className="inline-field-group pass-field" style={{ flex: 1.2 }}>
                          <label>API Key / Web Password Token</label>
                          <div className="inline-input-with-eye">
                            <input
                              type={showPiholeKey ? 'text' : 'password'}
                              placeholder="WEBPASSWORD hash or API token"
                              value={sinkholeConfig.piholeApiKey || ''}
                              onChange={(e) =>
                                setSinkholeConfig({ ...sinkholeConfig, piholeApiKey: e.target.value })
                              }
                            />
                            <button
                              type="button"
                              className="eye-toggle-btn"
                              onClick={() => setShowPiholeKey(!showPiholeKey)}
                              title={showPiholeKey ? 'Hide key' : 'Show key'}
                            >
                              {showPiholeKey ? (
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                  <circle cx="12" cy="12" r="3" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                  <line x1="1" y1="1" x2="23" y2="23" />
                                </svg>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="inline-actions-row">
                        <div className="inline-actions-left">
                          <button
                            type="button"
                            className="primary-button save-config-btn"
                            onClick={() => handleSaveSinkholeConfig('pihole')}
                            disabled={isSavingSinkhole}
                          >
                            {isSavingSinkhole ? 'Saving…' : 'Save Connection Details'}
                          </button>

                          <button
                            type="button"
                            className="secondary-button test-inline-btn"
                            onClick={() => handleTestConnection('pihole')}
                            disabled={testingService === 'pihole' || !sinkholeConfig.piholeUrl}
                          >
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5 }}>
                              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                            </svg>
                            <span>{testingService === 'pihole' ? 'Testing…' : 'Test Connection'}</span>
                          </button>
                        </div>

                        {sinkholeMessage && (
                          <span className="sinkhole-feedback-msg">{sinkholeMessage}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: AdGuard Desktop (Mac / Windows) */}
        {activeTab === 'adguard-desktop' && (
          <div className="guide-section">
            <div className="guide-hero-banner">
              <div className="guide-hero-text">
                <h3>Connecting to AdGuard for Mac & Windows</h3>
                <p>
                  Import or subscribe to your compiled rule bundle directly within the standalone AdGuard desktop application.
                </p>
              </div>
            </div>

            <div className="guide-steps-flow">
              <div className="guide-step-card">
                <div className="step-num-pill">1</div>
                <div className="step-content">
                  <h4>Open AdGuard Preferences</h4>
                  <p>Launch AdGuard for Mac or Windows, open <strong>Preferences / Settings</strong>, and select the <strong>Filters</strong> tab.</p>
                </div>
              </div>

              <div className="guide-step-card">
                <div className="step-num-pill">2</div>
                <div className="step-content">
                  <h4>Add Custom Filter</h4>
                  <p>Select <strong>Custom</strong> in the left filter categories, then click <strong>Add custom filter</strong> (the &ldquo;+&rdquo; button at the bottom).</p>
                </div>
              </div>

              <div className="guide-step-card highlight">
                <div className="step-num-pill">3</div>
                <div className="step-content">
                  <h4>Subscribe by URL or Local File</h4>
                  <p>You can either import the raw file or enter the local file URL for seamless updates:</p>

                  <div className="snippet-choice-group">
                    <div className="snippet-box">
                      <div className="snippet-header">
                        <span>Subscribe by URL (Automatic Updates)</span>
                        <button
                          className="copy-snippet-btn"
                          onClick={() => handleCopy(fileUrl, 'ag-desk-url')}
                        >
                          {copiedKey === 'ag-desk-url' ? 'Copied!' : 'Copy URL'}
                        </button>
                      </div>
                      <code>{fileUrl}</code>
                    </div>

                    <div className="snippet-box">
                      <div className="snippet-header">
                        <span>Direct Local File Path</span>
                        <button
                          className="copy-snippet-btn"
                          onClick={() => handleCopy(savePath, 'ag-desk-path')}
                        >
                          {copiedKey === 'ag-desk-path' ? 'Copied!' : 'Copy Path'}
                        </button>
                      </div>
                      <code>{savePath}</code>
                    </div>
                  </div>
                </div>
              </div>

              <div className="guide-step-card">
                <div className="step-num-pill">4</div>
                <div className="step-content">
                  <h4>Enable Filter</h4>
                  <p>Ensure the checkmark next to your newly added filter is checked. All desktop browser and application network traffic will now be filtered through this bundle.</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: OS System Hosts File */}
        {activeTab === 'hosts' && (
          <div className="guide-section">
            <div className="guide-hero-banner">
              <div className="guide-hero-text">
                <h3>Direct System Hosts File (/etc/hosts)</h3>
                <p>
                  Zero-software system-level blocking on macOS, Linux, and Windows. Requires export format to be set to Hosts.
                </p>
              </div>
            </div>

            <div className="guide-steps-flow">
              <div className="guide-step-card">
                <div className="step-num-pill">1</div>
                <div className="step-content">
                  <h4>Ensure Export Format is Hosts</h4>
                  <p>In Blockingmachine, go to <strong>Settings</strong> and ensure your export format is set to <strong>Pi-hole / Standard Hosts (hosts.txt)</strong>.</p>
                </div>
              </div>

              <div className="guide-step-card highlight">
                <div className="step-num-pill">2</div>
                <div className="step-content">
                  <h4>Apply to System Hosts & Flush DNS Cache</h4>
                  <p>Run the corresponding command in your terminal as Administrator/root:</p>

                  <div className="snippet-choice-group">
                    <div className="snippet-box">
                      <div className="snippet-header">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 20.94c1.5 0 2.75-.5 3.5-1.5 1.5-2 1.5-5 0-7-1.25-1.5-3-1.5-4.5-1.5s-3.25 0-4.5 1.5c-1.5 2-1.5 5 0 7 .75 1 2 1.5 3.5 1.5" />
                            <path d="M12 2a4 4 0 0 0-4 4" />
                          </svg>
                          macOS Terminal Command
                        </span>
                        <button
                          className="copy-snippet-btn"
                          onClick={() => handleCopy(`sudo cp "${savePath}" /etc/hosts && sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`, 'hosts-mac')}
                        >
                          {copiedKey === 'hosts-mac' ? 'Copied!' : 'Copy macOS Command'}
                        </button>
                      </div>
                      <code>{`sudo cp "${savePath}" /etc/hosts && sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`}</code>
                    </div>

                    <div className="snippet-box">
                      <div className="snippet-header">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="4 17 10 11 4 5" />
                            <line x1="12" y1="19" x2="20" y2="19" />
                          </svg>
                          Linux Terminal Command
                        </span>
                        <button
                          className="copy-snippet-btn"
                          onClick={() => handleCopy(`sudo cp "${savePath}" /etc/hosts && sudo systemd-resolve --flush-caches`, 'hosts-linux')}
                        >
                          {copiedKey === 'hosts-linux' ? 'Copied!' : 'Copy Linux Command'}
                        </button>
                      </div>
                      <code>{`sudo cp "${savePath}" /etc/hosts && sudo systemd-resolve --flush-caches`}</code>
                    </div>

                    <div className="snippet-box">
                      <div className="snippet-header">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="8" height="8" />
                            <rect x="13" y="3" width="8" height="8" />
                            <rect x="3" y="13" width="8" height="8" />
                            <rect x="13" y="13" width="8" height="8" />
                          </svg>
                          Windows PowerShell (Run as Administrator)
                        </span>
                        <button
                          className="copy-snippet-btn"
                          onClick={() => handleCopy(`Copy-Item "${savePath}" -Destination "$env:SystemRoot\\System32\\drivers\\etc\\hosts" -Force; ipconfig /flushdns`, 'hosts-win')}
                        >
                          {copiedKey === 'hosts-win' ? 'Copied!' : 'Copy PowerShell Command'}
                        </button>
                      </div>
                      <code>{`Copy-Item "${savePath}" -Destination "$env:SystemRoot\\System32\\drivers\\etc\\hosts" -Force; ipconfig /flushdns`}</code>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: Dnsmasq, Routers & Firewalls */}
        {activeTab === 'dnsmasq' && (
          <div className="guide-section">
            <div className="guide-hero-banner">
              <div className="guide-hero-text">
                <h3>Routers, Firewalls & Dnsmasq</h3>
                <p>
                  Deploy compiled rules into OpenWrt, pfSense (pfBlockerNG), OPNsense (Unbound), and DD-WRT.
                </p>
              </div>
            </div>

            <div className="guide-steps-flow">
              <div className="guide-step-card">
                <div className="step-num-pill">1</div>
                <div className="step-content">
                  <h4>Dnsmasq Server (OpenWrt / Linux)</h4>
                  <p>In your <code>/etc/dnsmasq.conf</code> or <code>/etc/config/dhcp</code>, add the following line pointing to the hosts file or conf file:</p>
                  <div className="code-command-snippet">
                    <code>{`addn-hosts=${savePath}`}</code>
                    <button
                      className="copy-snippet-btn"
                      onClick={() => handleCopy(`addn-hosts=${savePath}`, 'dnsmasq-conf')}
                    >
                      {copiedKey === 'dnsmasq-conf' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <p className="step-subtext">Restart dnsmasq to apply: <code>sudo /etc/init.d/dnsmasq restart</code></p>
                </div>
              </div>

              <div className="guide-step-card">
                <div className="step-num-pill">2</div>
                <div className="step-content">
                  <h4>pfSense & pfBlockerNG</h4>
                  <p>
                    In pfSense, navigate to <strong>Firewall</strong> → <strong>pfBlockerNG</strong> → <strong>DNSBL Feeds</strong>.
                    Add a new feed item and set the URL to your LAN feed URL:
                  </p>
                  <div className="snippet-box">
                    <div className="snippet-header">
                      <span>pfBlockerNG Custom Feed URL</span>
                      <button
                        className="copy-snippet-btn"
                        onClick={() => handleCopy(lanFeedUrl, 'pf-lan')}
                      >
                        {copiedKey === 'pf-lan' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <code>{lanFeedUrl}</code>
                  </div>
                </div>
              </div>

              <div className="guide-step-card">
                <div className="step-num-pill">3</div>
                <div className="step-content">
                  <h4>OPNsense & Unbound DNS</h4>
                  <p>
                    In OPNsense, go to <strong>Services</strong> → <strong>Unbound DNS</strong> → <strong>Blocklist</strong>.
                    Add a Custom URL with your LAN Feed URL and save changes.
                  </p>
                </div>
              </div>

              {/* Step 4: Generic Homelab & Automation Webhook */}
              <div className="guide-step-card live-sync-step-card">
                <div className="step-num-pill">4</div>
                <div className="step-content">
                  <div className="step-header-row">
                    <div>
                      <h4>Homelab & Custom Webhook Automation</h4>
                      <p>
                        Trigger custom reload scripts, Home Assistant automations, Node-RED, n8n, Technitium DNS, Blocky, or pfSense/OPNsense webhook handlers on compile.
                      </p>
                    </div>

                    <button
                      className="live-push-btn"
                      onClick={() => handleTestConnection('webhook')}
                      disabled={!customWebhookUrl}
                      title="Test webhook endpoint delivery"
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                      </svg>
                      <span>Test Webhook URL</span>
                    </button>
                  </div>

                  <div className="inline-config-editor">
                    <div className="inline-fields-row">
                      <div className="inline-field-group url-field" style={{ flex: 1 }}>
                        <label>Custom Webhook URL (HTTP POST)</label>
                        <input
                          type="text"
                          placeholder="http://192.168.1.1:8080/reload or http://homeassistant.local:8123/api/webhook/dns_reload"
                          value={customWebhookUrl}
                          onChange={(e) => {
                            setCustomWebhookUrl(e.target.value);
                            setSinkholeConfig({ ...sinkholeConfig, customWebhookUrl: e.target.value });
                          }}
                        />
                      </div>
                    </div>

                    <div className="inline-actions-row">
                      <div className="inline-actions-left">
                        <button
                          type="button"
                          className="primary-button save-config-btn"
                          onClick={async () => {
                            if (window.electron?.setSinkholeConfig) {
                              await window.electron.setSinkholeConfig({
                                ...sinkholeConfig,
                                customWebhookUrl,
                              });
                              if (isMountedRef.current) {
                                setSinkholeMessage('✓ Custom webhook URL saved!');
                                safeSetTimeout(() => setSinkholeMessage(null), 3000);
                              }
                            }
                          }}
                        >
                          Save Webhook
                        </button>

                        <button
                          type="button"
                          className="secondary-button test-inline-btn"
                          onClick={() => handleTestConnection('webhook')}
                          disabled={!customWebhookUrl}
                        >
                          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5 }}>
                            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                          </svg>
                          <span>Test Webhook</span>
                        </button>
                      </div>

                      {testResult?.service === 'webhook' && (
                        <span className={`test-status-pill ${testResult.success ? 'success' : 'error'}`}>
                          {testResult.message}
                        </span>
                      )}

                      {sinkholeMessage && (
                        <span className="sinkhole-feedback-msg">{sinkholeMessage}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DeployHubView;
