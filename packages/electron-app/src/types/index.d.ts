import type { Options } from 'electron-store';

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

export type AiVerdict = 'ad_server' | 'tracker' | 'malicious' | 'clean' | 'suspicious';
export type ThreatCategory = 'Advertising' | 'Telemetry/Analytics' | 'CNAME Cloaking' | 'Malware/Phishing' | 'Clean' | 'Unknown';
export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'none';
export type AiProviderType = 'mini-ai' | 'local-heuristics' | 'ollama' | 'gemini' | 'openai';

export interface AiProviderConfig {
  provider: AiProviderType;
  ollamaUrl?: string;
  ollamaModel?: string;
  apiKey?: string;
  apiEndpoint?: string;
  modelName?: string;
  allowlist?: string[];
  bypassCache?: boolean;
  skipDns?: boolean;
  dnsTimeoutMs?: number;
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
  autoQuarantineEntropyDga?: boolean;
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
  autoStartFeedServer?: boolean;
  launchOnStartup?: boolean;
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
  copyToClipboard?: (text: string) => void | Promise<{ success?: boolean; error?: string }>;
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
  setSavePath: (path: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  selectSavePath: () => Promise<string>;
  runImportProcess: () => Promise<ProcessingResult>;
  getLastProcessTime: () => Promise<string>;
  getCompilationHistory: () => Promise<CompilationSnapshot[]>;
  inspectDomain: (domain: string) => Promise<DomainInspectionResult>;
  testFeedUrl: (url: string) => Promise<FeedDiagnostic>;
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