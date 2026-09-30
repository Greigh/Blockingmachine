export interface TrackerDetection {
  domain: string;
  category: 'advertising' | 'tracker' | 'telemetry' | 'malware' | 'unknown';
  blockedCount: number;
  firstParty: boolean;
  /** DNR rule priority that produced the block, when known. */
  priority?: number;
  /** Whether the matching rule came from a synced blocklist or a user action. */
  source?: 'list' | 'user';
  /** Epoch ms of the most recent block. */
  lastSeen?: number;
  cnameCloaked?: boolean;
}

export interface TabTelemetry {
  tabId: number;
  url: string;
  domain: string;
  /** Requests blocked on this tab. */
  blockedRequests: number;
  /** Distinct third-party domains blocked on this tab. */
  blockedDomains: number;
  /** Cosmetic elements removed by the element picker on this tab. */
  elementsHidden: number;
  trackers: TrackerDetection[];
  scriptletsApplied: string[];
}

export interface HomeAssistantConfig {
  enabled: boolean;
  url: string;
  token: string;
  feedUrl: string;
  cosmeticsEnabled: boolean;
  autoSync: boolean;
}

export interface Mv3QuotaInfo {
  dynamicRulesCount: number;
  maxDynamicRules: number;
  isWithinQuota: boolean;
  utilizationPercent: number;
}

/** Everything the popup needs to render its header and diagnostics card. */
export interface ExtensionStatus {
  sseStatus: 'connected' | 'connecting' | 'disconnected';
  mv3: Mv3QuotaInfo | null;
  globalPaused: boolean;
  pausedSites: number;
  allowedDomains: number;
  /** Static (manifest-declared) ruleset tiers, which do not consume the dynamic quota. */
  staticRules?: {
    enabledTiers: number;
    totalTiers: number;
    enabledRules: number;
    totalRules: number;
  };
}

export interface SiteControlView {
  globalPaused: boolean;
  site: string | null;
  sitePaused: boolean;
  pausedSites: string[];
  allowedDomains: string[];
}

export interface TelemetryReport {
  trackersBlocked: number;
  elementsHidden: number;
  threatsDetected: number;
  trackers?: Array<{ domain: string; count: number }>;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface ExtensionMessage {
  type:
    | 'GET_TAB_TELEMETRY'
    | 'SYNC_RULES_NOW'
    | 'TOGGLE_SITE_BLOCKING'
    | 'SET_GLOBAL_PAUSE'
    | 'SET_DOMAIN_ALLOWED'
    | 'ADD_CUSTOM_RULE'
    | 'GET_SITE_CONTROL'
    | 'GET_EXTENSION_STATUS'
    | 'GET_MV3_STATUS'
    // ── Block-ledger source + `getMatchedRules` quota ──
    | 'GET_LEDGER_STATUS'
    // ── Static DNR ruleset tiers ──
    | 'GET_RULESET_TIERS'
    | 'SET_RULESET_TIER'
    | 'SET_RULESET_TIERS'
    | 'RECONCILE_RULESET_TIERS'
    // ── Rule hit ledger (coverage measurement) ──
    | 'GET_RULE_HIT_STATS'
    | 'RESET_RULE_HIT_STATS'
    // ── Browser-reported hit ledger (dated sessions for the hot set) ──
    | 'EXPORT_HIT_LEDGER'
    | 'GET_HA_CONFIG'
    | 'SET_HA_CONFIG'
    | 'TEST_HA_CONNECTION'
    | 'GET_SSE_STATUS'
    | 'REPORT_BROWSER_TELEMETRY'
    | 'TOGGLE_COSMETICS'
    // ── In-page actions (background → content script) ──
    | 'START_ELEMENT_PICKER'
    | 'STOP_ELEMENT_PICKER'
    | 'ELEMENT_PICKED'
    | 'REMOVE_USER_COSMETIC'
    | 'BLOCK_CONTEXT_TARGET'
    | 'BLOCK_SIMILAR_CONTEXT_TARGET'
    | 'BLOCK_SELECTOR'
    | 'COPY_CONTEXT_SELECTOR'
    | 'COPY_FROM_PAGE'
    | 'SHOW_PAGE_TOAST'
    // ── Element Mini-AI (popup/background → content script) ──
    | 'SCAN_PAGE_FOR_ADS'
    | 'HIGHLIGHT_AI_CANDIDATES'
    | 'BLOCK_AI_CANDIDATES'
    | 'ELEMENT_AI_FEEDBACK'
    | 'ELEMENT_AI_VERDICT'
    // ── Corpus harvest (content → background, and the export the hub reads) ──
    | 'HARVEST_ELEMENTS'
    | 'EXPORT_ELEMENT_HARVEST'
    | 'PING';
  payload?: any;
}

/** What one cluster of AI-detected elements looks like on the wire. */
export interface ElementAiGroupSummary {
  key: string;
  selector: string;
  matches: number;
  elementClass: 'Ad' | 'Tracker' | 'Annoyance' | 'Content';
  count: number;
  confidence: number;
  label: string;
  reason: string;
}

/** Result of a page-wide element-AI scan, as returned to the popup. */
export interface ElementAiScanSummaryResult {
  scanned: number;
  hideCount: number;
  suggestCount: number;
  groups: ElementAiGroupSummary[];
}
