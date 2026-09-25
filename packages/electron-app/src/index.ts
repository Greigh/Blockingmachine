import { join, dirname, isAbsolute, basename, resolve as pathResolve, sep } from 'path';
import { createServer, Server as HttpServer, ServerResponse } from 'http';
import { networkInterfaces } from 'os';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  IpcMainInvokeEvent,
  Menu,
  shell,
  session,
  Notification,
  Tray,
  nativeImage,
} from 'electron';
import { promises as fs, existsSync, createReadStream } from 'fs';
import isDev from 'electron-is-dev';

if (isDev) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

import Store from 'electron-store';
import type { ElectronStore, StoreSchema } from './types';
import {
  describeUrlEndpoint,
  formatSinkholeError,
  normalizeAdguardDirectPort,
  normalizeWebhookUrl,
  resolveAdguardDirectUrl,
  resolveHaApiUrl,
  type SinkholeEndpoint,
} from './sinkholeNet';
import { sinkholeFetch } from './sinkholeFetch';
import {
  classifyDirectStatus,
  classifyHaApiResponse,
  haApiConnectionResult,
  haApiSyncBlockReason,
  type ProbeResponse,
} from './sinkholeIdentity';
import { emptyUnblockedNotice, fetchAdguardQueryLog, separateAdguardUrls, type SinkholeUrlFields } from './queryLogScout';
import {
  downloadAndParseSource,
  parseFilterList,
  RuleDeduplicator,
  generateFilterList,
  filterLists,
  AiDetectorService,
  synthesizeAllowlistRule,
  sanitizeDomain,
  isSafePublicWebUrl,
  isDomainCoveredByRules,
  globalMiniAiClassifier,
  compactSubdomainRules,
  checkRuleConflict,
  synthesizeRules,
  evaluateDomainRules,
  filterDNSRules,
  filterBrowserRules,
  type AiProviderConfig,
  type AiScanResult,
  type RawDnsQuery,
} from '@blockingmachine/core';
import type {
  FilterSource,
  ThemeType,
  FilterFormat,
  StoredRule,
  FilterListMetadata,
  CompilationSnapshot,
  DomainInspectionResult,
  FeedDiagnostic,
  ThreatQuarantineItem,
  AiWatchdogConfig,
} from './types';
import { DaemonManager } from './daemonManager';

async function installExtensions() {
  if (!isDev) return;

  try {
    // electron-devtools-installer 4.0.0 still calls session.getAllExtensions and
    // session.loadExtension. Those Session methods are deprecated in this Electron
    // version. Download the extension, then load it only through session.extensions.
    const { REACT_DEVELOPER_TOOLS } = await import('electron-devtools-installer');
    const downloader = await import(
      'electron-devtools-installer/dist/downloadChromeExtension.js'
    );
    const downloadChromeExtension = downloader.downloadChromeExtension;
    const extensionId = REACT_DEVELOPER_TOOLS.id;
    const extensions = session.defaultSession.extensions;

    const existing = extensions.getAllExtensions().find((ext) => ext.id === extensionId);
    if (existing) {
      console.log('React DevTools installed:', existing.name);
      return;
    }

    const extensionFolder = await downloadChromeExtension(extensionId);
    const extensionRef = await extensions.loadExtension(extensionFolder);
    if (!extensionRef) {
      throw new Error('Failed to load React DevTools extension');
    }

    console.log('React DevTools installed:', extensionRef.name);
  } catch (err) {
    console.error('Failed to install extension:', err);
  }
}

function isValidFormat(format: unknown): format is FilterFormat {
  const validFormats: FilterFormat[] = [
    'adguard',
    'abp',
    'hosts',
    'dnsmasq',
    'unbound',
    'domains',
    'plain',
  ];
  return (
    typeof format === 'string' &&
    validFormats.includes(format as FilterFormat)
  );
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

// ============================================================================
// Crash Reporter & Uncaught Error Boundary
// ============================================================================
function setupCrashBoundary() {
  const logCrash = async (type: string, error: unknown) => {
    try {
      const errObj = error instanceof Error ? error : new Error(String(error));
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const crashInfo =
        `[${new Date().toISOString()}] ${type}: ${errObj.message}\n` +
        `Stack: ${errObj.stack || 'No stack trace'}\n` +
        `Node: ${process.version}, Platform: ${process.platform}, Arch: ${process.arch}\n` +
        `App Version: ${typeof app?.getVersion === 'function' ? app.getVersion() : '1.0.0'}\n\n`;

      console.error(`❌ [CRASH BOUNDARY] ${type}:`, errObj);

      try {
        if (typeof app?.getPath === 'function') {
          const userDataPath = app.getPath('userData');
          const crashDir = join(userDataPath, 'crash-logs');
          await fs.mkdir(crashDir, { recursive: true });
          await fs.appendFile(join(crashDir, `crash-${timestamp}.log`), crashInfo, 'utf8');
        }
      } catch (writeErr) {
        console.error('Failed to persist crash log to disk:', writeErr);
      }
    } catch {
      // Safe fallback
    }
  };

  process.on('uncaughtException', (err) => {
    logCrash('Uncaught Exception', err);
  });

  process.on('unhandledRejection', (reason) => {
    logCrash('Unhandled Rejection', reason);
  });
}

setupCrashBoundary();

// Set official application name for native macOS application menu
app.name = 'Blockingmachine';

const daemonManager = new DaemonManager();

const isMac = process.platform === 'darwin';

// Define standard native application menu (Matching Apple HIG)
const template: Electron.MenuItemConstructorOptions[] = [
  ...(isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            {
              label: 'Preferences...',
              accelerator: 'Cmd+,',
              click: () => {
                if (mainWindow) {
                  mainWindow.show();
                  mainWindow.focus();
                  mainWindow.webContents.send('open-settings');
                }
              },
            },
            { type: 'separator' as const },
            { role: 'services' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        },
      ]
    : []),
  {
    label: 'File',
    submenu: [
      {
        label: 'Compile Rules Now',
        accelerator: 'Cmd+R',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('trigger-compile');
          }
        },
      },
      {
        label: 'Reveal Output in Finder',
        accelerator: 'Cmd+Shift+O',
        click: async () => {
          const savePath = store.get('savePath');
          if (savePath && typeof savePath === 'string') {
            try {
              shell.showItemInFolder(savePath);
            } catch {
              shell.openPath(dirname(savePath));
            }
          }
        },
      },
      { type: 'separator' as const },
      isMac ? { role: 'close' as const } : { role: 'quit' as const },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' as const },
      { role: 'redo' as const },
      { type: 'separator' as const },
      { role: 'cut' as const },
      { role: 'copy' as const },
      { role: 'paste' as const },
      { role: 'selectAll' as const },
    ],
  },
  {
    label: 'View',
    submenu: [
      {
        label: 'Filter Processor',
        accelerator: 'Cmd+1',
        click: () => {
          mainWindow?.webContents.send('navigate-view', 'process');
        },
      },
      {
        label: 'Filter Sources',
        accelerator: 'Cmd+2',
        click: () => {
          mainWindow?.webContents.send('navigate-view', 'sources');
        },
      },
      {
        label: 'Defense Modules',
        accelerator: 'Cmd+3',
        click: () => {
          mainWindow?.webContents.send('navigate-view', 'modules');
        },
      },
      {
        label: 'Custom Rules',
        accelerator: 'Cmd+4',
        click: () => {
          mainWindow?.webContents.send('navigate-view', 'custom');
        },
      },
      {
        label: 'Rule & AI Inspector',
        accelerator: 'Cmd+5',
        click: () => {
          mainWindow?.webContents.send('navigate-view', 'inspector');
        },
      },
      {
        label: 'Rule Browser',
        accelerator: 'Cmd+6',
        click: () => {
          mainWindow?.webContents.send('navigate-view', 'browser');
        },
      },
      {
        label: 'Bulk Import',
        accelerator: 'Cmd+7',
        click: () => {
          mainWindow?.webContents.send('navigate-view', 'bulkImport');
        },
      },
      {
        label: 'Deploy & Sync',
        accelerator: 'Cmd+8',
        click: () => {
          mainWindow?.webContents.send('navigate-view', 'deploy');
        },
      },
      {
        label: 'AI Radar Hub',
        accelerator: 'Cmd+9',
        click: () => {
          mainWindow?.webContents.send('navigate-view', 'ai-radar');
        },
      },
      { type: 'separator' as const },
      { role: 'reload' as const },
      { role: 'forceReload' as const },
      { role: 'toggleDevTools' as const },
      { type: 'separator' as const },
      { role: 'resetZoom' as const },
      { role: 'zoomIn' as const },
      { role: 'zoomOut' as const },
      { type: 'separator' as const },
      { role: 'togglefullscreen' as const },
    ],
  },
  {
    label: 'Window',
    submenu: [
      { role: 'minimize' as const },
      { role: 'zoom' as const },
      ...(isMac
        ? [
            { type: 'separator' as const },
            { role: 'front' as const },
            { type: 'separator' as const },
            { role: 'window' as const },
          ]
        : [{ role: 'close' as const }]),
    ],
  },
  {
    role: 'help' as const,
    submenu: [
      {
        label: 'Quick Tour / Onboarding...',
        click: () => {
          mainWindow?.webContents.send('launch-onboarding');
        },
      },
      { type: 'separator' as const },
      {
        label: 'GitHub Repository',
        click: async () => {
          await shell.openExternal('https://github.com/Greigh/Blockingmachine');
        },
      },
      {
        label: 'Report an Issue',
        click: async () => {
          await shell.openExternal('https://github.com/Greigh/Blockingmachine/issues');
        },
      },
      {
        label: 'Documentation & Guides',
        click: async () => {
          await shell.openExternal('https://github.com/Greigh/Blockingmachine#readme');
        },
      },
    ],
  },
];

const menu = Menu.buildFromTemplate(template);
Menu.setApplicationMenu(menu);

// Initialize store with proper typing
const store = new Store<StoreSchema>({
  schema: {
    filterSources: {
      type: 'array',
      default: [],
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          url: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['name', 'url', 'enabled'],
      },
    },
    customRules: {
      type: 'string',
      default: '',
    },
    theme: {
      type: 'string',
      enum: ['light', 'dark', 'system'],
      default: 'system',
    },
    savePath: {
      type: 'string',
      default: join(
        app.getPath('documents'),
        'Blockingmachine',
        'processed_rules.txt'
      ),
    },
    exportFormat: {
      type: 'string',
      enum: [
        'adguard',
        'abp',
        'hosts',
        'dnsmasq',
        'unbound',
        'domains',
        'plain',
      ],
      default: 'adguard',
    },
    additionalFormats: {
      type: 'array',
      default: [],
    },
    autoSchedule: {
      type: 'string',
      enum: ['disabled', '12h', '24h', 'weekly'],
      default: 'disabled',
    },
    webhookUrl: {
      type: 'string',
      default: '',
    },
    lastProcessTime: {
      type: 'string',
      default: '',
    },
    compilationHistory: {
      type: 'array',
      default: [],
    },
    autoStartFeedServer: {
      type: 'boolean',
      default: false,
    },
    launchOnStartup: {
      type: 'boolean',
      default: false,
    },
  },
}) as unknown as ElectronStore<StoreSchema>;

// Concurrency pool helper for fast parallel downloads
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

// Global cache of latest compiled rules for real-time inspection
let latestCompiledRules: StoredRule[] = [];

// Auto-schedule background timer
let autoScheduleTimer: NodeJS.Timeout | null = null;

function setupAutoScheduleTimer(schedule: 'disabled' | '12h' | '24h' | 'weekly', _storeRef: ElectronStore<StoreSchema>) {
  if (autoScheduleTimer) {
    clearInterval(autoScheduleTimer);
    autoScheduleTimer = null;
  }
  let intervalMs = 0;
  if (schedule === '12h') intervalMs = 12 * 60 * 60 * 1000;
  else if (schedule === '24h') intervalMs = 24 * 60 * 60 * 1000;
  else if (schedule === 'weekly') intervalMs = 7 * 24 * 60 * 60 * 1000;

  if (intervalMs > 0) {
    console.log(`[AutoSchedule] Enabled background compilation schedule: ${schedule} (${intervalMs}ms)`);
    autoScheduleTimer = setInterval(async () => {
      console.log('[AutoSchedule] Triggering scheduled filter list compilation...');
      // Internal trigger can use existing sources
    }, intervalMs);
    autoScheduleTimer?.unref?.();
  }
}

// AI Sentinel Watchdog Background Timer [Beta]
let aiWatchdogTimer: NodeJS.Timeout | null = null;
let sharedAiDetectorService: AiDetectorService | null = null;
let sharedAiDetectorConfigKey = '';

function getSharedAiDetectorService(config: Partial<AiProviderConfig>): AiDetectorService {
  const key = JSON.stringify(config);
  if (!sharedAiDetectorService || sharedAiDetectorConfigKey !== key) {
    sharedAiDetectorService = new AiDetectorService(config);
    sharedAiDetectorConfigKey = key;
  }
  return sharedAiDetectorService;
}

