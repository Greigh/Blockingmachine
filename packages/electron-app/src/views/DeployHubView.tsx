import React, { useState, useEffect, useCallback, useRef } from 'react';
import type {
  FilterFormat,
  FeedServerStatus,
  SinkholeTestResult,
  SinkholeConfig,
  DaemonStatusInfo,
  UnboundResolverSettings,
} from '../types/';
import type { TierPlanResult } from '../components/ExtensionTierPlanCard';
import type {
  UnboundReachability,
  UnboundReachabilitySnapshot,
} from '../unboundReachability';
import { separateAdguardUrls } from '../queryLogScout';
import {
  DEFAULT_ADGUARD_DIRECT_PORT,
  normalizeAdguardDirectPort,
} from '../sinkholeNet';
import type { BindMechanism } from '../bindDeploy';
import { DeployHubHeader } from '../deploy/DeployHubHeader';
import {
  DEFAULT_DEPLOY_TARGET_ID,
  DEPLOY_TARGETS,
  deployTargetById,
  isDeployTargetId,
  type DeployTargetId,
  type DeploySelectEffect,
} from '../deploy/deployTargets';
import { pickPaneProps } from '../deploy/panes/paneProps';
import type { HubPaneProps } from '../deploy/panes/paneProps';
import { copyTextToClipboard } from '../clipboard';

/**
 * The Deploy Hub: the state behind every platform, and nothing else.
 *
 * Each platform's screen lives in `deploy/panes/`, one component per target, and the registry says
 * which pane belongs to which tab; the top bar is `deploy/DeployHubHeader`, markup over the same
 * boundary. What is left here is the part that cannot be per-platform — the compiled list's path
 * and format, the LAN server's status, the sinkhole credentials three targets share, the daemon's
 * service state — plus the effects those screens trigger and the handlers the header's buttons
 * call.
 *
 * Keeping the state here rather than in each pane is a deliberate cost, and it buys two things. The
 * panes stay pure functions of props, so a pane can be rendered in a test from an object literal
 * without a renderer, an Electron bridge or a mounted component. And state that outlives a tab
 * switch outlives it: the BIND mechanism, a revealed password field and the last sync result are
 * still there when the user comes back, which they would not be if each pane owned its own copy and
 * unmounted the moment another tab was chosen.
 */
interface DeployHubViewProps {
  savePath: string;
  onNavigateSettings?: () => void;
  onTriggerCompile?: () => void;
}

