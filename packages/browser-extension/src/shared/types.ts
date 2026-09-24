export interface TrackerDetection {
  domain: string;
  category: 'advertising' | 'tracker' | 'telemetry' | 'malware' | 'unknown';
  entropy: number;
  blockedCount: number;
  firstParty: boolean;
  cnameCloaked?: boolean;
}

export interface TabTelemetry {
  tabId: number;
  url: string;
  domain: string;
  totalRequests: number;
  blockedRequests: number;
  trackers: TrackerDetection[];
  scriptletsApplied: string[];
}

export interface ExtensionMessage {
  type: 'GET_TAB_TELEMETRY' | 'SYNC_RULES_NOW' | 'TOGGLE_SITE_BLOCKING' | 'ADD_CUSTOM_RULE';
  payload?: any;
}
