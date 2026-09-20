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
}

export interface SinkholeSyncResult {
  service: string;
  status: 'success' | 'error' | 'skipped';
  message: string;
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
  service: 'pihole' | 'adguard';
  success: boolean;
  statusCode?: number;
  latencyMs?: number;
  message: string;
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
}

// Electron API interface
export interface ElectronAPI {
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
  testSinkholeConnection: (service: 'pihole' | 'adguard') => Promise<SinkholeTestResult>;
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
  receive?: (channel: string, func: (...args: any[]) => void) => void;
  removeAllListeners?: (channel: string) => void;
}

// Global declarations
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}