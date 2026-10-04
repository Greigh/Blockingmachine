export interface TrackerDetection {
  domain: string;
  category: 'advertising' | 'tracker' | 'telemetry' | 'malware' | 'annoyance' | 'unknown';
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

/**
 * Which compiled list the browser is running on — recorded when a list application succeeds, not
 * recomputed when it is read, so the popup reports the source that was actually installed rather
 * than the source a fresh plan would pick today.
 */
export interface AppliedRuleSource {
  /** `hot` is the measured hot set; `full` is the complete export (possibly pruned). */
  source: 'full' | 'hot';
  /** When that application succeeded. */
  appliedAt: number;
  /** Dynamic rules the browser held after the application. */
  installed: number;
  /** Rules the chosen source offered before the budget was applied. */
  offered: number;
  /** Rules the full export would have pruned when the hot set was chosen over it; 0 otherwise. */
  fullOverflow: number;
  /**
   * The supplied hot set's own standing against the same budget, measured at apply time — absent
   * when no hot set was offered. `absentFromFull` counts hot rules the full list does not carry
   * verbatim: a nonzero value is a stale set, measured against a different or older export.
   * `ownRules` counts rules the deployment's own hit ledger contributed — evidence measured on
   * this browser rather than the repository's scripted sessions.
   */
  hotSet?:
    | {
        offered: number;
        overflow: number;
        absentFromFull: number;
        /** Lines the shipped hot set supplied — the denominator `absentFromFull` is measured over. */
        shipped: number;
        ownRules: number;
      }
    | null;
  /**
   * True when the installed full export was cut by measured tier benefit rather than list
   * order — the no-hot-set fallback, which keeps the hosts the shipped tiers can vouch for.
   */
  tierTrimmed?: boolean;
}

export interface Mv3QuotaInfo {
  dynamicRulesCount: number;
  maxDynamicRules: number;
  isWithinQuota: boolean;
  utilizationPercent: number;
  /** The last recorded list application, or null when none has been recorded yet. */
  ruleSource?: AppliedRuleSource | null;
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

/**
 * Whether the browser is enforcing the site decisions the rest of the view claims —
 * the dynamic-rules half of the question `RulesetDrift` asks of the static tiers.
 *
 * The comparison runs in both directions, because they are different user problems: a pause
 * with no rule behind it is blocking the user thinks they switched off, and a rule with no
 * decision behind it is a pause or an allowance they did not make.
 */
export interface SiteControlDrift {
  /** False when the browser would not answer — the view is then storage's claim, not fact. */
  known: boolean;
  /** True when every saved decision has its rule installed and no rule lacks its decision. */
  inSync: boolean;
  /** Sites paused in storage that have no pause rule installed — pauses that are not pausing. */
  missingPauses: string[];
  /** Domains allowed in storage with no allow rule installed — allowances that are not allowing. */
  missingAllowances: string[];
  /** Saved rules the planner can express but the browser has no rule for. */
  missingRules: string[];
  /** Pause rules installed that no saved pause asks for — sites still being let through. */
  unexpectedPauses: string[];
  /** Allow rules installed that no saved allowance asks for — domains still being let through. */
  unexpectedAllowances: string[];
  /** User-family rules that match no decision shape at all — foreign state, still enforced. */
  unexpectedRules: string[];
  /**
   * While blocking is paused everywhere, the blocklist rules the browser still holds. The pause
   * promises that nothing is blocked, so each of these is blocking the user asked to stop. A
   * count rather than names: the family is the whole compiled list.
   */
  unexpectedBlocking: number;
}

export interface SiteControlView {
  globalPaused: boolean;
  site: string | null;
  sitePaused: boolean;
  pausedSites: string[];
  allowedDomains: string[];
  /**
   * The browser's own answer about the decisions above — absent only from the optimistic
   * fallback view the popup renders before the first response, which has no reading at all.
   */
  drift?: SiteControlDrift;
  /**
   * Why the last `updateDynamicRules` call refused, when it did. The drift says *that* the
   * browser and the saved choices disagree; this says *why* — a quota rejection or a torn-down
   * worker — so the notice can name the cause instead of only the symptom. Absent when the
   * last apply succeeded (or none has run in this worker), so it is always a fresh reading.
   */
  applyError?: string;
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
    | 'RECONCILE_SITE_CONTROL'
    | 'GET_TIER_REDUNDANCY'
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
