import { join, dirname, isAbsolute, basename, resolve as pathResolve, sep } from 'path';
import { createServer, Server as HttpServer, ServerResponse, type IncomingMessage } from 'http';
import { networkInterfaces } from 'os';
import { getServers as getDnsServers } from 'dns';
import { createHash } from 'crypto';
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
  nativeImage,
  clipboard,
  safeStorage,
  WebContents,
} from 'electron';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import JSZip from 'jszip';
import { promises as fs, existsSync, createReadStream } from 'fs';
import isDev from 'electron-is-dev';

if (isDev) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

import Store from 'electron-store';
import type { ElectronStore, StoreSchema } from './types';
import { revalidateQuarantine, shouldAutoQuarantine } from './quarantineGate';
import {
  clearElementHarvest,
  rememberedElementHarvestPath,
  summarizeElementHarvest,
} from './elementHarvest';
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
import { piholeGravityUpdate, piholeVersionProbe } from './piholeApi.js';
import { feedTokenAuthorised } from './feedAuth';
import { isServableFeedFile } from './feedServing';
import {
  parseDeployRefreshQuery,
  recordDeployRefresh,
} from './deployRefresh';
import {
  readSecret,
  readSecretField,
  sealSecretField,
  secretStorageAvailable,
  writeSecret,
} from './secretsStore';
import { unboundFeedFileName } from './unboundDeploy';
import {
  RESOLVER_CONTROL_DOMAIN,
  classifyUnboundReachability,
  createFeedServeLog,
  parseUnboundDropIn,
  pickCanaryDomain,
  reachabilityProbeHeaders,
  toReachabilitySnapshot,
  type UnboundReachability,
  type UnboundReachabilitySnapshot,
} from './unboundReachability';
import {
  parseUnboundResolverAddress,
  pickReferenceTarget,
  resolveUnboundResolver,
} from './unboundAddress';
import { probeUnboundResolver } from './unboundProbe';
import {
  UNBOUND_WATCH_INTERVAL_MS,
  shouldWatchUnbound,
  unboundWatchAlert,
  unboundWatchIntervalMs,
} from './unboundWatch';
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
  parseFilterListStream,
  fetchContent,
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
  buildCategoryAttribution,
  toCategoryBlocklist,
  toAttributionManifest,
  extractHostFromRule,
  classifierInputFingerprint,
  parseVerdictCache,
  serializeVerdictCache,
  refreshDb,
  setDbCacheDirectory,
  checkRuleConflict,
  synthesizeRules,
  evaluateDomainRules,
  filterDNSRules,
  filterBrowserRules,
  LEARNED_SHADOW_SAMPLE_RATE,
  STATIC_RULE_TIERS,
  manifestRuleResources,
  computeTierPlan,
  parseEnabledTierIds,
  parseHitLedgerText,
  selectHotList,
  formatHotList,
  type TierFileInput,
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
  UnboundResolverSettings,
  ThreatQuarantineItem,
  AiWatchdogConfig,
} from './types';
import type { ThreatCategory } from '@blockingmachine/core';
import { DaemonManager } from './daemonManager';
import { TrayManager, type TraySharedState } from './trayManager';
import { shadowScoreWatchdogDomains } from './learnedShadow';
import {
  clearHeatForDomain,
  emptyRadarHeatMap,
  ignoreHeatDomain,
  recordFlagsInHeatMap,
  suggestWatchdogCadence,
  summarizeHeatMap,
  unignoreHeatDomain,
  type RadarHeatMap,
} from './radarHeatMap';

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
    // Shadowrocket, Privoxy and BIND are deploy targets, not just syntaxes: the Deploy Hub writes a
    // rule set, an action file and an RPZ zone for them, so each format has to be selectable or its
    // tab can only ever point at a file the app cannot produce.
    'shadowrocket',
    'privoxy',
    'bind',
    // The shared null-zone mechanism is a second BIND artifact, not a variant of the RPZ one: it
    // emits a named.conf fragment and a fixed 3-line zone file, where RPZ emits the zone itself.
    'bind-null',
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
    feedToken: {
      type: 'string',
      default: '',
    },
    deployRefreshReports: {
      type: 'object',
      default: {},
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

/**
 * The compile pipeline iterates hundreds of thousands of rules on the main
 * thread — a cold dedup + classify pass can hold the event loop for minutes,
 * which is what made the window, tray and feed server look dead mid-compile.
 * Yield between batches so IPC and HTTP keep answering while a compile runs.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A source saved as `./filters/...` is app-relative, not cwd-relative: dev
 * resolves beside the package manifest; the packaged app resolves under
 * `Resources/` where `filters/` ships as an extraResource. Anything already
 * absolute, remote, or a `file://` URL passes through untouched.
 */
function resolveSourcePath(url: string): string {
  const trimmed = url.trim();
  if (
    /^https?:/i.test(trimmed) ||
    trimmed.startsWith('file://') ||
    isAbsolute(trimmed)
  ) {
    return trimmed;
  }
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return pathResolve(base, trimmed);
}

/**
 * Fetch + parse a filter source without holding the event loop across the
 * whole payload: the body is fed to `parseFilterListStream` in chunks so
 * stream delivery gives the loop real breathing points, and the collection
 * loop yields again on a cadence. Local paths are resolved app-first by
 * `resolveSourcePath`.
 */
async function fetchAndParseSource(url: string): Promise<StoredRule[]> {
  const resolved = resolveSourcePath(url);
  console.log(`Processing source: ${resolved}`);
  const content = await fetchContent(resolved);
  if (content === null) {
    console.warn(`Failed to fetch content for ${resolved}, returning empty list.`);
    return [];
  }
  const chunkSize = 256 * 1024;
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += chunkSize) {
    chunks.push(content.slice(i, i + chunkSize));
  }
  const rules: StoredRule[] = [];
  for await (const rule of parseFilterListStream(Readable.from(chunks), resolved)) {
    rules.push(rule);
    if (rules.length % 20000 === 0) await yieldToEventLoop();
  }
  console.log(`   Found ${rules.length} rules in ${resolved}`);
  return rules;
}

interface ClassifyWorkerResult {
  measured: Record<string, ThreatCategory>;
  servedFromCache: number;
}

/**
 * Run the ~190k-host malware classify pass in `classifyWorker.cjs` instead of
 * on the event loop. User feedback tunings go with `workerData` so the worker
 * classifies as the same model the inline path would have; progress ticks are
 * forwarded so the compile UI keeps moving while the worker runs.
 * `__dirname` inside the main bundle is `.webpack/main/` — the sibling worker
 * bundle ships next to it in dev and inside the asar when packaged.
 */
function runClassifyWorker(
  candidates: string[],
  priorVerdicts: Record<string, ThreatCategory>,
  onProgress: (done: number) => void
): Promise<ClassifyWorkerResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(join(__dirname, 'classifierWorker.cjs'), {
      workerData: {
        candidates,
        priorVerdicts,
        feedback: globalMiniAiClassifier.exportFeedback(),
        progressEvery: 5000,
      },
    });
    let settled = false;
    worker.on('message', (msg: { type?: string; done?: number } & Partial<ClassifyWorkerResult>) => {
      if (msg?.type === 'progress' && typeof msg.done === 'number') {
        onProgress(msg.done);
      } else if (msg?.type === 'result' && msg.measured) {
        settled = true;
        resolvePromise({
          measured: msg.measured,
          servedFromCache: typeof msg.servedFromCache === 'number' ? msg.servedFromCache : 0,
        });
      }
    });
    worker.once('error', rejectPromise);
    worker.once('exit', (code) => {
      if (!settled) {
        rejectPromise(new Error(`classifier worker exited with code ${code}`));
      }
    });
  });
}

interface OutputWorkerResult {
  generatedList: string;
  additionalContents: Array<{ format: string; content: string }>;
  dnsContent: string;
  browserContent: string;
  dnsCount: number;
  browserCount: number;
  candidates: string[];
  hotlistContent: string | null;
}

interface OutputWorkerInput {
  ruleLines: string;
  format: FilterFormat;
  additionalFormats: FilterFormat[];
  metadata: FilterListMetadata;
  hotlist: {
    hits: Array<{ rule: string; count: number }>;
    exceptions: string[];
    source: string;
    measuredOn: string;
  } | null;
}

/**
 * Run the post-dedup generation pass in `outputWorker.cjs` instead of on the
 * event loop. The worker re-parses the joined raw lines (a ~13MB string is a
 * cheap clone; the rule objects would be a ~160MB one), then generates every
 * output list, segregates the endpoints, extracts the classify pass's host
 * candidates and derives the hot set — ~3s of CPU that used to block the main
 * thread across the 90–95% window. Stage strings are forwarded so the compile
 * UI names what is actually running.
 */
function runOutputWorker(
  input: OutputWorkerInput,
  onStage: (stage: string) => void
): Promise<OutputWorkerResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(join(__dirname, 'outputWorker.cjs'), { workerData: input });
    let settled = false;
    worker.on('message', (msg: { type?: string; stage?: string } & Partial<OutputWorkerResult>) => {
      if (msg?.type === 'progress' && typeof msg.stage === 'string') {
        onStage(msg.stage);
      } else if (msg?.type === 'result' && typeof msg.generatedList === 'string') {
        settled = true;
        resolvePromise(msg as OutputWorkerResult);
      }
    });
    worker.once('error', rejectPromise);
    worker.once('exit', (code) => {
      if (!settled) {
        rejectPromise(new Error(`output worker exited with code ${code}`));
      }
    });
  });
}

/**
 * The same generation pass the output worker runs, on the main thread, for the
 * case where the worker cannot start. Identical semantics to
 * `outputWorker.ts` — the duplicated body is the resilience path, and the
 * yields between stages are what keep a fallback compile merely slow instead
 * of frozen.
 */
async function generateOutputsInline(
  input: OutputWorkerInput,
  onStage: (stage: string) => void
): Promise<OutputWorkerResult> {
  onStage('Re-parsing compiled rules');
  const rules = parseFilterList(input.ruleLines, 'compiled');
  await yieldToEventLoop();

  onStage(`Generating ${input.format} filter list`);
  const generatedList = generateFilterList(rules, input.metadata, input.format);

  const additionalContents: Array<{ format: string; content: string }> = [];
  for (const addFormat of input.additionalFormats) {
    await yieldToEventLoop();
    onStage(`Generating ${addFormat} export`);
    additionalContents.push({
      format: addFormat,
      content: generateFilterList(rules, input.metadata, addFormat),
    });
  }

  await yieldToEventLoop();
  onStage('Generating DNS endpoint list');
  const dnsRules = filterDNSRules(rules);
  const dnsContent = generateFilterList(
    dnsRules,
    {
      ...input.metadata,
      stats: {
        ...input.metadata.stats,
        totalRules: dnsRules.length,
        uniqueRules: dnsRules.length,
      },
    },
    'adguard'
  );

  await yieldToEventLoop();
  onStage('Generating browser endpoint list');
  const browserRules = filterBrowserRules(rules);
  const browserContent = generateFilterList(
    browserRules,
    {
      ...input.metadata,
      stats: {
        ...input.metadata.stats,
        totalRules: browserRules.length,
        uniqueRules: browserRules.length,
      },
    },
    'adguard'
  );

  await yieldToEventLoop();
  onStage('Extracting host candidates');
  const candidateSet = new Set<string>();
  for (let i = 0; i < rules.length; i++) {
    if (i !== 0 && i % 20000 === 0) await yieldToEventLoop();
    const host = extractHostFromRule(rules[i].raw);
    if (host) candidateSet.add(host);
  }

  let hotlistContent: string | null = null;
  if (input.hotlist && input.hotlist.hits.length > 0) {
    onStage('Deriving the measured hot set');
    hotlistContent = formatHotList(
      selectHotList({
        lines: browserRules.map((rule) => rule.raw),
        hits: input.hotlist.hits,
        exceptions: input.hotlist.exceptions,
      }),
      { source: input.hotlist.source, measuredOn: input.hotlist.measuredOn }
    );
  }

  return {
    generatedList,
    additionalContents,
    dnsContent,
    browserContent,
    dnsCount: dnsRules.length,
    browserCount: browserRules.length,
    candidates: [...candidateSet],
    hotlistContent,
  };
}

