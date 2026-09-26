import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { FilterFormat, FeedServerStatus, SinkholeTestResult, SinkholeConfig, DaemonStatusInfo } from '../types/';
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

type PlatformTab = 'adguard-home' | 'pihole' | 'home-assistant' | 'system-daemon' | 'adguard-desktop' | 'hosts' | 'dnsmasq';

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

  // Home Assistant Live API inspector
  const [haApiPreview, setHaApiPreview] = useState<string | null>(null);
  const [isTestingHaApi, setIsTestingHaApi] = useState(false);

  const handleInspectHaApi = async () => {
    setIsTestingHaApi(true);
    try {
      const port = serverStatus?.port || 9191;
      const res = await fetch(`http://127.0.0.1:${port}/v1/status`);
      const data = await res.json();
      if (isMountedRef.current) {
        setHaApiPreview(JSON.stringify(data, null, 2));
      }
    } catch (err: any) {
      if (isMountedRef.current) {
        setHaApiPreview(`Error querying local /v1/status: ${err?.message || err}`);
      }
    } finally {
      if (isMountedRef.current) {
        setIsTestingHaApi(false);
      }
    }
  };

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
  const [autoStartFeedServer, setAutoStartFeedServer] = useState(false);
  const [launchOnStartup, setLaunchOnStartup] = useState(false);

  // Local System DNS Daemon
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatusInfo | null>(null);
  const [isDaemonLoading, setIsDaemonLoading] = useState(false);
  const [daemonMessage, setDaemonMessage] = useState<string | null>(null);
  const [networkServices, setNetworkServices] = useState<string[]>(['Wi-Fi']);
  const [selectedService, setSelectedService] = useState<string>('Wi-Fi');
  const [showInstallScripts, setShowInstallScripts] = useState(false);
  const [serviceScripts, setServiceScripts] = useState<{ mac: string; linux: string } | null>(null);

  const refreshDaemonStatus = useCallback(async () => {
    if (window.electron?.getDaemonStatus) {
      try {
        const s = await window.electron.getDaemonStatus();
        if (isMountedRef.current) setDaemonStatus(s);
      } catch {
        // ignore
      }
    }
  }, []);

  const handleStartDaemon = async () => {
    setIsDaemonLoading(true);
    setDaemonMessage(null);
    try {
      const res = await window.electron.startDaemonProcess?.();
      setDaemonMessage(res?.message || 'Started');
      await refreshDaemonStatus();
    } catch (err: any) {
      setDaemonMessage(`Failed to start daemon: ${err?.message || err}`);
    } finally {
      setIsDaemonLoading(false);
    }
  };

  const handleStopDaemon = async () => {
    setIsDaemonLoading(true);
    setDaemonMessage(null);
    try {
      const res = await window.electron.stopDaemonProcess?.();
      setDaemonMessage(res?.message || 'Stopped');
      await refreshDaemonStatus();
    } catch (err: any) {
      setDaemonMessage(`Failed to stop daemon: ${err?.message || err}`);
    } finally {
      setIsDaemonLoading(false);
    }
  };

  const handleToggleDaemonProtection = async () => {
    setIsDaemonLoading(true);
    try {
      await window.electron.toggleDaemonProtection?.();
      await refreshDaemonStatus();
    } catch (err: any) {
      setDaemonMessage(`Toggle failed: ${err?.message || err}`);
    } finally {
      setIsDaemonLoading(false);
    }
  };

  const handleReloadDaemon = async () => {
    setIsDaemonLoading(true);
    setDaemonMessage(null);
    try {
      const res = await window.electron.reloadDaemonRules?.();
      setDaemonMessage(res?.message || 'Reloaded rules');
      await refreshDaemonStatus();
    } catch (err: any) {
      setDaemonMessage(`Reload failed: ${err?.message || err}`);
    } finally {
      setIsDaemonLoading(false);
    }
  };

  const handleSetSystemDns = async () => {
    setIsDaemonLoading(true);
    setDaemonMessage(null);
    try {
      const res = await window.electron.setSystemDns?.(selectedService);
      setDaemonMessage(res?.message || 'System DNS updated');
    } catch (err: any) {
      setDaemonMessage(`Set DNS error: ${err?.message || err}`);
    } finally {
      setIsDaemonLoading(false);
    }
  };

  const handleRestoreSystemDns = async () => {
    setIsDaemonLoading(true);
    setDaemonMessage(null);
    try {
      const res = await window.electron.restoreSystemDns?.(selectedService);
      setDaemonMessage(res?.message || 'System DNS restored');
    } catch (err: any) {
      setDaemonMessage(`Restore DNS error: ${err?.message || err}`);
    } finally {
      setIsDaemonLoading(false);
    }
  };

  const handleFlushCache = async () => {
    setIsDaemonLoading(true);
    setDaemonMessage(null);
    try {
      const res = await window.electron.flushDnsCache?.();
      setDaemonMessage(res?.message || 'Cache flushed');
    } catch (err: any) {
      setDaemonMessage(`Flush cache error: ${err?.message || err}`);
    } finally {
      setIsDaemonLoading(false);
    }
  };

  const handleToggleInstallScripts = async () => {
    if (!serviceScripts && window.electron?.getServiceInstallScript) {
      try {
        const scripts = await window.electron.getServiceInstallScript();
        if (isMountedRef.current) setServiceScripts(scripts);
      } catch {
        // ignore
      }
    }
    setShowInstallScripts((prev) => !prev);
  };

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

    if (window.electron?.getAutoStartFeedServer) {
      window.electron.getAutoStartFeedServer().then((val) => {
        if (isMountedRef.current) setAutoStartFeedServer(Boolean(val));
      });
    }

    if (window.electron?.getLaunchOnStartup) {
      window.electron.getLaunchOnStartup().then((val) => {
        if (isMountedRef.current) setLaunchOnStartup(Boolean(val));
      });
    }

    if (window.electron?.getLastProcessTime) {
      window.electron.getLastProcessTime().then((time) => {
        if (isMountedRef.current) setLastProcessTime(time);
      });
    }

    if (window.electron?.getDaemonStatus) {
      window.electron.getDaemonStatus().then((ds) => {
        if (isMountedRef.current && ds) setDaemonStatus(ds);
      });
    }

    if (window.electron?.getNetworkServices) {
      window.electron.getNetworkServices().then((svcs) => {
        if (isMountedRef.current && svcs && svcs.length > 0) {
          setNetworkServices(svcs);
          setSelectedService(svcs[0]);
        }
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

  const handleToggleAutoStartFeedServer = async (enabled: boolean) => {
    setAutoStartFeedServer(enabled);
    if (window.electron?.setAutoStartFeedServer) {
      try {
        await window.electron.setAutoStartFeedServer(enabled);
        if (enabled && window.electron.getFeedServerStatus) {
          const updated = await window.electron.getFeedServerStatus();
          if (isMountedRef.current) setServerStatus(updated);
        }
      } catch (err) {
        console.error('Failed to set auto-start feed server:', err);
      }
    }
  };

  const handleToggleLaunchOnStartup = async (enabled: boolean) => {
    setLaunchOnStartup(enabled);
    if (window.electron?.setLaunchOnStartup) {
      try {
        await window.electron.setLaunchOnStartup(enabled);
      } catch (err) {
        console.error('Failed to set launch on startup:', err);
      }
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
  const _directWarning = directModeWarning(sinkholeConfig.adguardHomeUrl || '', directPort);
  const activeTlsUrl = sinkholeConfig.adguardMode === 'webhook'
    ? (sinkholeConfig.haWebhookUrl || '')
    : (sinkholeConfig.adguardHomeUrl || '');
  const tlsScopeNote = localTlsBypassNote(activeTlsUrl, Boolean(sinkholeConfig.allowInsecureLocalTls));
  const _directEndpointLabel = (() => {
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
      {/* =========================================================================
          1. UNIFIED COMPACT TOP CONTROL BAR
         ========================================================================= */}
      <div className="deploy-hub-top-bar">
        {/* Left: Compiled Target List File Info */}
        <div className="deploy-top-file-info">
          <div className="deploy-file-main-row">
            <div className="deploy-file-badge-group">
              <span className="deploy-format-pill">{exportFormat.toUpperCase()}</span>
              <span className="deploy-count-pill">
                {uniqueRulesCount ? `${uniqueRulesCount.toLocaleString()} Active Rules` : 'Ready to Deploy'}
              </span>
              {lastProcessTime && (
                <span className="deploy-time-pill">
                  • Updated {new Date(lastProcessTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
            <div className="deploy-file-path-row">
              <span className="deploy-file-path" title={savePath}>{savePath || 'No save path configured'}</span>
            </div>
          </div>

          <div className="deploy-file-actions-row">
            {onTriggerCompile && (
              <button
                type="button"
                className="deploy-tool-btn primary"
                onClick={onTriggerCompile}
                title="Recompile blocklists now (⌘R)"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                <span>Compile (⌘R)</span>
              </button>
            )}
            <button
              type="button"
              className={`deploy-tool-btn ${copiedKey === 'local-path' ? 'copied' : ''}`}
              onClick={() => handleCopy(savePath, 'local-path')}
              title="Copy absolute filesystem path"
            >
              <span>{copiedKey === 'local-path' ? 'Copied Path!' : 'Copy Path'}</span>
            </button>
            {window.electron?.showItemInFolder && (
              <button
                type="button"
                className="deploy-tool-btn"
                onClick={() => window.electron.showItemInFolder(savePath)}
                title="Reveal file in macOS Finder"
              >
                <span>Reveal in Finder</span>
              </button>
            )}
            {onNavigateSettings && (
              <button
                type="button"
                className="deploy-tool-btn"
                onClick={onNavigateSettings}
                title="Format & export settings"
              >
                <span>Format Settings</span>
              </button>
            )}
          </div>
        </div>

        {/* Right: LAN Feed Server Cardlet */}
        <div className={`deploy-top-server-cardlet ${serverStatus?.isRunning ? 'online' : 'offline'}`}>
          <div className="deploy-server-top-row">
            <div className="deploy-server-status-indicator">
              <span className={`deploy-server-dot ${serverStatus?.isRunning ? 'online' : 'offline'}`} />
              <span className="deploy-server-title">
                {serverStatus?.isRunning ? `LAN Server :${serverStatus.port || 9191} (Live)` : 'LAN Feed Server (Offline)'}
              </span>
            </div>
            <button
              type="button"
              className={`deploy-server-toggle-btn ${serverStatus?.isRunning ? 'stop' : 'start'}`}
              onClick={handleToggleFeedServer}
              disabled={isServerLoading}
            >
              {isServerLoading ? '…' : serverStatus?.isRunning ? 'Stop Server' : 'Start Server'}
            </button>
          </div>

          <div className="deploy-server-url-row">
            <code className="deploy-server-url" title={lanFeedUrl}>{lanFeedUrl}</code>
            <button
              type="button"
              className={`deploy-server-copy-btn ${copiedKey === 'lan-url' ? 'copied' : ''}`}
              onClick={() => handleCopy(lanFeedUrl, 'lan-url')}
              title="Copy LAN subscription URL for remote devices"
            >
              {copiedKey === 'lan-url' ? '✓ Copied' : 'Copy'}
            </button>
          </div>

          <div className="deploy-server-options-row">
            <label className="deploy-checkbox-label" title="Start LAN server when Blockingmachine launches">
              <input
                type="checkbox"
                checked={autoStartFeedServer}
                onChange={(e) => handleToggleAutoStartFeedServer(e.target.checked)}
              />
              <span>Auto-start on launch</span>
            </label>
            <label className="deploy-checkbox-label" title="Launch Blockingmachine on computer startup">
              <input
                type="checkbox"
                checked={launchOnStartup}
                onChange={(e) => handleToggleLaunchOnStartup(e.target.checked)}
              />
              <span>Launch on computer startup</span>
            </label>
          </div>
        </div>
      </div>

      {/* =========================================================================
          2. PLATFORM NAVIGATION TABS
         ========================================================================= */}
      <div className="deploy-platform-tabs" role="tablist" aria-label="Deployment Platforms">
        <button
          type="button"
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
          type="button"
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
          type="button"
          role="tab"
          aria-selected={activeTab === 'home-assistant'}
          className={`platform-tab-btn ${activeTab === 'home-assistant' ? 'active' : ''}`}
          onClick={() => setActiveTab('home-assistant')}
        >
          <span className="platform-tab-icon">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </span>
          <span className="platform-tab-label">Home Assistant</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'system-daemon'}
          className={`platform-tab-btn ${activeTab === 'system-daemon' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('system-daemon');
            refreshDaemonStatus();
          }}
        >
          <span className="platform-tab-icon">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
          </span>
          <span className="platform-tab-label">Local System DNS</span>
        </button>

        <button
          type="button"
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
          type="button"
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
          type="button"
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

      {/* =========================================================================
          3. DUAL-PANE PLATFORM WORKSPACE: ADGUARD HOME
         ========================================================================= */}
      {activeTab === 'adguard-home' && (
        <div className="deploy-dual-pane">
          {/* Left Column: Live API Automation */}
          <div className="deploy-pane-column">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">⚡</span>
                <div>
                  <h3 className="deploy-pane-title">Live API Automation</h3>
                  <p className="deploy-pane-subtitle">
                    Automate zero-touch reloads when compiling rules
                  </p>
                </div>
              </div>
              <div className="deploy-pane-status-pill">
                <span className={`status-indicator-dot ${sinkholeConfig.adguardHomeUrl ? 'active' : 'idle'}`} />
                <span>{sinkholeConfig.adguardHomeUrl ? 'Configured' : 'Not Connected'}</span>
              </div>
            </div>

            <ServiceMismatchBanner
              details={testResult?.service === 'adguard' ? testResult.details : lastSyncResult?.service?.toLowerCase().includes('adguard') ? lastSyncResult.details : undefined}
              message={testResult?.service === 'adguard' ? testResult.message : lastSyncResult?.service?.toLowerCase().includes('adguard') ? lastSyncResult.message : undefined}
              onUseDirect={() => { void applyDetectedMode('direct'); }}
              onUseHaApi={() => { void applyDetectedMode('ha-api'); }}
            />

            {/* Integration Method Selector */}
            <div className="deploy-field-group">
              <label className="deploy-field-label">Integration Method</label>
              <div className="deploy-segmented-selector">
                <button
                  type="button"
                  className={`deploy-segment-btn ${(!sinkholeConfig.adguardMode || sinkholeConfig.adguardMode === 'direct') ? 'active' : ''}`}
                  onClick={() => selectAdguardMode('direct')}
                >
                  Direct Port {directPort} (Recommended)
                </button>
                <button
                  type="button"
                  className={`deploy-segment-btn ${sinkholeConfig.adguardMode === 'ha-api' ? 'active' : ''}`}
                  onClick={() => selectAdguardMode('ha-api')}
                >
                  HA REST API
                </button>
                <button
                  type="button"
                  className={`deploy-segment-btn ${sinkholeConfig.adguardMode === 'webhook' ? 'active' : ''}`}
                  onClick={() => selectAdguardMode('webhook')}
                >
                  Webhook
                </button>
              </div>
            </div>

            {/* Fast Presets Chips */}
            <div className="deploy-fast-presets-wrap">
              <span className="fast-presets-title">Quick Presets:</span>
              <div className="fast-presets-chips">
                <button
                  type="button"
                  className="preset-chip"
                  onClick={() => selectAdguardMode('direct', { adguardHomeUrl: `http://homeassistant.local:${directPort}` })}
                >
                  homeassistant.local:{directPort}
                </button>
                <button
                  type="button"
                  className="preset-chip"
                  onClick={() => selectAdguardMode('ha-api', { adguardHomeUrl: 'http://homeassistant.local:8123' })}
                >
                  HA API (:8123)
                </button>
                <button
                  type="button"
                  className="preset-chip"
                  onClick={() => selectAdguardMode('direct', { adguardHomeUrl: `http://localhost:${directPort}` })}
                >
                  Docker (localhost)
                </button>
                <button
                  type="button"
                  className="preset-chip"
                  onClick={() => selectAdguardMode('direct', { adguardHomeUrl: `http://192.168.8.1:${directPort}` })}
                >
                  GL.iNet (192.168.8.1)
                </button>
                <button
                  type="button"
                  className="preset-chip"
                  onClick={() => selectAdguardMode('ha-api', { adguardHomeUrl: 'https://your-instance.ui.nabu.casa' })}
                >
                  Nabu Casa Cloud
                </button>
              </div>
            </div>

            {/* Credentials & Endpoint Form */}
            <div className="deploy-form-fields-grid">
              {sinkholeConfig.adguardMode === 'ha-api' ? (
                <>
                  <div className="deploy-field-group">
                    <label className="deploy-field-label">Home Assistant URL</label>
                    <input
                      type="text"
                      className="deploy-field-input"
                      placeholder="http://homeassistant.local:8123 or https://*.ui.nabu.casa"
                      value={sinkholeConfig.adguardHomeUrl || ''}
                      onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: e.target.value })}
                    />
                  </div>
                  <div className="deploy-field-group">
                    <label className="deploy-field-label">Long-Lived Access Token</label>
                    <div className="deploy-input-with-eye">
                      <input
                        type={showHaToken ? 'text' : 'password'}
                        className="deploy-field-input"
                        placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6..."
                        value={sinkholeConfig.haToken || ''}
                        onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, haToken: e.target.value })}
                      />
                      <button
                        type="button"
                        className="deploy-eye-btn"
                        onClick={() => setShowHaToken(!showHaToken)}
                      >
                        {showHaToken ? '👁' : '🔒'}
                      </button>
                    </div>
                  </div>
                  <div className="deploy-field-row">
                    <div className="deploy-field-group">
                      <label className="deploy-field-label">AdGuard Username</label>
                      <input
                        type="text"
                        className="deploy-field-input"
                        placeholder="admin"
                        value={sinkholeConfig.adguardHomeUser || ''}
                        onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUser: e.target.value })}
                      />
                    </div>
                    <div className="deploy-field-group">
                      <label className="deploy-field-label">AdGuard Password</label>
                      <div className="deploy-input-with-eye">
                        <input
                          type={showAdguardPass ? 'text' : 'password'}
                          className="deploy-field-input"
                          placeholder="••••••••"
                          value={sinkholeConfig.adguardHomePassword || ''}
                          onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomePassword: e.target.value })}
                        />
                        <button
                          type="button"
                          className="deploy-eye-btn"
                          onClick={() => setShowAdguardPass(!showAdguardPass)}
                          title={showAdguardPass ? 'Hide password' : 'Show password'}
                        >
                          {showAdguardPass ? '👁' : '🔒'}
                        </button>
                      </div>
                    </div>
                  </div>
                  <p style={{ fontSize: 10.5, color: 'var(--secondary-color)', margin: '2px 0 0', lineHeight: 1.4 }}>
                    Used for the AI Radar live query log feed. Requires AdGuard Home admin credentials.
                  </p>
                </>
              ) : sinkholeConfig.adguardMode === 'webhook' ? (
                <>
                  <div className="deploy-field-group">
                    <label className="deploy-field-label">Home Assistant Webhook URL</label>
                    <input
                      type="text"
                      className="deploy-field-input"
                      placeholder="http://homeassistant.local:8123/api/webhook/... or https://hooks.nabu.casa/..."
                      value={sinkholeConfig.haWebhookUrl || ''}
                      onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, haWebhookUrl: e.target.value })}
                    />
                  </div>
                  <div className="deploy-field-row">
                    <div className="deploy-field-group">
                      <label className="deploy-field-label">AdGuard Username</label>
                      <input
                        type="text"
                        className="deploy-field-input"
                        placeholder="admin"
                        value={sinkholeConfig.adguardHomeUser || ''}
                        onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUser: e.target.value })}
                      />
                    </div>
                    <div className="deploy-field-group">
                      <label className="deploy-field-label">AdGuard Password</label>
                      <input
                        type={showAdguardPass ? 'text' : 'password'}
                        className="deploy-field-input"
                        placeholder="••••••••"
                        value={sinkholeConfig.adguardHomePassword || ''}
                        onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomePassword: e.target.value })}
                      />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="deploy-field-row">
                    <div className="deploy-field-group" style={{ flex: 3 }}>
                      <label className="deploy-field-label">AdGuard Home URL</label>
                      <input
                        type="text"
                        className="deploy-field-input"
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
                    <div className="deploy-field-group" style={{ flex: 1 }}>
                      <label className="deploy-field-label">API Port</label>
                      <input
                        type="number"
                        className="deploy-field-input"
                        min={1}
                        max={65535}
                        value={sinkholeConfig.adguardDirectPort ?? ''}
                        onFocus={() => { directPortFocusRef.current = directPort; }}
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
                  </div>

                  <div className="deploy-field-row">
                    <div className="deploy-field-group">
                      <label className="deploy-field-label">Username</label>
                      <input
                        type="text"
                        className="deploy-field-input"
                        placeholder="admin"
                        value={sinkholeConfig.adguardHomeUser || ''}
                        onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUser: e.target.value })}
                      />
                    </div>
                    <div className="deploy-field-group">
                      <label className="deploy-field-label">Password</label>
                      <div className="deploy-input-with-eye">
                        <input
                          type={showAdguardPass ? 'text' : 'password'}
                          className="deploy-field-input"
                          placeholder="••••••••"
                          value={sinkholeConfig.adguardHomePassword || ''}
                          onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomePassword: e.target.value })}
                        />
                        <button
                          type="button"
                          className="deploy-eye-btn"
                          onClick={() => setShowAdguardPass(!showAdguardPass)}
                        >
                          {showAdguardPass ? '👁' : '🔒'}
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Local TLS Bypass Option */}
              <label className="deploy-checkbox-label" title={tlsScopeNote || undefined}>
                <input
                  type="checkbox"
                  checked={Boolean(sinkholeConfig.allowInsecureLocalTls)}
                  onChange={(e) =>
                    setSinkholeConfig({ ...sinkholeConfig, allowInsecureLocalTls: e.target.checked })
                  }
                />
                <span>Allow self-signed HTTPS / local TLS certificate bypass</span>
              </label>
            </div>

            {/* Actions Row */}
            <div className="deploy-actions-row">
              <button
                type="button"
                className="deploy-btn"
                onClick={() => handleTestConnection('adguard')}
                disabled={testingService === 'adguard'}
              >
                <span>{testingService === 'adguard' ? 'Testing…' : '⚡ Test Connection'}</span>
              </button>
              <button
                type="button"
                className="deploy-btn"
                onClick={() => handleSaveSinkholeConfig('adguard')}
                disabled={isSavingSinkhole}
              >
                <span>{isSavingSinkhole ? 'Saving…' : '💾 Save Settings'}</span>
              </button>
              <button
                type="button"
                className="deploy-btn primary"
                onClick={() => handleTriggerLiveSync('adguard')}
                disabled={isSyncingSinkhole || (!sinkholeConfig.adguardHomeUrl && !sinkholeConfig.haWebhookUrl)}
              >
                <span>{isSyncingSinkhole ? 'Reloading…' : '▶ Push Live Reload Now'}</span>
              </button>
            </div>

            {/* Auto-Push Toggle & Status Feedback */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              <label className="deploy-checkbox-label" title="Automatically reload AdGuard Home whenever you compile rules (⌘R)">
                <input
                  type="checkbox"
                  checked={sinkholeConfig.syncOnCompile}
                  onChange={(e) => handleToggleSyncOnCompile(e.target.checked)}
                />
                <span style={{ fontWeight: 600, color: 'var(--heading-color)' }}>
                  Auto-Push to AdGuard on Compile (⌘R)
                </span>
              </label>

              {sinkholeMessage && (
                <span style={{ fontSize: '11px', color: 'var(--primary-color)', fontWeight: 500 }}>
                  {sinkholeMessage}
                </span>
              )}
              {testResult?.service === 'adguard' && !isServiceMismatch(testResult.details) && (
                <span className={`test-status-pill ${testResult.success ? 'success' : 'error'}`} style={{ alignSelf: 'flex-start' }}>
                  {testResult.message}
                </span>
              )}
              {lastSyncResult?.service?.toLowerCase().includes('adguard') && !isServiceMismatch(lastSyncResult.details) && (
                <span className={`test-status-pill ${lastSyncResult.status === 'success' ? 'success' : 'error'}`} style={{ alignSelf: 'flex-start' }}>
                  Last Reload: {lastSyncResult.message} ({lastSyncResult.timestamp})
                </span>
              )}
            </div>
          </div>

          {/* Right Column: Feed Subscription & Setup Instructions */}
          <div className="deploy-pane-column">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">📡</span>
                <div>
                  <h3 className="deploy-pane-title">Feed Subscription & Setup</h3>
                  <p className="deploy-pane-subtitle">
                    Subscribe inside AdGuard Home web console
                  </p>
                </div>
              </div>
            </div>

            {/* Big Feed Subscription Box */}
            <div className="deploy-feed-box">
              <div className="deploy-feed-box-top">
                <span className="deploy-feed-box-label">LAN Subscription URL</span>
                <span className="deploy-feed-box-tag">● Live Wi-Fi Feed</span>
              </div>
              <div className="deploy-feed-input-row">
                <input type="text" readOnly value={lanFeedUrl} className="deploy-feed-input" />
                <button
                  type="button"
                  className={`deploy-copy-feed-btn ${copiedKey === 'agh-lan' ? 'copied' : ''}`}
                  onClick={() => handleCopy(lanFeedUrl, 'agh-lan')}
                >
                  {copiedKey === 'agh-lan' ? '✓ Copied' : 'Copy Feed URL'}
                </button>
              </div>
              <div className="deploy-feed-sublink-row">
                <button
                  type="button"
                  className="deploy-sublink-btn"
                  onClick={() => handleCopy(fileUrl, 'agh-file')}
                >
                  {copiedKey === 'agh-file' ? '✓ Copied file:// URL' : 'Or copy native file:// path (Mac-only setups) →'}
                </button>
              </div>
            </div>

            {/* Environment Tabs */}
            <div className="deploy-env-bar">
              <span className="deploy-env-title">Environment:</span>
              <div className="deploy-env-tabs">
                <button
                  type="button"
                  className={`env-tab-btn ${adguardEnv === 'homeassistant' ? 'active' : ''}`}
                  onClick={() => setAdguardEnv('homeassistant')}
                >
                  Home Assistant
                </button>
                <button
                  type="button"
                  className={`env-tab-btn ${adguardEnv === 'docker' ? 'active' : ''}`}
                  onClick={() => setAdguardEnv('docker')}
                >
                  Docker / NAS
                </button>
                <button
                  type="button"
                  className={`env-tab-btn ${adguardEnv === 'router' ? 'active' : ''}`}
                  onClick={() => setAdguardEnv('router')}
                >
                  GL.iNet / Router
                </button>
                <button
                  type="button"
                  className={`env-tab-btn ${adguardEnv === 'standalone' ? 'active' : ''}`}
                  onClick={() => setAdguardEnv('standalone')}
                >
                  Standalone
                </button>
              </div>
            </div>

            {/* 3-Step Setup Stepper */}
            <div className="deploy-numbered-stepper">
              <div className="stepper-step">
                <div className="stepper-num">1</div>
                <div className="stepper-content">
                  <h4>Open AdGuard Home Web Interface</h4>
                  <p>
                    {adguardEnv === 'homeassistant'
                      ? `Open Home Assistant > AdGuard Home, or navigate directly to http://homeassistant.local:${directPort}`
                      : adguardEnv === 'router'
                      ? `Navigate to your router web dashboard (default: http://192.168.8.1:${directPort})`
                      : `Open your browser to your AdGuard Home IP: http://<ip>:${directPort}`}
                  </p>
                </div>
              </div>

              <div className="stepper-step">
                <div className="stepper-num">2</div>
                <div className="stepper-content">
                  <h4>Navigate to DNS Blocklists</h4>
                  <p>In the top navigation menu, click on <strong>Filters</strong>, then choose <strong>DNS blocklists</strong>.</p>
                </div>
              </div>

              <div className="stepper-step">
                <div className="stepper-num">3</div>
                <div className="stepper-content">
                  <h4>Add Custom Blocklist & Paste Feed URL</h4>
                  <p>
                    Click <strong>Add blocklist → Add a custom list</strong>. Name it <code>Blockingmachine Compiled</code> and paste the copied LAN URL above.
                  </p>
                </div>
              </div>
            </div>

            {/* Contextual Guidance */}
            {adguardEnv === 'homeassistant' && (
              <div className="deploy-contextual-note">
                <span className="note-icon">💡</span>
                <div className="note-text">
                  <strong>Nabu Casa & Remote Access:</strong> AdGuard Home runs locally on your home network. Even if you access Home Assistant remotely using Nabu Casa, paste the <strong>LAN Feed URL</strong> above into AdGuard so it fetches blocklists over your local Wi-Fi.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          3. DUAL-PANE PLATFORM WORKSPACE: PI-HOLE
         ========================================================================= */}
      {activeTab === 'pihole' && (
        <div className="deploy-dual-pane">
          {/* Left Column: Pi-hole Live API Automation */}
          <div className="deploy-pane-column">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">⚡</span>
                <div>
                  <h3 className="deploy-pane-title">Pi-hole Gravity Automation</h3>
                  <p className="deploy-pane-subtitle">
                    Automate Pi-hole Gravity updates (`pihole -g`) over API
                  </p>
                </div>
              </div>
              <div className="deploy-pane-status-pill">
                <span className={`status-indicator-dot ${sinkholeConfig.piholeUrl ? 'active' : 'idle'}`} />
                <span>{sinkholeConfig.piholeUrl ? 'Configured' : 'Not Connected'}</span>
              </div>
            </div>

            {/* Quick Presets */}
            <div className="deploy-fast-presets-wrap">
              <span className="fast-presets-title">Quick Presets:</span>
              <div className="fast-presets-chips">
                <button
                  type="button"
                  className="preset-chip"
                  onClick={() => setSinkholeConfig({ ...sinkholeConfig, piholeUrl: 'http://pi.hole/admin' })}
                >
                  pi.hole/admin
                </button>
                <button
                  type="button"
                  className="preset-chip"
                  onClick={() => setSinkholeConfig({ ...sinkholeConfig, piholeUrl: 'http://homeassistant.local:8080/admin' })}
                >
                  HA Pi-hole (:8080)
                </button>
                <button
                  type="button"
                  className="preset-chip"
                  onClick={() => setSinkholeConfig({ ...sinkholeConfig, piholeUrl: 'http://localhost:80/admin' })}
                >
                  Docker (localhost)
                </button>
              </div>
            </div>

            {/* Credentials Form */}
            <div className="deploy-form-fields-grid">
              <div className="deploy-field-group">
                <label className="deploy-field-label">Pi-hole Admin URL</label>
                <input
                  type="text"
                  className="deploy-field-input"
                  placeholder="http://pi.hole/admin or http://192.168.1.50/admin"
                  value={sinkholeConfig.piholeUrl || ''}
                  onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, piholeUrl: e.target.value })}
                />
              </div>

              <div className="deploy-field-group">
                <label className="deploy-field-label">API Key / App Password (v5 & v6)</label>
                <div className="deploy-input-with-eye">
                  <input
                    type={showPiholeKey ? 'text' : 'password'}
                    className="deploy-field-input"
                    placeholder="Pi-hole API token (WEBPASSWORD hash or v6 app password)"
                    value={sinkholeConfig.piholeApiKey || ''}
                    onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, piholeApiKey: e.target.value })}
                  />
                  <button
                    type="button"
                    className="deploy-eye-btn"
                    onClick={() => setShowPiholeKey(!showPiholeKey)}
                  >
                    {showPiholeKey ? '👁' : '🔒'}
                  </button>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="deploy-actions-row">
              <button
                type="button"
                className="deploy-btn"
                onClick={() => handleTestConnection('pihole')}
                disabled={testingService === 'pihole'}
              >
                <span>{testingService === 'pihole' ? 'Testing…' : '⚡ Test Connection'}</span>
              </button>
              <button
                type="button"
                className="deploy-btn"
                onClick={() => handleSaveSinkholeConfig('pihole')}
                disabled={isSavingSinkhole}
              >
                <span>{isSavingSinkhole ? 'Saving…' : '💾 Save Settings'}</span>
              </button>
              <button
                type="button"
                className="deploy-btn primary"
                onClick={() => handleTriggerLiveSync('pihole')}
                disabled={isSyncingSinkhole || !sinkholeConfig.piholeUrl}
              >
                <span>{isSyncingSinkhole ? 'Reloading…' : '▶ Trigger Gravity Reload Now'}</span>
              </button>
            </div>

            {/* Auto-Push Toggle */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              <label className="deploy-checkbox-label" title="Trigger automated Gravity update after each rule compile">
                <input
                  type="checkbox"
                  checked={sinkholeConfig.syncOnCompile}
                  onChange={(e) => handleToggleSyncOnCompile(e.target.checked)}
                />
                <span style={{ fontWeight: 600, color: 'var(--heading-color)' }}>
                  Auto-Push to Pi-hole on Compile (⌘R)
                </span>
              </label>

              {sinkholeMessage && (
                <span style={{ fontSize: '11px', color: 'var(--primary-color)', fontWeight: 500 }}>
                  {sinkholeMessage}
                </span>
              )}
              {testResult?.service === 'pihole' && (
                <span className={`test-status-pill ${testResult.success ? 'success' : 'error'}`} style={{ alignSelf: 'flex-start' }}>
                  {testResult.message}
                </span>
              )}
              {lastSyncResult?.service?.toLowerCase().includes('pi-hole') && (
                <span className={`test-status-pill ${lastSyncResult.status === 'success' ? 'success' : 'error'}`} style={{ alignSelf: 'flex-start' }}>
                  Last Gravity Reload: {lastSyncResult.message} ({lastSyncResult.timestamp})
                </span>
              )}
            </div>
          </div>

          {/* Right Column: Feed Subscription & Setup Instructions */}
          <div className="deploy-pane-column">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">📡</span>
                <div>
                  <h3 className="deploy-pane-title">Feed Subscription & Setup</h3>
                  <p className="deploy-pane-subtitle">
                    Add subscription in Pi-hole Admin Console
                  </p>
                </div>
              </div>
            </div>

            {/* Big Feed Subscription Box */}
            <div className="deploy-feed-box">
              <div className="deploy-feed-box-top">
                <span className="deploy-feed-box-label">LAN Subscription URL</span>
                <span className="deploy-feed-box-tag">● Live Wi-Fi Feed</span>
              </div>
              <div className="deploy-feed-input-row">
                <input type="text" readOnly value={lanFeedUrl} className="deploy-feed-input" />
                <button
                  type="button"
                  className={`deploy-copy-feed-btn ${copiedKey === 'pi-lan' ? 'copied' : ''}`}
                  onClick={() => handleCopy(lanFeedUrl, 'pi-lan')}
                >
                  {copiedKey === 'pi-lan' ? '✓ Copied' : 'Copy Feed URL'}
                </button>
              </div>
            </div>

            {/* 3-Step Setup Stepper */}
            <div className="deploy-numbered-stepper">
              <div className="stepper-step">
                <div className="stepper-num">1</div>
                <div className="stepper-content">
                  <h4>Open Pi-hole Admin Console</h4>
                  <p>Open your browser to <code>http://pi.hole/admin</code> or your Pi-hole device IP.</p>
                </div>
              </div>

              <div className="stepper-step">
                <div className="stepper-num">2</div>
                <div className="stepper-content">
                  <h4>Navigate to Adlists</h4>
                  <p>In the left sidebar menu, click on <strong>Adlists</strong> (or <strong>Lists</strong> in v6).</p>
                </div>
              </div>

              <div className="stepper-step">
                <div className="stepper-num">3</div>
                <div className="stepper-content">
                  <h4>Add Subscription Address & Update Gravity</h4>
                  <p>
                    Paste the LAN URL into the <strong>Address</strong> field and click <strong>Add</strong>. Then run Gravity update:
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <code style={{ background: 'var(--bg-color)', padding: '3px 8px', borderRadius: 4 }}>pihole -g</code>
                    <button
                      type="button"
                      className="deploy-tool-btn"
                      onClick={() => handleCopy('pihole -g', 'pi-cmd')}
                    >
                      {copiedKey === 'pi-cmd' ? 'Copied!' : 'Copy Command'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          3. PLATFORM WORKSPACE: HOME ASSISTANT (ADD-ON & INTEGRATION)
         ========================================================================= */}
      {activeTab === 'home-assistant' && (
        <div className="deploy-dual-pane">
          {/* Left Column: Home Assistant Automation & Live Sync */}
          <div className="deploy-pane-column">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">🏠</span>
                <div>
                  <h3 className="deploy-pane-title">Home Assistant Hub Connection</h3>
                  <p className="deploy-pane-subtitle">
                    Control AdGuard & Pi-hole Add-ons via Home Assistant REST or Webhook
                  </p>
                </div>
              </div>
              <div className="deploy-pane-status-pill">
                <span className={`status-indicator-dot ${sinkholeConfig.haToken || sinkholeConfig.haWebhookUrl ? 'active' : 'idle'}`} />
                <span>{sinkholeConfig.haToken || sinkholeConfig.haWebhookUrl ? 'Configured' : 'Not Connected'}</span>
              </div>
            </div>

            <div className="deploy-pane-body">
              <div className="deploy-field-group">
                <label className="deploy-field-label">Home Assistant Mode</label>
                <div className="deploy-mode-selector">
                  <button
                    type="button"
                    className={`deploy-mode-pill ${sinkholeConfig.adguardMode === 'ha-api' ? 'active' : ''}`}
                    onClick={() => setSinkholeConfig({ ...sinkholeConfig, adguardMode: 'ha-api' })}
                  >
                    REST Service API
                  </button>
                  <button
                    type="button"
                    className={`deploy-mode-pill ${sinkholeConfig.adguardMode === 'webhook' ? 'active' : ''}`}
                    onClick={() => setSinkholeConfig({ ...sinkholeConfig, adguardMode: 'webhook' })}
                  >
                    Webhook
                  </button>
                </div>
              </div>

              {sinkholeConfig.adguardMode === 'ha-api' && (
                <>
                  <div className="deploy-field-group">
                    <label className="deploy-field-label">Home Assistant Instance URL</label>
                    <input
                      type="url"
                      className="deploy-text-input"
                      placeholder="http://homeassistant.local:8123 or Nabu Casa Cloud URL"
                      value={sinkholeConfig.adguardHomeUrl || ''}
                      onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: e.target.value })}
                    />
                    <span className="deploy-field-hint">
                      Connects directly to your Home Assistant instance (Local or Nabu Casa Cloud)
                    </span>
                  </div>

                  <div className="deploy-field-group">
                    <label className="deploy-field-label">Long-Lived Access Token</label>
                    <div className="deploy-input-with-action">
                      <input
                        type={showHaToken ? 'text' : 'password'}
                        className="deploy-text-input"
                        placeholder="Bearer token from your Home Assistant profile"
                        value={sinkholeConfig.haToken || ''}
                        onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, haToken: e.target.value })}
                      />
                      <button
                        type="button"
                        className="deploy-input-icon-btn"
                        onClick={() => setShowHaToken(!showHaToken)}
                        title={showHaToken ? 'Hide token' : 'Show token'}
                      >
                        {showHaToken ? '👁️' : '🔒'}
                      </button>
                    </div>
                    <span className="deploy-field-hint">
                      Generate in Home Assistant: Profile &gt; Long-Lived Access Tokens
                    </span>
                  </div>
                </>
              )}

              {sinkholeConfig.adguardMode === 'webhook' && (
                <div className="deploy-field-group">
                  <label className="deploy-field-label">Home Assistant Webhook URL</label>
                  <input
                    type="url"
                    className="deploy-text-input"
                    placeholder="https://hooks.nabu.casa/... or http://homeassistant.local:8123/api/webhook/..."
                    value={sinkholeConfig.haWebhookUrl || ''}
                    onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, haWebhookUrl: e.target.value })}
                  />
                  <span className="deploy-field-hint">
                    Triggers your Home Assistant automation to reload AdGuard or Pi-hole
                  </span>
                </div>
              )}

              <div className="deploy-field-group">
                <label className="deploy-checkbox-label">
                  <input
                    type="checkbox"
                    checked={sinkholeConfig.syncOnCompile}
                    onChange={(e) => handleToggleSyncOnCompile(e.target.checked)}
                  />
                  <span>Automatically push & reload Home Assistant when compiling filters</span>
                </label>
              </div>

              <div className="deploy-btn-row">
                <button
                  type="button"
                  className="deploy-primary-btn"
                  onClick={() => handleSaveSinkholeConfig('adguard')}
                  disabled={isSavingSinkhole}
                >
                  {isSavingSinkhole ? 'Saving...' : 'Save Connection'}
                </button>
                <button
                  type="button"
                  className="deploy-secondary-btn"
                  onClick={() => handleTestConnection('adguard')}
                  disabled={testingService !== null}
                >
                  {testingService === 'adguard' ? 'Testing...' : 'Test Connection'}
                </button>
                <button
                  type="button"
                  className="deploy-secondary-btn"
                  onClick={() => handleTriggerLiveSync('adguard')}
                  disabled={isSyncingSinkhole}
                >
                  {isSyncingSinkhole ? 'Reloading...' : 'Reload Home Assistant'}
                </button>
              </div>

              {sinkholeMessage && (
                <div className="deploy-message-banner success">{sinkholeMessage}</div>
              )}

              {testResult && testResult.service === 'adguard' && (
                <div className={`deploy-test-result-box ${testResult.success ? 'success' : 'error'}`}>
                  <strong>{testResult.success ? '✓ Connection Verified' : '✕ Connection Error'}:</strong>{' '}
                  {testResult.message}
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Home Assistant Integration & Add-on Hub */}
          <div className="deploy-pane-column">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">🧩</span>
                <div>
                  <h3 className="deploy-pane-title">Integration & Add-on Endpoints</h3>
                  <p className="deploy-pane-subtitle">
                    Expose live metrics, sensors, and controls into your Home Assistant dashboards
                  </p>
                </div>
              </div>
            </div>

            <div className="deploy-pane-body">
              {/* Endpoint 1: REST API /v1/status */}
              <div className="deploy-feed-box">
                <div className="deploy-feed-box-top">
                  <span className="deploy-feed-box-label">📡 Home Assistant Integration API</span>
                  <span className="deploy-feed-box-tag">HACS / Custom Component</span>
                </div>
                <p className="deploy-feed-box-desc">
                  Point the Home Assistant <code>blockingmachine</code> integration at this desktop app:
                </p>
                <div className="deploy-feed-input-row">
                  <input
                    type="text"
                    readOnly
                    value={`http://${serverStatus?.lanIp || '127.0.0.1'}:${serverStatus?.port || 9191}/v1/status`}
                    className="deploy-feed-input"
                  />
                  <button
                    type="button"
                    className={`deploy-copy-feed-btn ${copiedKey === 'ha-status-url' ? 'copied' : ''}`}
                    onClick={() => handleCopy(`http://${serverStatus?.lanIp || '127.0.0.1'}:${serverStatus?.port || 9191}/v1/status`, 'ha-status-url')}
                  >
                    {copiedKey === 'ha-status-url' ? '✓ Copied' : 'Copy API URL'}
                  </button>
                </div>
              </div>

              {/* Endpoint 2: DNS Feed for AdGuard Home in HA */}
              <div className="deploy-feed-box">
                <div className="deploy-feed-box-top">
                  <span className="deploy-feed-box-label">🛡️ Pure DNS Feed (AdGuard Home in HA)</span>
                  <span className="deploy-feed-box-tag">Zero Browser Modifiers</span>
                </div>
                <div className="deploy-feed-input-row">
                  <input
                    type="text"
                    readOnly
                    value={`http://${serverStatus?.lanIp || '127.0.0.1'}:${serverStatus?.port || 9191}/dns.txt`}
                    className="deploy-feed-input"
                  />
                  <button
                    type="button"
                    className={`deploy-copy-feed-btn ${copiedKey === 'ha-dns-feed' ? 'copied' : ''}`}
                    onClick={() => handleCopy(`http://${serverStatus?.lanIp || '127.0.0.1'}:${serverStatus?.port || 9191}/dns.txt`, 'ha-dns-feed')}
                  >
                    {copiedKey === 'ha-dns-feed' ? '✓ Copied' : 'Copy DNS Feed'}
                  </button>
                </div>
              </div>

              {/* Endpoint 3: Browser Feed */}
              <div className="deploy-feed-box">
                <div className="deploy-feed-box-top">
                  <span className="deploy-feed-box-label">🌐 Browser Extension Feed</span>
                  <span className="deploy-feed-box-tag">Network + Cosmetics</span>
                </div>
                <div className="deploy-feed-input-row">
                  <input
                    type="text"
                    readOnly
                    value={`http://${serverStatus?.lanIp || '127.0.0.1'}:${serverStatus?.port || 9191}/browser.txt`}
                    className="deploy-feed-input"
                  />
                  <button
                    type="button"
                    className={`deploy-copy-feed-btn ${copiedKey === 'ha-browser-feed' ? 'copied' : ''}`}
                    onClick={() => handleCopy(`http://${serverStatus?.lanIp || '127.0.0.1'}:${serverStatus?.port || 9191}/browser.txt`, 'ha-browser-feed')}
                  >
                    {copiedKey === 'ha-browser-feed' ? '✓ Copied' : 'Copy Browser Feed'}
                  </button>
                </div>
              </div>

              {/* Endpoint 4: AI Threat Quarantine Feed (ABP Format) */}
              <div className="deploy-feed-box">
                <div className="deploy-feed-box-top">
                  <span className="deploy-feed-box-label">⚡ AI Threat Quarantine Feed (ABP Format)</span>
                  <span className="deploy-feed-box-tag">Auto-updating DGA / Malware</span>
                </div>
                <div className="deploy-feed-input-row">
                  <input
                    type="text"
                    readOnly
                    value={`http://${serverStatus?.lanIp || '127.0.0.1'}:${serverStatus?.port || 9191}/threats.txt`}
                    className="deploy-feed-input"
                  />
                  <button
                    type="button"
                    className={`deploy-copy-feed-btn ${copiedKey === 'ha-threats-abp-feed' ? 'copied' : ''}`}
                    onClick={() => handleCopy(`http://${serverStatus?.lanIp || '127.0.0.1'}:${serverStatus?.port || 9191}/threats.txt`, 'ha-threats-abp-feed')}
                  >
                    {copiedKey === 'ha-threats-abp-feed' ? '✓ Copied' : 'Copy ABP Threats'}
                  </button>
                </div>
              </div>

              {/* Endpoint 5: AI Threat Quarantine Feed (Domain List) */}
              <div className="deploy-feed-box">
                <div className="deploy-feed-box-top">
                  <span className="deploy-feed-box-label">🛑 AI Threat Feed (Raw Domains)</span>
                  <span className="deploy-feed-box-tag">Zero-Day High Entropy</span>
                </div>
                <div className="deploy-feed-input-row">
                  <input
                    type="text"
                    readOnly
                    value={`http://${serverStatus?.lanIp || '127.0.0.1'}:${serverStatus?.port || 9191}/ai-threats.txt`}
                    className="deploy-feed-input"
                  />
                  <button
                    type="button"
                    className={`deploy-copy-feed-btn ${copiedKey === 'ha-threats-raw-feed' ? 'copied' : ''}`}
                    onClick={() => handleCopy(`http://${serverStatus?.lanIp || '127.0.0.1'}:${serverStatus?.port || 9191}/ai-threats.txt`, 'ha-threats-raw-feed')}
                  >
                    {copiedKey === 'ha-threats-raw-feed' ? '✓ Copied' : 'Copy Domain Feed'}
                  </button>
                </div>
              </div>

              {/* Live Status Inspector */}
              <div className="deploy-tool-box">
                <div className="deploy-tool-box-header">
                  <strong>Inspect Live /v1/status Output</strong>
                  <button
                    type="button"
                    className="deploy-tool-btn"
                    onClick={handleInspectHaApi}
                    disabled={isTestingHaApi}
                  >
                    {isTestingHaApi ? 'Querying...' : 'Fetch Live JSON'}
                  </button>
                </div>
                {haApiPreview && (
                  <pre className="deploy-json-preview">{haApiPreview}</pre>
                )}
              </div>

              {/* Setup Guide */}
              <div className="deploy-instructions-box">
                <h4 className="deploy-instructions-title">Quick Setup in Home Assistant:</h4>
                <ol className="deploy-instructions-list">
                  <li>
                    Copy <code>packages/homeassistant-integration/custom_components/blockingmachine</code> into your HA <code>config/custom_components/</code> folder (or install via HACS).
                  </li>
                  <li>Restart Home Assistant.</li>
                  <li>
                    Go to <strong>Settings</strong> &gt; <strong>Devices &amp; Services</strong> &gt; <strong>Add Integration</strong> &gt; search <strong>Blockingmachine</strong>.
                  </li>
                  <li>
                    Enter Host <code>{serverStatus?.lanIp || '127.0.0.1'}</code> and Port <code>{serverStatus?.port || 9191}</code>.
                  </li>
                  <li>Your Home Assistant dashboard will automatically gain live sensors, compile buttons, and protection switches!</li>
                </ol>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          2.4 PLATFORM WORKSPACE: LOCAL SYSTEM DNS DAEMON
         ========================================================================= */}
      {activeTab === 'system-daemon' && (
        <div className="deploy-dual-pane">
          {/* Left Column: Local Daemon Status & System DNS */}
          <div className="deploy-pane-column">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">🖥️</span>
                <div>
                  <h3 className="deploy-pane-title">Local DNS Filtering Proxy</h3>
                  <p className="deploy-pane-subtitle">
                    Zero-latency, on-device loopback filtering for all system apps and network traffic
                  </p>
                </div>
              </div>
              <div
                className={`deploy-pane-status-pill ${
                  daemonStatus?.status === 'running'
                    ? 'connected'
                    : daemonStatus?.status === 'paused'
                    ? 'testing'
                    : 'idle'
                }`}
              >
                {daemonStatus?.status === 'running'
                  ? '● Active Shield'
                  : daemonStatus?.status === 'paused'
                  ? '⏸ Paused'
                  : '○ Daemon Inactive'}
              </div>
            </div>

            <div className="deploy-pane-body">
              {/* Daemon Status Summary Box */}
              <div className="deploy-feed-box">
                <div className="deploy-feed-box-top">
                  <span className="deploy-feed-box-label">⚙️ Daemon Process Status</span>
                  <span className="deploy-feed-box-tag">
                    {daemonStatus?.managedByApp ? 'Managed by App' : 'External / Service'}
                  </span>
                </div>
                <div className="deploy-form-fields-grid" style={{ marginTop: '8px' }}>
                  <div className="deploy-field-group">
                    <span className="deploy-field-label">DNS Port</span>
                    <strong style={{ fontSize: '13px', color: 'var(--text-color, #e0e0e0)' }}>
                      {daemonStatus?.port || 5353} (UDP)
                    </strong>
                  </div>
                  <div className="deploy-field-group">
                    <span className="deploy-field-label">Control Port</span>
                    <strong style={{ fontSize: '13px', color: 'var(--text-color, #e0e0e0)' }}>
                      {daemonStatus?.controlPort || 9292} (HTTP)
                    </strong>
                  </div>
                  <div className="deploy-field-group">
                    <span className="deploy-field-label">Loaded Rules</span>
                    <strong style={{ fontSize: '13px', color: 'var(--accent-color, #00d26a)' }}>
                      {daemonStatus?.rulesLoaded?.toLocaleString() || '0'}
                    </strong>
                  </div>
                  <div className="deploy-field-group">
                    <span className="deploy-field-label">Upstream DoH</span>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted, #888)' }} title={daemonStatus?.upstream}>
                      {daemonStatus?.upstream ? new URL(daemonStatus.upstream).hostname : 'dns.quad9.net'}
                    </span>
                  </div>
                </div>

                <div className="deploy-sync-actions-row" style={{ marginTop: '14px' }}>
                  {daemonStatus?.status === 'stopped' ? (
                    <button
                      type="button"
                      className="deploy-sync-btn primary"
                      onClick={handleStartDaemon}
                      disabled={isDaemonLoading}
                    >
                      {isDaemonLoading ? 'Starting...' : 'Start Local Daemon'}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="deploy-sync-btn"
                        onClick={handleToggleDaemonProtection}
                        disabled={isDaemonLoading}
                      >
                        {daemonStatus?.status === 'running' ? 'Pause Protection' : 'Resume Protection'}
                      </button>
                      <button
                        type="button"
                        className="deploy-sync-btn"
                        onClick={handleReloadDaemon}
                        disabled={isDaemonLoading}
                      >
                        Reload Rules
                      </button>
                      {daemonStatus?.managedByApp && (
                        <button
                          type="button"
                          className="deploy-sync-btn danger"
                          onClick={handleStopDaemon}
                          disabled={isDaemonLoading}
                        >
                          Stop Daemon
                        </button>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="deploy-test-btn"
                    onClick={refreshDaemonStatus}
                    disabled={isDaemonLoading}
                  >
                    Refresh
                  </button>
                </div>
              </div>

              {/* OS Resolver Configuration Box */}
              <div className="deploy-feed-box" style={{ marginTop: '16px' }}>
                <div className="deploy-feed-box-top">
                  <span className="deploy-feed-box-label">🌐 Operating System DNS Resolver</span>
                  <span className="deploy-feed-box-tag">macOS / Linux</span>
                </div>
                <p className="deploy-feed-box-desc">
                  Point your computer's network interface directly to <code>127.0.0.1</code> to block ads across all native desktop applications:
                </p>

                <div className="deploy-field-group" style={{ marginBottom: '10px' }}>
                  <label className="deploy-field-label">Network Interface:</label>
                  <select
                    className="deploy-field-input"
                    value={selectedService}
                    onChange={(e) => setSelectedService(e.target.value)}
                  >
                    {networkServices.map((svc) => (
                      <option key={svc} value={svc}>
                        {svc}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="deploy-sync-actions-row">
                  <button
                    type="button"
                    className="deploy-sync-btn primary"
                    onClick={handleSetSystemDns}
                    disabled={isDaemonLoading}
                  >
                    Set as System DNS (127.0.0.1)
                  </button>
                  <button
                    type="button"
                    className="deploy-sync-btn"
                    onClick={handleRestoreSystemDns}
                    disabled={isDaemonLoading}
                  >
                    Restore DHCP Default
                  </button>
                  <button
                    type="button"
                    className="deploy-test-btn"
                    onClick={handleFlushCache}
                    disabled={isDaemonLoading}
                  >
                    Flush DNS Cache
                  </button>
                </div>
              </div>

              {daemonMessage && (
                <div className="deploy-message-banner success" style={{ marginTop: '12px' }}>
                  {daemonMessage}
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Live Telemetry & OS Service Installation */}
          <div className="deploy-pane-column">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">📊</span>
                <div>
                  <h3 className="deploy-pane-title">DNS Telemetry &amp; Service Setup</h3>
                  <p className="deploy-pane-subtitle">
                    Live loopback traffic metrics and OS background daemon configuration
                  </p>
                </div>
              </div>
            </div>

            <div className="deploy-pane-body">
              {/* Telemetry Stat Cards */}
              <div className="deploy-feed-box">
                <div className="deploy-feed-box-top">
                  <span className="deploy-feed-box-label">📈 Real-Time DNS Traffic</span>
                  <span className="deploy-feed-box-tag">Live Feed</span>
                </div>
                <div className="deploy-form-fields-grid" style={{ marginTop: '8px' }}>
                  <div className="deploy-field-group">
                    <span className="deploy-field-label">Total Queries</span>
                    <strong style={{ fontSize: '16px', color: 'var(--text-color, #fff)' }}>
                      {daemonStatus?.stats?.totalQueries?.toLocaleString() || '0'}
                    </strong>
                  </div>
                  <div className="deploy-field-group">
                    <span className="deploy-field-label">Blocked Trackers</span>
                    <strong style={{ fontSize: '16px', color: '#ff4d4f' }}>
                      {daemonStatus?.stats?.blockedQueries?.toLocaleString() || '0'}
                    </strong>
                  </div>
                  <div className="deploy-field-group">
                    <span className="deploy-field-label">Allowed Queries</span>
                    <strong style={{ fontSize: '16px', color: '#00d26a' }}>
                      {daemonStatus?.stats?.allowedQueries?.toLocaleString() || '0'}
                    </strong>
                  </div>
                  <div className="deploy-field-group">
                    <span className="deploy-field-label">Block Rate</span>
                    <strong style={{ fontSize: '16px', color: '#1890ff' }}>
                      {daemonStatus?.stats?.blockRatePercent != null ? `${daemonStatus.stats.blockRatePercent}%` : '0%'}
                    </strong>
                  </div>
                </div>
              </div>

              {/* OS Background Service Installation */}
              <div className="deploy-instructions-box" style={{ marginTop: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 className="deploy-instructions-title" style={{ margin: 0 }}>
                    Install as OS Background Service (Port 53)
                  </h4>
                  <button
                    type="button"
                    className="deploy-tool-btn"
                    onClick={handleToggleInstallScripts}
                  >
                    {showInstallScripts ? 'Hide Scripts' : 'View Install Scripts'}
                  </button>
                </div>
                <p className="deploy-feed-box-desc" style={{ marginTop: '8px' }}>
                  Running Blockingmachine as a system daemon on port 53 starts automatically at boot and protects all users, background tasks, and browsers with zero overhead.
                </p>

                {showInstallScripts && serviceScripts && (
                  <div style={{ marginTop: '12px' }}>
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 600 }}>macOS launchd Plist &amp; Commands</span>
                        <button
                          type="button"
                          className="deploy-copy-feed-btn"
                          onClick={() => handleCopy(serviceScripts.mac, 'mac-daemon-script')}
                        >
                          {copiedKey === 'mac-daemon-script' ? '✓ Copied' : 'Copy Commands'}
                        </button>
                      </div>
                      <pre className="deploy-json-preview" style={{ maxHeight: '160px' }}>{serviceScripts.mac}</pre>
                    </div>

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 600 }}>Linux systemd Unit &amp; Commands</span>
                        <button
                          type="button"
                          className="deploy-copy-feed-btn"
                          onClick={() => handleCopy(serviceScripts.linux, 'linux-daemon-script')}
                        >
                          {copiedKey === 'linux-daemon-script' ? '✓ Copied' : 'Copy Commands'}
                        </button>
                      </div>
                      <pre className="deploy-json-preview" style={{ maxHeight: '160px' }}>{serviceScripts.linux}</pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          3. PLATFORM WORKSPACE: ADGUARD APP (DESKTOP)
         ========================================================================= */}
      {activeTab === 'adguard-desktop' && (
        <div className="deploy-single-platform-wrap">
          <div className="deploy-info-card">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">💻</span>
                <div>
                  <h3 className="deploy-pane-title">Local Subscription Endpoints</h3>
                  <p className="deploy-pane-subtitle">Direct file:// or HTTP subscription for AdGuard Desktop</p>
                </div>
              </div>
            </div>

            <div className="deploy-feed-box">
              <div className="deploy-feed-box-top">
                <span className="deploy-feed-box-label">Local File URL (Native Mac App)</span>
              </div>
              <div className="deploy-feed-input-row">
                <input type="text" readOnly value={fileUrl} className="deploy-feed-input" />
                <button
                  type="button"
                  className={`deploy-copy-feed-btn ${copiedKey === 'app-file' ? 'copied' : ''}`}
                  onClick={() => handleCopy(fileUrl, 'app-file')}
                >
                  {copiedKey === 'app-file' ? '✓ Copied' : 'Copy file:// URL'}
                </button>
              </div>
            </div>

            <div className="deploy-feed-box">
              <div className="deploy-feed-box-top">
                <span className="deploy-feed-box-label">Localhost HTTP URL</span>
              </div>
              <div className="deploy-feed-input-row">
                <input type="text" readOnly value={localHttpUrl} className="deploy-feed-input" />
                <button
                  type="button"
                  className={`deploy-copy-feed-btn ${copiedKey === 'app-http' ? 'copied' : ''}`}
                  onClick={() => handleCopy(localHttpUrl, 'app-http')}
                >
                  {copiedKey === 'app-http' ? '✓ Copied' : 'Copy Localhost URL'}
                </button>
              </div>
            </div>
          </div>

          <div className="deploy-info-card">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">📖</span>
                <div>
                  <h3 className="deploy-pane-title">Setup in AdGuard for Mac / Windows</h3>
                  <p className="deploy-pane-subtitle">Steps to add custom filter list</p>
                </div>
              </div>
            </div>

            <div className="deploy-numbered-stepper">
              <div className="stepper-step">
                <div className="stepper-num">1</div>
                <div className="stepper-content">
                  <h4>Open Preferences / Settings</h4>
                  <p>Launch AdGuard and open <strong>Settings</strong> (or press <code>⌘,</code> on macOS).</p>
                </div>
              </div>

              <div className="stepper-step">
                <div className="stepper-num">2</div>
                <div className="stepper-content">
                  <h4>Navigate to Filters → Custom</h4>
                  <p>Select the <strong>Filters</strong> tab, scroll down to <strong>Custom</strong>, and click <strong>Add custom filter</strong>.</p>
                </div>
              </div>

              <div className="stepper-step">
                <div className="stepper-num">3</div>
                <div className="stepper-content">
                  <h4>Paste URL & Subscribe</h4>
                  <p>Paste the copied <code>file://</code> or <code>http://localhost:9191</code> URL into the address field and click <strong>Subscribe</strong>.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          3. PLATFORM WORKSPACE: SYSTEM HOSTS
         ========================================================================= */}
      {activeTab === 'hosts' && (
        <div className="deploy-single-platform-wrap">
          <div className="deploy-info-card">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">📄</span>
                <div>
                  <h3 className="deploy-pane-title">System /etc/hosts Export</h3>
                  <p className="deploy-pane-subtitle">Apply DNS sinkhole directly to local machine OS</p>
                </div>
              </div>
            </div>

            <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
              Export format must be set to <code>hosts</code> in Format Settings to generate standard IP mapping lines (<code>0.0.0.0 domain.com</code>).
            </p>

            <div className="deploy-feed-box">
              <div className="deploy-feed-box-top">
                <span className="deploy-feed-box-label">One-Click Terminal Command</span>
                <span className="deploy-feed-box-tag">macOS & Linux</span>
              </div>
              <div className="deploy-feed-input-row">
                <input
                  type="text"
                  readOnly
                  value={`sudo cp "${savePath}" /etc/hosts && sudo killall -HUP mDNSResponder`}
                  className="deploy-feed-input"
                />
                <button
                  type="button"
                  className={`deploy-copy-feed-btn ${copiedKey === 'hosts-cmd' ? 'copied' : ''}`}
                  onClick={() =>
                    handleCopy(
                      `sudo cp "${savePath}" /etc/hosts && sudo killall -HUP mDNSResponder`,
                      'hosts-cmd'
                    )
                  }
                >
                  {copiedKey === 'hosts-cmd' ? '✓ Copied' : 'Copy Command'}
                </button>
              </div>
            </div>
          </div>

          <div className="deploy-info-card">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">⚙️</span>
                <div>
                  <h3 className="deploy-pane-title">Manual Installation</h3>
                  <p className="deploy-pane-subtitle">Safe application instructions</p>
                </div>
              </div>
            </div>

            <div className="deploy-numbered-stepper">
              <div className="stepper-step">
                <div className="stepper-num">1</div>
                <div className="stepper-content">
                  <h4>Backup Existing Hosts File</h4>
                  <p>In Terminal: <code>sudo cp /etc/hosts /etc/hosts.bak</code></p>
                </div>
              </div>

              <div className="stepper-step">
                <div className="stepper-num">2</div>
                <div className="stepper-content">
                  <h4>Overwrite or Append</h4>
                  <p>Copy compiled output over <code>/etc/hosts</code> using the command on the left.</p>
                </div>
              </div>

              <div className="stepper-step">
                <div className="stepper-num">3</div>
                <div className="stepper-content">
                  <h4>Flush DNS Cache</h4>
                  <p>Flush system resolver cache: <code>sudo killall -HUP mDNSResponder</code></p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          3. PLATFORM WORKSPACE: ROUTERS & DNS
         ========================================================================= */}
      {activeTab === 'dnsmasq' && (
        <div className="deploy-single-platform-wrap">
          <div className="deploy-info-card">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">🌐</span>
                <div>
                  <h3 className="deploy-pane-title">Network DNS Stream URL</h3>
                  <p className="deploy-pane-subtitle">Technitium, dnsmasq, pfSense, OPNsense</p>
                </div>
              </div>
            </div>

            <div className="deploy-feed-box">
              <div className="deploy-feed-box-top">
                <span className="deploy-feed-box-label">HTTP Feed Stream URL</span>
                <span className="deploy-feed-box-tag">LAN Broadcast</span>
              </div>
              <div className="deploy-feed-input-row">
                <input type="text" readOnly value={lanFeedUrl} className="deploy-feed-input" />
                <button
                  type="button"
                  className={`deploy-copy-feed-btn ${copiedKey === 'router-lan' ? 'copied' : ''}`}
                  onClick={() => handleCopy(lanFeedUrl, 'router-lan')}
                >
                  {copiedKey === 'router-lan' ? '✓ Copied' : 'Copy Feed URL'}
                </button>
              </div>
            </div>

            <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
              Use this HTTP feed address inside Technitium Block Lists, or schedule automated cron fetching in dnsmasq / Unbound.
            </p>
          </div>

          <div className="deploy-info-card">
            <div className="deploy-pane-header">
              <div className="deploy-pane-title-group">
                <span className="deploy-pane-icon-badge">📋</span>
                <div>
                  <h3 className="deploy-pane-title">Router Setup Recipes</h3>
                  <p className="deploy-pane-subtitle">Popular router architectures</p>
                </div>
              </div>
            </div>

            <div className="deploy-numbered-stepper">
              <div className="stepper-step">
                <div className="stepper-num">1</div>
                <div className="stepper-content">
                  <h4>Technitium DNS Server</h4>
                  <p>In Technitium Admin, go to <strong>Settings</strong> → <strong>Blocking</strong> → <strong>Block List URLs</strong>, paste the LAN Feed URL, and click <strong>Save</strong>.</p>
                </div>
              </div>

              <div className="stepper-step">
                <div className="stepper-num">2</div>
                <div className="stepper-content">
                  <h4>OpenWrt / dnsmasq Cron Job</h4>
                  <p>
                    Download and reload daily: <br />
                    <code>0 4 * * * curl -s &quot;{lanFeedUrl}&quot; -o /etc/dnsmasq.d/blockingmachine.conf && /etc/init.d/dnsmasq reload</code>
                  </p>
                </div>
              </div>

              <div className="stepper-step">
                <div className="stepper-num">3</div>
                <div className="stepper-content">
                  <h4>pfSense / OPNsense (Unbound / pfBlockerNG)</h4>
                  <p>In pfBlockerNG, create a new <strong>DNSBL Feed</strong> pointing to the LAN Feed URL with Action: <strong>Unbound</strong>.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
