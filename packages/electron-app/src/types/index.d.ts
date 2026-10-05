import type { Options } from 'electron-store';
import type { RadarHeatMap } from '../radarHeatMap';
import type { UnboundReachability, UnboundReachabilitySnapshot } from '../unboundReachability';

export interface ElectronStore<T extends Record<string, any>> {
  get<K extends keyof T>(key: K): T[K];
  get<K extends keyof T>(key: K, defaultValue: T[K]): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  store: T;
  path: string;
  clear(): void;
  delete(key: keyof T): void;
  has(key: keyof T): boolean;
  // Add other store methods if needed
}

// Export the Store class type
export type { default as Store } from 'electron-store';

// Re-export types from core
export type {
  RuleType,
  FilterListMetadata,
  StoredRule,
  FilterFormat,
  CompactionResult,
  RuleConflictResult,
  SynthesisTarget,
  TriageOutcomeSummary,
  FalsePositiveGuardResult,
} from '@blockingmachine/core';
export type ThemeType = 'light' | 'dark' | 'system';

// Add ProcessingResult interface
export interface ProcessingResult {
  success: boolean;
  error?: string;
  processedRuleCount: number;
  uniqueRuleCount: number;
  exceptionRuleCount?: number;
  timestamp: string;
}

export interface UpdateInfo {
  version: string;
  status: string;
  info: {
    version: string;
    files: string[];
    path: string;
    sha512: string;
    releaseDate: string;
  };
}

export interface ProcessProgress {
  status: string;
  percent: number;
}