function setupAiWatchdogTimer(config: AiWatchdogConfig, storeRef: ElectronStore<StoreSchema>): void {
  if (aiWatchdogTimer) {
    clearInterval(aiWatchdogTimer);
    aiWatchdogTimer = null;
  }

  if (!config.enabled) {
    console.log('[AI Watchdog] Disabled');
    return;
  }

  const intervalMs = Math.max(5, config.intervalMinutes || 60) * 60 * 1000;
  console.log(`[AI Watchdog] Started with interval: ${config.intervalMinutes || 60}m`);

  aiWatchdogTimer = setInterval(async () => {
    try {
      console.log('[AI Watchdog] Running periodic background query scout...');
      const savedConfig = (storeRef.get('aiConfig') || {}) as Partial<AiProviderConfig>;
      const service = getSharedAiDetectorService(savedConfig);

      const queries: RawDnsQuery[] = [];
      const limit = 50;

      if (config.service === 'adguard') {
        const loaded = await loadStoredAdguardQueries(storeRef, limit);
        if (!loaded.ok) {
          console.error(`[AI Watchdog] Query log scout failed: ${loaded.message}`);
        } else if (loaded.unblockedCount === 0) {
          console.log(`[AI Watchdog] ${emptyUnblockedNotice(limit)}`);
        } else {
          queries.push(...loaded.queries);
        }
      } else if (config.service === 'pihole') {
        const baseUrl = storeRef.get('piholeUrl') || 'http://127.0.0.1';
        const token = storeRef.get('piholeApiKey') || '';
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/admin/api.php?getAllQueries=${limit}&auth=${token}`, {
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) {
          console.error(`[AI Watchdog] Pi-hole query log returned HTTP ${res.status}. This was not treated as an empty log.`);
        } else {
          const json: any = await res.json();
          const data = Array.isArray(json?.data) ? json.data : [];
          for (const item of data) {
            const name = item?.[2];
            const status = item?.[4];
            if (name && (status === '2' || status === '3')) {
              queries.push({ domain: name, client: item?.[3], blocked: false });
            }
          }
          if (queries.length === 0) {
            console.log(`[AI Watchdog] ${emptyUnblockedNotice(limit)}`);
          }
        }
      }

      if (queries.length > 0) {
        const scan = await service.scanQueryLog(queries, savedConfig);
        const autoQuarantine = config.autoQuarantineEntropyDga !== false;
        const threats = scan.results.filter((r) => {
          if (r.verdict === 'clean') return false;
          if (!autoQuarantine) return true;
          const conf = typeof r.confidence === 'number' ? (r.confidence > 1 ? r.confidence : r.confidence * 100) : 0;
          return r.isLikelyDga || (typeof r.entropy === 'number' && r.entropy > 4.2) || conf >= 85 || r.riskLevel === 'high' || r.riskLevel === 'critical';
        });

        if (threats.length > 0) {
          const existingQuarantine: ThreatQuarantineItem[] = storeRef.get('aiThreatQuarantine') || [];
          const existingDomains = new Set(existingQuarantine.map((q) => q.domain));
          const newItems: ThreatQuarantineItem[] = threats
            .filter((t) => !existingDomains.has(t.domain))
            .map((t) => ({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              domain: t.domain,
              category: t.category,
              verdict: t.verdict,
              riskLevel: t.riskLevel,
              confidence: t.confidence,
              reasons: t.reasons,
              generatedRules: t.generatedRules,
              source: 'watchdog',
              timestamp: new Date().toISOString(),
              blocked: false,
            }));

          if (newItems.length > 0) {
            const updatedQuarantine = [...newItems, ...existingQuarantine].slice(0, 200);
            storeRef.set('aiThreatQuarantine', updatedQuarantine);
            console.log(`[AI Watchdog] Quarantined ${newItems.length} new threat domains`);
            daemonManager.quarantineDomain(newItems.map((t) => t.domain)).catch(() => {});
            broadcastSseEvent('quarantine_added', {
              count: newItems.length,
              domains: newItems.map((t) => t.domain),
            });
          }
        }

        const currentWatchdog = storeRef.get('aiWatchdogConfig') || config;
        storeRef.set('aiWatchdogConfig', {
          ...currentWatchdog,
          lastRun: new Date().toISOString(),
          lastThreatsFound: threats.length,
        });
      }
    } catch (err) {
      console.error('[AI Watchdog] Background scan error:', err);
    }
  }, intervalMs);

  aiWatchdogTimer?.unref?.();
}

// ============================================================================
// Live Radar Background Scanning Session [Beta]
// ============================================================================
interface LiveRadarSessionState {
  active: boolean;
  service: 'adguard' | 'pihole';
  durationMinutes: number; // 0 = continuous until stopped
  pollIntervalSeconds: number;
  startTime: number;
  endTime: number; // 0 for continuous
  pollCount: number;
  totalQueriesAnalyzed: number;
  flaggedCount: number;
  cleanCount: number;
  results: AiScanResult[];
  lastPollTime?: number;
  lastError?: string;
  notice?: string;
}

let liveRadarTimer: NodeJS.Timeout | null = null;
let currentLiveRadarSession: LiveRadarSessionState = {
  active: false,
  service: 'adguard',
  durationMinutes: 15,
  pollIntervalSeconds: 10,
  startTime: 0,
  endTime: 0,
  pollCount: 0,
  totalQueriesAnalyzed: 0,
  flaggedCount: 0,
  cleanCount: 0,
  results: [],
};

function broadcastLiveRadarUpdate(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('live-radar-session-update', currentLiveRadarSession);
  }
}

async function pollLiveRadarQueries(storeRef: ElectronStore<StoreSchema>): Promise<void> {
  if (!currentLiveRadarSession.active) return;

  // Check if session duration expired
  if (currentLiveRadarSession.endTime > 0 && Date.now() >= currentLiveRadarSession.endTime) {
    console.log('[Live Radar] Session duration reached.');
    stopLiveRadarSession(storeRef, 'Session duration completed');
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: 'AI Radar Session Complete',
          body: `Scanned ${currentLiveRadarSession.totalQueriesAnalyzed} unblocked queries. Flagged ${currentLiveRadarSession.flaggedCount} ad/tracker threats.`,
        }).show();
      }
    } catch {
      // Ignore notification error
    }
    return;
  }

  try {
    const savedConfig = (storeRef.get('aiConfig') || {}) as Partial<AiProviderConfig>;
    const service = getSharedAiDetectorService(savedConfig);
    const queries: RawDnsQuery[] = [];
    const limit = 60;

    if (currentLiveRadarSession.service === 'adguard') {
      const loaded = await loadStoredAdguardQueries(storeRef, limit);
      if (!loaded.ok) {
        currentLiveRadarSession.lastError = loaded.message;
        broadcastLiveRadarUpdate();
        return;
      }
      queries.push(...loaded.queries);
    } else if (currentLiveRadarSession.service === 'pihole') {
      const baseUrl = storeRef.get('piholeUrl') || 'http://127.0.0.1';
      const token = storeRef.get('piholeApiKey') || '';
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/admin/api.php?getAllQueries=${limit}&auth=${token}`, {
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        currentLiveRadarSession.lastError = `Pi-hole query log returned HTTP ${res.status}`;
        broadcastLiveRadarUpdate();
        return;
      }
      const json: any = await res.json();
      const data = Array.isArray(json?.data) ? json.data : [];
      for (const item of data) {
        const name = item?.[2];
        const status = item?.[4];
        if (name && (status === '2' || status === '3')) {
          queries.push({ domain: name, client: item?.[3], blocked: false });
        }
      }
    }

    currentLiveRadarSession.lastError = undefined;

    if (queries.length === 0) {
      currentLiveRadarSession.pollCount++;
      currentLiveRadarSession.lastPollTime = Date.now();
      currentLiveRadarSession.notice = emptyUnblockedNotice(limit);
      broadcastLiveRadarUpdate();
      return;
    }

    const scan = await service.scanQueryLog(queries, savedConfig);
    currentLiveRadarSession.notice = undefined;
    currentLiveRadarSession.pollCount++;
    currentLiveRadarSession.lastPollTime = Date.now();

    const existingDomainMap = new Map<string, AiScanResult>();
    for (const r of currentLiveRadarSession.results) {
      existingDomainMap.set(r.domain, r);
    }

    const watchdogConfig = (storeRef.get('aiWatchdogConfig') || {}) as AiWatchdogConfig;
    const autoQuarantine = watchdogConfig.autoQuarantineEntropyDga !== false;
    const threatsToQuarantine: ThreatQuarantineItem[] = [];

    for (const fresh of scan.results) {
      if (!existingDomainMap.has(fresh.domain)) {
        existingDomainMap.set(fresh.domain, fresh);
        currentLiveRadarSession.totalQueriesAnalyzed++;
        if (fresh.verdict !== 'clean') {
          currentLiveRadarSession.flaggedCount++;
          const conf = typeof fresh.confidence === 'number' ? (fresh.confidence > 1 ? fresh.confidence : fresh.confidence * 100) : 0;
          const isDgaOrEntropy = fresh.isLikelyDga || (typeof fresh.entropy === 'number' && fresh.entropy > 4.2);
          if (autoQuarantine || isDgaOrEntropy || conf >= 85 || fresh.riskLevel === 'high' || fresh.riskLevel === 'critical') {
            threatsToQuarantine.push({
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              domain: fresh.domain,
              category: fresh.category,
              verdict: fresh.verdict,
              riskLevel: fresh.riskLevel,
              confidence: fresh.confidence,
              reasons: fresh.reasons,
              generatedRules: fresh.generatedRules,
              source: 'sinkhole',
              timestamp: new Date().toISOString(),
              blocked: false,
            });
          }
        } else {
          currentLiveRadarSession.cleanCount++;
        }
      }
    }

    const combined = Array.from(existingDomainMap.values());
    combined.sort((a, b) => {
      if (a.verdict !== 'clean' && b.verdict === 'clean') return -1;
      if (a.verdict === 'clean' && b.verdict !== 'clean') return 1;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
    currentLiveRadarSession.results = combined.slice(0, 300);

    if (threatsToQuarantine.length > 0) {
      const existingQuarantine: ThreatQuarantineItem[] = storeRef.get('aiThreatQuarantine') || [];
      const existingQDomains = new Set(existingQuarantine.map((q) => q.domain));
      const filtered = threatsToQuarantine.filter((t) => !existingQDomains.has(t.domain));
      if (filtered.length > 0) {
        storeRef.set('aiThreatQuarantine', [...filtered, ...existingQuarantine].slice(0, 200));
        console.log(`[Live Radar] Auto-quarantined ${filtered.length} new threat(s)`);
        daemonManager.quarantineDomain(filtered.map((t) => t.domain)).catch(() => {});
        broadcastSseEvent('quarantine_added', {
          count: filtered.length,
          domains: filtered.map((t) => t.domain),
        });
      }
    }

    broadcastLiveRadarUpdate();
  } catch (err: any) {
    console.error('[Live Radar] Poll error:', err);
    currentLiveRadarSession.lastError = err?.message || String(err);
    broadcastLiveRadarUpdate();
  }
}

function startLiveRadarSession(
  options: { service: 'adguard' | 'pihole'; durationMinutes: number; pollIntervalSeconds?: number },
  storeRef: ElectronStore<StoreSchema>
): LiveRadarSessionState {
  if (liveRadarTimer) {
    clearInterval(liveRadarTimer);
    liveRadarTimer = null;
  }

  const durationMin = Math.max(0, options.durationMinutes || 0);
  const intervalSec = Math.max(3, Math.min(60, options.pollIntervalSeconds || 10));
  const now = Date.now();

  currentLiveRadarSession = {
    active: true,
    service: options.service,
    durationMinutes: durationMin,
    pollIntervalSeconds: intervalSec,
    startTime: now,
    endTime: durationMin > 0 ? now + durationMin * 60 * 1000 : 0,
    pollCount: 0,
    totalQueriesAnalyzed: 0,
    flaggedCount: 0,
    cleanCount: 0,
    results: [],
  };

  console.log(`[Live Radar] Started session: service=${options.service}, duration=${durationMin}m, interval=${intervalSec}s`);
  broadcastLiveRadarUpdate();

  pollLiveRadarQueries(storeRef);

  liveRadarTimer = setInterval(() => {
    pollLiveRadarQueries(storeRef);
  }, intervalSec * 1000);

  return currentLiveRadarSession;
}

function stopLiveRadarSession(storeRef: ElectronStore<StoreSchema>, reason?: string): LiveRadarSessionState {
  if (liveRadarTimer) {
    clearInterval(liveRadarTimer);
    liveRadarTimer = null;
  }
  currentLiveRadarSession.active = false;
  if (reason) {
    currentLiveRadarSession.notice = reason;
  }
  console.log(`[Live Radar] Stopped session. Analyzed: ${currentLiveRadarSession.totalQueriesAnalyzed}, Flagged: ${currentLiveRadarSession.flaggedCount}`);
  broadcastLiveRadarUpdate();
  return currentLiveRadarSession;
}

let appTray: Tray | null = null;

function getAssetPath(filename: string): string {
  const assetCandidates = [
    join(process.resourcesPath, 'assets', filename),
    join(process.resourcesPath, filename),
    join(app.getAppPath(), 'assets', filename),
    join(__dirname, '../assets', filename),
    join(__dirname, '../../assets', filename),
    join(process.cwd(), 'packages/electron-app/assets', filename),
    join(process.cwd(), 'assets', filename),
  ];
  for (const candidate of assetCandidates) {
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }
  return '';
}

function getAppIcon(): Electron.NativeImage | undefined {
  const iconPath = getAssetPath('Blockingmachine.png') || getAssetPath('Blockingmachine.icns');
  if (iconPath) {
    try {
      const loaded = nativeImage.createFromPath(iconPath);
      if (!loaded.isEmpty()) {
        return loaded;
      }
    } catch {
      // fallback
    }
  }
  return undefined;
}

function getTrayIcon(): Electron.NativeImage {
  const isMac = process.platform === 'darwin';
  if (isMac) {
    const templateCandidate = getAssetPath('trayTemplate.png') || getAssetPath('trayTemplate@2x.png');
    if (templateCandidate) {
      try {
        const loaded = nativeImage.createFromPath(templateCandidate);
        if (!loaded.isEmpty()) {
          const resized = loaded.resize({ width: 18, height: 18 });
          resized.setTemplateImage(true);
          return resized;
        }
      } catch {
        // fallback
      }
    }
  }

  const iconPath = getAssetPath('Blockingmachine.png');
  if (iconPath) {
    try {
      const loaded = nativeImage.createFromPath(iconPath);
      if (!loaded.isEmpty()) {
        const resized = loaded.resize({ width: 18, height: 18 });
        if (isMac) {
          resized.setTemplateImage(true);
        }
        return resized;
      }
    } catch {
      // fallback
    }
  }
  return nativeImage.createEmpty();
}

function createTray() {
  try {
    const icon = getTrayIcon();
    appTray = new Tray(icon);
    appTray.setToolTip('Blockingmachine');

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Blockingmachine', enabled: false },
      { type: 'separator' },
      {
        label: 'Open Blockingmachine',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      {
        label: 'Compile Rules Now',
        accelerator: 'Cmd+R',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('trigger-compile');
          }
        },
      },
      {
        label: 'Deploy & Sync...',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('navigate-view', 'deploy');
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Preferences...',
        accelerator: 'Cmd+,',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('open-settings');
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Blockingmachine',
        accelerator: 'Cmd+Q',
        click: () => app.quit(),
      },
    ]);
    appTray.setContextMenu(contextMenu);
    appTray.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.warn('Tray initialization skipped:', err);
  }
}

async function getOrLoadCompiledRules(storeRef: ElectronStore<StoreSchema>): Promise<StoredRule[]> {
  if (latestCompiledRules.length > 0) {
    return latestCompiledRules;
  }

  const savePath = storeRef.get('savePath');
  const candidates: string[] = [];

  if (savePath && typeof savePath === 'string' && isAbsolute(savePath)) {
    candidates.push(savePath);
    candidates.push(join(savePath, 'processed_rules.txt'));
    candidates.push(join(savePath, 'filter-list.txt'));
    candidates.push(join(savePath, 'adguard.txt'));
    candidates.push(join(savePath, 'hosts.txt'));
  }

  const defaultDocDir = join(app.getPath('documents'), 'Blockingmachine');
  candidates.push(join(defaultDocDir, 'processed_rules.txt'));
  candidates.push(join(defaultDocDir, 'filter-list.txt'));
  candidates.push(join(process.cwd(), 'filters', 'output', 'filter-list.txt'));
  candidates.push(join(process.cwd(), 'filters', 'output', 'hosts.txt'));
  candidates.push(join(process.cwd(), 'packages', 'electron-app', 'filters', 'output', 'hosts.txt'));

  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, 'utf8');
      if (content.length > 0) {
        latestCompiledRules = parseFilterList(content);
        if (latestCompiledRules.length > 0) {
          console.log(`[IPC Main] Loaded ${latestCompiledRules.length} compiled rules from ${candidate}`);
          break;
        }
      }
    } catch {
      // try next candidate
    }
  }

  return latestCompiledRules;
}