// ---------------------------------------------------------------------------
// Browser extension package download (GitHub release assets)
// ---------------------------------------------------------------------------

const GITHUB_RELEASES_API = 'https://api.github.com/repos/Greigh/Blockingmachine/releases';

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}
interface GitHubRelease {
  tag_name?: string;
  draft?: boolean;
  assets?: GitHubReleaseAsset[];
}

const EXTENSION_ASSET_PATTERN = /^blockingmachine-(chrome|firefox)-mv3-.+\.zip$/;

function releaseHasExtensionAssets(release: GitHubRelease): boolean {
  return (release.assets ?? []).some(
    (asset) => typeof asset.name === 'string' && EXTENSION_ASSET_PATTERN.test(asset.name),
  );
}

async function fetchGitHubJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Blockingmachine-App',
      Accept: 'application/vnd.github+json',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`GitHub API answered ${res.status}`);
  return res.json();
}

/**
 * Which release an extension download should come from. The tag matching the app's own
 * version wins whenever it exists — even when it carries no extension assets, so the
 * caller reports "this release has no package" rather than silently shipping a different
 * version's bits. Only when the tag itself is absent (a local or unreleased build) does
 * the newest release carrying the assets answer, named in the result.
 */
async function findExtensionRelease(): Promise<GitHubRelease | null> {
  const tag = `v${app.getVersion()}`;
  try {
    const rel = (await fetchGitHubJson(
      `${GITHUB_RELEASES_API}/tags/${encodeURIComponent(tag)}`,
    )) as GitHubRelease;
    if (rel && !rel.draft) return rel;
  } catch {
    // The tag is absent (unreleased build) — fall through to the newest release
    // that actually ships the packages.
  }
  const list = (await fetchGitHubJson(`${GITHUB_RELEASES_API}?per_page=10`)) as GitHubRelease[];
  return list.find((rel) => !rel.draft && releaseHasExtensionAssets(rel)) ?? null;
}

// Global cache of latest compiled rules for real-time inspection
let latestCompiledRules: StoredRule[] = [];

/**
 * The compile pipeline, exposed once `initialize()` wires its IPC handler, so
 * the auto-schedule timer can drive a real compile instead of only logging
 * that one was due. Null until the app is ready; the timer skips it then.
 */
let compileInvoker:
  | ((sender?: WebContents | null) => Promise<unknown>)
  | null = null;

// Auto-schedule background timer
let autoScheduleTimer: NodeJS.Timeout | null = null;
let dbRefreshTimer: NodeJS.Timeout | null = null;
const DB_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // hourly reputation-db patch refresh

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
      if (!compileInvoker) return;
      console.log('[AutoSchedule] Triggering scheduled filter list compilation...');
      try {
        await compileInvoker(null);
      } catch (err) {
        console.error('[AutoSchedule] Scheduled compilation failed:', err);
      }
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

/**
 * Merges flagged scan results into the persistent radar heat map and persists it.
 * Only non-clean verdicts carry heat. Returns the updated map for reuse.
 */
function recordRadarHeat(storeRef: ElectronStore<StoreSchema>, flagged: AiScanResult[], clientHint?: string): RadarHeatMap {
  const currentHeat = storeRef.get('radarHeatMap') || emptyRadarHeatMap();
  const updated = recordFlagsInHeatMap(
    currentHeat,
    flagged.map((r) => ({
      domain: r.domain,
      verdict: r.verdict,
      category: r.category,
      riskLevel: r.riskLevel,
      client: clientHint ?? (r as { client?: string }).client,
    })),
  );
  try {
    storeRef.set('radarHeatMap', updated);
  } catch (err) {
    console.error('[Radar Heat] Failed to persist heat map:', err);
  }
  return updated;
}

/**
 * Applies the adaptive cadence suggestion to the persisted watchdog config.
 * Logs only when the suggestion actually changes the effective interval, so
 * steady-state sweeps don't spam the console with identical lines.
 */