/** The registry owns the id union, so the tabs and the pane dispatch cannot drift apart. */
type PlatformTab = DeployTargetId;

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

  const [activeTab, setActiveTab] = useState<PlatformTab>(DEFAULT_DEPLOY_TARGET_ID);
  const [exportFormat, setExportFormat] = useState<FilterFormat>('adguard');
  // Which of BIND's two blocking mechanisms the pane is writing a recipe for. Local to the pane
  // rather than a stored setting, because it chooses between two recipes rather than describing a
  // deployment \u2014 and the export format below is what actually has to match it.
  const [bindMechanism, setBindMechanism] = useState<BindMechanism>('rpz');
  const [serverStatus, setServerStatus] = useState<FeedServerStatus | null>(null);
  const [isServerLoading, setIsServerLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [lastProcessTime, setLastProcessTime] = useState<string | null>(null);
  const [uniqueRulesCount, setUniqueRulesCount] = useState<number | null>(null);

  // Home Assistant Live API inspector
  const [haApiPreview, setHaApiPreview] = useState<string | null>(null);
  const [tierPlanState, setTierPlanState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tierPlan, setTierPlan] = useState<TierPlanResult | null>(null);
  const [tierPlanError, setTierPlanError] = useState<string | null>(null);
  const [extensionSaving, setExtensionSaving] = useState(false);
  const [extensionSavedPath, setExtensionSavedPath] = useState<string | null>(null);
  const [extensionMessage, setExtensionMessage] = useState<{
    text: string;
    type: 'success' | 'error';
  } | null>(null);

  /**
   * Reads the extension's tier plan from the main process.
   *
   * No capacity is sent, so the plan is computed against Chrome's guaranteed 30,000 — which is the
   * honest number for a checkout, and is stated as such in the plan's own explanation. A figure
   * the browser is actually granting cannot be known outside a browser, and inventing one here
   * would make the hub's answer look like a measurement.
   */
  const loadTierPlan = useCallback(async () => {
    if (!window.electron?.getExtensionTierPlan) return;
    setTierPlanState((prev) => (prev === 'ready' ? prev : 'loading'));
    try {
      // No arguments: the main process supplies the remembered ledger itself, so a plan cannot
      // silently revert to rule counts because this view forgot to pass one.
      const res = await window.electron.getExtensionTierPlan();
      if (!isMountedRef.current) return;
      if (res?.ok) {
        setTierPlan(res);
        setTierPlanError(null);
        setTierPlanState('ready');
      } else {
        setTierPlan(null);
        setTierPlanError(res?.error ?? 'The tier plan is unavailable.');
        setTierPlanState('error');
      }
    } catch (error) {
      if (!isMountedRef.current) return;
      setTierPlan(null);
      setTierPlanError(error instanceof Error ? error.message : String(error));
      setTierPlanState('error');
    }
  }, []);

  /**
   * Points the plan at a rule-hit ledger, or forgets the one it has.
   *
   * The hub holds no measurement of its own — the extension accumulates the blocks and the user
   * exports them — so weighting the plan by anything real starts with picking that file. Choosing
   * it reloads immediately rather than waiting for a restart, because the whole point is to watch
   * the plan change basis while looking at it.
   */
  const chooseTierLedger = useCallback(async () => {
    const picked = await window.electron?.selectTierLedger?.();
    if (picked) await loadTierPlan();
  }, [loadTierPlan]);

  const clearTierLedger = useCallback(async () => {
    await window.electron?.clearTierLedger?.();
    await loadTierPlan();
  }, [loadTierPlan]);
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
  const [feedToken, setFeedToken] = useState('');
  const [secretStorageAvailable, setSecretStorageAvailable] = useState<boolean | null>(null);
  const [launchOnStartup, setLaunchOnStartup] = useState(false);
  const [unboundReachability, setUnboundReachability] = useState<UnboundReachability | null>(null);
  const [unboundSnapshot, setUnboundSnapshot] = useState<UnboundReachabilitySnapshot | null>(null);
  const [unboundResolver, setUnboundResolver] = useState<UnboundResolverSettings | null>(null);
  const [resolverDraft, setResolverDraft] = useState('');
  const [referenceDraft, setReferenceDraft] = useState('');
  const [isCheckingUnbound, setIsCheckingUnbound] = useState(false);
  const [resolverMessage, setResolverMessage] = useState<string | null>(null);

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
    void loadTierPlan();

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

    // The recipe commands a pane writes may need the mutation token in a header — the Unbound
    // refresh's report-back POST is refused without it when one is configured.
    if (window.electron?.getFeedToken) {
      window.electron.getFeedToken().then((res) => {
        if (isMountedRef.current) setFeedToken(res?.token || '');
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

    if (window.electron?.getUnboundReachability) {
      window.electron.getUnboundReachability().then((snap) => {
        if (isMountedRef.current) setUnboundSnapshot(snap);
      });
    }

    // The reachability check now re-runs itself, so the verdict on screen has to follow it. Without
    // this subscription the pane holds whatever it was given at mount: the check would keep running
    // on schedule and the user would keep looking at a verdict from whenever the tab was opened.
    const unsubscribeUnboundWatch = window.electron?.onUnboundReachabilityUpdated?.((snap) => {
      if (!isMountedRef.current) return;
      setUnboundSnapshot(snap);
      // A scheduled verdict carries no rows, so the row breakdown from a manual run is dropped
      // rather than left next to a newer headline it no longer describes.
      setUnboundReachability(null);
    });

    if (window.electron?.getUnboundResolvers) {
      window.electron.getUnboundResolvers().then((setting) => {
        if (!isMountedRef.current) return;
        setUnboundResolver(setting);
        setResolverDraft(setting.address || '');
        setReferenceDraft(setting.referenceAddress || '');
      });
    }

    if (window.electron?.getSinkholeConfig) {
      window.electron.getSinkholeConfig().then((cfg) => {
        if (isMountedRef.current && cfg) {
          if (typeof cfg.encryptionAvailable === 'boolean') {
            setSecretStorageAvailable(cfg.encryptionAvailable);
          }
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
      unsubscribeUnboundWatch?.();
      for (const t of timersRef.current) {
        clearTimeout(t);
      }
      timersRef.current = [];
    };
  }, []);

  const handleCopy = useCallback(async (text: string, key: string) => {
    if (!(await copyTextToClipboard(text))) return;
    if (isMountedRef.current) {
      setCopiedKey(key);
      safeSetTimeout(() => setCopiedKey(null), 2400);
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

  const handleCheckUnboundReachability = async () => {
    if (!window.electron?.checkUnboundReachability) return;
    setIsCheckingUnbound(true);
    setResolverMessage(null);
    try {
      const result = await window.electron.checkUnboundReachability();
      if (!isMountedRef.current) return;
      setUnboundReachability(result);
      setUnboundSnapshot(result);
    } catch (err) {
      if (isMountedRef.current) {
        setResolverMessage(err instanceof Error ? err.message : 'The check could not run.');
      }
    } finally {
      if (isMountedRef.current) setIsCheckingUnbound(false);
    }
  };

  const handleSaveUnboundResolver = async () => {
    if (!window.electron?.setUnboundResolvers) return;
    const saved = await window.electron.setUnboundResolvers({
      address: resolverDraft.trim(),
      referenceAddress: referenceDraft.trim(),
    });
    if (!isMountedRef.current) return;
    if (!saved.success) {
      setResolverMessage(saved.error ?? 'Those addresses could not be used.');
      return;
    }
    const setting = await window.electron.getUnboundResolvers?.();
    if (!isMountedRef.current || !setting) return;
    setUnboundResolver(setting);
    setResolverDraft(setting.address || '');
    setReferenceDraft(setting.referenceAddress || '');
    setResolverMessage('Saved.');
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

  /** Selects a tab, running whatever side effect the registry declares for it. */
  const handleSelectTarget = (id: string) => {
    // The tab strip only ever passes a registry id, but the same handler reaches the sibling
    // index in the extension pane as a plain string — refuse rather than trust it.
    if (!isDeployTargetId(id)) return;
    setActiveTab(id);
    const effect = deployTargetById(id)?.selectEffect;
    if (effect) SELECT_EFFECTS[effect]();
  };

  /**
   * The extension's "install" from the hub's side: a fresh build copied where the browser can
   * load it. The browser keeps the actual install click — Load unpacked / temporary add-on —
   * and the pane says so rather than implying the download finished the job.
   */
  const handleDownloadExtension = async () => {
    if (!window.electron?.downloadExtension) return;
    setExtensionSaving(true);
    setExtensionMessage(null);
    try {
      const res = await window.electron.downloadExtension();
      if (res?.cancelled) return;
      if (res?.success && res.path) {
        setExtensionSavedPath(res.path);
        setExtensionMessage({
          text: 'Saved — now load it in the browser with the steps below.',
          type: 'success',
        });
      } else {
        setExtensionMessage({
          text: res?.error || 'The extension package could not be written.',
          type: 'error',
        });
      }
    } catch (err) {
      setExtensionMessage({ text: String(err), type: 'error' });
    } finally {
      setExtensionSaving(false);
    }
  };

  /**
   * The pane bundle.
   *
   * One object, built every render, handed to whichever pane the registry points at. Panes take the
   * fields they use out of it with `Pick`, so this is the whole list of what any deploy pane can
   * reach — the states above and the handlers that change them. Typing it as `HubPaneProps` is what
   * keeps the list honest in both directions: a state field nothing renders cannot be added here
   * without a compile error, and a pane cannot reach for one that is missing.
   *
   * Derived values are absent on purpose. The feed URLs and format notices a pane shows come from
   * these three inputs through the helpers in `deploy/feedUrls`, so a pane cannot print an address
   * that disagrees with the header above it.
   *
   * The bundle is the whole field set, but no pane sees it whole: dispatch narrows it through
   * `pickPaneProps` with the entry's own `paneKeys`, so each renderer is invoked with the subset
   * its module declares and nothing else.
   */
  const paneProps: HubPaneProps = {
    savePath,
    exportFormat,
    serverStatus,
    feedToken,
    secretStorageAvailable,

    handleCopy,
    copiedKey,

    sinkholeConfig,
    setSinkholeConfig,
    showHaToken,
    setShowHaToken,
    showAdguardPass,
    setShowAdguardPass,
    showPiholeKey,
    setShowPiholeKey,
    adguardEnv,
    setAdguardEnv,
    testingService,
    isSavingSinkhole,
    isSyncingSinkhole,
    sinkholeMessage,
    testResult,
    lastSyncResult,
    handleTestConnection,
    handleSaveSinkholeConfig,
    handleTriggerLiveSync,
    handleToggleSyncOnCompile,
    selectAdguardMode,
    applyDetectedMode,
    directPortFocusRef,

    haApiPreview,
    isTestingHaApi,
    handleInspectHaApi,
    tierPlanState,
    tierPlan,
    tierPlanError,
    loadTierPlan,
    chooseTierLedger,
    clearTierLedger,

    daemonStatus,
    isDaemonLoading,
    daemonMessage,
    networkServices,
    selectedService,
    setSelectedService,
    showInstallScripts,
    serviceScripts,
    refreshDaemonStatus,
    handleStartDaemon,
    handleStopDaemon,
    handleToggleDaemonProtection,
    handleReloadDaemon,
    handleSetSystemDns,
    handleRestoreSystemDns,
    handleFlushCache,
    handleToggleInstallScripts,

    unboundReachability,
    unboundSnapshot,
    unboundResolver,
    resolverDraft,
    setResolverDraft,
    referenceDraft,
    setReferenceDraft,
    isCheckingUnbound,
    resolverMessage,
    handleCheckUnboundReachability,
    handleSaveUnboundResolver,

    bindMechanism,
    setBindMechanism,

    extensionSaving,
    extensionSavedPath,
    extensionMessage,
    handleDownloadExtension,
    // Every target but this pane's own — the pane's "everywhere else" index, narrowed here
    // because the pane cannot import the registry that imports it.
    siblingTargets: DEPLOY_TARGETS.filter((t) => t.id !== 'browser-extension').map(
      ({ id, label, summary, icon }) => ({ id, label, summary, icon }),
    ),
    onSelectTarget: handleSelectTarget,
  };

  /**
   * The implementations behind the registry's named select effects.
   *
   * Typed as an exhaustive record of `DeploySelectEffect`, so a target that declares an effect the
   * component does not implement fails the build rather than silently doing nothing.
   */
  const SELECT_EFFECTS: Record<DeploySelectEffect, () => void> = {
    'refresh-daemon-status': () => void refreshDaemonStatus(),
  };

  /**
   * The tab's entry, and through it the pane.
   *
   * The registry is the only place a platform is named, so this is the whole of the dispatch: look
   * the entry up by id, call the pane it carries. The fallback covers an id that somehow is not in
   * the registry, which the tab strip cannot produce but a restored session could — and it answers
   * with the first tab rather than a blank pane.
   */
  const activeTarget = deployTargetById(activeTab) ?? DEPLOY_TARGETS[0];
  return (
    <div className="deploy-hub-container">
      {/* 1. The header — artifact identity and the LAN feed server. Markup, not state: everything
          it shows or fires is a prop, the same boundary the panes keep. */}
      <DeployHubHeader
        savePath={savePath}
        exportFormat={exportFormat}
        uniqueRulesCount={uniqueRulesCount}
        lastProcessTime={lastProcessTime}
        handleCopy={handleCopy}
        copiedKey={copiedKey}
        onTriggerCompile={onTriggerCompile}
        onNavigateSettings={onNavigateSettings}
        serverStatus={serverStatus}
        isServerLoading={isServerLoading}
        onToggleFeedServer={handleToggleFeedServer}
        autoStartFeedServer={autoStartFeedServer}
        onToggleAutoStartFeedServer={handleToggleAutoStartFeedServer}
        launchOnStartup={launchOnStartup}
        onToggleLaunchOnStartup={handleToggleLaunchOnStartup}
      />

      {/* =========================================================================
          2. PLATFORM NAVIGATION TABS
         ========================================================================= */}
      <div className="deploy-platform-tabs" role="tablist" aria-label="Deployment Platforms">
        {DEPLOY_TARGETS.map((target) => (
          <button
            key={target.id}
            type="button"
            role="tab"
            aria-selected={activeTab === target.id}
            title={target.summary}
            className={`platform-tab-btn ${activeTab === target.id ? 'active' : ''}`}
            onClick={() => handleSelectTarget(target.id)}
          >
            <span className="platform-tab-icon">{target.icon}</span>
            <span className="platform-tab-label">{target.label}</span>
          </button>
        ))}
      </div>

      {activeTarget.pane(pickPaneProps(paneProps, activeTarget.paneKeys))}
    </div>
  );
};
