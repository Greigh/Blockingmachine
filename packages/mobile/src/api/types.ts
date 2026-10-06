/**
 * Mirrored /v1 payload shapes for the mobile companion.
 *
 * Both the Electron hub's feed server and the HA add-on implement this surface, but
 * they do not agree on every field — the add-on omits `daemonStatus`, answers
 * `/v1/check` with `matchedHost` where the hub answers `coveringRule`, and posts
 * browser telemetry counters with no `recentTrackers`. Fields that only one
 * implementation sends are optional here; fields both send are required.
 */

export interface RulesSummary {
  total: number;
  dns: number;
  browser: number;
  quarantinedThreats: number;
}

export interface ProtectionState {
  enabled: boolean;
  pausedUntil: number | string | null;
  /** Hub only — 'running' | 'stopped' | 'starting' | ... */
  daemonStatus?: string;
}

export interface AiRadarState {
  enabled: boolean;
  /** Hub only. */
  sessionActive?: boolean;
}

export interface BrowserTrackerEntry {
  domain: string;
  count: number;
}

export interface BrowserTelemetryAggregate {
  trackersBlocked: number;
  elementsHidden: number;
  threatsDetected: number;
  /** Hub only. */
  recentTrackers?: BrowserTrackerEntry[];
  /** Hub only. */
  lastUpdated?: string | null;
}

export interface FeedServerInfo {
  port: number;
  /** Hub only — LAN IP the URLs are built from. */
  lanIp?: string;
  /** Add-on only — whether a feed token is configured there. */
  requiresAuth?: boolean;
  dnsFeedUrl?: string;
  browserFeedUrl?: string;
  aiThreatsFeedUrl?: string;
  abpThreatsFeedUrl?: string;
  eventsUrl?: string;
  [extra: string]: unknown;
}

export interface StatusPayload {
  status: string;
  service: string;
  version: string;
  uptimeSeconds: number;
  rules: RulesSummary;
  lastCompile: string | null;
  feedServer?: FeedServerInfo;
  protection: ProtectionState;
  aiRadar?: AiRadarState;
  browserTelemetry?: BrowserTelemetryAggregate;
  /** Hub only. */
  activeSseClients?: number;
  /** Add-on only. */
  compileCount?: number;
  lastCompileMs?: number;
  autoCompile?: boolean;
}

export type ThreatCategory =
  | 'Advertising'
  | 'Telemetry/Analytics'
  | 'Consent/Annoyance'
  | 'CNAME Cloaking'
  | 'Malware/Phishing'
  | 'Clean'
  | 'Unknown'
  | string;

export interface ThreatQuarantineItem {
  id: string;
  domain: string;
  category: ThreatCategory;
  verdict: string;
  riskLevel: string;
  confidence: number;
  reasons: string[];
  generatedRules: string[];
  source: 'sinkhole' | 'inspector' | 'crawler' | 'watchdog' | string;
  timestamp: string;
  blocked?: boolean;
}

export interface CompilationSnapshot {
  timestamp: string;
  processedRuleCount: number;
  uniqueRuleCount: number;
  exceptionRuleCount?: number;
  duplicatesRemoved: number;
  exportFormats?: string[];
}

export interface TelemetryPayload {
  threats: ThreatQuarantineItem[];
  history: CompilationSnapshot[];
  browser?: BrowserTelemetryAggregate;
}

/**
 * Hub shape: { domain, blocked, verdict, coveringRule, timestamp }.
 * Add-on shape: { domain, blocked, matchedHost, source }.
 * `blocked` is the only field both guarantee.
 */
export interface CheckResult {
  domain: string;
  blocked: boolean;
  /** Hub: 'blocked' | 'not_blocked' | … */
  verdict?: string;
  /** Hub: the rule that matched. */
  coveringRule?: string | null;
  /** Add-on: the longest matching host. */
  matchedHost?: string | null;
  /** Add-on: which feed copy answered. */
  source?: string;
  timestamp?: string;
}

/** Hub protection POST: { success, enabled }. Add-on: { success, protection }. */
export interface ProtectionToggleResult {
  success: boolean;
  enabled?: boolean;
  protection?: ProtectionState;
}

export interface CompileResult {
  success: boolean;
  alreadyRunning?: boolean;
  message?: string;
  stats?: { total: number; dns: number; browser: number };
}

export interface ControlResult {
  success: boolean;
  action?: string;
  enabled?: boolean;
  message?: string;
}
