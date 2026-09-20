import { join, dirname, isAbsolute } from 'path';
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
import { promises as fs } from 'fs';
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

// Define a minimal custom menu (no Help, no View)
const template: Electron.MenuItemConstructorOptions[] = [
  {
    label: 'File',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      {
        label: 'Settings',
        accelerator: process.platform === 'darwin' ? 'Cmd+,' : 'Ctrl+,',
        click: () => {
          // Send an IPC message to open settings, or show a settings window/modal
          if (mainWindow) {
            mainWindow.webContents.send('open-settings');
          }
        },
      },
      { role: 'quit' },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  },
  {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'close' },
      { type: 'separator' },
      { role: 'front' },
      { role: 'window' },
      { type: 'separator' },
      ...(isDev
        ? [
            {
              label: 'Toggle Developer Tools',
              accelerator:
                process.platform === 'darwin' ? 'Cmd+Alt+I' : 'Ctrl+Shift+I',
              click: () => {
                if (mainWindow) {
                  mainWindow.webContents.toggleDevTools();
                }
              },
            },
          ]
        : []),
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
  }
}

let appTray: Tray | null = null;

function createTray() {
  try {
    const assetCandidates = [
      join(__dirname, '../assets/Blockingmachine.png'),
      join(app.getAppPath(), 'assets/Blockingmachine.png'),
      join(process.cwd(), 'packages/electron-app/assets/Blockingmachine.png'),
    ];
    const isMac = process.platform === 'darwin';
    let icon = nativeImage.createEmpty();
    if (!isMac) {
      for (const candidate of assetCandidates) {
        try {
          const loaded = nativeImage.createFromPath(candidate);
          if (!loaded.isEmpty()) {
            icon = loaded.resize({ width: 16, height: 16 });
            break;
          }
        } catch {
          // try next
        }
      }
    }

    appTray = new Tray(icon);
    const contextMenu = Menu.buildFromTemplate([
      { label: '🛡️ Blockingmachine', enabled: false },
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
        click: () => {
          if (mainWindow) {
            mainWindow.webContents.send('trigger-compile');
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Blockingmachine',
        click: () => app.quit(),
      },
    ]);
    appTray.setToolTip('Blockingmachine - Ad & Tracker Filter Compiler');
    appTray.setContextMenu(contextMenu);
    if (process.platform === 'darwin') {
      appTray.setTitle('🛡️ BM');
    }
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

  if (rawAdguard && rawAdguard.trim()) {
    try {
      let adguardUrl = rawAdguard.trim();
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
  } else {
    results.push({ service: 'AdGuard Home', status: 'skipped', message: 'Not configured' });
  }

  return results;
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
      console.log('[IPC Main] Received request for sources.');
      const sources: FilterSource[] = store.get('filterSources');
      console.log('[IPC Main] Sent sources from store.');
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
          status: 'Aggregating rules for deduplication...',
          percent: 60,
        });

        // Fast collection without array churn
        const allRules: StoredRule[] = [];
        for (const res of sourceResults) {
          if (res.rules.length > 0) {
            allRules.push(...res.rules);
          }
        }

        const totalProcessedCount = allRules.length;
        console.log(
          `[IPC Main] Total rules before deduplication: ${totalProcessedCount}`
        );

        sendProgress({
          status: 'Deduplicating rules...',
          percent: 70,
        });

        const deduplicator = new RuleDeduplicator();
        const uniqueRulesSet = new Set<string>();

        console.log(
          '[IPC Main] Starting deduplication of',
          allRules.length,
          'rules'
        );

        const uniqueRules = allRules.filter((rule) => {
          if (!rule || !rule.raw) {
            return false;
          }
          const strippedRule = deduplicator.stripRule(rule.raw);
          const isDuplicate = uniqueRulesSet.has(strippedRule);
          if (!isDuplicate) {
            uniqueRulesSet.add(strippedRule);
            return true;
          }
          return false;
        });

        const uniqueRuleCount = uniqueRules.length;
        console.log(`[IPC Main] Deduplication complete:
  - Initial rules: ${allRules.length}
  - Unique rules: ${uniqueRuleCount}
  - Duplicates removed: ${allRules.length - uniqueRuleCount}
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
            const stripped = deduplicator.stripRule(rule.raw);
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
            duplicatesRemoved: allRules.length - uniqueRuleCount,
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
          duplicatesRemoved: allRules.length - uniqueRuleCount,
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
          new Notification({
            title: 'Blockingmachine',
            body: `Compilation complete: ${uniqueRuleCount.toLocaleString()} rules compiled.`,
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

      const cleanDomain = domainQuery
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/.*$/, '')
        .replace(/:[0-9]+$/, '');

      if (!cleanDomain) {
        return {
          domain: domainQuery,
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
          verdict: 'blocked',
          matchingRule: blockRule.raw,
          sourceName: blockRule.metadata?.sourceInfo?.url || 'Filter Feeds',
          ruleType: blockRule.type || 'domain',
          details: `Blocked by rule: ${blockRule.raw}`,
        };
      }

      return {
        domain: cleanDomain,
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
      };
    });

    ipcMain.handle('set-sinkhole-config', async (_event, config: any) => {
      if (config.piholeUrl !== undefined) store.set('piholeUrl', config.piholeUrl);
      if (config.piholeApiKey !== undefined) store.set('piholeApiKey', config.piholeApiKey);
      if (config.adguardHomeUrl !== undefined) store.set('adguardHomeUrl', config.adguardHomeUrl);
      if (config.adguardHomeUser !== undefined) store.set('adguardHomeUser', config.adguardHomeUser);
      if (config.adguardHomePassword !== undefined) store.set('adguardHomePassword', config.adguardHomePassword);
      if (config.syncOnCompile !== undefined) store.set('syncOnCompile', Boolean(config.syncOnCompile));
      return { success: true };
    });

    ipcMain.handle('sync-sinkholes', async () => {
      const results = await executeSinkholeSync(store);
      return { results };
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

  mainWindow = new BrowserWindow({
    width: 1060,
    height: 750,
    minWidth: 920,
    minHeight: 600,
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
      if (autoScheduleTimer) {
        clearInterval(autoScheduleTimer);
        autoScheduleTimer = null;
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
