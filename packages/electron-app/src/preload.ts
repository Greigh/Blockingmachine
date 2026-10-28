import { contextBridge, ipcRenderer, clipboard } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { FilterSource, ThemeType, FilterFormat } from './types/index';
import type { UpdateInfo, ProcessProgress, UpdateProgress } from './types/index';

import type { ElectronAPI } from './types/index';

const ALLOWED_CHANNELS = new Set([
  'open-settings',
  'process-progress',
  'update-status',
  'update-progress',
  'update-downloaded',
  'trigger-compile',
  'navigate-view',
  'launch-onboarding',
]);

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electron', {
  copyToClipboard: (text: string) => {
    try {
      if (clipboard && typeof clipboard.writeText === 'function') {
        clipboard.writeText(String(text ?? ''));
        return { success: true };
      }
    } catch {
      // Fallback to IPC
    }
    return ipcRenderer
      .invoke('copy-to-clipboard', text)
      .catch((error) => ({ success: false, error: String(error) }));
  },
  getSources: () => ipcRenderer.invoke('get-sources') as Promise<FilterSource[]>,
  saveSources: (sources: FilterSource[]) => ipcRenderer.invoke('save-sources', sources),
  getCustomRules: () => ipcRenderer.invoke('get-custom-rules'),
  setCustomRules: (rules: string) => ipcRenderer.invoke('save-custom-rules', rules),
  getSavePath: () => ipcRenderer.invoke('get-save-path'),
  getExtensionTierPlan: (request?: {
    capacity?: number;
    enabled?: string;
  }) => ipcRenderer.invoke('get-extension-tier-plan', request),
  /** Picks and remembers the browser's rule-hit ledger. Returns '' when cancelled. */
  selectTierLedger: () => ipcRenderer.invoke('select-tier-ledger') as Promise<string>,
  /** Forgets the chosen ledger, so the plan falls back to rule count. */
  clearTierLedger: () => ipcRenderer.invoke('clear-tier-ledger') as Promise<string>,
  /** Reads the element harvest the browser exported, for the corpus queue. */
  getElementHarvest: () => ipcRenderer.invoke('get-element-harvest'),
  /** Picks and remembers the element harvest file. Returns '' when cancelled. */
  selectElementHarvest: () => ipcRenderer.invoke('select-element-harvest') as Promise<string>,
  /** Forgets the chosen harvest, and deletes the file. */
  clearElementHarvest: () => ipcRenderer.invoke('clear-element-harvest') as Promise<string>,
  /** Downloads the release's extension package for the chosen browser and unpacks it where the user picks. */
  downloadExtension: (flavor?: 'chromium' | 'firefox' | 'both') =>
    ipcRenderer.invoke('download-extension', flavor) as Promise<{
      success: boolean;
      cancelled?: boolean;
      path?: string;
      firefoxPath?: string;
      release?: string;
      error?: string;
    }>,
  setSavePath: (path: string) => ipcRenderer.invoke('set-save-path', path),
  selectSavePath: () => ipcRenderer.invoke('select-save-path') as Promise<string>,
  getExportFormat: () => ipcRenderer.invoke('get-export-format'),
  setExportFormat: (format: FilterFormat) => ipcRenderer.invoke('set-export-format', format),
  getAdditionalFormats: () => ipcRenderer.invoke('get-additional-formats') as Promise<FilterFormat[]>,
  setAdditionalFormats: (formats: FilterFormat[]) => ipcRenderer.invoke('set-additional-formats', formats),
  getAutoSchedule: () => ipcRenderer.invoke('get-auto-schedule') as Promise<'disabled' | '12h' | '24h' | 'weekly'>,
  setAutoSchedule: (schedule: 'disabled' | '12h' | '24h' | 'weekly') => ipcRenderer.invoke('set-auto-schedule', schedule),
  getWebhookUrl: () => ipcRenderer.invoke('get-webhook-url') as Promise<string>,
  setWebhookUrl: (url: string) => ipcRenderer.invoke('set-webhook-url', url),
  getCompiledRules: (options?: any) => ipcRenderer.invoke('get-compiled-rules', options),
  getSinkholeConfig: () => ipcRenderer.invoke('get-sinkhole-config'),
  setSinkholeConfig: (config: any) => ipcRenderer.invoke('set-sinkhole-config', config),
  syncSinkholes: () => ipcRenderer.invoke('sync-sinkholes'),
  getCompilationHistory: () => ipcRenderer.invoke('get-compilation-history'),
  inspectDomain: (domain: string) => ipcRenderer.invoke('inspect-domain', domain),
  testFeedUrl: (url: string) => ipcRenderer.invoke('test-feed-url', url),
  getUnboundReachability: () => ipcRenderer.invoke('get-unbound-reachability'),
  checkUnboundReachability: () => ipcRenderer.invoke('check-unbound-reachability'),
  onUnboundReachabilityUpdated: (callback: (snapshot: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on('unbound-reachability-updated', handler);
    return () => {
      ipcRenderer.removeListener('unbound-reachability-updated', handler);
    };
  },
  getUnboundResolvers: () => ipcRenderer.invoke('get-unbound-resolvers'),
  setUnboundResolvers: (values: { address?: string; referenceAddress?: string }) =>
    ipcRenderer.invoke('set-unbound-resolvers', values),
  startFeedServer: (port?: number) => ipcRenderer.invoke('start-feed-server', port),
  stopFeedServer: () => ipcRenderer.invoke('stop-feed-server'),
  getFeedServerStatus: () => ipcRenderer.invoke('get-feed-server-status'),
  testSinkholeConnection: (service: 'pihole' | 'adguard' | 'webhook') => ipcRenderer.invoke('test-sinkhole-connection', service),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (theme: ThemeType) => ipcRenderer.invoke('set-theme', theme),
  getAppVersion: () => ipcRenderer.invoke('get-app-version') as Promise<string>,
  checkForUpdates: () =>
    ipcRenderer.invoke('check-for-updates') as Promise<
      | { ok: true; current: string; latest: string; updateAvailable: boolean; url: string }
      | { ok: false; current: string; error: string }
    >,
  getAutoStartFeedServer: () => ipcRenderer.invoke('get-auto-start-feed-server'),
  setAutoStartFeedServer: (enabled: boolean) => ipcRenderer.invoke('set-auto-start-feed-server', enabled),
  getFeedToken: () => ipcRenderer.invoke('get-feed-token') as Promise<{ configured: boolean; mode: 'required' | 'open' | 'legacy' }>,
  setFeedToken: (token: string) => ipcRenderer.invoke('set-feed-token', token) as Promise<{ success: boolean; unchanged?: boolean; error?: string }>,
  generateFeedToken: () => ipcRenderer.invoke('generate-feed-token') as Promise<{ success: boolean; token?: string; error?: string }>,
  clearFeedToken: () => ipcRenderer.invoke('clear-feed-token') as Promise<{ success: boolean; rotated?: boolean; error?: string }>,
  setLanAuthMode: (mode: 'required' | 'open') => ipcRenderer.invoke('set-lan-auth-mode', mode) as Promise<{ success: boolean; mode?: string; tokenMinted?: boolean; error?: string }>,
  getFeedPairingPayload: () =>
    ipcRenderer.invoke('get-feed-pairing-payload') as Promise<{
      success: boolean;
      running: boolean;
      url: string;
      tokenConfigured: boolean;
      /** True when the engine answered /v1/proxy/ca — the QR carries the CA. */
      httpsCaConfigured?: boolean;
      /** True when a data-port token is stored — the QR carries `httpsToken`. */
      httpsTokenConfigured?: boolean;
      payload: string;
    }>,
  // Flag 127's data-port token — presence-only read, set/clear, and the
  // one-shot generate display. Same write-only convention as feedToken.
  getHttpsFilterDataToken: () =>
    ipcRenderer.invoke('httpsfilter:get-data-token') as Promise<{ configured: boolean }>,
  setHttpsFilterDataToken: (token: string) =>
    ipcRenderer.invoke('httpsfilter:set-data-token', token) as Promise<{
      success: boolean;
      cleared?: boolean;
      error?: string;
    }>,
  generateHttpsFilterDataToken: () =>
    ipcRenderer.invoke('httpsfilter:generate-data-token') as Promise<{
      success: boolean;
      token?: string;
      error?: string;
    }>,
  getLaunchOnStartup: () => ipcRenderer.invoke('get-launch-on-startup'),
  setLaunchOnStartup: (enabled: boolean) => ipcRenderer.invoke('set-launch-on-startup', enabled),
  getMenuBarAgent: () => ipcRenderer.invoke('get-menu-bar-agent'),
  setMenuBarAgent: (enabled: boolean) => ipcRenderer.invoke('set-menu-bar-agent', enabled),
  getModuleContent: (moduleName: string) => ipcRenderer.invoke('get-module-content', moduleName) as Promise<string | null>,

  // AI Radar Methods [Beta]
  aiScanDomain: (domain: string, config?: any) => ipcRenderer.invoke('ai-scan-domain', domain, config),
  aiScanQueryLog: (options: { service: 'adguard' | 'pihole'; limit?: number }, config?: any) =>
    ipcRenderer.invoke('ai-scan-querylog', options, config),
  aiCrawlUrl: (url: string, config?: any) => ipcRenderer.invoke('ai-crawl-url', url, config),
  getAiConfig: () => ipcRenderer.invoke('get-ai-config'),
  setAiConfig: (config: any) => ipcRenderer.invoke('set-ai-config', config),
  testAiConnection: (config: any) => ipcRenderer.invoke('test-ai-connection', config),
  addCustomRules: (rules: string[]) => ipcRenderer.invoke('add-custom-rules', rules),
  getThreatQuarantine: () => ipcRenderer.invoke('get-threat-quarantine'),
  addThreatQuarantine: (items: any[]) => ipcRenderer.invoke('add-threat-quarantine', items),
  removeThreatQuarantineItem: (id: string) => ipcRenderer.invoke('remove-threat-quarantine-item', id),
  clearThreatQuarantine: () => ipcRenderer.invoke('clear-threat-quarantine'),
  getAiWatchdogConfig: () => ipcRenderer.invoke('get-ai-watchdog-config'),
  setAiWatchdogConfig: (config: any) => ipcRenderer.invoke('set-ai-watchdog-config', config),
  addCustomAllowlist: (domain: string) => ipcRenderer.invoke('add-custom-allowlist', domain),
  isDomainCoveredByRules: (domain: string) => ipcRenderer.invoke('is-domain-covered-by-rules', domain),
  tuneMiniAiFeedback: (domain: string, action: string) => ipcRenderer.invoke('tune-mini-ai-feedback', domain, action),
  compactSubdomainRules: (domains: string[], threshold?: number) => ipcRenderer.invoke('compact-subdomain-rules', domains, threshold),
  checkRuleConflict: (rule: string) => ipcRenderer.invoke('check-rule-conflict', rule),
  getMiniAiFeedbackStats: () => ipcRenderer.invoke('get-mini-ai-feedback-stats'),
  getAiShadowReadiness: () => ipcRenderer.invoke('ai-shadow-readiness'),
  resetMiniAiFeedback: (domain: string) => ipcRenderer.invoke('reset-mini-ai-feedback', domain),
  getUserLabelStats: () => ipcRenderer.invoke('get-user-label-stats'),
  getRadarHeatSummary: () => ipcRenderer.invoke('get-radar-heat-summary'),
  clearRadarHeatDomain: (domain: string) => ipcRenderer.invoke('clear-radar-heat-domain', domain),
  ignoreRadarHeatDomain: (domain: string) => ipcRenderer.invoke('ignore-radar-heat-domain', domain),
  unignoreRadarHeatDomain: (domain: string) => ipcRenderer.invoke('unignore-radar-heat-domain', domain),
  getRadarDisplayConfig: () => ipcRenderer.invoke('get-radar-display-config'),
  setRadarDisplayConfig: (config: any) => ipcRenderer.invoke('set-radar-display-config', config),
  onRadarDisplayConfigUpdated: (callback: (config: any) => void) => {
    const handler = (_event: IpcRendererEvent, config: any) => callback(config);
    ipcRenderer.on('radar-display-config-updated', handler);
    return () => {
      ipcRenderer.removeListener('radar-display-config-updated', handler);
    };
  },
  synthesizeCustomRules: (input: any) => ipcRenderer.invoke('synthesize-custom-rules', input),
  startLiveRadarSession: (options: any) => ipcRenderer.invoke('start-live-radar-session', options),
  stopLiveRadarSession: () => ipcRenderer.invoke('stop-live-radar-session'),
  getLiveRadarSession: () => ipcRenderer.invoke('get-live-radar-session'),
  onLiveRadarSessionUpdate: (callback: (session: any) => void) => {
    const handler = (_event: IpcRendererEvent, session: any) => callback(session);
    ipcRenderer.on('live-radar-session-update', handler);
    return () => {
      ipcRenderer.removeListener('live-radar-session-update', handler);
    };
  },

  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => {
    const handler = (_event: IpcRendererEvent, info: UpdateInfo) => callback(info);
    ipcRenderer.on('update-available', handler);
    return () => {
      ipcRenderer.removeListener('update-available', handler);
    };
  },
  onUpdateDownloaded: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('update-downloaded', handler);
    return () => {
      ipcRenderer.removeListener('update-downloaded', handler);
    };
  },
  onUpdateError: (callback: (error: Error) => void) => {
    const handler = (_event: IpcRendererEvent, error: Error) => callback(error);
    ipcRenderer.on('update-error', handler);
    return () => {
      ipcRenderer.removeListener('update-error', handler);
    };
  },
  onUpdateStatus: (callback: (status: string) => void) => {
    const handler = (_event: IpcRendererEvent, status: string) => callback(status);
    ipcRenderer.on('update-status', handler);
    return () => {
      ipcRenderer.removeListener('update-status', handler);
    };
  },
  onProcessProgress: (callback: (progress: ProcessProgress) => void) => {
    const handler = (_event: IpcRendererEvent, progress: ProcessProgress) => callback(progress);
    ipcRenderer.on('process-progress', handler);
    return () => {
      ipcRenderer.removeListener('process-progress', handler);
    };
  },
  removeProcessProgressListener: () => ipcRenderer.removeAllListeners('process-progress'),
  onUpdateProgress: (callback: (progress: number) => void) => {
    const handler = (_event: IpcRendererEvent, progress: UpdateProgress | number) => {
      const percent = typeof progress === 'number' ? progress : progress?.percent ?? 0;
      callback(percent);
    };
    ipcRenderer.on('update-progress', handler);
    return () => {
      ipcRenderer.removeListener('update-progress', handler);
    };
  },
  onOpenSettings: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('open-settings', handler);
    return () => {
      ipcRenderer.removeListener('open-settings', handler);
    };
  },
  onTriggerCompile: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('trigger-compile', handler);
    return () => {
      ipcRenderer.removeListener('trigger-compile', handler);
    };
  },
  onNavigateView: (callback: (view: string) => void) => {
    const handler = (_event: IpcRendererEvent, view: string) => callback(view);
    ipcRenderer.on('navigate-view', handler);
    return () => {
      ipcRenderer.removeListener('navigate-view', handler);
    };
  },
  onLaunchOnboarding: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('launch-onboarding', handler);
    return () => {
      ipcRenderer.removeListener('launch-onboarding', handler);
    };
  },
  getLastProcessTime: () => ipcRenderer.invoke('get-last-process-time'),
  notifyResize: (width: number, height: number) => ipcRenderer.send('notify-resize', width, height),
  runImportProcess: () => ipcRenderer.invoke('run-import-process'),

  // Local System DNS Daemon Integration
  getDaemonStatus: () => ipcRenderer.invoke('daemon:get-status'),
  getLiveServices: () => ipcRenderer.invoke('get-live-services'),
  startDaemonProcess: () => ipcRenderer.invoke('daemon:start'),
  stopDaemonProcess: () => ipcRenderer.invoke('daemon:stop'),
  reloadDaemonRules: () => ipcRenderer.invoke('daemon:reload'),
  toggleDaemonProtection: (enabled?: boolean) => ipcRenderer.invoke('daemon:toggle', enabled),
  setSystemDns: (serviceName?: string) => ipcRenderer.invoke('daemon:set-system-dns', serviceName),
  restoreSystemDns: (serviceName?: string) => ipcRenderer.invoke('daemon:restore-system-dns', serviceName),
  flushDnsCache: () => ipcRenderer.invoke('daemon:flush-cache'),
  getServiceInstallScript: () => ipcRenderer.invoke('daemon:get-service-script'),
  getNetworkServices: () => ipcRenderer.invoke('daemon:get-network-services'),

  // HTTPS filter proxy — CA trust store (P1 Task 4)
  getHttpsFilterCaTrust: () => ipcRenderer.invoke('httpsfilter:ca-trust-status'),
  installHttpsFilterCa: (options?: { elevate?: boolean }) =>
    ipcRenderer.invoke('httpsfilter:ca-install', options),
  uninstallHttpsFilterCa: () => ipcRenderer.invoke('httpsfilter:ca-uninstall'),

  // HTTPS filter proxy — engine lifecycle + policy surface (P1 Task 5)
  getHttpsFilterStatus: () => ipcRenderer.invoke('httpsfilter:status'),
  startHttpsFilter: () => ipcRenderer.invoke('httpsfilter:start'),
  stopHttpsFilter: () => ipcRenderer.invoke('httpsfilter:stop'),
  // The rendered install-macos-capture.sh invocation — absolute paths, so
  // the card's hint pastes on a machine with no repo checkout.
  getHttpsFilterInstallScript: () => ipcRenderer.invoke('httpsfilter:get-install-script'),
  toggleHttpsFilterPause: (enabled?: boolean) => ipcRenderer.invoke('httpsfilter:toggle-pause', enabled),
  getHttpsFilterPins: () => ipcRenderer.invoke('httpsfilter:pins'),
  removeHttpsFilterPin: (host: string) => ipcRenderer.invoke('httpsfilter:pin-remove', host),

  // Secure channel-checked fallback for legacy listeners
  receive: (channel: string, callback: (...args: unknown[]) => void) => {
    if (ALLOWED_CHANNELS.has(channel)) {
      const handler = (_event: IpcRendererEvent, ...args: unknown[]) => callback(...args);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    } else {
      console.warn(`[Preload] Blocked unauthorized receive on channel: ${channel}`);
      return () => {};
    }
  },
  removeAllListeners: (channel: string) => {
    if (ALLOWED_CHANNELS.has(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  },

  showItemInFolder: (path: string) => {
    if (typeof path === 'string' && path.trim().length > 0) {
      ipcRenderer.send('show-item-in-folder', path);
    }
  },
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  /** Signals subscriptions are mounted so queued window messages can flush. */
  rendererReady: () => ipcRenderer.send('renderer-ready'),
} as ElectronAPI);