function sinkholeTlsAllowed(storeRef: ElectronStore<StoreSchema>): boolean {
  return Boolean(storeRef.get('allowInsecureLocalTls'));
}

function sinkholeUrlFields(storeRef: ElectronStore<StoreSchema>): SinkholeUrlFields {
  return {
    adguardMode: (storeRef.get('adguardMode') as SinkholeUrlFields['adguardMode']) || 'direct',
    adguardHomeUrl: (storeRef.get('adguardHomeUrl') as string) || '',
    adguardDirectUrl: (storeRef.get('adguardDirectUrl') as string) || '',
    adguardDirectPort: storeRef.get('adguardDirectPort') as number | undefined,
  };
}

async function readSinkholeProbe(
  storeRef: ElectronStore<StoreSchema>,
  url: string,
  headers?: Record<string, string>,
): Promise<ProbeResponse> {
  const res = await sinkholeFetch(url, {
    headers,
    timeoutMs: 6000,
    allowInsecureLocalTls: sinkholeTlsAllowed(storeRef),
  });
  return { ok: res.ok, status: res.status, statusText: res.statusText, body: await res.text() };
}

async function loadStoredAdguardQueries(storeRef: ElectronStore<StoreSchema>, limit: number) {
  const user = (storeRef.get('adguardHomeUser') as string) || '';
  const pass = (storeRef.get('adguardHomePassword') as string) || '';
  const headers: Record<string, string> = {};
  if (user || pass) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return fetchAdguardQueryLog({
    config: sinkholeUrlFields(storeRef),
    limit,
    request: async (url) => readSinkholeProbe(storeRef, url, url.includes('/control/') ? headers : undefined),
  });
}

function explainSinkholeFailure(
  storeRef: ElectronStore<StoreSchema>,
  err: unknown,
  url: string,
  opts?: { haAddonPortHint?: boolean; hintPort?: number | null },
): string {
  let endpoint: SinkholeEndpoint;
  try {
    endpoint = describeUrlEndpoint(url);
  } catch {
    endpoint = { display: url, host: url, port: opts?.hintPort ?? null, scheme: 'http' };
  }
  return formatSinkholeError(err, endpoint, {
    allowInsecureLocalTls: sinkholeTlsAllowed(storeRef),
    haAddonPortHint: opts?.haAddonPortHint,
    hintPort: opts?.hintPort,
  });
}

