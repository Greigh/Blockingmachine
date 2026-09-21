import { contextBridge, ipcRenderer } from 'electron';
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
  getFilterSources: () => ipcRenderer.invoke('get-sources') as Promise<FilterSource[]>,
  setFilterSources: (sources: FilterSource[]) => ipcRenderer.invoke('save-sources', sources),
  getSources: () => ipcRenderer.invoke('get-sources') as Promise<FilterSource[]>,
  setSources: (sources: FilterSource[]) => ipcRenderer.invoke('save-sources', sources),
  saveSources: (sources: FilterSource[]) => ipcRenderer.invoke('save-sources', sources),
  getCustomRules: () => ipcRenderer.invoke('get-custom-rules'),
  setCustomRules: (rules: string) => ipcRenderer.invoke('save-custom-rules', rules),
  getSavePath: () => ipcRenderer.invoke('get-save-path'),
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
  startFeedServer: (port?: number) => ipcRenderer.invoke('start-feed-server', port),
  stopFeedServer: () => ipcRenderer.invoke('stop-feed-server'),
  getFeedServerStatus: () => ipcRenderer.invoke('get-feed-server-status'),
  testSinkholeConnection: (service: 'pihole' | 'adguard' | 'webhook') => ipcRenderer.invoke('test-sinkhole-connection', service),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (theme: ThemeType) => ipcRenderer.invoke('set-theme', theme),
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
} as ElectronAPI);