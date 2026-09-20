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
  RuleDeduplicator,
  generateFilterList,
  filterLists,
} from '@blockingmachine/core';
import type {
  FilterSource,
  ThemeType,
  FilterFormat,
  StoredRule,
  FilterListMetadata
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
    lastProcessTime: {
      type: 'string',
      default: '',
    },
  },
}) as unknown as ElectronStore<StoreSchema>;

// Remove the typed wrapper and use store directly
function registerIPCHandlers(store: ElectronStore<StoreSchema>): void {
  try {
    console.log('[Main Process] Registering IPC handlers...');

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

        sendProgress({
          status: 'Fetching filter lists...',
          percent: 10,
        });

        let allRules: StoredRule[] = [];

        let processedCount = 0;
        const totalSources = enabledSources.length;
        for (const source of enabledSources) {
          console.log(
            `[IPC Main] Downloading and parsing source: ${source.name} (${source.url})`
          );
          try {
            const rulesFromSource = await downloadAndParseSource(source.url);
            allRules = [...allRules, ...(rulesFromSource as StoredRule[])];
            console.log(
              `[IPC Main] Collected ${rulesFromSource.length} rules from ${source.name}.`
            );
          } catch (sourceError) {
            console.error(
              `[IPC Main] Error processing source ${source.name}:`,
              sourceError
            );
          }
          processedCount++;
          const percent = Math.floor(10 + (processedCount / totalSources) * 30);
          sendProgress({
            status: `Fetching source ${processedCount}/${totalSources}: ${source.name}`,
            percent,
          });
        }

        sendProgress({
          status: 'Processing rules...',
          percent: 50,
        });
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
            console.log('[IPC Main] Skipping invalid rule:', rule);
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

        // Add validation before continuing
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

        const exceptionRuleCount = uniqueRules.filter(
          (rule) => rule.isException || (rule.raw && rule.raw.startsWith('@@'))
        ).length;

        sendProgress({
          status: 'Generating filter list...',
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
            duplicatesRemoved: allRules.length - uniqueRuleCount
          },
          generatorVersion: app.getVersion()
        };

        const generatedList = generateFilterList(uniqueRules, metadata, format);

        sendProgress({
          status: 'Saving to file...',
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

        store.set('lastProcessTime', new Date().toLocaleString());

        sendProgress({ status: 'Complete!', percent: 100 });

        const endTime = Date.now();
        console.log(`[IPC Main] Import process took ${endTime - startTime}ms.`);

        return {
          success: true,
          processedRuleCount: totalProcessedCount,
          uniqueRuleCount: uniqueRuleCount,
          exceptionRuleCount: exceptionRuleCount,
          timestamp: new Date().toLocaleString(),
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

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
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