async function executeSinkholeSync(storeRef: ElectronStore<StoreSchema>) {
  const rawPihole = storeRef.get('piholeUrl') as string | undefined;
  const piholeApiKey = storeRef.get('piholeApiKey') as string | undefined;
  const rawAdguard = storeRef.get('adguardHomeUrl') as string | undefined;
  const adguardHomeUser = storeRef.get('adguardHomeUser') as string | undefined;
  const adguardHomePassword = storeRef.get('adguardHomePassword') as string | undefined;
  const adguardMode = (storeRef.get('adguardMode') as 'direct' | 'ha-api' | 'webhook' | undefined) || 'direct';
  const haToken = storeRef.get('haToken') as string | undefined;
  const haWebhookUrl = storeRef.get('haWebhookUrl') as string | undefined;
  const customWebhookUrl = storeRef.get('customWebhookUrl') as string | undefined;

  const results: { service: string; status: 'success' | 'error' | 'skipped'; message: string; details?: string }[] = [];

  if (rawPihole && rawPihole.trim()) {
    try {
      let piholeUrl = rawPihole.trim();
      if (!piholeUrl.startsWith('http://') && !piholeUrl.startsWith('https://')) {
        piholeUrl = `http://${piholeUrl}`;
      }
      const url = new URL(piholeUrl);
      if (piholeApiKey) {
        url.searchParams.set('auth', piholeApiKey.trim());
      }
      url.searchParams.set('action', 'updategravity');
      const target = url.toString();
      const res = await sinkholeFetch(target, {
        timeoutMs: 6000,
        allowInsecureLocalTls: sinkholeTlsAllowed(storeRef),
      });
      if (res.ok) {
        results.push({ service: 'Pi-hole', status: 'success', message: 'Gravity update triggered successfully' });
      } else {
        results.push({ service: 'Pi-hole', status: 'error', message: `HTTP status ${res.status}` });
      }
    } catch (err: any) {
      const attempted = rawPihole.trim().startsWith('http') ? rawPihole.trim() : `http://${rawPihole.trim()}`;
      results.push({ service: 'Pi-hole', status: 'error', message: explainSinkholeFailure(storeRef, err, attempted) });
    }
  } else {
    results.push({ service: 'Pi-hole', status: 'skipped', message: 'Not configured' });
  }

  // AdGuard Home Sync: supports Direct API, Home Assistant REST Service API, or Home Assistant Webhook
  if (adguardMode === 'ha-api') {
    const rawUrl = rawAdguard?.trim() || '';
    const haTarget = rawUrl ? resolveHaApiUrl(rawUrl) : null;
    if (haTarget?.ok && haToken?.trim()) {
      try {
        const api = await readSinkholeProbe(storeRef, haTarget.target.pingUrl, {
          Authorization: `Bearer ${haToken.trim()}`,
        });
        const identity = await classifyHaApiResponse(api, haTarget.target.pingUrl, (url) => readSinkholeProbe(storeRef, url));
        const blocked = haApiSyncBlockReason(identity);
        if (blocked) {
          results.push({
            service: 'AdGuard Home (Home Assistant)',
            status: 'error',
            message: blocked.message,
            details: blocked.details,
          });
        } else {
          const res = await sinkholeFetch(haTarget.target.refreshUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${haToken.trim()}`,
              'Content-Type': 'application/json',
            },
            timeoutMs: 7000,
            allowInsecureLocalTls: sinkholeTlsAllowed(storeRef),
          });
          if (res.ok) {
            const providerMsg = haTarget.target.baseUrl.includes('nabu.casa')
              ? 'Filters refreshed via Home Assistant API (Nabu Casa Cloud)'
              : 'Filters refreshed via Home Assistant API';
            results.push({ service: 'AdGuard Home (Home Assistant)', status: 'success', message: providerMsg });
          } else {
            results.push({ service: 'AdGuard Home (Home Assistant)', status: 'error', message: `Home Assistant API returned HTTP ${res.status}: ${res.statusText}` });
          }
        }
      } catch (err: any) {
        results.push({
          service: 'AdGuard Home (Home Assistant)',
          status: 'error',
          message: explainSinkholeFailure(storeRef, err, haTarget.target.refreshUrl),
        });
      }
    } else if (haTarget && !haTarget.ok) {
      results.push({ service: 'AdGuard Home (Home Assistant)', status: 'error', message: haTarget.message });
    } else {
      results.push({ service: 'AdGuard Home (Home Assistant)', status: 'skipped', message: 'Home Assistant URL or Bearer token missing' });
    }
  } else if (adguardMode === 'webhook') {
    const targetWebhook = haWebhookUrl?.trim() || rawAdguard?.trim() || '';
    const webhook = targetWebhook ? normalizeWebhookUrl(targetWebhook) : null;
    if (webhook?.ok) {
      try {
        const res = await sinkholeFetch(webhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'adguard_refresh', timestamp: new Date().toISOString() }),
          timeoutMs: 6000,
          allowInsecureLocalTls: sinkholeTlsAllowed(storeRef),
        });
        if (res.ok) {
          results.push({ service: 'AdGuard Home (Webhook)', status: 'success', message: 'Automation webhook triggered successfully' });
        } else {
          results.push({ service: 'AdGuard Home (Webhook)', status: 'error', message: `Webhook returned HTTP ${res.status}` });
        }
      } catch (err: any) {
        results.push({
          service: 'AdGuard Home (Webhook)',
          status: 'error',
          message: explainSinkholeFailure(storeRef, err, webhook.url),
        });
      }
    } else if (webhook && !webhook.ok) {
      results.push({ service: 'AdGuard Home (Webhook)', status: 'error', message: webhook.message });
    } else {
      results.push({ service: 'AdGuard Home (Webhook)', status: 'skipped', message: 'Webhook URL not configured' });
    }
  } else if (rawAdguard && rawAdguard.trim()) {
    const resolved = resolveAdguardDirectUrl(rawAdguard, storeRef.get('adguardDirectPort'));
    if (!resolved.ok) {
      results.push({ service: 'AdGuard Home', status: 'error', message: resolved.message });
    } else {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (adguardHomeUser && adguardHomePassword) {
          const credentials = Buffer.from(`${adguardHomeUser}:${adguardHomePassword}`).toString('base64');
          headers['Authorization'] = `Basic ${credentials}`;
        }
        const res = await sinkholeFetch(resolved.target.refreshUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ whitelist: false }),
          timeoutMs: 6000,
          allowInsecureLocalTls: sinkholeTlsAllowed(storeRef),
        });
        if (res.ok) {
          results.push({ service: 'AdGuard Home', status: 'success', message: 'Filters refreshed successfully' });
        } else {
          results.push({ service: 'AdGuard Home', status: 'error', message: `HTTP status ${res.status}` });
        }
      } catch (err: any) {
        results.push({
          service: 'AdGuard Home',
          status: 'error',
          message: explainSinkholeFailure(storeRef, err, resolved.target.refreshUrl, {
            haAddonPortHint: resolved.target.homeAssistantHost,
            hintPort: resolved.target.port,
          }),
        });
      }
    }
  } else {
    results.push({ service: 'AdGuard Home', status: 'skipped', message: 'Not configured' });
  }

  // Custom Homelab Webhook / Automation Endpoint
  if (customWebhookUrl && customWebhookUrl.trim()) {
    const webhook = normalizeWebhookUrl(customWebhookUrl);
    if (!webhook.ok) {
      results.push({ service: 'Custom Homelab Webhook', status: 'error', message: webhook.message });
    } else {
      try {
        const res = await sinkholeFetch(webhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'blockingmachine_compiled', timestamp: new Date().toISOString() }),
          timeoutMs: 6000,
          allowInsecureLocalTls: sinkholeTlsAllowed(storeRef),
        });
        if (res.ok) {
          results.push({ service: 'Custom Homelab Webhook', status: 'success', message: 'Homelab automation webhook triggered successfully' });
        } else {
          results.push({ service: 'Custom Homelab Webhook', status: 'error', message: `Webhook returned HTTP ${res.status}` });
        }
      } catch (err: any) {
        results.push({
          service: 'Custom Homelab Webhook',
          status: 'error',
          message: explainSinkholeFailure(storeRef, err, webhook.url),
        });
      }
    }
  }

  return results;
}

let feedHttpServer: HttpServer | null = null;
let feedServerPort = 9191;
const sseClients = new Set<ServerResponse>();
let sseHeartbeatTimer: NodeJS.Timeout | null = null;

export interface BrowserTelemetryData {
  lastUpdated: string;
  trackersBlocked: number;
  elementsHidden: number;
  threatsDetected: number;
  recentTrackers: Array<{ domain: string; count: number }>;
}

const browserTelemetryAggregator: BrowserTelemetryData = {
  lastUpdated: new Date().toISOString(),
  trackersBlocked: 0,
  elementsHidden: 0,
  threatsDetected: 0,
  recentTrackers: [],
};

function broadcastSseEvent(eventName: string, data: any) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function getLocalLanIp(): string {
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
  } catch {
    // fallback
  }
  return '127.0.0.1';
}

function getFeedServerStatus() {
  const isRunning = feedHttpServer !== null && feedHttpServer.listening;
  const lanIp = getLocalLanIp();
  return {
    isRunning,
    port: feedServerPort,
    localUrl: `http://localhost:${feedServerPort}`,
    lanUrl: `http://${lanIp}:${feedServerPort}`,
    lanIp,
  };
}

async function startFeedServer(port = 9191, storeRef: ElectronStore<StoreSchema>) {
  if (feedHttpServer && feedHttpServer.listening) {
    return getFeedServerStatus();
  }

  const safePort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 9191;
  feedServerPort = safePort;

  return new Promise<{ isRunning: boolean; port: number; localUrl: string; lanUrl: string; lanIp: string; error?: string }>((resolve) => {
    try {
      feedHttpServer = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const savePath = storeRef.get('savePath');
        const outputDir = dirname(savePath);
        let pathname: string;
        let reqUrl: URL;
        try {
          reqUrl = new URL(req.url || '/', 'http://localhost');
          pathname = decodeURIComponent(reqUrl.pathname);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Bad Request: Malformed URI' }));
          return;
        }
        const lowerPath = pathname.toLowerCase();

        // ====================================================================
        // REST API Endpoints for Home Assistant Integration & Browser Extension
        // ====================================================================
        if (lowerPath === '/v1/status' || lowerPath === '/api/status') {
          const currentSavePath = storeRef.get('savePath');
          const currentOutputDir = dirname(currentSavePath);
          const history = storeRef.get('compilationHistory') || [];
          const lastSnapshot = history[0];
          const quarantine = (storeRef.get('aiThreatQuarantine') || []) as ThreatQuarantineItem[];

          let dnsRuleCount = 0;
          let browserRuleCount = 0;
          try {
            if (existsSync(join(currentOutputDir, 'dns.txt'))) {
              const dnsText = await fs.readFile(join(currentOutputDir, 'dns.txt'), 'utf8');
              dnsRuleCount = dnsText.split('\n').filter((l) => l.trim() && !l.startsWith('!') && !l.startsWith('#')).length;
            }
            if (existsSync(join(currentOutputDir, 'browser.txt'))) {
              const browserText = await fs.readFile(join(currentOutputDir, 'browser.txt'), 'utf8');
              browserRuleCount = browserText.split('\n').filter((l) => l.trim() && !l.startsWith('!') && !l.startsWith('#')).length;
            }
          } catch {
            // fallback
          }

          const statusPayload = {
            status: 'online',
            service: 'Blockingmachine Hub',
            version: app.getVersion(),
            uptimeSeconds: Math.floor(process.uptime()),
            rules: {
              total: lastSnapshot?.uniqueRuleCount || latestCompiledRules.length || 0,
              dns: dnsRuleCount || lastSnapshot?.uniqueRuleCount || 0,
              browser: browserRuleCount || lastSnapshot?.uniqueRuleCount || 0,
              quarantinedThreats: quarantine.length,
            },
            lastCompile: storeRef.get('lastProcessTime') || lastSnapshot?.timestamp || null,
            feedServer: {
              port: feedServerPort,
              lanIp: getLocalLanIp(),
              dnsFeedUrl: `http://${getLocalLanIp()}:${feedServerPort}/dns.txt`,
              browserFeedUrl: `http://${getLocalLanIp()}:${feedServerPort}/browser.txt`,
              aiThreatsFeedUrl: `http://${getLocalLanIp()}:${feedServerPort}/ai-threats.txt`,
              abpThreatsFeedUrl: `http://${getLocalLanIp()}:${feedServerPort}/threats.txt`,
            },
            protection: {
              enabled: true,
              pausedUntil: null,
            },
            aiRadar: {
              enabled: storeRef.get('aiWatchdogConfig')?.enabled ?? false,
              sessionActive: currentLiveRadarSession.active,
            },
            browserTelemetry: browserTelemetryAggregator,
            activeSseClients: sseClients.size,
          };

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(statusPayload, null, 2));
          return;
        }

        // Origin guard for control and telemetry mutations
        const originHeader = req.headers.origin || (typeof req.headers.referer === 'string' ? req.headers.referer : undefined);
        const isSafeClientOrigin = (): boolean => {
          if (!originHeader) return true;
          try {
            const parsedOrigin = new URL(originHeader);
            return (
              parsedOrigin.hostname === 'localhost' ||
              parsedOrigin.hostname === '127.0.0.1' ||
              parsedOrigin.hostname.endsWith('.local') ||
              parsedOrigin.protocol === 'chrome-extension:' ||
              parsedOrigin.protocol === 'moz-extension:'
            );
          } catch {
            return false;
          }
        };

        if (lowerPath === '/v1/events' || lowerPath === '/api/events') {
          if (sseClients.size >= 64) {
            res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Too Many Connections', message: 'Maximum SSE subscribers reached' }));
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
          res.write(
            `event: connected\ndata: ${JSON.stringify({
              status: 'connected',
              version: typeof app?.getVersion === 'function' ? app.getVersion() : '1.0.0',
              timestamp: new Date().toISOString(),
              ruleCount: latestCompiledRules.length,
            })}\n\n`
          );
          sseClients.add(res);

          if (!sseHeartbeatTimer) {
            sseHeartbeatTimer = setInterval(() => {
              for (const client of sseClients) {
                try {
                  client.write(': ping\n\n');
                } catch {
                  sseClients.delete(client);
                }
              }
            }, 20000);
          }

          req.on('close', () => {
            sseClients.delete(res);
            if (sseClients.size === 0 && sseHeartbeatTimer) {
              clearInterval(sseHeartbeatTimer);
              sseHeartbeatTimer = null;
            }
          });
          return;
        }

        if (lowerPath === '/v1/telemetry/browser' || lowerPath === '/api/telemetry/browser') {
          if (!isSafeClientOrigin()) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Cross-origin telemetry forbidden' }));
            return;
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Method Not Allowed. Use POST.' }));
            return;
          }
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1e6) req.destroy();
          });
          req.on('end', () => {
            try {
              const data = JSON.parse(body || '{}');
              if (typeof data.trackersBlocked === 'number' && Number.isFinite(data.trackersBlocked)) {
                browserTelemetryAggregator.trackersBlocked += Math.max(0, Math.floor(data.trackersBlocked));
              }
              if (typeof data.elementsHidden === 'number' && Number.isFinite(data.elementsHidden)) {
                browserTelemetryAggregator.elementsHidden += Math.max(0, Math.floor(data.elementsHidden));
              }
              if (typeof data.threatsDetected === 'number' && Number.isFinite(data.threatsDetected)) {
                browserTelemetryAggregator.threatsDetected += Math.max(0, Math.floor(data.threatsDetected));
              }
              if (Array.isArray(data.trackers)) {
                for (const t of data.trackers) {
                  if (typeof t?.domain !== 'string' || !t.domain.trim() || t.domain.length > 253) continue;
                  const domain = t.domain.trim().toLowerCase();
                  const count = typeof t.count === 'number' && Number.isFinite(t.count) && t.count > 0 ? Math.floor(t.count) : 1;
                  const exist = browserTelemetryAggregator.recentTrackers.find((x) => x.domain === domain);
                  if (exist) {
                    exist.count += count;
                  } else {
                    browserTelemetryAggregator.recentTrackers.unshift({ domain, count });
                  }
                }
                browserTelemetryAggregator.recentTrackers = browserTelemetryAggregator.recentTrackers.slice(0, 50);
              }
              browserTelemetryAggregator.lastUpdated = new Date().toISOString();

              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: true, aggregated: browserTelemetryAggregator }));
            } catch (err: any) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: err?.message || 'Invalid JSON' }));
            }
          });
          return;
        }

        if (lowerPath === '/v1/control/cosmetics' || lowerPath === '/api/control/cosmetics') {
          if (!isSafeClientOrigin()) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Cross-origin control forbidden' }));
            return;
          }

          if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: 'Cosmetics status query' }));
            return;
          }

          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
            return;
          }

          let enabled = true;
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1e6) {
              req.destroy();
            }
          });
          req.on('end', () => {
            try {
              const data = JSON.parse(body || '{}');
              if (typeof data.enabled === 'boolean') enabled = data.enabled;
              broadcastSseEvent('remote_control', { action: 'toggle_cosmetics', enabled });
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: true, action: 'toggle_cosmetics', enabled }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: 'Invalid payload' }));
            }
          });
          return;
        }

        if (lowerPath === '/v1/control/reload' || lowerPath === '/api/control/reload') {
          if (!isSafeClientOrigin()) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Cross-origin control forbidden' }));
            return;
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Method Not Allowed' }));
            return;
          }
          broadcastSseEvent('remote_control', { action: 'reload_rules' });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, action: 'reload_rules', message: 'Reload signal broadcast to connected browsers' }));
          return;
        }

        if (lowerPath === '/v1/compile' || lowerPath === '/api/compile') {
          if (!isSafeClientOrigin()) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Cross-origin compilation forbidden' }));
            return;
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Method Not Allowed. Use POST.' }));
            return;
          }
          console.log('[Feed Server API] Received trigger: compile rules');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('trigger-compile');
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, message: 'Compilation triggered in Blockingmachine hub' }));
          return;
        }

        if (lowerPath === '/v1/check') {
          const domainToCheck = reqUrl.searchParams.get('domain') || '';
          const clean = domainToCheck.trim().toLowerCase();
          if (clean.length > 253) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Domain exceeds maximum length of 253 characters' }));
            return;
          }
          const isCovered = clean ? isDomainCoveredByRules(clean, latestCompiledRules.map((r) => r.raw)) : false;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ domain: clean, blocked: isCovered, timestamp: new Date().toISOString() }));
          return;
        }

        if (lowerPath === '/v1/telemetry') {
          const quarantine = (storeRef.get('aiThreatQuarantine') || []) as ThreatQuarantineItem[];
          const history = storeRef.get('compilationHistory') || [];
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            threats: quarantine.slice(0, 50),
            history: history.slice(0, 5),
            browser: browserTelemetryAggregator,
          }));
          return;
        }

        if (lowerPath === '/ai-threats.txt' || lowerPath === '/ai-threats') {
          const quarantine = (storeRef.get('aiThreatQuarantine') || []) as ThreatQuarantineItem[];
          const highConfThreats = quarantine
            .filter((t) => {
              const conf = typeof t.confidence === 'number' ? (t.confidence > 1 ? t.confidence : t.confidence * 100) : 0;
              return conf >= 85 && Boolean(t.domain);
            })
            .map((t) => t.domain.trim().toLowerCase());
          const uniqueDomains = Array.from(new Set(highConfThreats)).sort();

          const header = [
            '# Title: Blockingmachine AI Threat Feed (Domain List)',
            `# Updated: ${new Date().toISOString()}`,
            `# High-Confidence Quarantined Domains: ${uniqueDomains.length}`,
            '# Confidence Threshold: >= 85%',
            '',
          ].join('\n');

          const body = uniqueDomains.length > 0 ? `${header}${uniqueDomains.join('\n')}\n` : `${header}# No active threats currently quarantined\n`;
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(body);
          return;
        }

        if (lowerPath === '/threats.txt' || lowerPath === '/threats') {
          const quarantine = (storeRef.get('aiThreatQuarantine') || []) as ThreatQuarantineItem[];
          const highConfThreats = quarantine
            .filter((t) => {
              const conf = typeof t.confidence === 'number' ? (t.confidence > 1 ? t.confidence : t.confidence * 100) : 0;
              return conf >= 85 && Boolean(t.domain);
            })
            .map((t) => t.domain.trim().toLowerCase());
          const uniqueDomains = Array.from(new Set(highConfThreats)).sort();

          const header = [
            '! Title: Blockingmachine AI Threat Feed (ABP Format)',
            `! Updated: ${new Date().toISOString()}`,
            `! High-Confidence Quarantined Domains: ${uniqueDomains.length}`,
            '! Confidence Threshold: >= 85%',
            '',
          ].join('\n');

          const abpRules = uniqueDomains.map((d) => `||${d}^`);
          const body = abpRules.length > 0 ? `${header}${abpRules.join('\n')}\n` : `${header}! No active threats currently quarantined\n`;
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(body);
          return;
        }

        const isDnsEndpoint =
          lowerPath === '/dns.txt' ||
          lowerPath === '/dns-rules.txt' ||
          lowerPath === '/adguarddns.txt';
        const isBrowserEndpoint =
          lowerPath === '/browser.txt' ||
          lowerPath === '/browser-rules.txt' ||
          lowerPath === '/adguardbrowser.txt';

        // Determine target file to serve with strict DNS vs Browser endpoint routing
        let targetFilePath = savePath;

        if (isDnsEndpoint) {
          const dnsCandidates = [
            join(outputDir, 'dns.txt'),
            join(outputDir, 'processed_dns.txt'),
            join(outputDir, 'adguardDns.txt'),
            join(outputDir, 'processed_domains.txt'),
            join(outputDir, 'processed_hosts.txt'),
          ];
          for (const cand of dnsCandidates) {
            if (existsSync(cand)) {
              targetFilePath = cand;
              break;
            }
          }
        } else if (isBrowserEndpoint) {
          const browserCandidates = [
            join(outputDir, 'browser.txt'),
            join(outputDir, 'processed_browser.txt'),
            join(outputDir, 'adguardBrowser.txt'),
            join(outputDir, 'processed_abp.txt'),
            join(outputDir, 'processed_adguard.txt'),
          ];
          for (const cand of browserCandidates) {
            if (existsSync(cand)) {
              targetFilePath = cand;
              break;
            }
          }
        } else if (pathname !== '/' && pathname.length > 1) {
          const cleanName = basename(pathname);
          if (cleanName.startsWith('.')) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('403 Forbidden: Hidden files cannot be served.');
            return;
          }
          targetFilePath = join(outputDir, cleanName);
        }

        // Security check: verify resolved target is within outputDir or matches savePath
        const resolvedTarget = pathResolve(targetFilePath);
        const resolvedOutputDir = pathResolve(outputDir);
        const resolvedSavePath = pathResolve(savePath);
        const safeDir = resolvedOutputDir.endsWith(sep) ? resolvedOutputDir : `${resolvedOutputDir}${sep}`;
        if (!resolvedTarget.startsWith(safeDir) && resolvedTarget !== resolvedSavePath) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('403 Forbidden: Access denied.');
          return;
        }

        try {
          if (existsSync(targetFilePath)) {
            // If serving the fallback savePath for a dedicated DNS or Browser endpoint, filter on-the-fly
            if (targetFilePath === savePath && (isDnsEndpoint || isBrowserEndpoint)) {
              const rawText = await fs.readFile(savePath, 'utf8');
              const lines = rawText.split('\n');
              let filteredLines: string[] = [];

              if (isDnsEndpoint) {
                // Keep only DNS-safe rules (reject cosmetics, scriptlets, browser modifiers, paths, arpa)
                filteredLines = lines.filter((line) => {
                  const t = line.trim();
                  if (!t || t.startsWith('!') || t.startsWith('#')) return true;
                  if (t.includes('##') || t.includes('#@#') || t.includes('#?#') || t.includes('$$') || t.includes('+js(')) return false;
                  if (t.includes('.arpa') || t.includes('/')) return false;
                  if (t.includes('$')) {
                    const mods = t.split('$')[1]?.toLowerCase().split(',') || [];
                    if (mods.some((m) => ['image', 'script', 'stylesheet', 'websocket', 'csp', 'popup', 'media'].includes(m.split('=')[0]))) {
                      return false;
                    }
                  }
                  return true;
                });
              } else {
                // Keep only browser-safe rules (reject DNS rewrite, query types, loopback hosts mappings)
                filteredLines = lines.filter((line) => {
                  const t = line.trim();
                  if (!t || t.startsWith('!') || t.startsWith('#')) return true;
                  if (t.includes('$dnsrewrite') || t.includes('$dnstype') || t.includes('$client') || t.includes('$ctag') || t.includes('.arpa')) {
                    return false;
                  }
                  if (/^(?:0\.0\.0\.0|127\.0\.0\.1|::1|::)\s+(?:localhost|broadcasthost|local)/i.test(t)) {
                    return false;
                  }
                  return true;
                });
              }

              const payload = Buffer.from(filteredLines.join('\n'), 'utf8');
              res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Length': payload.length,
              });
              res.end(payload);
              return;
            }

            const stat = await fs.stat(targetFilePath);
            if (stat.isFile()) {
              res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Length': stat.size,
              });
              const stream = createReadStream(targetFilePath);
              stream.on('error', (streamErr) => {
                console.error('[Feed Server Stream Error]:', streamErr);
                if (!res.headersSent) {
                  res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                }
                res.end();
              });
              res.on('close', () => {
                stream.destroy();
              });
              stream.pipe(res);
              return;
            }
          }

          // Not found response with helpful feed directory listing
          const available = existsSync(outputDir) ? (await fs.readdir(outputDir)).filter((f) => !f.startsWith('.')) : [];
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(
            `File not found: ${pathname}\n\nAvailable compiled lists in Blockingmachine output directory:\n${available.map((f) => ` - http://${getLocalLanIp()}:${feedServerPort}/${f}`).join('\n') || ' (no files yet - compile rules first)'}`
          );
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Internal server error: ${err?.message || err}`);
        }
      });

      feedHttpServer.on('error', (err: any) => {
        console.error('[Feed Server Error]:', err);
        feedHttpServer = null;
        resolve({
          ...getFeedServerStatus(),
          error: err?.message || String(err),
        });
      });

      feedHttpServer.listen(feedServerPort, '0.0.0.0', () => {
        console.log(`[Feed Server] Started on http://0.0.0.0:${feedServerPort}`);
        resolve(getFeedServerStatus());
      });
    } catch (err: any) {
      resolve({
        ...getFeedServerStatus(),
        error: err?.message || String(err),
      });
    }
  });
}