export interface UpdateProgress {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

export type SourceScope = 'dns' | 'browser' | 'hybrid';

export type SourceCategory =
  | 'ads'
  | 'privacy'
  | 'security'
  | 'annoyances'
  | 'social'
  | 'mobile'
  | 'unbreak'
  | 'anti-circumvention'
  | 'custom';

export interface FilterSource {
  name: string;
  url: string;
  enabled: boolean;
  scope?: SourceScope;
  category?: SourceCategory | string;
  description?: string;
  recommendedFor?: string;
}

export interface DomainInspectionResult {
  domain: string;
  inputQuery?: string;
  verdict: 'blocked' | 'exception' | 'not_blocked';
  matchingRule?: string;
  sourceName?: string;
  ruleType?: string;
  details?: string;
}

export interface FeedDiagnostic {
  url: string;
  status: 'ok' | 'error' | 'pending';
  statusCode?: number;
  latencyMs?: number;
  ruleCount?: number;
  error?: string;
}

export interface CompilationSnapshot {
  timestamp: string;
  processedRuleCount: number;
  uniqueRuleCount: number;
  exceptionRuleCount?: number;
  duplicatesRemoved: number;
  exportFormats: FilterFormat[];
}

export interface CompiledRuleItem {
  raw: string;
  type: string;
  domain?: string;
  isException: boolean;
  source?: string;
}

export interface CompiledRulesResponse {
  total: number;
  rules: CompiledRuleItem[];
}

export interface SinkholeConfig {
  piholeUrl: string;
  piholeApiKey: string;
  adguardHomeUrl: string;
  adguardHomeUser: string;
  adguardHomePassword: string;
  syncOnCompile: boolean;
  adguardMode?: 'direct' | 'ha-api' | 'webhook';
  /** AdGuard Home direct API port used when the URL has no explicit port. Default 3000. */
  adguardDirectPort?: number;
  /** AdGuard Home API origin used for Direct mode, query logs, and Radar. Kept separate from the Home Assistant URL. */
  adguardDirectUrl?: string;
  /** Opt in to accepting untrusted TLS certificates for local/private sinkhole hosts only. */
  allowInsecureLocalTls?: boolean;
  haToken?: string;
  haWebhookUrl?: string;
  customWebhookUrl?: string;
  /** `get-sinkhole-config` only: whether safeStorage can seal the secrets at rest. */
  encryptionAvailable?: boolean;
  /** `get-sinkhole-config` only: a secret exists at rest — the value itself never crosses IPC. */
  piholeApiKeyConfigured?: boolean;
  adguardHomePasswordConfigured?: boolean;
  haTokenConfigured?: boolean;
  /** `set-sinkhole-config` only: secret keys the user explicitly cleared (blank field alone is "unchanged"). */
  clearSecrets?: string[];
}

export interface SinkholeSyncResult {
  service: string;
  status: 'success' | 'error' | 'skipped';
  message: string;
  details?: string;
}

export interface FeedServerStatus {
  isRunning: boolean;
  port: number;
  localUrl: string;
  lanUrl?: string;
  lanIp?: string;
  error?: string;
}

export interface SinkholeTestResult {
  service: 'pihole' | 'adguard' | 'webhook';
  success: boolean;
  statusCode?: number;
  latencyMs?: number;
  message: string;
  details?: string;
}

export type AiVerdict = 'ad_server' | 'tracker' | 'malicious' | 'annoyance' | 'clean' | 'suspicious';
export type ThreatCategory = 'Advertising' | 'Telemetry/Analytics' | 'Consent/Annoyance' | 'CNAME Cloaking' | 'Malware/Phishing' | 'Clean' | 'Unknown';
export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'none';
export type AiProviderType = 'mini-ai' | 'local-heuristics' | 'ollama' | 'gemini' | 'openai';

/**
 * Triage cascade settings.
 *
 * When enabled, the embedded classifier screens every candidate and `provider` becomes
 * the *escalation backend* for the ones it cannot decide, rather than the single engine
 * that evaluates everything.
 */
export interface TriageCascadeConfig {
  enabled: boolean;
  /** Model calls allowed per scan. */
  maxEscalations?: number;
  /** Also escalate uncertain *clean* verdicts — discovery mode. */
  escalateClean?: boolean;
}

export interface AiProviderConfig {
  provider: AiProviderType;
  cascade?: TriageCascadeConfig;
  ollamaUrl?: string;
  ollamaModel?: string;
  apiKey?: string;
  /** `safeStorage`-sealed form of `apiKey` — the two never coexist once the seal has run. */
  apiKeyEncrypted?: string;
  apiEndpoint?: string;
  modelName?: string;
  allowlist?: string[];
  bypassCache?: boolean;
  skipDns?: boolean;
  dnsTimeoutMs?: number;
  /** `get-ai-config` only: whether safeStorage can seal `apiKey` at rest. */
  encryptionAvailable?: boolean;
}

export interface DomainLabelEntropy {
  label: string;
  entropy: number;
  isSuspicious: boolean;
}

export interface DomainDecomposition {
  sld: string;
  tld: string;
  subdomains: string[];
  labelEntropies: DomainLabelEntropy[];
}

export interface ThreatQuarantineItem {
  id: string;
  domain: string;
  category: ThreatCategory;
  verdict: AiVerdict;
  riskLevel: RiskLevel;
  confidence: number;
  reasons: string[];
  generatedRules: string[];
  source: 'sinkhole' | 'inspector' | 'crawler' | 'watchdog';
  timestamp: string;
  blocked?: boolean;
}

export interface AiWatchdogConfig {
  enabled: boolean;
  intervalMinutes: number;
  service: 'adguard' | 'pihole';
  lastRun?: string;
  lastThreatsFound?: number;
  /** Adaptive cadence suggested by the radar heat map after the last sweep. */
  adaptiveIntervalMinutes?: number;
  /** Human-readable rationale behind the current adaptive cadence. */
  cadenceReason?: string;
  /** ISO timestamp of when the adaptive cadence was last recomputed. */
  cadenceUpdatedAt?: string;
  autoQuarantineEntropyDga?: boolean;
}

/** Renderer display preferences for the AI Radar (power-user browsing aids). */
export interface RadarDisplayConfig {
  /** Show ignored offenders inline in Top Repeat Offenders instead of the collapsed section. */
  showIgnoredOffenders: boolean;
}

export interface AiScanResult {
  target: string;
  domain: string;
  verdict: AiVerdict;
  confidence: number;
  riskLevel: RiskLevel;
  category: ThreatCategory;
  reasons: string[];
  entropy: number;
  isLikelyDga: boolean;
  decomposition?: DomainDecomposition;
  cnames: string[];
  resolvedIps: string[];
  generatedRules: string[];
  coveredByRule?: string;
  featureScores?: Record<string, number>;
  inferenceTimeMs?: number;
  provider: AiProviderType;
  modelUsed?: string;
  /**
   * Set only when the false-positive guard cleared this target before any screening ran.
   *
   * The guard sits in front of both the cascade and the single-engine paths, so this is present with
   * the cascade on or off — and it is the reason a running scan can contain results that carry no
   * `triage` at all.
   */
  falsePositiveGuard?: FalsePositiveGuardResult;
  /**
   * What the triage cascade did with this candidate, when it was running.
   *
   * Absent on results scanned with the cascade off — which the results list reports as *not
   * screened* rather than as a defaulted score, because "no record" and "decided instantly" are
   * different facts. The engine has always attached this; the app's own declaration omitted it, so
   * nothing could read it.
   */
  triage?: TriageOutcomeSummary;
  timestamp: string;
}

export interface QueryLogScanResult {
  totalQueriesAnalyzed: number;
  flaggedCount: number;
  cleanCount: number;
  results: AiScanResult[];
  timestamp: string;
  notice?: string;
}

export interface LiveRadarSession {
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

export interface LiveRadarStartOptions {
  service: 'adguard' | 'pihole';
  durationMinutes: number; // 0 = continuous until stopped
  pollIntervalSeconds?: number;
}

export interface CrawlScanResult {
  url: string;
  scannedAt: string;
  extractedHosts: string[];
  newUnblockedHosts: string[];
  flaggedHosts: AiScanResult[];
  synthesizedRules: string[];
}

export interface StoreSchema {
  filterSources: FilterSource[];
  customRules: string;
  theme: ThemeType;
  savePath: string;
  /**
   * The browser's rule-hit ledger the extension tier plan is weighted by.
   *
   * The hub accumulates no measurement of its own, so this is the only way its plan can be ranked
   * by what actually blocked rather than by how many rules a tier ships. Remembered deliberately: a
   * plan weighted by measurement and one weighted by rule count can disagree completely, so a hub
   * that reverted to rule counts on each launch would answer a different question every time.
   */
  tierLedgerPath?: string;
  /**
   * The element harvest the browser exported, if the user has pointed the hub at one.
   *
   * Remembered for the same reason the tier ledger is: the queue is built from a file on
   * disk, and a hub that forgot the path each launch would report an empty corpus
   * contribution every time it was opened and quietly stop asking.
   */
  elementHarvestPath?: string;
  exportFormat: FilterFormat;
  additionalFormats?: FilterFormat[];
  autoSchedule?: 'disabled' | '12h' | '24h' | 'weekly';
  webhookUrl?: string;
  lastProcessTime: string;
  compilationHistory?: CompilationSnapshot[];
  piholeUrl?: string;
  piholeApiKey?: string;
  adguardHomeUrl?: string;
  adguardHomeUser?: string;
  adguardHomePassword?: string;
  syncOnCompile?: boolean;
  adguardMode?: 'direct' | 'ha-api' | 'webhook';
  adguardDirectPort?: number;
  adguardDirectUrl?: string;
  allowInsecureLocalTls?: boolean;
  haToken?: string;
  haWebhookUrl?: string;
  customWebhookUrl?: string;
  aiConfig?: Partial<AiProviderConfig>;
  aiThreatQuarantine?: ThreatQuarantineItem[];
  aiWatchdogConfig?: AiWatchdogConfig;
  miniAiFeedback?: Record<string, number>;
  radarHeatMap?: RadarHeatMap;
  radarDisplayConfig?: RadarDisplayConfig;
  autoStartFeedServer?: boolean;
  /**
   * Optional bearer token the feed server requires on its mutation endpoints (`/v1/control/*`,
   * `/v1/compile`, `/v1/telemetry/browser`). Empty means unset, and unset keeps the
   * origin-guard-only trust model the LAN deployment assumes — the token is for a LAN the user
   * does not fully trust, not a requirement the server can assume its clients satisfy.
   */
  feedToken?: string;
  /**
   * What each deploy target's scheduled refresh has reported back, keyed by target id
   * (`unbound`, `bind`, …). The refresh command in the recipe POSTs its result to
   * `/v1/deploy-report`; this record is what survives the window where the hub was closed,
   * so "the 02:00 fetch failed" is a fact on the next launch rather than an absence.
   */
  deployRefreshReports?: Record<string, import('../deployRefresh').DeployRefreshReport>;
  /** `safeStorage`-sealed credentials — the plaintext siblings are deleted when these exist. */
  piholeApiKeyEncrypted?: string;
  adguardHomePasswordEncrypted?: string;
  haTokenEncrypted?: string;
  launchOnStartup?: boolean;
  /** `host`, `host:port`, or a URL for the Unbound instance the reachability check queries. */
  unboundResolver?: string;
  /** A resolver that is *not* the one under test, used to confirm the canary exists upstream. */
  unboundReferenceResolver?: string;
  /** The last reachability result, so the pane can report it without re-querying the resolver. */
  unboundReachability?: UnboundReachabilitySnapshot;
}

export interface UnboundResolverSettings {
  /** What the user typed, verbatim. Empty means the default applies. */
  address: string;
  /** `host:port` the check will query, or null when the address is unusable. */
  effective: string | null;
  error: string | null;
  /** True when nothing is set and the check falls back to the conventional address. */
  isDefault: boolean;
  /** What the user typed into the reference field, verbatim. */
  referenceAddress: string;
  /** `host:port` the existence check will query, or null when there is none. */
  referenceEffective: string | null;
  referenceError: string | null;
  /** Where the reference came from, so the hint can say whose address it is. */
  referenceSource: 'explicit' | 'system' | 'none';
  /** This machine's configured DNS servers, for suggesting what to type. */
  systemServers: string[];
}

export interface DaemonStatusInfo {
  status: 'running' | 'paused' | 'stopped';
  port: number;
  controlPort: number;
  upstream: string;
  rulesLoaded: number;
  protectionEnabled: boolean;
  uptimeSeconds: number;
  managedByApp: boolean;
  stats?: {
    totalQueries: number;
    blockedQueries: number;
    allowedQueries: number;
    blockRatePercent: number;
  };
}

// Electron API interface
export interface ElectronAPI {
  copyToClipboard?: (
    text: string,
  ) =>
    | void
    | { success?: boolean; error?: string }
    | Promise<{ success?: boolean; error?: string }>;
  getTheme: () => Promise<ThemeType>;
  setTheme: (theme: ThemeType) => Promise<{ success: boolean; error?: string }>;
  getSources: () => Promise<FilterSource[]>;
  saveSources: (sources: FilterSource[]) => Promise<{ success: boolean; error?: string }>;
  getFilterSources?: () => Promise<FilterSource[]>;
  setFilterSources?: (sources: FilterSource[]) => Promise<{ success: boolean; error?: string }>;
  setSources?: (sources: FilterSource[]) => Promise<{ success: boolean; error?: string }>;
  getCustomRules: () => Promise<string>;
  setCustomRules: (rules: string) => Promise<{ success: boolean; error?: string }>;
  getExportFormat: () => Promise<FilterFormat>;
  setExportFormat: (format: FilterFormat) => Promise<{ success: boolean; error?: string }>;
  getAdditionalFormats: () => Promise<FilterFormat[]>;
  setAdditionalFormats: (formats: FilterFormat[]) => Promise<{ success: boolean; error?: string }>;
  getAutoSchedule: () => Promise<'disabled' | '12h' | '24h' | 'weekly'>;
  setAutoSchedule: (schedule: 'disabled' | '12h' | '24h' | 'weekly') => Promise<{ success: boolean; error?: string }>;
  getWebhookUrl: () => Promise<string>;
  setWebhookUrl: (url: string) => Promise<{ success: boolean; error?: string }>;
  getCompiledRules: (options?: {
    search?: string;
    limit?: number;
    offset?: number;
    typeFilter?: string;
  }) => Promise<CompiledRulesResponse>;
  getSinkholeConfig: () => Promise<SinkholeConfig>;
  setSinkholeConfig: (config: Partial<SinkholeConfig>) => Promise<{ success: boolean; error?: string }>;
  syncSinkholes: () => Promise<{ results: SinkholeSyncResult[] }>;
  getSavePath: () => Promise<string>;
  /**
   * The extension's static tier capacity plan, computed from the tier rulesets on disk by the
   * same `computeTierPlan` the CLI uses. `capacity` asks "what if the browser granted only this
   * many slots", which is the question the hub can answer and a browser can only report.
   */
  getExtensionTierPlan: (request?: {
    capacity?: number;
    hitsPath?: string;
    enabled?: string;
  }) => Promise<import('../components/ExtensionTierPlanCard.js').TierPlanResponse>;
  /** Picks and remembers the browser's rule-hit ledger for the plan. Empty string when cancelled. */
  selectTierLedger: () => Promise<string>;
  clearTierLedger: () => Promise<string>;
  /** What the chosen element harvest holds, and what queue it would produce. */
  getElementHarvest: () => Promise<import('../elementHarvest.js').ElementHarvestSummary>;
  selectElementHarvest: () => Promise<string>;
  clearElementHarvest: () => Promise<string>;
  /** Downloads the release's extension package and unpacks it where the user picks. */
  downloadExtension?: () => Promise<{
    success: boolean;
    cancelled?: boolean;
    /** The unpacked Chromium package folder, when that asset was written. */
    path?: string;
    /** The unpacked Firefox package folder, when that asset was written. */
    firefoxPath?: string;
    /** The release tag the package came from. */
    release?: string;
    error?: string;
  }>;
  setSavePath: (path: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  selectSavePath: () => Promise<string>;
  runImportProcess: () => Promise<ProcessingResult>;
  getLastProcessTime: () => Promise<string>;
  getCompilationHistory: () => Promise<CompilationSnapshot[]>;
  inspectDomain: (domain: string) => Promise<DomainInspectionResult>;
  testFeedUrl: (url: string) => Promise<FeedDiagnostic>;
  getUnboundReachability?: () => Promise<UnboundReachabilitySnapshot | null>;
  checkUnboundReachability?: () => Promise<UnboundReachability>;
  /**
   * Fired when the scheduled reachability check finishes, with its verdict.
   *
   * Optional like the rest of this surface, and unsubscribable: the pane only listens while it is
   * mounted, and the main process sends whether or not anybody is.
   */
  onUnboundReachabilityUpdated?: (
    callback: (snapshot: UnboundReachabilitySnapshot) => void,
  ) => () => void;
  getUnboundResolvers?: () => Promise<UnboundResolverSettings>;
  setUnboundResolvers?: (values: {
    address?: string;
    referenceAddress?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  startFeedServer: (port?: number) => Promise<FeedServerStatus>;
  stopFeedServer: () => Promise<FeedServerStatus>;
  getFeedServerStatus: () => Promise<FeedServerStatus>;
  testSinkholeConnection: (service: 'pihole' | 'adguard' | 'webhook') => Promise<SinkholeTestResult>;
  getModuleContent?: (moduleName: string) => Promise<string | null>;

  // AI Radar Methods [Beta]
  aiScanDomain?: (domain: string, config?: Partial<AiProviderConfig>) => Promise<AiScanResult>;
  aiScanQueryLog?: (options: { service: 'adguard' | 'pihole'; limit?: number }, config?: Partial<AiProviderConfig>) => Promise<QueryLogScanResult>;
  aiCrawlUrl?: (url: string, config?: Partial<AiProviderConfig>) => Promise<CrawlScanResult>;
  getAiConfig?: () => Promise<AiProviderConfig>;
  setAiConfig?: (config: Partial<AiProviderConfig>) => Promise<{ success: boolean; error?: string }>;
  testAiConnection?: (config: Partial<AiProviderConfig>) => Promise<{ success: boolean; latencyMs?: number; message: string }>;
  addCustomRules?: (rules: string[]) => Promise<{ success: boolean; count: number; error?: string }>;
  getThreatQuarantine?: () => Promise<ThreatQuarantineItem[]>;
  addThreatQuarantine?: (items: ThreatQuarantineItem[]) => Promise<{ success: boolean; count: number }>;
  removeThreatQuarantineItem?: (id: string) => Promise<{ success: boolean }>;
  clearThreatQuarantine?: () => Promise<{ success: boolean }>;
  getAiWatchdogConfig?: () => Promise<AiWatchdogConfig>;
  setAiWatchdogConfig?: (config: Partial<AiWatchdogConfig>) => Promise<{ success: boolean }>;
  addCustomAllowlist?: (domain: string) => Promise<{ success: boolean; rule: string; error?: string }>;
  isDomainCoveredByRules?: (domain: string) => Promise<{ isCovered: boolean; coveringRule?: string }>;
  tuneMiniAiFeedback?: (domain: string, action: 'whitelist' | 'block' | 'reset') => Promise<{ success: boolean }>;
  compactSubdomainRules?: (domains: string[], threshold?: number) => Promise<CompactionResult>;
  checkRuleConflict?: (rule: string) => Promise<RuleConflictResult>;
  getMiniAiFeedbackStats?: () => Promise<{ count: number; feedback: Record<string, number> }>;
  resetMiniAiFeedback?: (domain: string) => Promise<{ success: boolean }>;
  getRadarHeatSummary?: () => Promise<import('./radarHeatMap').HeatSummary>;
  clearRadarHeatDomain?: (domain: string) => Promise<{ success: boolean; error?: string }>;
  ignoreRadarHeatDomain?: (domain: string) => Promise<{ success: boolean; error?: string }>;
  unignoreRadarHeatDomain?: (domain: string) => Promise<{ success: boolean; error?: string }>;
  getRadarDisplayConfig?: () => Promise<RadarDisplayConfig>;
  setRadarDisplayConfig?: (config: Partial<RadarDisplayConfig>) => Promise<{ success: boolean; error?: string }>;
  onRadarDisplayConfigUpdated?: (callback: (config: RadarDisplayConfig) => void) => () => void;
  synthesizeCustomRules?: (input: {
    domain: string;
    verdict: any;
    category: any;
    cnames?: string[];
    isSubdomain?: boolean;
    target?: string;
    includeComments?: boolean;
    confidence?: number;
  }) => Promise<{ success: boolean; rules: string[]; error?: string }>;
  startLiveRadarSession?: (options: LiveRadarStartOptions) => Promise<LiveRadarSession>;
  stopLiveRadarSession?: () => Promise<LiveRadarSession>;
  getLiveRadarSession?: () => Promise<LiveRadarSession>;
  onLiveRadarSessionUpdate?: (callback: (session: LiveRadarSession) => void) => () => void;

  notifyResize: (width: number, height: number) => void;
  openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  /** Tells the main process this renderer's IPC subscriptions are mounted. */
  rendererReady?: () => void;
  showItemInFolder: (path: string) => void;
  onProcessProgress: (callback: (data: ProcessProgress) => void) => () => void;
  removeProcessProgressListener: () => void;
  onUpdateStatus: (callback: (status: string) => void) => () => void;
  onUpdateProgress: (callback: (progress: number) => void) => () => void;
  onUpdateDownloaded: (callback: () => void) => () => void;
  onUpdateAvailable?: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateError?: (callback: (error: Error) => void) => () => void;
  onOpenSettings?: (callback: () => void) => () => void;
  onTriggerCompile?: (callback: () => void) => () => void;
  onNavigateView?: (callback: (view: string) => void) => () => void;
  onLaunchOnboarding?: (callback: () => void) => () => void;
  receive?: (channel: string, func: (...args: any[]) => void) => (() => void) | void;
  removeAllListeners?: (channel: string) => void;
  getAppVersion?: () => Promise<string>;
  getAutoStartFeedServer?: () => Promise<boolean>;
  setAutoStartFeedServer?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  getFeedToken?: () => Promise<{ configured: boolean }>;
  setFeedToken?: (token: string) => Promise<{ success: boolean; unchanged?: boolean; error?: string }>;
  clearFeedToken?: () => Promise<{ success: boolean; error?: string }>;
  getLaunchOnStartup?: () => Promise<boolean>;
  setLaunchOnStartup?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

  // Local System DNS Daemon Integration
  getDaemonStatus?: () => Promise<DaemonStatusInfo>;
  startDaemonProcess?: () => Promise<{ success: boolean; message: string }>;
  stopDaemonProcess?: () => Promise<{ success: boolean; message: string }>;
  reloadDaemonRules?: () => Promise<{ success: boolean; rulesLoaded: number; message: string }>;
  toggleDaemonProtection?: (enabled?: boolean) => Promise<{ success: boolean; protectionEnabled: boolean }>;
  setSystemDns?: (serviceName?: string) => Promise<{ success: boolean; message: string }>;
  restoreSystemDns?: (serviceName?: string) => Promise<{ success: boolean; message: string }>;
  flushDnsCache?: () => Promise<{ success: boolean; message: string }>;
  getServiceInstallScript?: () => Promise<{ mac: string; linux: string }>;
  getNetworkServices?: () => Promise<string[]>;
}

// Global declarations
declare global {
  const __APP_VERSION__: string;
  interface Window {
    electron: ElectronAPI;
  }
}