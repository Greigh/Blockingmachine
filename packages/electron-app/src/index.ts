import { join, dirname, isAbsolute, basename, resolve as pathResolve } from 'path';
import { createServer, Server as HttpServer } from 'http';
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
  downloadAndParseSource,
  parseFilterList,
  cleanDomainPattern,
  RuleDeduplicator,
  generateFilterList,
  filterLists,
  AiDetectorService,
  synthesizeAllowlistRule,
  sanitizeDomain,
  isSafePublicWebUrl,
  isDomainCoveredByRules,
  type AiProviderConfig,
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

async function installExtensions() {
  if (isDev) {
    try {
      const { default: installExtension, REACT_DEVELOPER_TOOLS } = await import(
        'electron-devtools-installer'
      );
      const extensionPath = await installExtension(REACT_DEVELOPER_TOOLS);
      const extensionRef =
        await session.defaultSession.extensions.loadExtension(typeof extensionPath === 'string' ? extensionPath : extensionPath.path);

      if (!extensionRef) {
        throw new Error('Failed to load React DevTools extension');
      }

      console.log('React DevTools installed:', extensionRef.name);
    } catch (err) {
      console.error('Failed to install extension:', err);
    }
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

// Set official application name for native macOS application menu
app.name = 'Blockingmachine';

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
        label: 'Bulk Import',
        accelerator: 'Cmd+3',
        click: () => {
          mainWindow?.webContents.send('navigate-view', 'bulkImport');
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
        label: 'Rule Inspector',
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
        label: 'Deploy & Sync',
        accelerator: 'Cmd+7',
        click: () => {
          mainWindow?.webContents.send('navigate-view', 'deploy');
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
      const service = new AiDetectorService(savedConfig);

      const queries: RawDnsQuery[] = [];
      const limit = 50;

      if (config.service === 'adguard') {
        const baseUrl = storeRef.get('adguardHomeUrl') || 'http://127.0.0.1:3000';
        const user = storeRef.get('adguardHomeUser') || '';
        const pass = storeRef.get('adguardHomePassword') || '';
        const headers: Record<string, string> = {};
        if (user || pass) {
          headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
        }
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/control/querylog?limit=${limit}`, { headers });
        if (res.ok) {
          const json: any = await res.json();
          const data = Array.isArray(json?.data) ? json.data : [];
          for (const item of data) {
            const name = item?.question?.name;
            const isBlocked = Boolean(item?.filter_id && item.filter_id > 0);
            if (name && !isBlocked) {
              queries.push({ domain: name, client: item?.client, blocked: false });
            }
          }
        }
      } else if (config.service === 'pihole') {
        const baseUrl = storeRef.get('piholeUrl') || 'http://127.0.0.1';
        const token = storeRef.get('piholeApiKey') || '';
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/admin/api.php?getAllQueries=${limit}&auth=${token}`);
        if (res.ok) {
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
      }

      if (queries.length > 0) {
        const scan = await service.scanQueryLog(queries, savedConfig);
        const threats = scan.results.filter((r) => r.verdict !== 'clean');
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
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size > 0) {
        const content = await fs.readFile(candidate, 'utf8');
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

  const results: { service: string; status: 'success' | 'error' | 'skipped'; message: string }[] = [];

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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      try {
        const res = await fetch(url.toString(), { signal: controller.signal });
        if (res.ok) {
          results.push({ service: 'Pi-hole', status: 'success', message: 'Gravity update triggered successfully' });
        } else {
          results.push({ service: 'Pi-hole', status: 'error', message: `HTTP status ${res.status}` });
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: any) {
      results.push({ service: 'Pi-hole', status: 'error', message: err.message || String(err) });
    }
  } else {
    results.push({ service: 'Pi-hole', status: 'skipped', message: 'Not configured' });
  }

  // AdGuard Home Sync: supports Direct API, Home Assistant REST Service API, or Home Assistant Webhook
  if (adguardMode === 'ha-api') {
    const rawUrl = rawAdguard?.trim() || '';
    if (rawUrl && haToken?.trim()) {
      try {
        let baseUrl = rawUrl;
        if (baseUrl.includes('nabu.casa')) {
          if (baseUrl.startsWith('http://')) {
            baseUrl = baseUrl.replace(/^http:\/\//, 'https://');
          } else if (!baseUrl.startsWith('https://')) {
            baseUrl = `https://${baseUrl}`;
          }
        } else if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
          baseUrl = `http://${baseUrl}`;
        }
        baseUrl = baseUrl.replace(/\/$/, '');
        const serviceUrl = `${baseUrl}/api/services/adguard/refresh`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7000);
        try {
          const res = await fetch(serviceUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${haToken.trim()}`,
              'Content-Type': 'application/json',
            },
            signal: controller.signal,
          });
          if (res.ok) {
            const providerMsg = baseUrl.includes('nabu.casa')
              ? 'Filters refreshed via Home Assistant API (Nabu Casa Cloud)'
              : 'Filters refreshed via Home Assistant API';
            results.push({ service: 'AdGuard Home (Home Assistant)', status: 'success', message: providerMsg });
          } else {
            results.push({ service: 'AdGuard Home (Home Assistant)', status: 'error', message: `Home Assistant API returned HTTP ${res.status}: ${res.statusText}` });
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err: any) {
        results.push({ service: 'AdGuard Home (Home Assistant)', status: 'error', message: err.message || String(err) });
      }
    } else {
      results.push({ service: 'AdGuard Home (Home Assistant)', status: 'skipped', message: 'Home Assistant URL or Bearer token missing' });
    }
  } else if (adguardMode === 'webhook') {
    const targetWebhook = haWebhookUrl?.trim() || rawAdguard?.trim() || '';
    if (targetWebhook) {
      try {
        let urlStr = targetWebhook;
        if (urlStr.includes('nabu.casa')) {
          if (urlStr.startsWith('http://')) {
            urlStr = urlStr.replace(/^http:\/\//, 'https://');
          } else if (!urlStr.startsWith('https://')) {
            urlStr = `https://${urlStr}`;
          }
        } else if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
          urlStr = `http://${urlStr}`;
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        try {
          const res = await fetch(urlStr, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'adguard_refresh', timestamp: new Date().toISOString() }),
            signal: controller.signal,
          });
          if (res.ok) {
            results.push({ service: 'AdGuard Home (Webhook)', status: 'success', message: 'Automation webhook triggered successfully' });
          } else {
            results.push({ service: 'AdGuard Home (Webhook)', status: 'error', message: `Webhook returned HTTP ${res.status}` });
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err: any) {
        results.push({ service: 'AdGuard Home (Webhook)', status: 'error', message: err.message || String(err) });
      }
    } else {
      results.push({ service: 'AdGuard Home (Webhook)', status: 'skipped', message: 'Webhook URL not configured' });
    }
  } else if (rawAdguard && rawAdguard.trim()) {
    // Direct AdGuard Home API
    const trimmedAdguard = rawAdguard.trim();
    if (trimmedAdguard.includes('nabu.casa')) {
      results.push({
        service: 'AdGuard Home',
        status: 'error',
        message: 'Nabu Casa remote URLs only proxy Home Assistant (port 8123), not AdGuard direct port 3000. Switch to Home Assistant REST API or Webhook mode.',
      });
    } else {
      try {
        let adguardUrl = trimmedAdguard;
        if (!adguardUrl.startsWith('http://') && !adguardUrl.startsWith('https://')) {
          adguardUrl = `http://${adguardUrl}`;
        }
        const base = adguardUrl.replace(/\/$/, '');
        const refreshUrl = `${base}/control/filtering/refresh`;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (adguardHomeUser && adguardHomePassword) {
          const credentials = Buffer.from(`${adguardHomeUser}:${adguardHomePassword}`).toString('base64');
          headers['Authorization'] = `Basic ${credentials}`;
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        try {
          const res = await fetch(refreshUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ whitelist: false }),
            signal: controller.signal,
          });
          if (res.ok) {
            results.push({ service: 'AdGuard Home', status: 'success', message: 'Filters refreshed successfully' });
          } else {
            results.push({ service: 'AdGuard Home', status: 'error', message: `HTTP status ${res.status}` });
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err: any) {
        results.push({ service: 'AdGuard Home', status: 'error', message: err.message || String(err) });
      }
    }
  } else {
    results.push({ service: 'AdGuard Home', status: 'skipped', message: 'Not configured' });
  }

  // Custom Homelab Webhook / Automation Endpoint ("or any other thing like it")
  if (customWebhookUrl && customWebhookUrl.trim()) {
    try {
      let urlStr = customWebhookUrl.trim();
      if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
        urlStr = `http://${urlStr}`;
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      try {
        const res = await fetch(urlStr, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'blockingmachine_compiled', timestamp: new Date().toISOString() }),
          signal: controller.signal,
        });
        if (res.ok) {
          results.push({ service: 'Custom Homelab Webhook', status: 'success', message: 'Homelab automation webhook triggered successfully' });
        } else {
          results.push({ service: 'Custom Homelab Webhook', status: 'error', message: `Webhook returned HTTP ${res.status}` });
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: any) {
      results.push({ service: 'Custom Homelab Webhook', status: 'error', message: err.message || String(err) });
    }
  }

  return results;
}

let feedHttpServer: HttpServer | null = null;
let feedServerPort = 9191;

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

  feedServerPort = port;

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
        const reqUrl = new URL(req.url || '/', 'http://localhost');
        const pathname = decodeURIComponent(reqUrl.pathname);

        // Determine target file to serve
        let targetFilePath = savePath;
        if (pathname !== '/' && pathname.length > 1) {
          const cleanName = basename(pathname);
          targetFilePath = join(outputDir, cleanName);
        }

        // Security check: verify resolved target is within outputDir or matches savePath
        const resolvedTarget = pathResolve(targetFilePath);
        const resolvedOutputDir = pathResolve(outputDir);
        const resolvedSavePath = pathResolve(savePath);
        if (!resolvedTarget.startsWith(resolvedOutputDir) && resolvedTarget !== resolvedSavePath) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('403 Forbidden: Access denied.');
          return;
        }

        try {
          if (existsSync(targetFilePath)) {
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
          const webhookController = new AbortController();
          const webhookTimeout = setTimeout(() => webhookController.abort(), 10000);
          fetch(webhookUrl.trim(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: webhookController.signal,
            body: JSON.stringify({
              event: 'compilation_complete',
              timestamp: new Date().toISOString(),
              uniqueRules: uniqueRuleCount,
              totalRules: totalProcessedCount,
              format,
              savePath,
            }),
          })
            .catch((err) => console.error('[IPC Main] Webhook ping failed:', err))
            .finally(() => clearTimeout(webhookTimeout));
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

      // Check exception rules first
      const exceptionRule = rulesToSearch.find((r) => {
        const isEx = r.isException || (r.raw && r.raw.startsWith('@@'));
        if (!isEx) return false;
        const dom = r.domain || cleanDomainPattern(r.raw || '');
        if (dom && (cleanDomain === dom || cleanDomain.endsWith(`.${dom}`))) {
          return true;
        }
        return Boolean(r.raw && r.raw.includes(cleanDomain));
      });

      if (exceptionRule) {
        return {
          domain: cleanDomain,
          inputQuery: rawInput,
          verdict: 'exception',
          matchingRule: exceptionRule.raw,
          sourceName: exceptionRule.metadata?.sourceInfo?.url || 'Custom Rules / Allowlist',
          ruleType: exceptionRule.type || 'exception',
          details: 'Domain is explicitly allowlisted by an exception rule.',
        };
      }

      // Check blocking rules
      const blockRule = rulesToSearch.find((r) => {
        const dom = r.domain || cleanDomainPattern(r.raw || '');
        if (dom && (cleanDomain === dom || cleanDomain.endsWith(`.${dom}`))) {
          return true;
        }
        if (r.raw) {
          if (r.raw.includes(`||${cleanDomain}^`) || r.raw.includes(`||${cleanDomain}`)) {
            return true;
          }
          if (r.raw.endsWith(` ${cleanDomain}`) || r.raw.endsWith(`\t${cleanDomain}`)) {
            return true;
          }
        }
        return false;
      });

      if (blockRule) {
        return {
          domain: cleanDomain,
          inputQuery: rawInput,
          verdict: 'blocked',
          matchingRule: blockRule.raw,
          sourceName: blockRule.metadata?.sourceInfo?.url || 'Filter Feeds',
          ruleType: blockRule.type || 'domain',
          details: `Blocked by rule: ${blockRule.raw}`,
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
      try {
        const rules = await downloadAndParseSource(url);
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

      let filtered = allCompiled;
      const search = options?.search?.trim().toLowerCase();
      if (search) {
        filtered = filtered.filter((r) =>
          (r.raw && r.raw.toLowerCase().includes(search)) ||
          (r.domain && r.domain.toLowerCase().includes(search))
        );
      }

      if (options?.typeFilter && options.typeFilter !== 'all') {
        if (options.typeFilter === 'exceptions') {
          filtered = filtered.filter((r) => r.isException || r.raw?.startsWith('@@'));
        } else if (options.typeFilter === 'cosmetic') {
          filtered = filtered.filter((r) => r.raw?.includes('##') || r.raw?.includes('#@#'));
        } else if (options.typeFilter === 'blocking') {
          filtered = filtered.filter((r) => !r.isException && !r.raw?.startsWith('@@'));
        }
      }

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
      };
    });

    ipcMain.handle('set-sinkhole-config', async (_event, config: any) => {
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
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 6000);
          const res = await fetch(u.toString(), { signal: controller.signal });
          clearTimeout(timeout);
          const latencyMs = Date.now() - startTime;
          if (res.ok) {
            return { service: 'pihole', success: true, statusCode: res.status, latencyMs, message: `Connected to Pi-hole (${latencyMs}ms, HTTP ${res.status})` };
          } else {
            return { service: 'pihole', success: false, statusCode: res.status, latencyMs, message: `Pi-hole returned HTTP ${res.status}: ${res.statusText}` };
          }
        } else if (service === 'webhook') {
          const customWebhookUrl = store.get('customWebhookUrl') as string | undefined;
          if (!customWebhookUrl || !customWebhookUrl.trim()) {
            return { service: 'webhook', success: false, message: 'Custom webhook URL is not configured.' };
          }
          let urlStr = customWebhookUrl.trim();
          if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
            urlStr = `http://${urlStr}`;
          }
          try {
            new URL(urlStr);
            return { service: 'webhook', success: true, message: 'Custom webhook URL syntax is valid and ready.' };
          } catch {
            return { service: 'webhook', success: false, message: 'Invalid webhook URL syntax.' };
          }
        } else {
          // AdGuard Home connection testing
          const adguardMode = (store.get('adguardMode') as 'direct' | 'ha-api' | 'webhook' | undefined) || 'direct';
          const rawUrl = store.get('adguardHomeUrl') as string | undefined;
          const user = store.get('adguardHomeUser') as string | undefined;
          const pass = store.get('adguardHomePassword') as string | undefined;
          const haToken = store.get('haToken') as string | undefined;
          const haWebhookUrl = store.get('haWebhookUrl') as string | undefined;

          if (adguardMode === 'ha-api') {
            if (!rawUrl || !rawUrl.trim()) {
              return { service: 'adguard', success: false, message: 'Home Assistant instance URL is not configured.' };
            }
            if (!haToken || !haToken.trim()) {
              return { service: 'adguard', success: false, message: 'Home Assistant Long-Lived Access Token is required.' };
            }
            let urlStr = rawUrl.trim();
            if (urlStr.includes('nabu.casa')) {
              if (urlStr.startsWith('http://')) {
                urlStr = urlStr.replace(/^http:\/\//, 'https://');
              } else if (!urlStr.startsWith('https://')) {
                urlStr = `https://${urlStr}`;
              }
            } else if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
              urlStr = `http://${urlStr}`;
            }
            const base = urlStr.replace(/\/$/, '');
            const pingUrl = `${base}/api/`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            try {
              const res = await fetch(pingUrl, {
                headers: { Authorization: `Bearer ${haToken.trim()}` },
                signal: controller.signal,
              });
              clearTimeout(timeout);
              const latencyMs = Date.now() - startTime;
              if (res.ok) {
                const cloudMsg = urlStr.includes('nabu.casa')
                  ? `Connected to Home Assistant API via Nabu Casa Cloud (${latencyMs}ms, ready for adguard.refresh)`
                  : `Connected to Home Assistant API (${latencyMs}ms, ready for adguard.refresh)`;
                return { service: 'adguard', success: true, statusCode: res.status, latencyMs, message: cloudMsg };
              } else if (res.status === 401) {
                return { service: 'adguard', success: false, statusCode: 401, latencyMs, message: 'Home Assistant token rejected (HTTP 401 Unauthorized). Verify your Long-Lived Access Token.' };
              } else {
                return { service: 'adguard', success: false, statusCode: res.status, latencyMs, message: `Home Assistant returned HTTP ${res.status}: ${res.statusText}` };
              }
            } catch (err: any) {
              clearTimeout(timeout);
              throw err;
            }
          } else if (adguardMode === 'webhook') {
            const target = haWebhookUrl?.trim() || rawUrl?.trim();
            if (!target) {
              return { service: 'adguard', success: false, message: 'Home Assistant Webhook URL is not configured.' };
            }
            let urlStr = target;
            if (urlStr.includes('nabu.casa')) {
              if (urlStr.startsWith('http://')) {
                urlStr = urlStr.replace(/^http:\/\//, 'https://');
              } else if (!urlStr.startsWith('https://')) {
                urlStr = `https://${urlStr}`;
              }
            } else if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
              urlStr = `http://${urlStr}`;
            }
            try {
              new URL(urlStr);
              const isCloudWebhook = urlStr.includes('nabu.casa');
              const readyMsg = isCloudWebhook
                ? 'Home Assistant Cloud Webhook URL (Nabu Casa) is valid and ready.'
                : 'Home Assistant Webhook URL is configured and ready.';
              return { service: 'adguard', success: true, message: readyMsg };
            } catch {
              return { service: 'adguard', success: false, message: 'Invalid Webhook URL format.' };
            }
          } else {
            // Direct AdGuard Home API
            if (!rawUrl || !rawUrl.trim()) {
              return { service: 'adguard', success: false, message: 'AdGuard Home URL is not configured.' };
            }
            let urlStr = rawUrl.trim();

            // Detect Nabu Casa in direct mode: Nabu Casa only proxies HA port 8123, not AdGuard port 3000
            if (urlStr.includes('nabu.casa')) {
              return {
                service: 'adguard',
                success: false,
                statusCode: 400,
                message: 'Nabu Casa Cloud remote URLs only proxy Home Assistant itself (port 8123), not AdGuard Home direct port 3000. Switch Mode to "Home Assistant REST API" or "Home Assistant Webhook" to reload AdGuard over Nabu Casa.',
                details: 'nabu_casa_direct_mode',
              };
            }

            if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
              urlStr = `http://${urlStr}`;
            }

            // Detect Home Assistant port 8123 in direct mode to prevent common mistake
            if (urlStr.includes(':8123')) {
              return {
                service: 'adguard',
                success: false,
                statusCode: 8123,
                message: 'Port 8123 detected (Home Assistant web interface). For AdGuard Home direct API, use port 3000 (e.g. http://homeassistant.local:3000) after mapping it in Add-ons > AdGuard Home > Configuration > Network, or select "Home Assistant API" mode.',
                details: 'ha_port_warning',
              };
            }

            const base = urlStr.replace(/\/$/, '');
            const u = `${base}/control/status`;
            const headers: Record<string, string> = {};
            if (user && pass) {
              const credentials = Buffer.from(`${user}:${pass}`).toString('base64');
              headers['Authorization'] = `Basic ${credentials}`;
            }
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            try {
              const res = await fetch(u, { headers, signal: controller.signal });
              clearTimeout(timeout);
              const latencyMs = Date.now() - startTime;
              if (res.ok) {
                return { service: 'adguard', success: true, statusCode: res.status, latencyMs, message: `Connected to AdGuard Home (${latencyMs}ms, HTTP ${res.status})` };
              } else if (res.status === 401) {
                return { service: 'adguard', success: false, statusCode: 401, latencyMs, message: 'Authentication required. Check your AdGuard Home username and password.' };
              } else {
                return { service: 'adguard', success: false, statusCode: res.status, latencyMs, message: `AdGuard Home returned HTTP ${res.status}: ${res.statusText}` };
              }
            } catch (err: any) {
              clearTimeout(timeout);
              const latencyMs = Date.now() - startTime;
              if (urlStr.includes('homeassistant') || urlStr.includes(':3000')) {
                return {
                  service: 'adguard',
                  success: false,
                  latencyMs,
                  message: `Cannot connect to port 3000 on Home Assistant. In Home Assistant, go to Settings > Add-ons > AdGuard Home > Configuration, ensure port 3000 is mapped under Network, and restart the add-on.`,
                  details: 'ha_connection_failed',
                };
              }
              throw err;
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
        provider: saved?.provider || 'local-heuristics',
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
      const provider = config?.provider || 'local-heuristics';

      if (provider === 'local-heuristics') {
        return { success: true, latencyMs: 1, message: 'Local heuristic & Shannon entropy engine active (0ms offline)' };
      }

      if (provider === 'ollama') {
        const url = config?.ollamaUrl || 'http://127.0.0.1:11434';
        try {
          const res = await fetch(`${url}/api/tags`);
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
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
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
      const service = new AiDetectorService(activeConfig);
      return await service.scanDomain(domain, activeConfig);
    });

    ipcMain.handle('ai-scan-querylog', async (_event, options: { service: 'adguard' | 'pihole'; limit?: number }, overrideConfig?: Partial<AiProviderConfig>) => {
      const savedConfig = (store.get('aiConfig') || {}) as Partial<AiProviderConfig>;
      const activeConfig = { ...savedConfig, ...overrideConfig };
      const service = new AiDetectorService(activeConfig);

      const queries: RawDnsQuery[] = [];
      const limit = options.limit || 50;

      if (options.service === 'adguard') {
        const baseUrl = store.get('adguardHomeUrl') || 'http://127.0.0.1:3000';
        const user = store.get('adguardHomeUser') || '';
        const pass = store.get('adguardHomePassword') || '';

        try {
          const headers: Record<string, string> = {};
          if (user || pass) {
            const auth = Buffer.from(`${user}:${pass}`).toString('base64');
            headers.Authorization = `Basic ${auth}`;
          }
          const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/control/querylog?limit=${limit}`, { headers });
          if (res.ok) {
            const json: any = await res.json();
            const data = Array.isArray(json?.data) ? json.data : [];
            for (const item of data) {
              const name = item?.question?.name;
              const isBlocked = Boolean(item?.filter_id && item.filter_id > 0);
              if (name && !isBlocked) {
                queries.push({
                  domain: name,
                  client: item?.client,
                  elapsedMs: item?.elapsed_ms,
                  blocked: false,
                });
              }
            }
          }
        } catch (err) {
          console.error('[AI Radar] Failed to fetch AdGuard query log:', err);
        }
      } else if (options.service === 'pihole') {
        const baseUrl = store.get('piholeUrl') || 'http://127.0.0.1';
        const token = store.get('piholeApiKey') || '';

        try {
          const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/admin/api.php?getAllQueries=${limit}&auth=${token}`);
          if (res.ok) {
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
          }
        } catch (err) {
          console.error('[AI Radar] Failed to fetch Pi-hole query log:', err);
        }
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
      const service = new AiDetectorService(activeConfig);
      return await service.crawlAndScanUrl(url, activeConfig);
    });

    ipcMain.handle('add-custom-rules', async (_event, newRules: string[]) => {
      try {
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

    // AI Sentinel Watchdog Settings [Beta]
    ipcMain.handle('get-ai-watchdog-config', async () => {
      return store.get('aiWatchdogConfig') || {
        enabled: false,
        intervalMinutes: 60,
        service: 'adguard',
      };
    });

    ipcMain.handle('set-ai-watchdog-config', async (_event, cfg: Partial<AiWatchdogConfig>) => {
      const current = (store.get('aiWatchdogConfig') || {
        enabled: false,
        intervalMinutes: 60,
        service: 'adguard',
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
      const currentCustomRules = (store.get('customRules') as string) || '';
      const rulesArray = currentCustomRules.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return isDomainCoveredByRules(domain, rulesArray);
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
    width: 1060,
    height: 750,
    minWidth: 920,
    minHeight: 600,
    icon: appIcon,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: preloadPath,
    },
    show: false,
  });

  // Open external links in user's default browser safely
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('mailto:')) {
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
      if (navigationUrl.startsWith('http:') || navigationUrl.startsWith('https:')) {
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

  if (isDev) {
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

    await installExtensions();
    setupDefaultFilterSources();
    registerIPCHandlers(store);
    await createWindow();
    createTray();

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
        if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('mailto:')) {
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