function applyAdaptiveCadence(storeRef: ElectronStore<StoreSchema>, heat: RadarHeatMap): void {
  try {
    const current = storeRef.get('aiWatchdogConfig');
    if (!current?.enabled) return;
    const suggestion = suggestWatchdogCadence(heat, current.intervalMinutes || 60);
    const previous = current.adaptiveIntervalMinutes || current.intervalMinutes || 60;
    storeRef.set('aiWatchdogConfig', {
      ...current,
      adaptiveIntervalMinutes: suggestion.intervalMinutes,
      cadenceReason: suggestion.reason,
      cadenceUpdatedAt: new Date().toISOString(),
    });
    if (suggestion.intervalMinutes !== previous) {
      console.log(`[Radar Heat] Adaptive cadence: next sweep in ~${suggestion.intervalMinutes}m (${suggestion.reason})`);
    }
  } catch (err) {
    console.error('[Radar Heat] Failed to apply adaptive cadence:', err);
  }
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

  // Adaptive cadence: the radar heat map may tighten or stretch the configured
  // interval. If no adaptive value has been computed yet (fresh startup),
  // derive one from the persisted heat map so the first sweep already runs at
  // the suggested cadence instead of waiting a full configured cycle.
  const configuredMinutes = Math.max(5, config.intervalMinutes || 60);
  let adaptiveMinutes = configuredMinutes;
  if (config.adaptiveIntervalMinutes && config.adaptiveIntervalMinutes >= 5) {
    adaptiveMinutes = Math.min(720, Math.round(config.adaptiveIntervalMinutes));
  } else {
    const suggestion = suggestWatchdogCadence(storeRef.get('radarHeatMap'), configuredMinutes);
    adaptiveMinutes = Math.min(720, suggestion.intervalMinutes);
    if (adaptiveMinutes !== configuredMinutes) {
      console.log(`[AI Watchdog] Cadence from heat map: ${adaptiveMinutes}m (${suggestion.reason})`);
    }
  }
  // Clamp the adaptive value into the cadence function's own bounds relative
  // to the CURRENT configured interval. A persisted suggestion computed for a
  // previous intervalMinutes setting must not mask the user's new choice
  // (e.g. user drops 60m -> 15m; a stale 120m adaptive would otherwise keep
  // winning until the next sweep recomputes it).
  const maxAdaptive = Math.min(720, configuredMinutes * 2);
  const minAdaptive = Math.max(5, Math.round(configuredMinutes / 2));
  if (adaptiveMinutes > maxAdaptive) adaptiveMinutes = maxAdaptive;
  if (adaptiveMinutes < minAdaptive) adaptiveMinutes = minAdaptive;
  const intervalMs = adaptiveMinutes * 60 * 1000;
  console.log(`[AI Watchdog] Started with interval: ${adaptiveMinutes}m (configured: ${configuredMinutes}m)`);

  aiWatchdogTimer = setInterval(async () => {
    try {
      console.log('[AI Watchdog] Running periodic background query scout...');
      const savedConfig = loadAiConfig(storeRef);
      const service = getSharedAiDetectorService(savedConfig);

      const queries: RawDnsQuery[] = [];
      const limit = 50;
      let flaggedWithClients: AiScanResult[] = [];

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
        const token = readSecret(storeRef, safeStorage, 'piholeApiKey');
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
              queries.push({ domain: name, client: item?.[3], timestamp: piholeEpochToIso(item?.[0]), blocked: false });
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
        const threats = scan.results.filter((r) => shouldAutoQuarantine(r, autoQuarantine));

        // Collect flagged domains (not only quarantined ones) with client
        // attribution for the heat ledger. Cadence is applied after the scan
        // block so empty sweeps participate too.
        const clientByDomain = new Map<string, string | undefined>();
        for (const q of queries) {
          if (!clientByDomain.has(q.domain)) clientByDomain.set(q.domain, q.client);
        }
        flaggedWithClients = scan.results
          .filter((r) => r.verdict !== 'clean')
          .map((r) => ({ ...r, client: clientByDomain.get(r.domain) }));

        // Learned-model shadow mode (M3): score every scanned domain with the trained
        // GBDT and log disagreements against production verdicts. Read-only — the model's
        // output never blocks or quarantines here, and the hook is fail-soft so a missing
        // or corrupt weights file cannot break the watchdog.
        //
        // The sample rate is stated rather than defaulted. Disagreements are the domains
        // where this model differs from the lists, so on their own they are a biased view
        // of traffic, and the M5 drift stage (PSI against the training baseline) has
        // nothing to compare — `drift.py` exits with "no sample records in the shadow
        // log". 1% of every scored domain is the unbiased slice it needs. What a sampled
        // record contains is a domain, two decisions and a score, written to a local
        // file and never transmitted: see docs/learned-shadow-privacy.md.
        try {
          const threatSet = new Set(threats.map((t) => t.domain));
          shadowScoreWatchdogDomains(
            scan.results.map((r) => r.domain),
            (d) => (threatSet.has(d) ? 'block' : 'allow'),
            LEARNED_SHADOW_SAMPLE_RATE,
          );
        } catch (err) {
          console.error('[Learned Shadow] sweep hook failed:', err);
        }

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

      // Adaptive cadence runs on EVERY sweep — including empty ones. A quiet
      // network is exactly when the interval should stretch to save resources,
      // and recording an empty flagged set still decays stale heat entries.
      const heat = recordRadarHeat(storeRef, flaggedWithClients);
      applyAdaptiveCadence(storeRef, heat);
      // Re-arm the timer only when the adaptive interval actually changed —
      // clearing and recreating an unchanged setInterval restarts the full
      // interval countdown, which would continuously delay the next sweep.
      const currentWatchdogForRearm = storeRef.get('aiWatchdogConfig');
      if (currentWatchdogForRearm) {
        const nextAdaptive = Math.max(
          5,
          Math.min(720, Math.round(currentWatchdogForRearm.adaptiveIntervalMinutes || configuredMinutes)),
        );
        if (nextAdaptive !== adaptiveMinutes) {
          console.log(`[AI Watchdog] Adaptive cadence changed ${adaptiveMinutes}m -> ${nextAdaptive}m; re-arming timer`);
          setupAiWatchdogTimer({ ...config, ...currentWatchdogForRearm }, storeRef);
        }
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
    const savedConfig = loadAiConfig(storeRef);
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
      const token = readSecret(storeRef, safeStorage, 'piholeApiKey');
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
          queries.push({ domain: name, client: item?.[3], timestamp: piholeEpochToIso(item?.[0]), blocked: false });
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
    // Feed the persistent heat map from live radar sessions as well
    const liveClientByDomain = new Map<string, string | undefined>();
    for (const q of queries) {
      if (!liveClientByDomain.has(q.domain)) liveClientByDomain.set(q.domain, q.client);
    }
    const liveHeat = recordRadarHeat(
      storeRef,
      scan.results.filter((r) => r.verdict !== 'clean').map((r) => ({ ...r, client: liveClientByDomain.get(r.domain) })),
    );
    // Propagate heat-driven cadence so the idle background watchdog adapts
    // while a live radar session is actively surfacing flagged traffic.
    applyAdaptiveCadence(storeRef, liveHeat);
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
          if (shouldAutoQuarantine(fresh, autoQuarantine)) {
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

let trayManager: TrayManager | null = null;
let trayStatusTimer: NodeJS.Timeout | null = null;
/** Live compile progress mirrored to the tray while a compilation runs. */
let trayCompileProgress: { status: string; percent: number } | null = null;
/** True while the main-process compile pipeline is running. */
let compileInFlight = false;
/** Cached daemon status — `getStatus()` is async, the tray menu is sync. */
let trayProtectionState: TraySharedState['protection'] = null;

/**
 * Pull a fresh DNS-daemon status into the cache and refresh the tray. Called on
 * a slow timer and immediately after a protection toggle.
 */
async function refreshTrayProtection(): Promise<void> {
  try {
    const status = await daemonManager.getStatus();
    trayProtectionState = {
      enabled: Boolean(status.protectionEnabled),
      status: status.status,
    };
  } catch {
    trayProtectionState = null;
  }
  trayManager?.scheduleRebuild();
}

/** Snapshot of everything the tray menu renders. Never throws. */
function getTraySharedState(): TraySharedState {
  let lastRuleCount: number | null = null;
  try {
    const history = store.get('compilationHistory') as
      | Array<{ uniqueRuleCount?: number }>
      | undefined;
    const fromHistory = history?.[0]?.uniqueRuleCount;
    lastRuleCount =
      typeof fromHistory === 'number'
        ? fromHistory
        : latestCompiledRules.length || null;
  } catch {
    lastRuleCount = latestCompiledRules.length || null;
  }

  let feedServer: TraySharedState['feedServer'] = null;
  try {
    const status = getFeedServerStatus();
    feedServer = { isRunning: status.isRunning, lanUrl: status.lanUrl };
  } catch {
    feedServer = null;
  }

  return {
    lastProcessTime: store.get('lastProcessTime') || null,
    lastRuleCount,
    compileProgress: trayCompileProgress,
    feedServer,
    protection: trayProtectionState,
  };
}

/**
 * Where the extension's static tier rulesets are, if they are anywhere this app can see.
 *
 * Searched rather than configured because there are two legitimate answers and the hub runs in
 * both: a checkout has them beside the extension package, and a packaged hub has them copied into
 * its resources. A packaged *extension* is a build artifact the hub does not ship, so the third
 * candidate is the one a user is most likely to be looking at when the feature appears not to
 * work — hence the third path, and hence the handler's refusal to report a plan for nothing.
 */
function findTierRulesDir(): string | null {
  const candidates = [
    join(process.resourcesPath, 'assets', 'rules'),
    join(process.resourcesPath, 'rules'),
    join(app.getAppPath(), 'assets', 'rules'),
    join(__dirname, '../../browser-extension/rules'),
    join(process.cwd(), 'packages/browser-extension/rules'),
    join(process.cwd(), 'rules'),
  ];
  for (const dir of candidates) {
    try {
      if (existsSync(dir) && existsSync(join(dir, 'tier_core.json'))) return dir;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * The synced list the extension's dynamic rules are built from, if this app has written one.
 *
 * Beside the compiled output, because that is the file the hub produces and the extension fetches
 * — the same bytes, so a redundancy report can never be about a list the browser was never given.
 * A checkout that has not compiled yet has no such file, and returns null: an empty list would
 * claim every tier is entirely redundant, which is the loudest possible way to be wrong.
 */
function findSyncedListPath(): string | null {
  const candidates: string[] = [];
  const savePath = store.get('savePath');
  if (typeof savePath === 'string' && isAbsolute(savePath)) {
    candidates.push(join(dirname(savePath), 'browser.txt'));
    candidates.push(join(dirname(savePath), 'adguardBrowser.txt'));
  }
  candidates.push(
    join(app.getPath('documents'), 'Blockingmachine', 'browser.txt'),
    join(app.getPath('documents'), 'Blockingmachine', 'adguardBrowser.txt'),
    join(process.cwd(), 'packages/browser-extension/rules/browser.txt'),
  );
  for (const file of candidates) {
    try {
      if (existsSync(file)) return file;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function getAssetPath(filename: string): string {  const assetCandidates = [
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

function createTray() {
  try {
    if (trayManager) {
      trayManager.ensureTray();
      return;
    }

    trayManager = new TrayManager({
      getMainWindow: () => mainWindow,
      getSavePath: () => {
        try {
          const p = store.get('savePath');
          return typeof p === 'string' && p ? p : null;
        } catch {
          return null;
        }
      },
      triggerCompile: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('trigger-compile');
        }
      },
      isCompiling: () => compileInFlight,
      setProtection: async (enabled: boolean) => {
        const res = await daemonManager.toggleProtection(enabled);
        if (res.success) {
          trayProtectionState = {
            enabled: Boolean(res.protectionEnabled),
            status: res.protectionEnabled ? 'running' : 'paused',
          };
        }
        return res.success;
      },
      flushDnsCache: async () => {
        const res = await daemonManager.flushCache();
        return res.success;
      },
      getState: getTraySharedState,
    });
    trayManager.ensureTray();

    // Keep the daemon-state row honest without polling the control API hard.
    if (!trayStatusTimer) {
      trayStatusTimer = setInterval(() => {
        void refreshTrayProtection();
      }, 15_000);
      trayStatusTimer.unref?.();
    }
    void refreshTrayProtection();
  } catch (err) {
    console.warn('Tray initialization skipped:', err);
    trayManager = null;
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

/**
 * The stored AI provider config with its key resolved for use.
 *
 * `apiKey` persists only as `apiKeyEncrypted` once the seal has run, so a bare
 * `store.get('aiConfig')` returns a config that *has* a key the scanner cannot see — the
 * decrypt has to happen at the boundary, exactly here, rather than trusting every
 * `{ ...savedConfig, ...override }` site to remember it.
 */
function loadAiConfig(storeRef: ElectronStore<StoreSchema>): Partial<AiProviderConfig> {
  const saved = (storeRef.get('aiConfig') || {}) as Partial<AiProviderConfig>;
  // Lazy migration, same as `readSecret` on the flat keys: seal a plaintext apiKey on the
  // first read that sees it — `get-ai-config` is not guaranteed to have run first.
  if (typeof saved.apiKey === 'string' && saved.apiKey && secretStorageAvailable(safeStorage)) {
    const sealed = sealSecretField(saved, safeStorage, 'apiKey');
    storeRef.set('aiConfig', sealed);
    saved.apiKey = undefined;
    saved.apiKeyEncrypted = sealed.apiKeyEncrypted as string | undefined;
  }
  const apiKey = readSecretField(saved, safeStorage, 'apiKey');
  return apiKey ? { ...saved, apiKey } : saved;
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

/**
 * Converts a Pi-hole query-log epoch-seconds timestamp (row field 0) to ISO 8601.
 * Behavioral cadence analysis needs query timestamps; returns undefined for
 * missing or malformed values rather than fabricating a time.
 */
function piholeEpochToIso(raw: unknown): string | undefined {
  const seconds = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  try {
    return new Date(seconds * 1000).toISOString();
  } catch {
    return undefined;
  }
}

async function loadStoredAdguardQueries(storeRef: ElectronStore<StoreSchema>, limit: number) {
  const user = (storeRef.get('adguardHomeUser') as string) || '';
  const pass = readSecret(storeRef, safeStorage, 'adguardHomePassword');
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
  const piholeApiKey = readSecret(storeRef, safeStorage, 'piholeApiKey') || undefined;
  const rawAdguard = storeRef.get('adguardHomeUrl') as string | undefined;
  const adguardHomeUser = storeRef.get('adguardHomeUser') as string | undefined;
  const adguardHomePassword = readSecret(storeRef, safeStorage, 'adguardHomePassword') || undefined;
  const adguardMode = (storeRef.get('adguardMode') as 'direct' | 'ha-api' | 'webhook' | undefined) || 'direct';
  const haToken = readSecret(storeRef, safeStorage, 'haToken') || undefined;
  const haWebhookUrl = storeRef.get('haWebhookUrl') as string | undefined;
  const customWebhookUrl = storeRef.get('customWebhookUrl') as string | undefined;

  const results: { service: string; status: 'success' | 'error' | 'skipped'; message: string; details?: string }[] = [];

  if (rawPihole && rawPihole.trim()) {
    try {
      let piholeUrl = rawPihole.trim();
      if (!piholeUrl.startsWith('http://') && !piholeUrl.startsWith('https://')) {
        piholeUrl = `http://${piholeUrl}`;
      }
      const res = await piholeGravityUpdate(piholeUrl, piholeApiKey, sinkholeFetch, {
        timeoutMs: 6000,
        allowInsecureLocalTls: sinkholeTlsAllowed(storeRef),
      });
      if (res.ok) {
        results.push({ service: 'Pi-hole', status: 'success', message: 'Gravity update triggered successfully' });
      } else {
        results.push({ service: 'Pi-hole', status: 'error', message: `HTTP status ${res.status}${res.detail ? ` — ${res.detail}` : ''}` });
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

/**
 * Serves of compiled feed files, so the Deploy Hub can tell whether a resolver is actually fetching.
 *
 * The scheduled `curl` in a Unbound recipe is the subscription, and the only local evidence that it
 * exists is the request log. In-memory on purpose: "has anything fetched this since the hub
 * started" is the question, and a persisted answer would be misleading after a restart.
 */
const feedServeLog = createFeedServeLog();

/** Record a file serve, unless the reachability check is the client. */
function recordFeedServe(
  req: IncomingMessage,
  path: string,
  status: number,
  bytes?: number,
): void {
  feedServeLog.record(
    { headers: req.headers, peer: req.socket?.remoteAddress || 'unknown' },
    path,
    status,
    bytes,
  );
}

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
      // A subscriber that connected and stopped reading still counts as open — `write` then
      // buffers every event in memory on its behalf. Drop a client whose backlog has grown
      // past what a heartbeat stream could ever legitimately owe it.
      if (client.writableLength > 512 * 1024) {
        sseClients.delete(client);
        client.destroy();
        continue;
      }
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

/**
 * This machine's configured DNS servers, for suggesting what to type.
 *
 * Read defensively: `getServers()` throws on a system with no resolver configuration, and a
 * suggestion is not worth failing a check over.
 */
function systemDnsServers(): string[] {
  try {
    return getDnsServers() || [];
  } catch {
    return [];
  }
}

/**
 * The addresses the check will use, or the reason it cannot.
 *
 * One function for the getter and the check, so the field the user sees and the address that is
 * actually queried cannot disagree about what the default is.
 */
/**
 * The parsed targets behind `unboundResolverSettings()`.
 *
 * Kept separate only because the check needs the address, not the label it was rendered as; both
 * entrances run the same two pure decisions, so "what the field says" and "what gets queried" have
 * one source of truth.
 */
function unboundResolverTargets(): {
  primary: ReturnType<typeof resolveUnboundResolver>;
  reference: ReturnType<typeof pickReferenceTarget>;
} {
  const primary = resolveUnboundResolver(store.get('unboundResolver'));
  const reference = primary.ok
    ? pickReferenceTarget(
        primary.resolved.target,
        store.get('unboundReferenceResolver'),
        systemDnsServers(),
      )
    : { ok: false as const, message: primary.message };
  return { primary, reference };
}

function unboundResolverSettings(): UnboundResolverSettings {
  const { primary, reference } = unboundResolverTargets();

  return {
    address: store.get('unboundResolver') || '',
    effective: primary.ok ? primary.resolved.target.label : null,
    error: primary.ok ? null : primary.message,
    isDefault: primary.ok ? primary.resolved.usedDefault : false,
    referenceAddress: store.get('unboundReferenceResolver') || '',
    referenceEffective: reference.ok ? reference.reference.target.label : null,
    referenceError: reference.ok ? null : reference.message,
    referenceSource: reference.ok ? reference.reference.source : 'none',
    systemServers: systemDnsServers(),
  };
}

/**
 * The last reachability result, as the pane reads it back between checks.
 *
 * Stored rather than recomputed so opening the Unbound tab does not quietly query the user's
 * resolver — a check that fires a DNS query on tab switch is a check nobody can predict.
 */
function getUnboundReachabilitySnapshot(): UnboundReachabilitySnapshot | null {
  return store.get('unboundReachability') ?? null;
}

/**
 * Fetch a feed URL the way a resolver's scheduled command would — minus the evidence.
 *
 * The probe header is what keeps this request out of the serve log: without it the check would
 * always see itself arrive and report a fetch that only it made.
 */
async function fetchOwnFeed(
  url: string,
): Promise<{ ok: boolean; status?: number; error?: string; body?: string; viaLoopback?: boolean }> {
  try {
    const res = await fetch(url, {
      headers: reachabilityProbeHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, status: res.status, body: await res.text() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run one Unbound reachability check against live state.
 *
 * The self-fetch targets the address the recipe puts in the copy-paste command, because that is the
 * one the resolver will use. It falls back to loopback and says so when the LAN address does not
 * answer from this machine: a host firewall that blocks the hub's own LAN port would otherwise be
 * reported as a broken feed, when the file is in fact being served.
 */
async function checkUnboundReachability(): Promise<UnboundReachability> {
  const checkedAt = new Date().toISOString();
  const status = getFeedServerStatus();
  const exportFormat = store.get('exportFormat');
  const feedFileName = unboundFeedFileName(exportFormat, store.get('savePath'));
  const feedUrl = `${status.lanUrl}/${encodeURIComponent(feedFileName)}`;

  let selfFetch = await fetchOwnFeed(feedUrl);
  if (!selfFetch.ok && status.isRunning) {
    const loopback = await fetchOwnFeed(
      `http://127.0.0.1:${status.port}/${encodeURIComponent(feedFileName)}`,
    );
    if (loopback.ok) selfFetch = { ...loopback, viaLoopback: true };
  }

  const dropIn = parseUnboundDropIn(selfFetch.body ?? '');
  const canaryDomain = pickCanaryDomain(dropIn.domains);
  const previous = getUnboundReachabilitySnapshot();

  const { primary, reference } = unboundResolverTargets();
  let probe = null;
  let probeSkipped: string | null = null;
  if (!status.isRunning || !selfFetch.ok || dropIn.zones === 0) {
    probeSkipped = 'The file has to be served before a resolver answer means anything.';
  } else if (!canaryDomain) {
    probeSkipped = 'No domain in the drop-in can be used as a test target.';
  } else if (!primary.ok) {
    probeSkipped = primary.message;
  } else {
    // A missing reference is not a reason to skip the check: it is the reason the verdict comes back
    // unconfirmed rather than live, which is the honest reading of an unverified NXDOMAIN.
    probe = await probeUnboundResolver({
      target: primary.resolved.target,
      canaryDomain,
      controlDomain: RESOLVER_CONTROL_DOMAIN,
      referenceTarget: reference.ok ? reference.reference.target : null,
    });
  }

  const reachability = classifyUnboundReachability({
    checkedAt,
    feedUrl,
    feedFileName,
    feedServerRunning: status.isRunning,
    selfFetch: {
      ok: selfFetch.ok,
      status: selfFetch.status,
      error: selfFetch.error,
      zones: dropIn.zones,
      hasServerBlock: dropIn.hasServerBlock,
      canaryDomain,
      viaLoopback: selfFetch.viaLoopback,
    },
    serves: [...feedServeLog.entries()],
    lastFetchedAt: previous?.fetchedAt ?? null,
    refreshReport: (store.get('deployRefreshReports') || {})['unbound'] ?? null,
    lastCompiledAt: store.get('lastProcessTime') || null,
    lastConfirmedAt: previous?.lastConfirmedAt ?? null,
    staleAnnouncedAt: previous?.staleAnnouncedAt ?? null,
    probe,
    probeSkipped,
  });

  store.set('unboundReachability', toReachabilitySnapshot(reachability));

  return reachability;
}

/**
 * The scheduled check, and the announcement when it finds a regression.
 *
 * `unboundWatch.ts` decides *whether* to speak; this owns the two things it cannot: the timer, and
 * a notification. Three details are the difference between a watcher and a nuisance:
 *
 *  - The previous verdict is read **before** the check runs, because the check overwrites the very
 *    snapshot the comparison needs. Read afterwards, every tick would compare a verdict with itself
 *    and never see a change.
 *  - One tick at a time. A manual **Check now** pressed while a scheduled check is mid-flight would
 *    otherwise put two rounds of DNS queries against the resolver at the same moment, and the
 *    slower one to finish would overwrite the newer verdict with an older reading.
 *  - A check the user just ran counts as having been told. It overwrites the same snapshot, so a
 *    regression discovered by hand is seen and not also announced — which is the correct outcome,
 *    because the person who pressed the button was looking at the screen it would have appeared on.
 */
let unboundWatchTimer: NodeJS.Timeout | null = null;
let unboundWatchInFlight = false;

async function runUnboundWatchTick(storeRef: ElectronStore<StoreSchema>): Promise<void> {
  if (unboundWatchInFlight) return;
  // The gate is re-read every tick rather than once at startup, because a machine that has never
  // deployed Unbound should not be querying a resolver on a timer, and one that has should start
  // watching the moment somebody engages with the pane rather than at the next launch.
  if (
    !shouldWatchUnbound({
      address: storeRef.get('unboundResolver'),
      snapshot: getUnboundReachabilitySnapshot(),
    })
  ) {
    return;
  }

  unboundWatchInFlight = true;
  try {
    const previous = getUnboundReachabilitySnapshot();
    const reachability = await checkUnboundReachability();
    const alert = unboundWatchAlert({ previous, current: toReachabilitySnapshot(reachability) });

    // The pane is only listening while it is mounted, and it renders snapshots it was given at
    // mount time — so without this the check runs on schedule and the screen keeps showing the
    // verdict from whenever the tab was opened.
    mainWindow?.webContents.send('unbound-reachability-updated', toReachabilitySnapshot(reachability));

    // The alert decision is pure, so it cannot remember that it spoke. A `stale` finding is held for
    // a grace period because a copy that has been behind the compile for five minutes may be
    // waiting for the resolver's next fetch; without this line the announcement would then never
    // be made, since every later tick is `stale` to `stale`. `classifyUnboundReachability` clears
    // the stamp when the deployment is current again, so the next regression can speak.
    if (alert?.staleAnnouncedAt) {
      const snapshot = getUnboundReachabilitySnapshot();
      if (snapshot) store.set('unboundReachability', { ...snapshot, staleAnnouncedAt: alert.staleAnnouncedAt });
    }

    if (alert && Notification.isSupported()) {
      try {
        const icon = getAssetPath('Blockingmachine.png');
        new Notification({ title: alert.title, body: alert.body, icon: icon || undefined }).show();
      } catch (err) {
        // Best-effort, the same way the tray and the compile notification are: a machine with
        // notifications disabled must not lose the check itself.
        console.warn('[Unbound Watch] Notification failed:', err);
      }
    } else if (alert) {
      // Notifications are off or unavailable. The verdict is still stored and still on the pane;
      // this line is the only trace that a regression was seen and not shown, so it is written
      // down rather than dropped.
      console.log(`[Unbound Watch] ${alert.from} → ${alert.to}: ${alert.body}`);
    }
  } catch (err) {
    console.warn('[Unbound Watch] Scheduled check failed:', err);
  } finally {
    unboundWatchInFlight = false;
  }
}

/**
 * Start re-checking the deployment on the cadence, once a deployment is worth watching.
 *
 * Called alongside the other background timers at startup. The first tick is one full interval away
 * rather than immediate: a check fires DNS queries at whatever address is configured, and doing that
 * at launch — before anyone has looked at the pane — is a surprise nobody asked for and cannot
 * predict. The snapshot the pane already reads is the previous verdict, so nothing is lost by
 * waiting.
 */
function startUnboundWatch(storeRef: ElectronStore<StoreSchema>): void {
  stopUnboundWatch();
  const intervalMs = unboundWatchIntervalMs(
    // No setting yet: the cadence is a constant until there is a reason to make it one, and the
    // clamp in `unboundWatchIntervalMs` is what a persisted preference will go through later.
    UNBOUND_WATCH_INTERVAL_MS,
  );
  unboundWatchTimer = setInterval(() => {
    void runUnboundWatchTick(storeRef);
  }, intervalMs);
  unboundWatchTimer?.unref?.();
  console.log(`[Unbound Watch] Deployment reachability will be re-checked every ${Math.round(intervalMs / 60000)}m.`);
}

function stopUnboundWatch(): void {
  if (unboundWatchTimer) {
    clearInterval(unboundWatchTimer);
    unboundWatchTimer = null;
  }
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

        // The optional second gate on mutations, resolved once per request — the semantics live
        // in `feedAuth.ts`. Returns true after writing the rejection, so a guarded endpoint is
        // one line; read-only queries keep the origin-only guard via `rejectCrossOrigin`.
        const configuredToken = (storeRef.get('feedToken') || '').trim();
        const rejectCrossOrigin = (crossOriginError: string): boolean => {
          if (!isSafeClientOrigin()) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: crossOriginError }));
            return true;
          }
          return false;
        };
        const rejectUnauthorisedMutation = (crossOriginError: string): boolean => {
          if (rejectCrossOrigin(crossOriginError)) return true;
          if (!feedTokenAuthorised(configuredToken, req.headers.authorization)) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorised — a valid feed token is required' }));
            return true;
          }
          return false;
        };

        if (lowerPath === '/v1/events' || lowerPath === '/api/events') {
          // The stream carries browsing-derived telemetry and `remote_control` broadcasts, so it
          // gets the origin guard mutations get — an EventSource from an arbitrary web page sends
          // an Origin header and must not be able to read it. A configured feed token gates the
          // stream the same way it gates mutations: otherwise the token would protect writes
          // while leaving the data they produce readable by anyone on the LAN.
          if (rejectCrossOrigin('Cross-origin event stream forbidden')) return;
          if (configuredToken && !feedTokenAuthorised(configuredToken, req.headers.authorization)) {
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Unauthorised — a valid feed token is required' }));
            return;
          }
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
          if (rejectUnauthorisedMutation('Cross-origin telemetry forbidden')) return;
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

        // The scheduled refresh's report-back: the resolver host's cron POSTs `ok`/`fail` after
        // its fetch-and-reload, so a failure that happened while nobody looked is recorded rather
        // than absent. Token-guarded like every mutation — when the recipe is copied with a
        // configured token it carries the header.
        if (lowerPath === '/v1/deploy-report' || lowerPath === '/api/deploy-report') {
          if (rejectUnauthorisedMutation('Cross-origin deploy reports forbidden')) return;
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Method Not Allowed. Use POST.' }));
            return;
          }
          const parsed = parseDeployRefreshQuery(reqUrl.searchParams);
          if (!parsed) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Bad Request: expected ?target=<target>&ok=0|1[&detail=…]' }));
            return;
          }
          const reports = { ...(storeRef.get('deployRefreshReports') || {}) };
          reports[parsed.target] = recordDeployRefresh(reports[parsed.target], {
            ok: parsed.ok,
            at: new Date().toISOString(),
            peer: req.socket?.remoteAddress || undefined,
            detail: parsed.detail,
          });
          storeRef.set('deployRefreshReports', reports);
          console.log(`[Deploy Report] ${parsed.target}: scheduled refresh ${parsed.ok ? 'ok' : 'FAILED'}${parsed.detail ? ` — ${parsed.detail}` : ''}`);
          // A mounted pane holds a snapshot whose `refreshReport` was stamped at check time —
          // minutes or days stale. Fold the new report into the stored snapshot and re-publish
          // it through the channel the view already subscribes to, so a fail report lands on
          // the card now rather than at the next scheduled tick.
          if (parsed.target === 'unbound') {
            const snap = storeRef.get('unboundReachability');
            if (snap) {
              storeRef.set('unboundReachability', { ...snap, refreshReport: reports[parsed.target] });
              mainWindow?.webContents.send('unbound-reachability-updated', storeRef.get('unboundReachability'));
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true }));
          return;
        }

        if (lowerPath === '/v1/control/cosmetics' || lowerPath === '/api/control/cosmetics') {
          // A status query reads nothing sensitive, so it keeps the origin-only guard even
          // when a feed token is configured — the token gates the change, not the question.
          if (req.method === 'GET') {
            if (rejectCrossOrigin('Cross-origin control forbidden')) return;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: 'Cosmetics status query' }));
            return;
          }

          if (rejectUnauthorisedMutation('Cross-origin control forbidden')) return;

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
          if (rejectUnauthorisedMutation('Cross-origin control forbidden')) return;
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
          if (rejectUnauthorisedMutation('Cross-origin compilation forbidden')) return;
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: 'Method Not Allowed. Use POST.' }));
            return;
          }
          console.log('[Feed Server API] Received trigger: compile rules');
          // `compileInFlight` already single-flights the real compile in the IPC handler — this
          // check keeps a flood of trigger POSTs from each paying an IPC round-trip only to
          // bounce, and answers honestly instead of claiming every request started a compile.
          if (compileInFlight) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, alreadyRunning: true, message: 'Compilation already in progress' }));
            return;
          }
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
          // The output directory is a shared user folder — a feed server must not hand out
          // whatever else sits beside the compiled lists (`config.yaml`, `package.json`, …).
          if (!isServableFeedFile(cleanName, basename(savePath))) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Not a feed file: ${pathname}`);
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
              recordFeedServe(req, pathname, 200, payload.length);
              res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Length': payload.length,
              });
              res.end(payload);
              return;
            }

            const stat = await fs.stat(targetFilePath);
            if (stat.isFile()) {
              recordFeedServe(req, pathname, 200, stat.size);
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

          // Not found response with helpful feed directory listing — filtered to servable names
          // only: naming every file in the directory would leak exactly what the allowlist is
          // there to keep private.
          const saveName = basename(savePath);
          const available = existsSync(outputDir)
            ? (await fs.readdir(outputDir)).filter((f) => isServableFeedFile(f, saveName))
            : [];
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

    // Re-judge the persisted quarantine against the current classifier once per launch. The
    // store accumulates verdicts across classifier versions and past gate bugs, and the
    // ai-threats feed serves them whether or not the watchdog runs — nothing else ever asks an
    // old verdict to prove itself again.
    void revalidateQuarantine(store, (domain) =>
      getSharedAiDetectorService(loadAiConfig(store)).scanDomain(domain, { skipDns: true }),
    ).catch((err) => console.error('[AI Quarantine] Revalidation failed:', err));

    // The Unbound reachability check re-runs itself. Not gated on a setting: the tick is gated on a
    // deployment being worth watching, which is a far narrower condition than opt-in (see
    // `shouldWatchUnbound`), and the alternative is a check whose only trigger is remembering to
    // look — which is the thing that stops happening.
    startUnboundWatch(store);

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

    ipcMain.handle('copy-to-clipboard', async (_event: IpcMainInvokeEvent, text: string) => {
      try {
        clipboard.writeText(String(text || ''));
        return { success: true };
      } catch (error) {
        console.error('[IPC Main] Error copying to clipboard:', error);
        return { success: false, error: String(error) };
      }
    });

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
    async function runImportProcess(sender?: WebContents | null) {
      const startTime = Date.now();
      let lastLoggedStage = '';
      const sendProgress = (data: { status: string; percent: number }) => {
        // Mirror progress into the menu-bar tray as well as the renderer.
        trayCompileProgress = data;
        trayManager?.onCompileProgress(data);
        // Stage transitions go to stdout too — a "stuck at N%" report is only
        // diagnosable if the log records which stage was running. Ticks inside
        // one stage (host counts, percents) stay out of the log on purpose.
        if (data.status !== lastLoggedStage) {
          lastLoggedStage = data.status;
          console.log(`[Compile] ${data.percent}% — ${data.status}`);
        }
        if (sender && !sender.isDestroyed()) {
          sender.send('process-progress', data);
        }
      };
      const finishCompile = (result: {
        success: boolean;
        ruleCount: number;
        error?: string;
      }) => {
        compileInFlight = false;
        trayCompileProgress = null;
        trayManager?.onCompileCompleted(result);
      };

      if (compileInFlight) {
        return {
          success: false,
          error: 'Compilation already in progress.',
          processedRuleCount: 0,
          uniqueRuleCount: 0,
          timestamp: new Date().toLocaleString(),
        };
      }

      try {
        compileInFlight = true;
        sendProgress({
          status: 'Loading sources...',
          percent: 5,
        });
        const sources = store.get('filterSources');
        const enabledSources = sources.filter(
          (source: FilterSource) => source.enabled
        );

        if (enabledSources.length === 0) {
          // A configuration problem, not a failed compilation: refresh the tray
          // quietly rather than firing a desktop notification at the user.
          compileInFlight = false;
          trayCompileProgress = null;
          trayManager?.scheduleRebuild();
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
              const rules = await fetchAndParseSource(source.url);
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
            if (i !== 0 && i % 20000 === 0) await yieldToEventLoop();
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

        // Resolve the write target before generation starts — the hot set's
        // provenance header names the file it travels beside.
        let savePath = store.get('savePath');
        if (!savePath || typeof savePath !== 'string' || !isAbsolute(savePath)) {
          savePath = join(
            app.getPath('documents'),
            'Blockingmachine',
            'processed_rules.txt'
          );
        }
        const outputDir = dirname(savePath);

        // Simultaneous Multi-Format Export
        const additionalFormats = (store.get('additionalFormats') || []) as FilterFormat[];
        const validAdditional = additionalFormats.filter(
          (f) => f !== format && isValidFormat(f)
        );
        // The extension has to match what the file is: a `.txt` holding an RPZ zone or a Privoxy
        // action file reads as a plain list to every tool that opens it, including the user.
        const additionalFormatExtensions: Partial<Record<FilterFormat, string>> = {
          dnsmasq: '.conf',
          unbound: '.conf',
          shadowrocket: '.conf',
          privoxy: '.action',
          bind: '.rpz',
        };

        // The measured hot set travels beside the list it was measured on: the extension
        // fetches `hotlist.txt` from the feed so a browser installs the rules its own ledger
        // says fire before the full sync lands. The ledger read stays here — it is a small
        // file — so the worker receives plain data rather than a path to trust. Written only
        // when a ledger is configured and carries hits; an absent file is the honest answer
        // for "no measurement here".
        const hotlistPath = join(outputDir, 'hotlist.txt');
        const wantedHotlistLedger =
          typeof store.get('tierLedgerPath') === 'string' && store.get('tierLedgerPath')
            ? (store.get('tierLedgerPath') as string)
            : null;
        let hotlistInput: OutputWorkerInput['hotlist'] = null;
        if (wantedHotlistLedger) {
          try {
            const parsed = parseHitLedgerText(await fs.readFile(wantedHotlistLedger, 'utf8'));
            if (parsed.hits.length > 0) {
              hotlistInput = {
                hits: parsed.hits,
                exceptions: parsed.exceptions,
                source: basename(savePath),
                measuredOn: `${basename(wantedHotlistLedger)} (browser rule-hit ledger)`,
              };
            }
          } catch (hotErr) {
            console.error('[IPC Main] Failed to read the picked ledger for the hot set:', hotErr);
          }
        }

        // The generation pass is ~3s of synchronous CPU across three
        // `generateFilterList` calls plus both segregations — off the main
        // thread it goes. The joined raw lines are a ~13MB string (~20ms to
        // build); the rule objects would be a ~160MB structured clone, so the
        // worker re-parses — byte-identical output on every shipped format.
        const ruleLines = uniqueRules.map((rule) => rule.raw).join('\n');
        const workerInput: OutputWorkerInput = {
          ruleLines,
          format,
          additionalFormats: validAdditional,
          metadata,
          hotlist: hotlistInput,
        };
        const outputStagePercent = (stage: string): number =>
          stage.startsWith('Re-parsing')
            ? 90
            : stage.startsWith('Generating DNS')
              ? 93
              : stage.startsWith('Generating browser')
                ? 94
                : stage.startsWith('Extracting host')
                  ? 94
                  : stage.startsWith('Deriving')
                    ? 95
                    : 92;
        const onOutputStage = (stage: string) =>
          sendProgress({ status: stage, percent: outputStagePercent(stage) });
        let outputs: OutputWorkerResult;
        try {
          outputs = await runOutputWorker(workerInput, onOutputStage);
        } catch (outputWorkerErr) {
          console.warn(
            '[IPC Main] Output worker unavailable, generating inline:',
            outputWorkerErr
          );
          outputs = await generateOutputsInline(workerInput, onOutputStage);
        }

        sendProgress({
          status: 'Saving to disk...',
          percent: 95,
        });
        await fs.mkdir(dirname(savePath), { recursive: true });
        await fs.writeFile(savePath, outputs.generatedList, 'utf8');
        console.log(`[IPC Main] Filter list saved to: ${savePath}`);

        for (const addContent of outputs.additionalContents) {
          try {
            const ext =
              additionalFormatExtensions[addContent.format as FilterFormat] ?? '.txt';
            const addPath = join(outputDir, `processed_${addContent.format}${ext}`);
            await fs.writeFile(addPath, addContent.content, 'utf8');
            console.log(`[IPC Main] Additional export saved: ${addPath}`);
          } catch (addError) {
            console.error(
              `[IPC Main] Failed to write additional format ${addContent.format}:`,
              addError
            );
          }
        }

        const timestampStr = new Date().toLocaleString();

        // Automatically write segregated endpoint files for System Daemon (dns.txt) and Browser Extension (browser.txt)
        sendProgress({ status: 'Writing segregated endpoint lists...', percent: 96 });
        try {
          await fs.writeFile(join(outputDir, 'dns.txt'), outputs.dnsContent, 'utf8');
          await fs.writeFile(join(outputDir, 'adguardDns.txt'), outputs.dnsContent, 'utf8');
          console.log(
            `[IPC Main] Segregated DNS endpoints saved: dns.txt (${outputs.dnsCount} rules)`
          );

          // Automatically hot-reload System DNS Daemon if running
          daemonManager.reloadRules().catch(() => {});

          await fs.writeFile(join(outputDir, 'browser.txt'), outputs.browserContent, 'utf8');
          await fs.writeFile(join(outputDir, 'adguardBrowser.txt'), outputs.browserContent, 'utf8');
          console.log(
            `[IPC Main] Segregated Browser endpoints saved: browser.txt (${outputs.browserCount} rules)`
          );

          if (outputs.hotlistContent) {
            await fs.writeFile(hotlistPath, outputs.hotlistContent, 'utf8');
            console.log(`[IPC Main] Hot set saved: hotlist.txt`);
          } else if (existsSync(hotlistPath)) {
            // No ledger picked, none readable, or none with hits — a stale file
            // would keep serving the set the dead ledger produced.
            await fs.unlink(hotlistPath);
          }

          // Broadcast real-time SSE event to connected browser extensions & LAN clients
          broadcastSseEvent('compile_completed', {
            timestamp: timestampStr,
            uniqueRuleCount,
            processedRuleCount: totalProcessedCount,
            dnsRuleCount: outputs.dnsCount,
            browserRuleCount: outputs.browserCount,
          });
          broadcastSseEvent('rules_updated', {
            timestamp: timestampStr,
            ruleCount: uniqueRuleCount,
            dnsRuleCount: outputs.dnsCount,
            browserRuleCount: outputs.browserCount,
          });
        } catch (segErr) {
          console.error('[IPC Main] Failed to write segregated dns/browser endpoints:', segErr);
        }

        // Per-category compiled outputs.
        //
        // The packaged extension used to decide which of its four static tiers a host belongs to
        // by tokenising the hostname against vocabulary derived from the curated tier files, and
        // on this list that failed to place 90% of hosts. The publisher's own category is right
        // here and was never written down, so it is written down now: one blocklist per category
        // next to the other compiled outputs, which is what `compile-tier-rulesets.mjs
        // --attribution` reads instead of guessing.
        //
        // Built from `sourceResults`, not from `uniqueRules`, because a host listed by six
        // publishers is one host with six categories and the deduplicated array keeps only the
        // first — the attribution is built before that information is thrown away.
        sendProgress({ status: 'Building category attribution...', percent: 96 });
        await yieldToEventLoop();
        try {
          // One entry per configured source, carrying its name and URL: the manifest is the
          // record a later build cites for "what was this built from", which is a question
          // about sources, not about the categories they resolved to. A rule's own
          // `metadata.sourceInfo.category` still wins over the list's declared one — the
          // parser stamps the catalog's answer onto each rule — and a fetch that failed is
          // recorded as attempted rather than dropped, so "nine sources produced this" and
          // "nine were configured" stay two different sentences the manifest can tell apart.
          // Pin what was pulled, not just what was named: a digest over each source's raw
          // rule lines, sorted so a reordered pull is still the same revision. "Which lists"
          // and "which pull of those lists" are different questions, and the manifest should
          // be able to answer both. A failed fetch gets no revision — there is nothing to pin.
          // The sort+join+hash per source is the largest synchronous block left outside the
          // classify worker, so the loop yields every few sources.
          const attributionSources = [];
          for (let i = 0; i < sourceResults.length; i++) {
            if (i !== 0 && i % 4 === 0) await yieldToEventLoop();
            const res = sourceResults[i];
            attributionSources.push({
              name: res.source.name,
              url: res.source.url,
              category: res.source.category ?? '',
              error: res.error,
              revision: res.error
                ? undefined
                : `sha256:${createHash('sha256')
                    .update(
                      (res.rules ?? [])
                        .map((rule) => rule.raw)
                        .filter((raw): raw is string => typeof raw === 'string')
                        .sort()
                        .join('\n'),
                      'utf8',
                    )
                    .digest('hex')}`,
              rules: res.rules ?? [],
            });
          }
          const attribution = buildCategoryAttribution(attributionSources);
          const categoriesDir = join(outputDir, 'categories');
          await fs.mkdir(categoriesDir, { recursive: true });
          // Only categories that actually have hosts get a file, and the manifest names exactly
          // those — so "the manifest promised a file that is not here" stays a real signal rather
          // than the everyday case of a category with nothing blockable in it.
          for (const category of attribution.categories) {
            const hosts = attribution.byCategory.get(category);
            if (!hosts || hosts.size === 0) continue;
            await fs.writeFile(
              join(categoriesDir, `${category}.txt`),
              toCategoryBlocklist(hosts),
              'utf8',
            );
          }
          const manifest = toAttributionManifest(attribution, {
            generatedAt: new Date().toISOString(),
          });
          await fs.writeFile(
            join(categoriesDir, 'manifest.json'),
            `${JSON.stringify(manifest, null, 2)}\n`,
            'utf8',
          );
          console.log(
            `[IPC Main] Category attribution saved: ${manifest.hosts} hosts across ` +
              `${manifest.categories.length} categor${manifest.categories.length === 1 ? 'y' : 'ies'} ` +
              `from ${manifest.sources.length} source${manifest.sources.length === 1 ? '' : 's'} ` +
              `(${manifest.contested} claimed by more than one` +
              `${manifest.empty.length > 0 ? `, ${manifest.empty.length} with nothing blockable: ${manifest.empty.join(', ')}` : ''}` +
              `) -> ${categoriesDir}`,
          );
        } catch (attrErr) {
          console.error('[IPC Main] Failed to write per-category outputs:', attrErr);
        }

        // The embedded classifier's own malware and phishing verdicts.
        //
        // `tier_security` is the one static tier whose contents are not a publisher's claim: a
        // host is in it because the model this extension ships said that host is malware or
        // phishing. That verdict exists only where the classifier has been run over a real list,
        // which is here — so it is written here, beside the lists it is a verdict *about*, and
        // `compile-tier-rulesets.mjs --security` reads it back. Writing it from the same
        // deduplicated array the other outputs come from is what keeps the verdicts and the
        // blocklist they describe from being produced from two different inputs.
        //
        // Measured on the real ~192k-host list a cold pass is ~131s, so it is the slowest
        // part of a compilation and runs in `classifyWorker.cjs` (worker_threads) with an
        // inline fallback; the duration is logged either way. It is still synchronous *within
        // the pipeline*: the file has to exist before `npm run package:extension` compiles the
        // tiers, and a verdict file written after the packaging step read it would be a tier
        // built from last week's model.
        //
        // The pass is incremental via `verdictCache`: a host whose verdict the same classifier
        // already produced is served from `mini-ai-verdicts.json` rather than re-scored, so a
        // recompile over a mostly-unchanged list pays only for what churned. The record's
        // fingerprint covers the model weights, the live vocabulary (a reputation hot patch
        // between runs invalidates on its own) and the user's feedback tunings — a verdict is
        // only reused when the classifier that would answer today is the one that answered then.
        try {
          // The host candidates travel back from the generation worker — the same
          // `extractHostFromRule` walk over the same deduplicated list, run off-thread.
          // `extractHostFromRule` refuses `@@` exceptions, cosmetic filters and scoped
          // rules, so an allow rule can never become a block rule here — the same refusal
          // the tier compiler and the ledger reader rely on.
          const candidateList = outputs.candidates;

          const classifyStartedAt = Date.now();
          const fingerprint = classifierInputFingerprint(globalMiniAiClassifier.exportFeedback(), BM_BUILD_ID);
          const cachePath = join(app.getPath('userData'), 'mini-ai-verdicts.json');
          let priorVerdicts: Record<string, ThreatCategory> = Object.create(null);
          let cacheState: 'empty' | 'stale' | 'current' = 'empty';
          try {
            const parsed = parseVerdictCache(await fs.readFile(cachePath, 'utf8'));
            if (parsed && parsed.fingerprint === fingerprint) {
              priorVerdicts = parsed.verdicts;
              cacheState = 'current';
            } else if (parsed) {
              cacheState = 'stale';
            }
          } catch {
            // No cache file yet (or unreadable): the pass below is a full cold run.
          }

          const verdicts: string[] = [];
          // Only current candidates are written back, so hosts that fell off the list do not
          // accumulate in the file run over run.
          const measured: Record<string, ThreatCategory> = Object.create(null);
          let servedFromCache = 0;
          // The pass is ~130s of synchronous CPU on a cold cache — too long to keep on the
          // event loop even with yields, so the worker bundle does it when it can. The
          // inline path below stays for the case where the worker cannot start.
          const classifyProgress = (done: number) => {
            sendProgress({
              status: `Classifying ${done.toLocaleString()} of ${candidateList.length.toLocaleString()} hosts (mini-AI)...`,
              // The pass maps onto 97–99% so a long cold run reads as movement, not a stall.
              percent: 97 + Math.min(2, Math.floor((done / Math.max(1, candidateList.length)) * 3)),
            });
          };
          let workerResult: ClassifyWorkerResult | null = null;
          try {
            workerResult = await runClassifyWorker(candidateList, priorVerdicts, classifyProgress);
          } catch (workerErr) {
            console.warn(
              '[IPC Main] Classifier worker unavailable, classifying inline:',
              workerErr
            );
          }
          if (workerResult) {
            Object.assign(measured, workerResult.measured);
            servedFromCache = workerResult.servedFromCache;
          } else {
            let classifiedCount = 0;
            for (const host of candidateList) {
              if (++classifiedCount % 250 === 0) await yieldToEventLoop();
              // The inline path is the fallback when the worker cannot start — it must keep
              // reporting progress or a cold compile reads as a hang at a frozen percent.
              if (classifiedCount % 5000 === 0) classifyProgress(classifiedCount);
              // `hasOwn` rather than truthiness: the record is null-prototype and validated on
              // parse, but a key must be present to mean anything — never inherit a lookup.
              const cached = Object.hasOwn(priorVerdicts, host) ? priorVerdicts[host] : undefined;
              const category =
                cached ?? globalMiniAiClassifier.classify(host).category;
              if (cached !== undefined) servedFromCache += 1;
              measured[host] = category;
            }
          }
          for (const host of candidateList) {
            if (measured[host] === 'Malware/Phishing') verdicts.push(host);
          }
          const elapsed = Date.now() - classifyStartedAt;

          // Sorted, so two compilations that reach the same verdicts produce the same bytes and a
          // diff shows a real change rather than a reordering. The header states the provenance,
          // because a tier that ships a model's opinion should say whose opinion it was and when.
          verdicts.sort();
          const malwarePath = join(outputDir, 'malware.txt');
          await fs.writeFile(
            malwarePath,
            [
              '! Title: Mini-AI Malware & Phishing Verdicts',
              '! Description: Hosts the embedded on-device classifier labelled Malware/Phishing.',
              '! Source: model verdict, not a publisher list — see the tier/model agreement suite.',
              `! Generated: ${new Date().toISOString()}`,
              `! Hosts classified: ${candidateList.length.toLocaleString()}`,
              '',
              ...verdicts.map((host) => `||${host}^`),
              '',
            ].join('\n'),
            'utf8',
          );
          console.log(
            `[IPC Main] Malware verdicts saved: ${verdicts.length.toLocaleString()} of ` +
              `${candidateList.length.toLocaleString()} hosts ` +
              `(${servedFromCache.toLocaleString()} served from the ${cacheState} verdict cache, ` +
              `${(candidateList.length - servedFromCache).toLocaleString()} classified ` +
              `in ${(elapsed / 1000).toFixed(1)}s) -> ${malwarePath}`,
          );

          // The write is best-effort and deliberately last: a compilation whose cache cannot be
          // persisted has still produced its verdict file, which is the artifact that matters.
          try {
            await fs.writeFile(cachePath, serializeVerdictCache(fingerprint, measured), 'utf8');
          } catch (cacheErr) {
            console.warn('[IPC Main] Verdict cache could not be written (next compile runs cold):', cacheErr);
          }
        } catch (verdictErr) {
          console.error('[IPC Main] Failed to write malware verdicts:', verdictErr);
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

        // Stamped at completion, not mid-run: the tray's "updated" line should mean a compile
        // finished then, not that one is still in flight beside last run's rule count.
        store.set('lastProcessTime', timestampStr);
        sendProgress({ status: 'Complete!', percent: 100 });
        finishCompile({ success: true, ruleCount: uniqueRuleCount });

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
        finishCompile({ success: false, ruleCount: 0, error: errorMessage });

        return {
          success: false,
          error: errorMessage,
          processedRuleCount: 0,
          uniqueRuleCount: 0,
          timestamp: new Date().toLocaleString(),
        };
      }
    }

    compileInvoker = runImportProcess;

    ipcMain.handle('run-import-process', async (_event: IpcMainInvokeEvent) =>
      runImportProcess(_event.sender)
    );

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
        piholeApiKey: readSecret(store, safeStorage, 'piholeApiKey'),
        adguardHomeUrl: store.get('adguardHomeUrl') || '',
        adguardHomeUser: store.get('adguardHomeUser') || '',
        adguardHomePassword: readSecret(store, safeStorage, 'adguardHomePassword'),
        syncOnCompile: Boolean(store.get('syncOnCompile')),
        adguardMode: (store.get('adguardMode') as 'direct' | 'ha-api' | 'webhook') || 'direct',
        haToken: readSecret(store, safeStorage, 'haToken'),
        haWebhookUrl: store.get('haWebhookUrl') || '',
        customWebhookUrl: store.get('customWebhookUrl') || '',
        adguardDirectPort: normalizeAdguardDirectPort(store.get('adguardDirectPort')),
        adguardDirectUrl: (store.get('adguardDirectUrl') as string) || '',
        allowInsecureLocalTls: Boolean(store.get('allowInsecureLocalTls')),
        // Whether the secrets above are sealed at rest — the Settings card surfaces this so a
        // session without a keychain backend stores weaker *visibly*, not silently.
        encryptionAvailable: secretStorageAvailable(safeStorage),
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
      if (config.piholeApiKey !== undefined) writeSecret(store, safeStorage, 'piholeApiKey', config.piholeApiKey);
      if (config.adguardHomeUrl !== undefined) store.set('adguardHomeUrl', config.adguardHomeUrl);
      if (config.adguardHomeUser !== undefined) store.set('adguardHomeUser', config.adguardHomeUser);
      if (config.adguardHomePassword !== undefined) writeSecret(store, safeStorage, 'adguardHomePassword', config.adguardHomePassword);
      if (config.syncOnCompile !== undefined) store.set('syncOnCompile', Boolean(config.syncOnCompile));
      if (config.adguardMode !== undefined) store.set('adguardMode', config.adguardMode);
      if (config.haToken !== undefined) writeSecret(store, safeStorage, 'haToken', config.haToken);
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

    // --- Unbound Reachability ---
    ipcMain.handle('get-unbound-reachability', async () => {
      return getUnboundReachabilitySnapshot();
    });

    ipcMain.handle('check-unbound-reachability', async () => {
      return await checkUnboundReachability();
    });

    ipcMain.handle('get-unbound-resolvers', async (): Promise<UnboundResolverSettings> => {
      return unboundResolverSettings();
    });

    ipcMain.handle(
      'set-unbound-resolvers',
      async (
        _event: IpcMainInvokeEvent,
        values: { address?: string; referenceAddress?: string },
      ): Promise<{ success: boolean; error?: string }> => {
        const address = typeof values?.address === 'string' ? values.address.trim() : '';
        const referenceAddress =
          typeof values?.referenceAddress === 'string' ? values.referenceAddress.trim() : '';
        // An empty value is allowed and means "fall back to the default", because clearing a wrong
        // address has to be possible without inventing a correct one first.
        if (address) {
          const parsed = parseUnboundResolverAddress(address);
          if (!parsed.ok) return { success: false, error: `Resolver: ${parsed.message}` };
        }
        if (referenceAddress) {
          const parsed = parseUnboundResolverAddress(referenceAddress);
          if (!parsed.ok) return { success: false, error: `Reference: ${parsed.message}` };
        }
        // Refused here rather than only at check time: a reference pointing at the resolver under
        // test is a configuration that can never confirm anything, and saving it silently would
        // leave the user waiting for a confirmation that cannot arrive.
        const primary = resolveUnboundResolver(address);
        if (primary.ok && referenceAddress) {
          const reference = pickReferenceTarget(primary.resolved.target, referenceAddress, []);
          if (!reference.ok) return { success: false, error: reference.message };
        }
        store.set('unboundResolver', address);
        store.set('unboundReferenceResolver', referenceAddress);
        return { success: true };
      },
    );

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

    // Whether a token is configured is returned alongside — the settings card needs to render
    // "required" or "optional" before the user types anything, and a blank read cannot show that.
    ipcMain.handle('get-feed-token', async () => {
      const token = (store.get('feedToken') || '').trim();
      return { configured: token.length > 0, token };
    });

    ipcMain.handle('set-feed-token', async (_event, token: unknown) => {
      try {
        // Unknown types are refused rather than coerced — a silent `String(token)` could store
        // an object the server then compares differently than the user expects.
        if (typeof token !== 'string') return { success: false, error: 'Token must be a string' };
        const val = token.trim();
        if (val.length > 256) return { success: false, error: 'Token exceeds the 256-character limit' };
        store.set('feedToken', val);
        return { success: true };
      } catch (err: any) {
        console.error('Failed to set feed token:', err);
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
          const apiKey = readSecret(store, safeStorage, 'piholeApiKey') || undefined;
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
          try {
            const res = await piholeVersionProbe(urlStr, apiKey, sinkholeFetch, {
              timeoutMs: 6000,
              allowInsecureLocalTls: sinkholeTlsAllowed(store),
            });
            const latencyMs = Date.now() - startTime;
            if (res.ok) {
              return { service: 'pihole', success: true, statusCode: res.status, latencyMs, message: `Connected to Pi-hole ${res.flavor} (${latencyMs}ms, HTTP ${res.status})` };
            } else {
              return { service: 'pihole', success: false, statusCode: res.status, latencyMs, message: `Pi-hole ${res.flavor} check failed${res.status ? ` (HTTP ${res.status})` : ''}${res.detail ? `: ${res.detail}` : ''}` };
            }
          } catch (err: any) {
            return {
              service: 'pihole',
              success: false,
              latencyMs: Date.now() - startTime,
              message: explainSinkholeFailure(store, err, urlStr),
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
          const pass = readSecret(store, safeStorage, 'adguardHomePassword') || undefined;
          const haToken = readSecret(store, safeStorage, 'haToken') || undefined;
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

    /**
     * The extension's static tier capacity plan, computed from the tier rulesets on disk.
     *
     * The hub is where the extension is configured and packaged, and until now the one question
     * that decided what a packaged build shipped — "will these four tiers fit, and which are worth
     * keeping on?" — could only be answered inside a browser, against a live grant the hub cannot
     * see. The arithmetic is `computeTierPlan` in core, the same function the CLI and the popup's
     * planner use, so the three cannot report different plans for the same files; what this
     * handler owns is finding the files and handing over bytes.
     *
     * The rules directory is searched rather than assumed. A packaged hub has the tier files under
     * its resources; a checkout has them beside the extension, and a packaged *extension* is a
     * build artifact this app does not ship. When none is found the handler says so instead of
     * reporting a plan for an empty set, which would look like "everything fits".
     */
    ipcMain.handle(
      'get-extension-tier-plan',
      async (
        _event: IpcMainInvokeEvent,
        request?: { capacity?: number; hitsPath?: string; enabled?: string },
      ) => {
        const rulesDir = findTierRulesDir();
        if (!rulesDir) {
          return {
            ok: false as const,
            error:
              'No tier ruleset directory was found. It sits beside the extension checkout at ' +
              'packages/browser-extension/rules; a packaged hub does not ship one.',
          };
        }

        const files: TierFileInput[] = [];
        for (const tier of STATIC_RULE_TIERS) {
          const file = join(rulesDir, basename(tier.path));
          try {
            files.push({ id: tier.id, rules: JSON.parse(await fs.readFile(file, 'utf8')) });
          } catch (error) {
            files.push({
              id: tier.id,
              rules: null,
              readError: `cannot read ${file}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
        }

        // The ledger is optional and its absence is not an error: with no ledger the plan is
        // ranked by rule count and says so, which is a true statement rather than a missing one.
        // A ledger that *was* chosen and has since moved is a different thing, and says so.
        const wanted = typeof request?.hitsPath === 'string' && request.hitsPath.trim()
          ? request.hitsPath
          : typeof store.get('tierLedgerPath') === 'string' && store.get('tierLedgerPath')
            ? (store.get('tierLedgerPath') as string)
            : null;

        let ledgerText: string | null = null;
        let ledgerMissing: string | null = null;
        if (wanted) {
          try {
            ledgerText = await fs.readFile(wanted, 'utf8');
          } catch (error) {
            ledgerMissing = `${wanted} — ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }

        // The synced list is found rather than chosen: the hub is what writes it, so the file it
        // would be diffed against is already known. Absent one, `computeTierPlan` reports
        // redundancy as unknown rather than as zero, so the card can say which of the two it is.
        const syncedPath = findSyncedListPath();
        let syncedText: string | null = null;
        if (syncedPath) {
          try {
            syncedText = await fs.readFile(syncedPath, 'utf8');
          } catch {
            // A list that vanished between the check and the read is reported as absent.
          }
        }

        const result = computeTierPlan({
          files,
          ledger: ledgerText === null ? null : { text: ledgerText },
          synced: syncedText === null ? null : { text: syncedText },
          enabled: parseEnabledTierIds(
            request?.enabled,
            manifestRuleResources().filter((entry) => entry.enabled).map((entry) => entry.id),
          ),
          capacity: typeof request?.capacity === 'number' ? request.capacity : undefined,
        });

        return {
          ok: true as const,
          rulesDir,
          capacitySlots: result.capacitySlots,
          rows: result.rows,
          broken: result.broken,
          plan: {
            enabled: result.plan.enabled,
            enabledRules: result.plan.enabledRules,
            totalRules: result.plan.totalRules,
            staticHeadroom: result.plan.staticHeadroom,
            bindingConstraint: result.plan.bindingConstraint,
            benefit: result.plan.benefit,
            benefitSource: result.plan.benefitSource,
            explanation: result.plan.explanation,
          },
          basis: result.basis
            ? {
                source: result.basis.source,
                reason: result.basis.reason,
                unmeasured: result.basis.unmeasured,
              }
            : null,
          ledger: result.ledger,
          ledgerPath: wanted,
          ledgerMissing,
          synced: result.synced,
          syncedPath: syncedText === null ? null : syncedPath,
          redundantTiers: result.redundantTiers,
        };
      },
    );

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

    /**
     * Picks the browser's rule-hit ledger, and remembers it.
     *
     * The hub has no ledger of its own: the extension accumulates the measurement and exports it
     * from its popup, so the only place a per-tier block count exists is a file the user chose to
     * keep. Remembering it matters more here than it looks — a plan weighted by measurement and a
     * plan weighted by rule count can disagree completely, so a hub that quietly reverted to rule
     * counts on every launch would be answering a different question each time it was opened.
     *
     * The file is not required. A path that has since moved is reported as gone rather than
     * silently ignored, because "the ledger you picked is missing" and "you have no ledger" lead
     * to different decisions about which one to go and get.
     */
    ipcMain.handle('select-tier-ledger', async () => {
      try {
        const result = await dialog.showOpenDialog({
          title: 'Select the browser rule-hit ledger',
          defaultPath: store.get('tierLedgerPath') || undefined,
          filters: [
            { name: 'Ledger files', extensions: ['txt', 'json'] },
            { name: 'All Files', extensions: ['*'] },
          ],
          properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths?.length) return '';
        const selectedPath = result.filePaths[0];
        store.set('tierLedgerPath', selectedPath);
        return selectedPath;
      } catch (error) {
        console.error('[IPC Main] Error showing ledger dialog:', error);
        return '';
      }
    });

    ipcMain.handle('clear-tier-ledger', async () => {
      store.set('tierLedgerPath', '');
      return '';
    });

    /**
     * Reads the element harvest the browser exported, for the corpus queue.
     *
     * A file the user chose, in the same spirit as the tier ledger: the hub has no element
     * data of its own, so this is a readout rather than a measurement. A path that has
     * since moved reads as `present: false` with the rest still zeroed, because "the
     * harvest you picked is gone" and "you never picked one" call for different actions
     * and the pane has to be able to tell them apart.
     */
    ipcMain.handle('get-element-harvest', async () =>
      summarizeElementHarvest(rememberedElementHarvestPath(store)),
    );

    ipcMain.handle('select-element-harvest', async () => {
      try {
        const result = await dialog.showOpenDialog({
          title: 'Select the exported element harvest',
          defaultPath: store.get('elementHarvestPath') || undefined,
          filters: [
            { name: 'Harvest files', extensions: ['jsonl', 'json', 'txt'] },
            { name: 'All Files', extensions: ['*'] },
          ],
          properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths?.length) return '';
        const selectedPath = result.filePaths[0];
        store.set('elementHarvestPath', selectedPath);
        return selectedPath;
      } catch (error) {
        console.error('[IPC Main] Error showing element harvest dialog:', error);
        return '';
      }
    });

    ipcMain.handle('clear-element-harvest', async () => {
      const chosen = rememberedElementHarvestPath(store);
      clearElementHarvest(chosen);
      store.set('elementHarvestPath', '');
      return '';
    });

    /**
     * Downloads the browser extension package from the GitHub release and unpacks it where the
     * user picks.
     *
     * "Install the extension" from inside the hub can only ever mean "put a loadable copy where
     * the browser can read it" — `Load unpacked` and `about:debugging` want a folder on disk,
     * and no app can click those buttons for the user. The package comes from the release, not
     * a local rebuild: the packaged app does not ship the extension's webpack sources, and a
     * folder built from them would silently be a different generation than the artifact the
     * release published. Chromium lands in `blockingmachine-extension/`, Firefox in
     * `blockingmachine-extension-firefox/`.
     *
     * The release is chosen, not assumed: the tag matching this app's version wins, and when
     * it carries no extension assets (a dev build, or a version whose release is not out yet)
     * the newest release that does carry them is used and named in the result.
     */
    ipcMain.handle('download-extension', async () => {
      const picked = await dialog.showOpenDialog({
        title: 'Choose where to save the extension package',
        defaultPath: app.getPath('downloads'),
        buttonLabel: 'Save here',
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
      });
      if (picked.canceled || !picked.filePaths?.length) return { success: false, cancelled: true };
      const destinationRoot = picked.filePaths[0];

      let release: { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> } | null = null;
      try {
        release = await findExtensionRelease();
      } catch (err) {
        console.error('[IPC Main] GitHub release lookup failed:', err);
        return {
          success: false,
          error: `Could not reach the GitHub releases API: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!release) {
        return {
          success: false,
          error: 'No GitHub release ships a browser extension package for this build.',
        };
      }

      const targets: Array<{ assetName: RegExp; dirName: string }> = [
        { assetName: /^blockingmachine-chrome-mv3-.+\.zip$/, dirName: 'blockingmachine-extension' },
        { assetName: /^blockingmachine-firefox-mv3-.+\.zip$/, dirName: 'blockingmachine-extension-firefox' },
      ];
      const written: Record<string, string> = {};
      const failures: string[] = [];
      for (const target of targets) {
        const asset = (release.assets ?? []).find(
          (a) => typeof a.name === 'string' && target.assetName.test(a.name) && typeof a.browser_download_url === 'string',
        );
        if (!asset?.browser_download_url || !asset.name) continue;
        const destination = join(destinationRoot, target.dirName);
        try {
          const res = await fetch(asset.browser_download_url, {
            headers: { 'User-Agent': 'Blockingmachine-App' },
            redirect: 'follow',
          });
          if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
          const zip = await JSZip.loadAsync(await res.arrayBuffer());
          await fs.rm(destination, { recursive: true, force: true });
          await fs.mkdir(destination, { recursive: true });
          for (const [name, entry] of Object.entries(zip.files)) {
            if (entry.dir) continue;
            const destPath = pathResolve(destination, name);
            if (!destPath.startsWith(destination + sep)) continue; // zip-slip guard
            await fs.mkdir(dirname(destPath), { recursive: true });
            await fs.writeFile(destPath, await entry.async('nodebuffer'));
          }
          written[target.dirName === 'blockingmachine-extension' ? 'path' : 'firefoxPath'] = destination;
          console.log(`[IPC Main] Extension package ${asset.name} unpacked to ${destination}`);
        } catch (err) {
          console.error(`[IPC Main] Failed to fetch extension asset ${asset.name}:`, err);
          failures.push(`${asset.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!written.path && !written.firefoxPath) {
        return {
          success: false,
          error:
            failures.length > 0
              ? `The extension download failed — ${failures.join('; ')}`
              : `Release ${release.tag_name ?? '?'} ships no extension package assets.`,
        };
      }
      return {
        success: true,
        ...written,
        release: release.tag_name,
        error: failures.length > 0 ? `Partial download — ${failures.join('; ')}` : undefined,
      };
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
      // `loadAiConfig` runs the one-time seal of a legacy plaintext key — the same lazy
      // migration `readSecret` gives the flat keys.
      const saved = loadAiConfig(store);
      return {
        provider: saved.provider || 'mini-ai',
        ollamaUrl: saved.ollamaUrl || 'http://127.0.0.1:11434',
        ollamaModel: saved.ollamaModel || 'llama3.2',
        apiKey: saved.apiKey || '',
        apiEndpoint: saved.apiEndpoint || '',
        modelName: saved.modelName || '',
        cascade: saved.cascade || { enabled: false },
        encryptionAvailable: secretStorageAvailable(safeStorage),
      };
    });

    ipcMain.handle('set-ai-config', async (_event, config: Partial<AiProviderConfig>) => {
      try {
        const existing = (store.get('aiConfig') || {}) as Partial<AiProviderConfig>;
        // The sealed form is an output of the seal, never input: a caller-supplied
        // `apiKeyEncrypted` — including an `undefined` carried on a spread config — would
        // overwrite the stored one with a blob this keychain cannot read, or nothing at all.
        // `apiKey` stays: plaintext in, sealed on the way to disk, `undefined` untouched.
        const { apiKeyEncrypted: _callerSealed, ...rest } = (config ?? {}) as Partial<AiProviderConfig>;
        store.set('aiConfig', sealSecretField({ ...existing, ...rest }, safeStorage, 'apiKey'));
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
      const savedConfig = loadAiConfig(store);
      const activeConfig = { ...savedConfig, ...overrideConfig };
      const service = getSharedAiDetectorService(activeConfig);
      return await service.scanDomain(domain, activeConfig);
    });

    ipcMain.handle('ai-scan-querylog', async (_event, options: { service: 'adguard' | 'pihole'; limit?: number }, overrideConfig?: Partial<AiProviderConfig>) => {
      const savedConfig = loadAiConfig(store);
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
        applyAdaptiveCadence(store, recordRadarHeat(store, scan.results.filter((r) => r.verdict !== 'clean')));
        return {
          ...scan,
          notice: loaded.unblockedCount === 0 ? emptyUnblockedNotice(limit) : undefined,
        };
      }

      if (options.service === 'pihole') {
        const baseUrl = store.get('piholeUrl') || 'http://127.0.0.1';
        const token = readSecret(store, safeStorage, 'piholeApiKey');
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
              timestamp: piholeEpochToIso(item?.[0]),
              blocked: false,
            });
          }
        }
        const scan = await service.scanQueryLog(queries, activeConfig);
        applyAdaptiveCadence(store, recordRadarHeat(store, scan.results.filter((r) => r.verdict !== 'clean')));
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
      const savedConfig = loadAiConfig(store);
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
      // Changing the base interval invalidates a previously suggested adaptive
      // value — otherwise a stale adaptiveIntervalMinutes keeps overriding the
      // user's new choice until the next sweep recomputes it.
      if (cfg.intervalMinutes !== undefined && cfg.intervalMinutes !== current.intervalMinutes) {
        delete updated.adaptiveIntervalMinutes;
        // The old rationale no longer describes the (invalidated) suggestion.
        delete updated.cadenceReason;
        delete updated.cadenceUpdatedAt;
      }
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

    // Reset Mini-AI feedback for one domain (or its generalized zone) [Beta]
    ipcMain.handle('reset-mini-ai-feedback', async (_event, domain: string) => {
      if (!domain || typeof domain !== 'string') {
        return { success: false, error: 'Invalid domain parameter' };
      }
      const removed = globalMiniAiClassifier.deleteDomainFeedback(domain);
      if (removed) {
        store.set('miniAiFeedback', globalMiniAiClassifier.exportFeedback());
      }
      return { success: removed };
    });

    // Persistent Radar Heat Map summary [Beta]
    ipcMain.handle('get-radar-heat-summary', async () => {
      return summarizeHeatMap(store.get('radarHeatMap'));
    });

    // Clear persistent heat for a domain (and its zone) after allowlisting [Beta]
    ipcMain.handle('clear-radar-heat-domain', async (_event, domain: string) => {
      if (!domain || typeof domain !== 'string') {
        return { success: false, error: 'Invalid domain parameter' };
      }
      store.set('radarHeatMap', clearHeatForDomain(store.get('radarHeatMap'), domain));
      return { success: true };
    });

    // Ignore an offender: hide from Top Repeat Offenders without trusting it [Beta]
    ipcMain.handle('ignore-radar-heat-domain', async (_event, domain: string) => {
      if (!domain || typeof domain !== 'string') {
        return { success: false, error: 'Invalid domain parameter' };
      }
      store.set('radarHeatMap', ignoreHeatDomain(store.get('radarHeatMap'), domain));
      return { success: true };
    });

    // Restore a previously ignored offender [Beta]
    ipcMain.handle('unignore-radar-heat-domain', async (_event, domain: string) => {
      if (!domain || typeof domain !== 'string') {
        return { success: false, error: 'Invalid domain parameter' };
      }
      store.set('radarHeatMap', unignoreHeatDomain(store.get('radarHeatMap'), domain));
      return { success: true };
    });

    // AI Radar display preferences (power-user browsing aids) [Beta]
    ipcMain.handle('get-radar-display-config', async () => {
      const saved = store.get('radarDisplayConfig');
      return {
        showIgnoredOffenders: Boolean(saved?.showIgnoredOffenders),
      };
    });

    ipcMain.handle('set-radar-display-config', async (_event, config: { showIgnoredOffenders?: boolean }) => {
      if (!config || typeof config !== 'object') {
        return { success: false, error: 'Invalid config parameter' };
      }
      const current = store.get('radarDisplayConfig') || { showIgnoredOffenders: false };
      const next = {
        showIgnoredOffenders: typeof config.showIgnoredOffenders === 'boolean'
          ? config.showIgnoredOffenders
          : Boolean(current.showIgnoredOffenders),
      };
      store.set('radarDisplayConfig', next);
      // Live-update any open Radar view so the change applies instantly.
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('radar-display-config-updated', next);
        }
      } catch {
        // Window may be closing; ignore
      }
      return { success: true };
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
// Stamped by webpack DefinePlugin from `git rev-parse --short HEAD` at build time — the value
// the verdict cache folds into its fingerprint so a new binary is a new cache epoch. 'unstamped'
// is what a dev or test context sees, and it still forms a stable epoch inside that context.
declare const __BM_BUILD_ID__: string;
const BM_BUILD_ID: string = typeof __BM_BUILD_ID__ === 'string' ? __BM_BUILD_ID__ : 'unstamped';

const createWindow = async () => {
  const preloadPath =
    typeof MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY !== 'undefined'
      ? MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY
      : join(__dirname, 'preload.cjs');

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
    await mainWindow.loadURL(`http://localhost:${process.env.FORGE_RENDERER_PORT || 3000}`);
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

    // ─── Reputation DB hot-patch refresh ────────────────────────────────────
    // Pull the latest remote-patch.json so AI classifications pick up pushed
    // list updates (new ad networks, false-positive removals) without waiting
    // for an app release. The cache lives in a writable userData subdir.
    try {
      setDbCacheDirectory(join(app.getPath('userData'), 'reputation-db'));
      void refreshDb().then((res) => {
        console.log(
          `[Reputation DB] ${
            res.remoteLastFetched
              ? `Remote patch applied (fetched ${res.remoteLastFetched})`
              : 'No remote patch available — using bundled lists'
          }`,
        );
      });
      dbRefreshTimer = setInterval(() => {
        void refreshDb().catch(() => {
          // refreshDb never throws; catch defensively anyway
        });
      }, DB_REFRESH_INTERVAL_MS);
      if (typeof dbRefreshTimer.unref === 'function') {
        dbRefreshTimer.unref();
      }
    } catch (err) {
      console.warn('[Reputation DB] Initial refresh failed:', err);
    }

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
      stopUnboundWatch();
      if (liveRadarTimer) {
        clearInterval(liveRadarTimer);
        liveRadarTimer = null;
      }
      if (trayStatusTimer) {
        clearInterval(trayStatusTimer);
        trayStatusTimer = null;
      }
      if (trayManager) {
        try {
          trayManager.destroy();
        } catch {
          // ignore
        }
        trayManager = null;
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