function stopFeedServer() {
  if (sseHeartbeatTimer) {
    clearInterval(sseHeartbeatTimer);
    sseHeartbeatTimer = null;
  }
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      // ignore
    }
  }
  sseClients.clear();

  if (feedHttpServer) {
    try {
      if (typeof (feedHttpServer as any).closeAllConnections === 'function') {
        (feedHttpServer as any).closeAllConnections();
      }
      feedHttpServer.close();
    } catch {
      // ignore
    }
    feedHttpServer = null;
  }
  return getFeedServerStatus();
}

// Remove the typed wrapper and use store directly
function registerIPCHandlers(store: ElectronStore<StoreSchema>): void {
  try {
    console.log('[Main Process] Registering IPC handlers...');

    // Initialize schedule if configured
    const initialSchedule = store.get('autoSchedule') || 'disabled';
    if (initialSchedule !== 'disabled') {
      setupAutoScheduleTimer(initialSchedule, store);
    }

    // Initialize AI Sentinel Watchdog if configured [Beta]
    const initialWatchdog = store.get('aiWatchdogConfig') as AiWatchdogConfig | undefined;
    if (initialWatchdog?.enabled) {
      setupAiWatchdogTimer(initialWatchdog, store);
    }

    ipcMain.handle('get-custom-rules', async () => {
      try {
        return store.get('customRules', '');
      } catch (error) {
        console.error('Error getting custom rules:', error);
        return '';
      }
    });

    ipcMain.handle(
      'save-custom-rules',
      async (_event: IpcMainInvokeEvent, rules: string) => {
        console.log('[IPC Main] Received request to save custom rules.');
        try {
          store.set('customRules', rules);
          console.log('[IPC Main] Custom rules saved successfully.');
          return { success: true };
        } catch (error) {
          console.error('[IPC Main] Error saving custom rules:', error);
          const message =
            error instanceof Error ? error.message : String(error);
          return { success: false, error: message };
        }
      }
    );

    ipcMain.handle('get-sources', async (_event: IpcMainInvokeEvent) => {
      const sources: FilterSource[] = store.get('filterSources');
      return sources;
    });

    ipcMain.handle('get-filter-sources', async (_event: IpcMainInvokeEvent) => {
      return store.get('filterSources') || [];
    });

    ipcMain.handle(
      'save-sources',
      async (_event: IpcMainInvokeEvent, sources: FilterSource[]) => {
        console.log('[IPC Main] Received request to save sources.');
        try {
          store.set('filterSources', sources);
          console.log('[IPC Main] Sources saved successfully.');
          return { success: true };
        } catch (error) {
          console.error('[IPC Main] Error saving sources:', error);
          const message =
            error instanceof Error ? error.message : String(error);
          return { success: false, error: message };
        }
      }
    );

    ipcMain.handle(
      'set-filter-sources',
      async (_event: IpcMainInvokeEvent, sources: FilterSource[]) => {
        try {
          store.set('filterSources', sources);
          return { success: true };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return { success: false, error: message };
        }
      }
    );

    ipcMain.handle(
      'get-module-content',
      async (_event: IpcMainInvokeEvent, moduleFileName: string) => {
        try {
          const cleanName = basename(moduleFileName);
          const candidatePaths = [
            join(__dirname, '../filters/modules', cleanName),
            join(process.cwd(), 'packages/electron-app/filters/modules', cleanName),
            join(process.cwd(), 'filters/modules', cleanName),
            join(app.getAppPath(), 'filters/modules', cleanName),
          ];
          for (const candidate of candidatePaths) {
            if (existsSync(candidate)) {
              return await fs.readFile(candidate, 'utf-8');
            }
          }
          return null;
        } catch (err) {
          console.error('[IPC Main] Error reading module content:', err);
          return null;
        }
      }
    );

    // High-performance concurrent filter processor
    ipcMain.handle('run-import-process', async (_event: IpcMainInvokeEvent) => {
      const startTime = Date.now();
      const sender = _event.sender;
      const sendProgress = (data: { status: string; percent: number }) => {
        if (sender && !sender.isDestroyed()) {
          sender.send('process-progress', data);
        }
      };

      try {
        sendProgress({
          status: 'Loading sources...',
          percent: 5,
        });
        const sources = store.get('filterSources');
        const enabledSources = sources.filter(
          (source: FilterSource) => source.enabled
        );

        if (enabledSources.length === 0) {
          return {
            success: false,
            error:
              'No enabled sources found. Please enable at least one source.',
            processedRuleCount: 0,
            uniqueRuleCount: 0,
            timestamp: new Date().toLocaleString(),
          };
        }

        const totalSources = enabledSources.length;
        sendProgress({
          status: `Fetching ${totalSources} sources concurrently...`,
          percent: 10,
        });

        let finishedCount = 0;
        // Fetch up to 5 sources in parallel for 5-8x speedup
        const sourceResults = await mapConcurrent(
          enabledSources,
          5,
          async (source) => {
            console.log(
              `[IPC Main] Concurrent fetch: ${source.name} (${source.url})`
            );
            try {
              const rules = await downloadAndParseSource(source.url);
              finishedCount++;
              const percent = Math.floor(10 + (finishedCount / totalSources) * 45);
              sendProgress({
                status: `Fetched ${finishedCount}/${totalSources}: ${source.name} (${rules.length.toLocaleString()} rules)`,
                percent,
              });
              return { source, rules: rules as StoredRule[], error: null };
            } catch (sourceError) {
              finishedCount++;
              const errorMsg =
                sourceError instanceof Error ? sourceError.message : String(sourceError);
              console.error(
                `[IPC Main] Error processing source ${source.name}:`,
                errorMsg
              );
              return { source, rules: [] as StoredRule[], error: errorMsg };
            }
          }
        );

        sendProgress({
          status: 'Deduplicating rules across feeds...',
          percent: 65,
        });

        const deduplicator = new RuleDeduplicator();
        const uniqueRulesSet = new Set<string>();
        const uniqueRules: StoredRule[] = [];
        let totalProcessedCount = 0;

        // Iterate safely without spreading large arrays onto call stack or doubling heap allocations
        for (const res of sourceResults) {
          if (!res.rules || res.rules.length === 0) continue;
          totalProcessedCount += res.rules.length;
          const rules = res.rules;
          const rulesLen = rules.length;
          for (let i = 0; i < rulesLen; i++) {
            const rule = rules[i];
            if (!rule || !rule.raw) continue;
            const strippedRule =
              deduplicator.stripRule(rule.raw) || rule.raw.toLowerCase().trim();
            if (!uniqueRulesSet.has(strippedRule)) {
              uniqueRulesSet.add(strippedRule);
              uniqueRules.push(rule);
            }
          }
        }

        const uniqueRuleCount = uniqueRules.length;
        const duplicatesRemovedCount = totalProcessedCount - uniqueRuleCount;
        console.log(`[IPC Main] Deduplication complete:
  - Initial rules: ${totalProcessedCount}
  - Unique rules: ${uniqueRuleCount}
  - Duplicates removed: ${duplicatesRemovedCount}
`);

        if (!Array.isArray(uniqueRules) || uniqueRules.length === 0) {
          throw new Error('No valid rules found after deduplication');
        }

        sendProgress({
          status: 'Adding custom rules...',
          percent: 80,
        });
        const customRulesText = (store.get('customRules') || '') as string;
        if (typeof customRulesText === 'string' && customRulesText.trim()) {
          const customRules = parseFilterList(customRulesText, 'custom');
          let addedCustom = 0;
          for (const rule of customRules) {
            if (!rule || !rule.raw) continue;
            const stripped =
              deduplicator.stripRule(rule.raw) || rule.raw.toLowerCase().trim();
            if (!uniqueRulesSet.has(stripped)) {
              uniqueRulesSet.add(stripped);
              uniqueRules.push(rule);
              addedCustom++;
            }
          }
          console.log(
            `[IPC Main] Added ${addedCustom} unique custom rules (${customRules.length} total parsed).`
          );
        }

        // Cache latest compiled rules in memory for live Rule Inspector
        latestCompiledRules = uniqueRules;

        const exceptionRuleCount = uniqueRules.filter(
          (rule) => rule.isException || (rule.raw && rule.raw.startsWith('@@'))
        ).length;

        sendProgress({
          status: 'Generating filter lists...',
          percent: 90,
        });
        const format = store.get('exportFormat');
        if (!isValidFormat(format)) {
          throw new Error('Invalid export format');
        }

        const metadata: FilterListMetadata = {
          title: 'Blockingmachine Generated Filter List',
          description: 'Combined and deduplicated filter list generated by Blockingmachine',
          homepage: 'https://blockingmachine.com',
          version: app.getVersion(),
          lastUpdated: new Date().toISOString(),
          stats: {
            totalRules: uniqueRules.length,
            uniqueRules: uniqueRules.length,
            blockingRules: uniqueRules.length - exceptionRuleCount,
            exceptionRules: exceptionRuleCount,
            duplicatesRemoved: duplicatesRemovedCount,
          },
          generatorVersion: app.getVersion(),
        };

        const generatedList = generateFilterList(uniqueRules, metadata, format);

        sendProgress({
          status: 'Saving to disk...',
          percent: 95,
        });
        let savePath = store.get('savePath');
        if (!savePath || typeof savePath !== 'string' || !isAbsolute(savePath)) {
          savePath = join(
            app.getPath('documents'),
            'Blockingmachine',
            'processed_rules.txt'
          );
        }
        await fs.mkdir(dirname(savePath), { recursive: true });
        await fs.writeFile(savePath, generatedList, 'utf8');
        console.log(`[IPC Main] Filter list saved to: ${savePath}`);

        // Simultaneous Multi-Format Export
        const additionalFormats = (store.get('additionalFormats') || []) as FilterFormat[];
        const validAdditional = additionalFormats.filter(
          (f) => f !== format && isValidFormat(f)
        );
        const outputDir = dirname(savePath);
        for (const addFormat of validAdditional) {
          try {
            const addContent = generateFilterList(uniqueRules, metadata, addFormat);
            const ext = addFormat === 'dnsmasq' ? '.conf' : '.txt';
            const addPath = join(outputDir, `processed_${addFormat}${ext}`);
            await fs.writeFile(addPath, addContent, 'utf8');
            console.log(`[IPC Main] Additional export saved: ${addPath}`);
          } catch (addError) {
            console.error(`[IPC Main] Failed to write additional format ${addFormat}:`, addError);
          }
        }

        const timestampStr = new Date().toLocaleString();
        store.set('lastProcessTime', timestampStr);

        // Automatically write segregated endpoint files for System Daemon (dns.txt) and Browser Extension (browser.txt)
        try {
          const dnsRules = filterDNSRules(uniqueRules);
          const dnsMeta: FilterListMetadata = {
            ...metadata,
            stats: {
              ...metadata.stats,
              totalRules: dnsRules.length,
              uniqueRules: dnsRules.length,
            },
          };
          const dnsContent = generateFilterList(dnsRules, dnsMeta, 'adguard');
          await fs.writeFile(join(outputDir, 'dns.txt'), dnsContent, 'utf8');
          await fs.writeFile(join(outputDir, 'adguardDns.txt'), dnsContent, 'utf8');
          console.log(`[IPC Main] Segregated DNS endpoints saved: dns.txt (${dnsRules.length} rules)`);

          // Automatically hot-reload System DNS Daemon if running
          daemonManager.reloadRules().catch(() => {});

          const browserRules = filterBrowserRules(uniqueRules);
          const browserMeta: FilterListMetadata = {
            ...metadata,
            stats: {
              ...metadata.stats,
              totalRules: browserRules.length,
              uniqueRules: browserRules.length,
            },
          };
          const browserContent = generateFilterList(browserRules, browserMeta, 'adguard');
          await fs.writeFile(join(outputDir, 'browser.txt'), browserContent, 'utf8');
          await fs.writeFile(join(outputDir, 'adguardBrowser.txt'), browserContent, 'utf8');
          console.log(`[IPC Main] Segregated Browser endpoints saved: browser.txt (${browserRules.length} rules)`);

          // Broadcast real-time SSE event to connected browser extensions & LAN clients
          broadcastSseEvent('compile_completed', {
            timestamp: timestampStr,
            uniqueRuleCount,
            processedRuleCount: totalProcessedCount,
            dnsRuleCount: dnsRules.length,
            browserRuleCount: browserRules.length,
          });
          broadcastSseEvent('rules_updated', {
            timestamp: timestampStr,
            ruleCount: uniqueRuleCount,
            dnsRuleCount: dnsRules.length,
            browserRuleCount: browserRules.length,
          });
        } catch (segErr) {
          console.error('[IPC Main] Failed to write segregated dns/browser endpoints:', segErr);
        }

        // Record in compilation history
        const prevHistory = (store.get('compilationHistory') || []) as CompilationSnapshot[];
        const newSnapshot: CompilationSnapshot = {
          timestamp: timestampStr,
          processedRuleCount: totalProcessedCount,
          uniqueRuleCount,
          exceptionRuleCount,
          duplicatesRemoved: duplicatesRemovedCount,
          exportFormats: [format, ...validAdditional],
        };
        store.set('compilationHistory', [newSnapshot, ...prevHistory].slice(0, 10));

        // Trigger optional post-compilation webhook
        const webhookUrl = store.get('webhookUrl');
        if (typeof webhookUrl === 'string' && webhookUrl.trim().startsWith('http')) {
          sinkholeFetch(webhookUrl.trim(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeoutMs: 10000,
            allowInsecureLocalTls: sinkholeTlsAllowed(store),
            body: JSON.stringify({
              event: 'compilation_complete',
              timestamp: new Date().toISOString(),
              uniqueRules: uniqueRuleCount,
              totalRules: totalProcessedCount,
              format,
              savePath,
            }),
          }).catch((err) => console.error('[IPC Main] Webhook ping failed:', err));
        }

        // Trigger Sinkhole Sync if configured
        if (store.get('syncOnCompile')) {
          executeSinkholeSync(store).catch((err) =>
            console.error('[IPC Main] Sinkhole auto-sync failed:', err)
          );
        }

        // Native Desktop Notification
        if (Notification.isSupported()) {
          const notifIconPath = getAssetPath('Blockingmachine.png');
          new Notification({
            title: 'Blockingmachine',
            body: `Compilation complete: ${uniqueRuleCount.toLocaleString()} rules compiled.`,
            icon: notifIconPath || undefined,
          }).show();
        }

        sendProgress({ status: 'Complete!', percent: 100 });

        const endTime = Date.now();
        console.log(`[IPC Main] Concurrent import process took ${endTime - startTime}ms.`);

        return {
          success: true,
          processedRuleCount: totalProcessedCount,
          uniqueRuleCount: uniqueRuleCount,
          exceptionRuleCount: exceptionRuleCount,
          timestamp: timestampStr,
        };
      } catch (error) {
        console.error('[IPC Main] Error during import process:', error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        return {
          success: false,
          error: errorMessage,
          processedRuleCount: 0,
          uniqueRuleCount: 0,
          timestamp: new Date().toLocaleString(),
        };
      }
    });

    // --- Domain Inspector IPC Handler ---
    ipcMain.handle('inspect-domain', async (_event, domainQuery: string): Promise<DomainInspectionResult> => {
      if (!domainQuery || typeof domainQuery !== 'string') {
        return {
          domain: '',
          verdict: 'not_blocked',
          details: 'Please enter a valid domain to test.',
        };
      }

      const rawInput = domainQuery.trim();
      let cleanDomain = rawInput.toLowerCase();

      // Robust URL parser handling protocols, paths, query params, hashes, and ports
      if (cleanDomain.startsWith('http://') || cleanDomain.startsWith('https://') || cleanDomain.startsWith('ftp://')) {
        try {
          const parsed = new URL(cleanDomain);
          cleanDomain = parsed.hostname;
        } catch {
          // fallback regex
        }
      }
      cleanDomain = cleanDomain.replace(/^[a-zA-Z]+:\/\//, '');
      cleanDomain = cleanDomain.replace(/[/?#].*$/, '');
      cleanDomain = cleanDomain.replace(/:[0-9]+$/, '');
      cleanDomain = cleanDomain.replace(/^www\./, '');

      if (!cleanDomain) {
        return {
          domain: rawInput,
          inputQuery: rawInput,
          verdict: 'not_blocked',
          details: 'Invalid domain format.',
        };
      }

      const rulesToSearch = await getOrLoadCompiledRules(store);
      const evalResult = evaluateDomainRules(cleanDomain, rulesToSearch);

      if (evalResult.verdict === 'exception') {
        const matchingRuleObj = rulesToSearch.find((r) => r.raw === evalResult.matchingRule);
        return {
          domain: cleanDomain,
          inputQuery: rawInput,
          verdict: 'exception',
          matchingRule: evalResult.matchingRule || '',
          sourceName: matchingRuleObj?.metadata?.sourceInfo?.url || 'Custom Rules / Allowlist',
          ruleType: matchingRuleObj?.type || 'exception',
          details: evalResult.details,
        };
      }

      if (evalResult.verdict === 'blocked') {
        const matchingRuleObj = rulesToSearch.find((r) => r.raw === evalResult.matchingRule);
        return {
          domain: cleanDomain,
          inputQuery: rawInput,
          verdict: 'blocked',
          matchingRule: evalResult.matchingRule || '',
          sourceName: matchingRuleObj?.metadata?.sourceInfo?.url || 'Filter Feeds',
          ruleType: matchingRuleObj?.type || 'domain',
          details: evalResult.details,
        };
      }

      return {
        domain: cleanDomain,
        inputQuery: rawInput,
        verdict: 'not_blocked',
        details: 'Domain is not blocked by any enabled filter list or custom rule.',
      };
    });

    // --- Feed Diagnostic Test Handler ---
    ipcMain.handle('test-feed-url', async (_event, url: string): Promise<FeedDiagnostic> => {
      const startTime = Date.now();
      if (!url || typeof url !== 'string') {
        return {
          url: String(url || ''),
          status: 'error',
          latencyMs: 0,
          error: 'URL must be a non-empty string',
        };
      }
      try {
        const parsed = new URL(url.trim());
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return {
            url,
            status: 'error',
            latencyMs: 0,
            error: `Unsupported protocol "${parsed.protocol}". Only HTTP and HTTPS feeds are supported.`,
          };
        }
        const rules = await downloadAndParseSource(url.trim());
        return {
          url,
          status: 'ok',
          latencyMs: Date.now() - startTime,
          ruleCount: rules.length,
        };
      } catch (error) {
        return {
          url,
          status: 'error',
          latencyMs: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    // --- Multi-Format & Schedule Handlers ---
    ipcMain.handle('get-additional-formats', async () => {
      return store.get('additionalFormats') || [];
    });

    ipcMain.handle('set-additional-formats', async (_event, formats: FilterFormat[]) => {
      store.set('additionalFormats', formats);
      return { success: true };
    });

    ipcMain.handle('get-auto-schedule', async () => {
      return store.get('autoSchedule') || 'disabled';
    });

    ipcMain.handle('set-auto-schedule', async (_event, schedule: 'disabled' | '12h' | '24h' | 'weekly') => {
      store.set('autoSchedule', schedule);
      setupAutoScheduleTimer(schedule, store);
      return { success: true };
    });

    ipcMain.handle('get-webhook-url', async () => {
      return store.get('webhookUrl') || '';
    });

    ipcMain.handle('set-webhook-url', async (_event, url: string) => {
      store.set('webhookUrl', url);
      return { success: true };
    });

    ipcMain.handle('get-compiled-rules', async (_event, options?: { search?: string; limit?: number; offset?: number; typeFilter?: string }) => {
      const allCompiled = await getOrLoadCompiledRules(store);

      const search = options?.search?.trim().toLowerCase();
      const typeFilter = options?.typeFilter;

      const filtered = allCompiled.filter((r) => {
        if (typeFilter && typeFilter !== 'all') {
          if (typeFilter === 'exceptions' && !(r.isException || r.raw?.startsWith('@@'))) return false;
          if (typeFilter === 'cosmetic' && !(r.raw?.includes('##') || r.raw?.includes('#@#'))) return false;
          if (typeFilter === 'blocking' && (r.isException || r.raw?.startsWith('@@'))) return false;
        }
        if (search) {
          const rawMatch = r.raw ? r.raw.toLowerCase().includes(search) : false;
          if (rawMatch) return true;
          const domMatch = r.domain ? r.domain.toLowerCase().includes(search) : false;
          return domMatch;
        }
        return true;
      });

      const total = filtered.length;
      const offset = Math.max(0, options?.offset || 0);
      const limit = Math.min(1000, Math.max(1, options?.limit || 200));
      const sliced = filtered.slice(offset, offset + limit).map((r) => ({
        raw: r.raw,
        type: r.type,
        domain: r.domain,
        isException: Boolean(r.isException || r.raw?.startsWith('@@')),
        source: r.metadata?.sourceInfo?.url || 'Filter Feed',
      }));

      return { total, rules: sliced };
    });

    ipcMain.handle('get-sinkhole-config', async () => {
      return {
        piholeUrl: store.get('piholeUrl') || '',
        piholeApiKey: store.get('piholeApiKey') || '',
        adguardHomeUrl: store.get('adguardHomeUrl') || '',
        adguardHomeUser: store.get('adguardHomeUser') || '',
        adguardHomePassword: store.get('adguardHomePassword') || '',
        syncOnCompile: Boolean(store.get('syncOnCompile')),
        adguardMode: (store.get('adguardMode') as 'direct' | 'ha-api' | 'webhook') || 'direct',
        haToken: store.get('haToken') || '',
        haWebhookUrl: store.get('haWebhookUrl') || '',
        customWebhookUrl: store.get('customWebhookUrl') || '',
        adguardDirectPort: normalizeAdguardDirectPort(store.get('adguardDirectPort')),
        adguardDirectUrl: (store.get('adguardDirectUrl') as string) || '',
        allowInsecureLocalTls: Boolean(store.get('allowInsecureLocalTls')),
      };
    });

    ipcMain.handle('set-sinkhole-config', async (_event, config: any) => {
      const previous = sinkholeUrlFields(store);
      const separated = separateAdguardUrls(previous, {
        adguardMode: config.adguardMode,
        adguardHomeUrl: config.adguardHomeUrl,
        adguardDirectUrl: config.adguardDirectUrl,
        adguardDirectPort: config.adguardDirectPort,
      });
      if (config.piholeUrl !== undefined) store.set('piholeUrl', config.piholeUrl);
      if (config.piholeApiKey !== undefined) store.set('piholeApiKey', config.piholeApiKey);
      if (config.adguardHomeUrl !== undefined) store.set('adguardHomeUrl', config.adguardHomeUrl);
      if (config.adguardHomeUser !== undefined) store.set('adguardHomeUser', config.adguardHomeUser);
      if (config.adguardHomePassword !== undefined) store.set('adguardHomePassword', config.adguardHomePassword);
      if (config.syncOnCompile !== undefined) store.set('syncOnCompile', Boolean(config.syncOnCompile));
      if (config.adguardMode !== undefined) store.set('adguardMode', config.adguardMode);
      if (config.haToken !== undefined) store.set('haToken', config.haToken);
      if (config.haWebhookUrl !== undefined) store.set('haWebhookUrl', config.haWebhookUrl);
      if (config.customWebhookUrl !== undefined) store.set('customWebhookUrl', config.customWebhookUrl);
      if (config.adguardDirectPort !== undefined) store.set('adguardDirectPort', normalizeAdguardDirectPort(config.adguardDirectPort));
      if (config.allowInsecureLocalTls !== undefined) store.set('allowInsecureLocalTls', Boolean(config.allowInsecureLocalTls));
      if (separated.adguardDirectUrl !== undefined) {
        store.set('adguardDirectUrl', separated.adguardDirectUrl);
      }
      return { success: true };
    });

    ipcMain.handle('sync-sinkholes', async () => {
      const results = await executeSinkholeSync(store);
      return { results };
    });

    ipcMain.handle('start-feed-server', async (_event, port?: number) => {
      return await startFeedServer(port || 9191, store);
    });

    ipcMain.handle('stop-feed-server', async () => {
      return stopFeedServer();
    });

    ipcMain.handle('get-feed-server-status', async () => {
      return getFeedServerStatus();
    });

    ipcMain.handle('get-auto-start-feed-server', async () => {
      return Boolean(store.get('autoStartFeedServer'));
    });

    ipcMain.handle('set-auto-start-feed-server', async (_event, enabled: boolean) => {
      try {
        const val = Boolean(enabled);
        store.set('autoStartFeedServer', val);
        if (val) {
          const status = getFeedServerStatus();
          if (!status.isRunning) {
            await startFeedServer(9191, store);
          }
        }
        return { success: true };
      } catch (err: any) {
        console.error('Failed to set auto-start feed server:', err);
        return { success: false, error: err?.message || String(err) };
      }
    });

    ipcMain.handle('get-launch-on-startup', async () => {
      try {
        const settings = app.getLoginItemSettings();
        const storeVal = store.get('launchOnStartup');
        return typeof storeVal === 'boolean' ? storeVal : settings.openAtLogin;
      } catch {
        return Boolean(store.get('launchOnStartup'));
      }
    });

    ipcMain.handle('set-launch-on-startup', async (_event, enabled: boolean) => {
      try {
        const val = Boolean(enabled);
        store.set('launchOnStartup', val);
        if (app.isPackaged) {
          try {
            app.setLoginItemSettings({
              openAtLogin: val,
            });
          } catch (loginErr) {
            console.warn('app.setLoginItemSettings notice:', loginErr);
          }
        }
        return { success: true };
      } catch (err: any) {
        console.error('Failed to set launch on startup:', err);
        return { success: false, error: err?.message || String(err) };
      }
    });

    // ====================================================================
    // Local System DNS Daemon IPC Handlers
    // ====================================================================
    ipcMain.handle('daemon:get-status', async () => {
      return await daemonManager.getStatus();
    });

    ipcMain.handle('daemon:start', async () => {
      return await daemonManager.start();
    });

    ipcMain.handle('daemon:stop', async () => {
      return await daemonManager.stop();
    });

    ipcMain.handle('daemon:reload', async () => {
      return await daemonManager.reloadRules();
    });

    ipcMain.handle('daemon:toggle', async (_event, enabled?: boolean) => {
      return await daemonManager.toggleProtection(enabled);
    });

    ipcMain.handle('daemon:set-system-dns', async (_event, serviceName?: string) => {
      return await daemonManager.setSystemDns(serviceName);
    });

    ipcMain.handle('daemon:restore-system-dns', async (_event, serviceName?: string) => {
      return await daemonManager.restoreSystemDns(serviceName);
    });

    ipcMain.handle('daemon:flush-cache', async () => {
      return await daemonManager.flushCache();
    });

    ipcMain.handle('daemon:get-service-script', async () => {
      return daemonManager.getServiceInstallInstructions();
    });

    ipcMain.handle('daemon:get-network-services', async () => {
      return await daemonManager.getNetworkServices();
    });

    ipcMain.handle('test-sinkhole-connection', async (_event, service: 'pihole' | 'adguard' | 'webhook') => {
      const startTime = Date.now();
      try {
        if (service === 'pihole') {
          const rawUrl = store.get('piholeUrl') as string | undefined;
          const apiKey = store.get('piholeApiKey') as string | undefined;
          if (!rawUrl || !rawUrl.trim()) {
            return { service: 'pihole', success: false, message: 'Pi-hole URL is not configured.' };
          }
          let urlStr = rawUrl.trim();
          if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
            urlStr = `http://${urlStr}`;
          }
          if (urlStr.includes(':8123')) {
            return {
              service: 'pihole',
              success: false,
              message: 'Port 8123 is Home Assistant web UI. For Pi-hole Add-on web interface, check the mapped port in Home Assistant Settings > Add-ons > Pi-hole > Configuration (typically port 80 or 8080).',
              details: 'ha_port_warning',
            };
          }
          const u = new URL(urlStr);
          if (apiKey) u.searchParams.set('auth', apiKey.trim());
          u.searchParams.set('type', 'version');
          const target = u.toString();
          try {
            const res = await sinkholeFetch(target, {
              timeoutMs: 6000,
              allowInsecureLocalTls: sinkholeTlsAllowed(store),
            });
            const latencyMs = Date.now() - startTime;
            if (res.ok) {
              return { service: 'pihole', success: true, statusCode: res.status, latencyMs, message: `Connected to Pi-hole (${latencyMs}ms, HTTP ${res.status})` };
            } else {
              return { service: 'pihole', success: false, statusCode: res.status, latencyMs, message: `Pi-hole returned HTTP ${res.status}: ${res.statusText}` };
            }
          } catch (err: any) {
            return {
              service: 'pihole',
              success: false,
              latencyMs: Date.now() - startTime,
              message: explainSinkholeFailure(store, err, target),
            };
          }
        } else if (service === 'webhook') {
          const customWebhookUrl = store.get('customWebhookUrl') as string | undefined;
          if (!customWebhookUrl || !customWebhookUrl.trim()) {
            return { service: 'webhook', success: false, message: 'Custom webhook URL is not configured.' };
          }
          const webhook = normalizeWebhookUrl(customWebhookUrl);
          if (!webhook.ok) {
            return { service: 'webhook', success: false, message: webhook.message };
          }
          return { service: 'webhook', success: true, message: 'Custom webhook URL syntax is valid and ready.' };
        } else {
          // AdGuard Home connection testing
          const adguardMode = (store.get('adguardMode') as 'direct' | 'ha-api' | 'webhook' | undefined) || 'direct';
          const rawUrl = store.get('adguardHomeUrl') as string | undefined;
          const user = store.get('adguardHomeUser') as string | undefined;
          const pass = store.get('adguardHomePassword') as string | undefined;
          const haToken = store.get('haToken') as string | undefined;
          const haWebhookUrl = store.get('haWebhookUrl') as string | undefined;

          if (adguardMode === 'ha-api') {
            const haTarget = resolveHaApiUrl(rawUrl || '');
            if (!haTarget.ok) {
              return { service: 'adguard', success: false, message: haTarget.message };
            }
            if (!haToken || !haToken.trim()) {
              return { service: 'adguard', success: false, message: 'Home Assistant Long-Lived Access Token is required.' };
            }
            try {
              const api = await readSinkholeProbe(store, haTarget.target.pingUrl, {
                Authorization: `Bearer ${haToken.trim()}`,
              });
              const identity = await classifyHaApiResponse(api, haTarget.target.pingUrl, (url) => readSinkholeProbe(store, url));
              const latencyMs = Date.now() - startTime;
              const decision = haApiConnectionResult(identity, latencyMs, haTarget.target.baseUrl, api.status);
              return { service: 'adguard', latencyMs, ...decision };
            } catch (err: any) {
              return {
                service: 'adguard',
                success: false,
                latencyMs: Date.now() - startTime,
                message: explainSinkholeFailure(store, err, haTarget.target.pingUrl),
              };
            }
          } else if (adguardMode === 'webhook') {
            const target = haWebhookUrl?.trim() || rawUrl?.trim() || '';
            const webhook = normalizeWebhookUrl(target);
            if (!webhook.ok) {
              return { service: 'adguard', success: false, message: target ? webhook.message : 'Home Assistant Webhook URL is not configured.' };
            }
            const isCloudWebhook = webhook.url.includes('nabu.casa');
            const readyMsg = isCloudWebhook
              ? 'Home Assistant Cloud Webhook URL (Nabu Casa) is valid and ready.'
              : 'Home Assistant Webhook URL is configured and ready.';
            return { service: 'adguard', success: true, message: readyMsg };
          } else {
            const resolved = resolveAdguardDirectUrl(rawUrl || '', store.get('adguardDirectPort'));
            if (!resolved.ok) {
              return {
                service: 'adguard',
                success: false,
                statusCode: resolved.statusCode,
                message: resolved.message,
                details: resolved.details,
              };
            }
            const headers: Record<string, string> = {};
            if (user && pass) {
              const credentials = Buffer.from(`${user}:${pass}`).toString('base64');
              headers['Authorization'] = `Basic ${credentials}`;
            }
            try {
              const res = await sinkholeFetch(resolved.target.statusUrl, {
                headers,
                timeoutMs: 6000,
                allowInsecureLocalTls: sinkholeTlsAllowed(store),
              });
              const body = await res.text();
              const latencyMs = Date.now() - startTime;
              if (res.ok) {
                return { service: 'adguard', success: true, statusCode: res.status, latencyMs, message: `Connected to AdGuard Home at ${resolved.target.display} (${latencyMs}ms, HTTP ${res.status})` };
              }
              if (res.status === 401) {
                return { service: 'adguard', success: false, statusCode: 401, latencyMs, message: 'Authentication required. Check your AdGuard Home username and password.' };
              }
              const identity = await classifyDirectStatus(
                { ok: res.ok, status: res.status, statusText: res.statusText, body },
                resolved.target.statusUrl,
                (url) => readSinkholeProbe(store, url),
              );
              if (identity.kind === 'home-assistant') {
                return { service: 'adguard', success: false, statusCode: res.status, latencyMs, message: identity.message, details: identity.details };
              }
              return { service: 'adguard', success: false, statusCode: res.status, latencyMs, message: `AdGuard Home at ${resolved.target.display} returned HTTP ${res.status}: ${res.statusText}` };
            } catch (err: any) {
              return {
                service: 'adguard',
                success: false,
                latencyMs: Date.now() - startTime,
                message: explainSinkholeFailure(store, err, resolved.target.statusUrl, {
                  haAddonPortHint: resolved.target.homeAssistantHost,
                  hintPort: resolved.target.port,
                }),
                details: resolved.target.homeAssistantHost ? 'ha_connection_failed' : undefined,
              };
            }
          }
        }
      } catch (err: any) {
        const latencyMs = Date.now() - startTime;
        return { service, success: false, latencyMs, message: err?.message || String(err) };
      }
    });

    ipcMain.handle('get-compilation-history', async () => {
      return store.get('compilationHistory') || [];
    });

    ipcMain.handle('get-last-process-time', async () => {
      try {
        return store.get('lastProcessTime') || null;
      } catch (error) {
        console.error('[IPC Main] Error getting last process time:', error);
        throw new Error('Failed to retrieve last process time');
      }
    });

    ipcMain.handle('get-app-version', async () => {
      return app.getVersion();
    });

    ipcMain.handle('get-theme', async (): Promise<ThemeType> => {
      const theme = store.get('theme') as ThemeType;
      return theme;
    });

    ipcMain.handle(
      'set-theme',
      async (_event: IpcMainInvokeEvent, theme: ThemeType) => {
        if (['light', 'dark', 'system'].includes(theme)) {
          store.set('theme', theme);
          console.log(`[IPC Main] Theme set to: ${theme}`);
          return { success: true };
        } else {
          console.warn(`[IPC Main] Invalid theme value received: ${theme}`);
          return { success: false, error: 'Invalid theme value.' };
        }
      }
    );

    ipcMain.handle('get-save-path', async (): Promise<string> => {
      return store.get('savePath');
    });

    ipcMain.handle(
      'set-save-path',
      async (_event: IpcMainInvokeEvent, filePath: string) => {
        if (
          typeof filePath === 'string' &&
          filePath.trim().length > 0 &&
          isAbsolute(filePath)
        ) {
          try {
            store.set('savePath', filePath);
            console.log(`[IPC Main] Save path set to: ${filePath}`);
            return { success: true, path: filePath };
          } catch (error) {
            console.error(`[IPC Main] Error setting save path:`, error);
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        } else {
          return {
            success: false,
            error: 'Invalid or non-absolute file path provided.',
          };
        }
      }
    );

    ipcMain.handle('select-save-path', async () => {
      try {
        const currentPath = store.get('savePath');
        const result = await dialog.showSaveDialog({
          title: 'Select Save Location for Processed Rules',
          defaultPath: currentPath,
          filters: [
            { name: 'Text Files', extensions: ['txt'] },
            { name: 'All Files', extensions: ['*'] },
          ],
          properties: ['createDirectory'],
        });

        if (result.canceled || !result.filePath) {
          console.log('[IPC Main] Save path selection cancelled.');
          return ''; // Return empty string if cancelled
        }

        const selectedPath = result.filePath;
        store.set('savePath', selectedPath);
        console.log(`[IPC Main] Save path set to: ${selectedPath}`);
        return selectedPath; // Return the selected path as a string
      } catch (error) {
        console.error('[IPC Main] Error showing save dialog:', error);
        return ''; // Return empty string on error
      }
    });

    ipcMain.handle('get-export-format', async () => {
      return store.get('exportFormat') || 'adguard';
    });

    ipcMain.handle(
      'set-export-format',
      async (_event: IpcMainInvokeEvent, format: FilterFormat) => {
        if (isValidFormat(format)) {
          store.set('exportFormat', format);
          console.log(`[IPC Main] Export format set to: ${format}`);
          return { success: true };
        } else {
          console.warn(`[IPC Main] Invalid export format received: ${format}`);
          return { success: false, error: 'Invalid export format.' };
        }
      }
    );

    ipcMain.on('notify-resize', (_event, width: number, height: number) => {
      if (isDev) {
        console.log(`Window resized to ${width}x${height}`);
      }
    });

    ipcMain.on('show-item-in-folder', (_event, itemPath: string) => {
      if (typeof itemPath === 'string' && itemPath.trim().length > 0 && isAbsolute(itemPath)) {
        shell.showItemInFolder(itemPath);
      } else {
        console.warn('[IPC Main] Invalid path passed to showItemInFolder:', itemPath);
      }
    });

    ipcMain.handle('open-external', async (_event, url: string) => {
      try {
        if (typeof url !== 'string' || !url.trim()) {
          throw new Error('Invalid URL');
        }
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error(`Forbidden protocol: ${parsed.protocol}`);
        }
        await shell.openExternal(parsed.href);
        return { success: true };
      } catch (error) {
        console.error('Failed to open external URL:', error);
        return { success: false, error: String(error) };
      }
    });

    // ==========================================
    // AI Radar IPC Handlers
    // ==========================================
    ipcMain.handle('get-ai-config', async () => {
      const saved = store.get('aiConfig') as Partial<AiProviderConfig> | undefined;
      return {
        provider: saved?.provider || 'mini-ai',
        ollamaUrl: saved?.ollamaUrl || 'http://127.0.0.1:11434',
        ollamaModel: saved?.ollamaModel || 'llama3.2',
        apiKey: saved?.apiKey || '',
        apiEndpoint: saved?.apiEndpoint || '',
        modelName: saved?.modelName || '',
      };
    });

    ipcMain.handle('set-ai-config', async (_event, config: Partial<AiProviderConfig>) => {
      try {
        const existing = (store.get('aiConfig') || {}) as Partial<AiProviderConfig>;
        store.set('aiConfig', { ...existing, ...config });
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    });

    ipcMain.handle('test-ai-connection', async (_event, config: Partial<AiProviderConfig>) => {
      const start = Date.now();
      const provider = config?.provider || 'mini-ai';

      if (provider === 'mini-ai') {
        return { success: true, latencyMs: 0, message: 'Mini-AI Embedded Classifier ready (<0.05ms in-memory neural model)' };
      }

      if (provider === 'local-heuristics') {
        return { success: true, latencyMs: 1, message: 'Local heuristic & Shannon entropy engine active (0ms offline)' };
      }

      if (provider === 'ollama') {
        const url = config?.ollamaUrl || 'http://127.0.0.1:11434';
        try {
          const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
          const latencyMs = Date.now() - start;
          if (res.ok) {
            const data: any = await res.json();
            const models = Array.isArray(data?.models) ? data.models.map((m: any) => m.name).join(', ') : '';
            return { success: true, latencyMs, message: `Connected to Ollama. Models: ${models || 'ready'}` };
          }
          return { success: false, latencyMs, message: `Ollama returned HTTP ${res.status}: ${res.statusText}` };
        } catch (err: any) {
          return { success: false, latencyMs: Date.now() - start, message: `Cannot connect to Ollama at ${url} (${err?.message || err})` };
        }
      }

      if (provider === 'gemini') {
        const key = config?.apiKey;
        if (!key) return { success: false, message: 'Missing Gemini API key' };
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {
            signal: AbortSignal.timeout(5000),
          });
          const latencyMs = Date.now() - start;
          if (res.ok) {
            return { success: true, latencyMs, message: 'Successfully authenticated with Google Gemini API' };
          }
          return { success: false, latencyMs, message: `Gemini API authentication failed (HTTP ${res.status})` };
        } catch (err: any) {
          return { success: false, latencyMs: Date.now() - start, message: `Gemini test failed: ${err?.message || err}` };
        }
      }

      if (provider === 'openai') {
        const key = config?.apiKey;
        const endpoint = config?.apiEndpoint || 'https://api.openai.com/v1';
        if (!key) return { success: false, message: 'Missing API key' };
        try {
          const res = await fetch(`${endpoint}/models`, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(5000),
          });
          const latencyMs = Date.now() - start;
          if (res.ok) {
            return { success: true, latencyMs, message: 'Successfully authenticated with OpenAI API' };
          }
          return { success: false, latencyMs, message: `OpenAI authentication failed (HTTP ${res.status})` };
        } catch (err: any) {
          return { success: false, latencyMs: Date.now() - start, message: `Connection test failed: ${err?.message || err}` };
        }
      }

      return { success: true, message: 'Provider ready' };
    });

    ipcMain.handle('ai-scan-domain', async (_event, domain: string, overrideConfig?: Partial<AiProviderConfig>) => {
      const savedConfig = (store.get('aiConfig') || {}) as Partial<AiProviderConfig>;
      const activeConfig = { ...savedConfig, ...overrideConfig };
      const service = getSharedAiDetectorService(activeConfig);
      return await service.scanDomain(domain, activeConfig);
    });

    ipcMain.handle('ai-scan-querylog', async (_event, options: { service: 'adguard' | 'pihole'; limit?: number }, overrideConfig?: Partial<AiProviderConfig>) => {
      const savedConfig = (store.get('aiConfig') || {}) as Partial<AiProviderConfig>;
      const activeConfig = { ...savedConfig, ...overrideConfig };
      const service = getSharedAiDetectorService(activeConfig);

      const queries: RawDnsQuery[] = [];
      const limit = options.limit || 50;

      if (options.service === 'adguard') {
        const loaded = await loadStoredAdguardQueries(store, limit);
        if (!loaded.ok) {
          console.error(`[AI Radar] Failed to fetch AdGuard query log: ${loaded.message}`);
          throw new Error(loaded.message);
        }
        queries.push(...loaded.queries);
        const scan = await service.scanQueryLog(queries, activeConfig);
        return {
          ...scan,
          notice: loaded.unblockedCount === 0 ? emptyUnblockedNotice(limit) : undefined,
        };
      }

      if (options.service === 'pihole') {
        const baseUrl = store.get('piholeUrl') || 'http://127.0.0.1';
        const token = store.get('piholeApiKey') || '';
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/admin/api.php?getAllQueries=${limit}&auth=${token}`, {
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) {
          throw new Error(`Could not fetch the Pi-hole query log (HTTP ${res.status}). This was not treated as an empty log.`);
        }
        const json: any = await res.json();
        const data = Array.isArray(json?.data) ? json.data : [];
        for (const item of data) {
          const name = item?.[2];
          const status = item?.[4];
          if (name && (status === '2' || status === '3')) {
            queries.push({
              domain: name,
              client: item?.[3],
              blocked: false,
            });
          }
        }
        const scan = await service.scanQueryLog(queries, activeConfig);
        return {
          ...scan,
          notice: queries.length === 0 ? emptyUnblockedNotice(limit) : undefined,
        };
      }

      return await service.scanQueryLog(queries, activeConfig);
    });

    ipcMain.handle('ai-crawl-url', async (_event, url: string, overrideConfig?: Partial<AiProviderConfig>) => {
      const safety = isSafePublicWebUrl(url);
      if (!safety.isSafe) {
        throw new Error(`SSRF Guard blocked crawl request to "${url}": ${safety.reason}`);
      }
      const savedConfig = (store.get('aiConfig') || {}) as Partial<AiProviderConfig>;
      const activeConfig = { ...savedConfig, ...overrideConfig };
      const service = getSharedAiDetectorService(activeConfig);
      return await service.crawlAndScanUrl(url, activeConfig);
    });

    ipcMain.handle('add-custom-rules', async (_event, newRules: string[]) => {
      try {
        if (!Array.isArray(newRules)) {
          return { success: false, count: 0, error: 'newRules must be an array of rule strings' };
        }
        const currentCustomRules = (store.get('customRules') as string) || '';
        const existingLines = new Set(
          currentCustomRules.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
        );

        const added: string[] = [];
        for (const rule of newRules) {
          const trimmed = rule.trim();
          // Reject multi-line or control character injection
          if (!trimmed || /[\r\n\0]/.test(trimmed)) continue;
          if (!existingLines.has(trimmed)) {
            existingLines.add(trimmed);
            added.push(trimmed);
          }
        }

        if (added.length > 0) {
          const updated = `${currentCustomRules ? `${currentCustomRules}\n` : ''}${added.join('\n')}`;
          store.set('customRules', updated);
        }

        return { success: true, count: added.length };
      } catch (err: any) {
        return { success: false, count: 0, error: err?.message || String(err) };
      }
    });

    // AI Threat Quarantine Ledger [Beta]
    ipcMain.handle('get-threat-quarantine', async () => {
      return store.get('aiThreatQuarantine') || [];
    });

    ipcMain.handle('add-threat-quarantine', async (_event, items: ThreatQuarantineItem[]) => {
      try {
        const existing: ThreatQuarantineItem[] = store.get('aiThreatQuarantine') || [];
        const existingMap = new Map(existing.map((i) => [i.domain, i]));
        for (const it of items) {
          existingMap.set(it.domain, it);
        }
        const merged = Array.from(existingMap.values())
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, 200);
        store.set('aiThreatQuarantine', merged);
        daemonManager.quarantineDomain(items.map((i) => i.domain)).catch(() => {});
        broadcastSseEvent('quarantine_added', {
          count: items.length,
          domains: items.map((i) => i.domain),
        });
        return { success: true, count: merged.length };
      } catch (err: any) {
        return { success: false, count: 0, error: err?.message || String(err) };
      }
    });

    ipcMain.handle('remove-threat-quarantine-item', async (_event, id: string) => {
      const existing: ThreatQuarantineItem[] = store.get('aiThreatQuarantine') || [];
      store.set('aiThreatQuarantine', existing.filter((i) => i.id !== id));
      return { success: true };
    });

    ipcMain.handle('clear-threat-quarantine', async () => {
      store.set('aiThreatQuarantine', []);
      return { success: true };
    });

    // Live Radar Background Scanning Session [Beta]
    ipcMain.handle('start-live-radar-session', async (_event, options: { service: 'adguard' | 'pihole'; durationMinutes: number; pollIntervalSeconds?: number }) => {
      return startLiveRadarSession(options, store);
    });

    ipcMain.handle('stop-live-radar-session', async () => {
      return stopLiveRadarSession(store, 'Stopped by user');
    });

    ipcMain.handle('get-live-radar-session', async () => {
      if (currentLiveRadarSession.active && currentLiveRadarSession.endTime > 0 && Date.now() >= currentLiveRadarSession.endTime) {
        stopLiveRadarSession(store, 'Session duration completed');
      }
      return currentLiveRadarSession;
    });

    // AI Sentinel Watchdog Settings [Beta]
    ipcMain.handle('get-ai-watchdog-config', async () => {
      return store.get('aiWatchdogConfig') || {
        enabled: false,
        intervalMinutes: 60,
        service: 'adguard',
        autoQuarantineEntropyDga: true,
      };
    });

    ipcMain.handle('set-ai-watchdog-config', async (_event, cfg: Partial<AiWatchdogConfig>) => {
      const current = (store.get('aiWatchdogConfig') || {
        enabled: false,
        intervalMinutes: 60,
        service: 'adguard',
        autoQuarantineEntropyDga: true,
      }) as AiWatchdogConfig;
      const updated: AiWatchdogConfig = { ...current, ...cfg };
      store.set('aiWatchdogConfig', updated);
      setupAiWatchdogTimer(updated, store);
      return { success: true };
    });

    // Smart False Positive Whitelisting [Beta]
    ipcMain.handle('add-custom-allowlist', async (_event, domain: string) => {
      try {
        const cleanDomain = sanitizeDomain(domain);
        if (!cleanDomain) {
          return { success: false, rule: '', error: 'Invalid domain name or syntax' };
        }
        const allowRule = synthesizeAllowlistRule(cleanDomain);
        const currentCustomRules = (store.get('customRules') as string) || '';
        const existingLines = new Set(
          currentCustomRules.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
        );
        if (!existingLines.has(allowRule)) {
          const updated = `${currentCustomRules ? `${currentCustomRules}\n` : ''}${allowRule}`;
          store.set('customRules', updated);
        }
        // Remove from quarantine if present
        const existing: ThreatQuarantineItem[] = store.get('aiThreatQuarantine') || [];
        store.set('aiThreatQuarantine', existing.filter((i) => i.domain !== cleanDomain));

        return { success: true, rule: allowRule };
      } catch (err: any) {
        return { success: false, rule: '', error: err?.message || String(err) };
      }
    });

    // Check Rule Coverage [Beta]
    ipcMain.handle('is-domain-covered-by-rules', async (_event, domain: string) => {
      if (!domain || typeof domain !== 'string') return { isCovered: false };
      const currentCustomRules = (store.get('customRules') as string) || '';
      const rulesArray = currentCustomRules.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return isDomainCoveredByRules(domain, rulesArray);
    });

    // On-Device Mini-AI Feedback Tuning [Beta]
    ipcMain.handle('tune-mini-ai-feedback', async (_event, domain: string, action: 'whitelist' | 'block' | 'reset') => {
      if (!domain || typeof domain !== 'string' || !['whitelist', 'block', 'reset'].includes(action)) {
        return { success: false, error: 'Invalid domain or action parameter' };
      }
      globalMiniAiClassifier.tuneDomainFeedback(domain, action);
      store.set('miniAiFeedback', globalMiniAiClassifier.exportFeedback());
      return { success: true };
    });

    // Get Mini-AI Feedback Stats [Beta]
    ipcMain.handle('get-mini-ai-feedback-stats', async () => {
      return {
        count: globalMiniAiClassifier.getFeedbackCount(),
        feedback: globalMiniAiClassifier.exportFeedback(),
      };
    });

    // Subdomain Clustering Compaction [Beta]
    ipcMain.handle('compact-subdomain-rules', async (_event, domains: string[], threshold?: number) => {
      if (!Array.isArray(domains)) {
        return {
          originalCount: 0,
          compactedCount: 0,
          compactedRules: [],
          savingsPercent: 0,
          collapsedGroups: [],
        };
      }
      const safeThreshold = typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 2 ? threshold : 3;
      return compactSubdomainRules(domains, safeThreshold);
    });

    // Whitelist Conflict Detection [Beta]
    ipcMain.handle('check-rule-conflict', async (_event, rule: string) => {
      if (!rule || typeof rule !== 'string') {
        return { hasConflict: false };
      }
      const currentCustomRules = (store.get('customRules') as string) || '';
      const allowRules = currentCustomRules.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('@@'));
      return checkRuleConflict(rule, allowRules);
    });

    // Target-Specific Rule Synthesizer [Beta]
    ipcMain.handle('synthesize-custom-rules', async (_event, input: any) => {
      try {
        if (!input || typeof input !== 'object') {
          return { success: false, rules: [], error: 'Input must be a valid synthesis object' };
        }
        const rules = synthesizeRules(input);
        return { success: true, rules };
      } catch (err: any) {
        return { success: false, rules: [], error: err?.message || String(err) };
      }
    });

    console.log('[Main Process] All IPC handlers registered successfully');
  } catch (error) {
    console.error('[Main Process] Error registering IPC handlers:', error);
  }
}

// Update setupDefaultFilterSources to use store directly
function setupDefaultFilterSources(): void {
  const sources = store.get('filterSources');
  
  if (!sources || sources.length === 0) {
    console.log('[Main Process] Setting up default filter sources...');
    store.set('filterSources', filterLists);
  }
}

let mainWindow: BrowserWindow | null = null;

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const createWindow = async () => {
  const preloadPath =
    typeof MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY !== 'undefined'
      ? MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY
      : join(__dirname, 'preload.js');

  const isMac = process.platform === 'darwin';
  const appIcon = getAppIcon();

  if (isMac && app.dock && appIcon) {
    try {
      app.dock.setIcon(appIcon);
    } catch (err) {
      console.warn('[Dock] Failed to set dock icon:', err);
    }
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 1200,
    maxWidth: 1200,
    minHeight: 860,
    maxHeight: 860,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    icon: appIcon,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath,
      backgroundThrottling: false,
    },
    show: false,
  });

  // Open external links in user's default browser safely
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Intercept in-window navigation to keep renderer safe
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (
      !navigationUrl.startsWith('http://localhost') &&
      !navigationUrl.startsWith('file://') &&
      (typeof MAIN_WINDOW_WEBPACK_ENTRY === 'undefined' || !navigationUrl.startsWith(MAIN_WINDOW_WEBPACK_ENTRY))
    ) {
      event.preventDefault();
      if (isSafeExternalUrl(navigationUrl)) {
        shell.openExternal(navigationUrl);
      }
    }
  });

  mainWindow.webContents.on('console-message', (event: any) => {
    const level = event.level ?? 0;
    const message = event.message ?? '';
    const line = event.lineNumber ?? 0;
    const sourceId = event.sourceId ?? '';
    if (isDev || level >= 2) {
      console.log(`[Renderer Console - ${level}] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Failed to load ${validatedURL}: ${errorCode} ${errorDescription}`);
  });

  if (typeof MAIN_WINDOW_WEBPACK_ENTRY !== 'undefined') {
    await mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  } else if (isDev) {
    await mainWindow.loadURL('http://localhost:3000');
  } else {
    await mainWindow.loadURL(
      `file://${join(__dirname, '../renderer/index.html')}`
    );
  }

  if (isDev && process.env.OPEN_DEVTOOLS === 'true') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.show();
};

async function initialize() {
  try {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const csp = isDev
        ? "default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-eval' 'unsafe-inline' data:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: http:;"
        : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';";

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      });
    });

    // Enforce least privilege for device permissions (block camera, microphone, geolocation)
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      if (permission === 'notifications') {
        return callback(true);
      }
      return callback(false);
    });

    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      return permission === 'notifications';
    });

    await installExtensions();
    setupDefaultFilterSources();
    const savedFeedback = store.get('miniAiFeedback');
    if (savedFeedback) {
      globalMiniAiClassifier.importFeedback(savedFeedback);
      console.log(`[Main Process] Restored ${globalMiniAiClassifier.getFeedbackCount()} Mini-AI domain feedback tunings from persistent store.`);
    }
    registerIPCHandlers(store);
    await createWindow();
    createTray();

    // Auto-start local HTTP feed server if enabled in settings
    const shouldAutoStartFeed = Boolean(store.get('autoStartFeedServer'));
    if (shouldAutoStartFeed) {
      console.log('[Feed Server] Auto-starting feed server on launch...');
      startFeedServer(9191, store)
        .then((res) => console.log(`[Feed Server] Auto-started successfully on port ${res.port}`))
        .catch((err) => console.error('[Feed Server] Failed to auto-start feed server:', err));
    }

    // Sync launchOnStartup settings if configured and packaged
    const launchOnStartupSetting = store.get('launchOnStartup');
    if (app.isPackaged && typeof launchOnStartupSetting === 'boolean') {
      try {
        app.setLoginItemSettings({
          openAtLogin: launchOnStartupSetting,
        });
      } catch {
        // Ignored if OS permissions restrict login items
      }
    }

    app.on('before-quit', () => {
      stopFeedServer();
      if (autoScheduleTimer) {
        clearInterval(autoScheduleTimer);
        autoScheduleTimer = null;
      }
      if (aiWatchdogTimer) {
        clearInterval(aiWatchdogTimer);
        aiWatchdogTimer = null;
      }
      if (liveRadarTimer) {
        clearInterval(liveRadarTimer);
        liveRadarTimer = null;
      }
      if (appTray) {
        try {
          appTray.destroy();
        } catch {
          // ignore
        }
        appTray = null;
      }
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });

    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-navigate', (event, navigationUrl) => {
        if (!navigationUrl.startsWith('http://localhost') && !navigationUrl.startsWith('file://')) {
          event.preventDefault();
          if (navigationUrl.startsWith('http:') || navigationUrl.startsWith('https:')) {
            shell.openExternal(navigationUrl);
          }
        }
      });

      contents.setWindowOpenHandler(({ url }) => {
        if (isSafeExternalUrl(url)) {
          shell.openExternal(url);
        }
        return { action: 'deny' };
      });

      contents.on('render-process-gone', (_event, details) => {
        console.error('Renderer process crashed:', details);
      });

      contents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        console.error('Page failed to load:', errorCode, errorDescription);
      });
    });
  } catch (error) {
    console.error('Initialization error:', error);
    app.quit();
  }
}

app
  .whenReady()
  .then(initialize)
  .catch((error) => {
    console.error('Failed to initialize app:', error);
    app.quit();
  });
