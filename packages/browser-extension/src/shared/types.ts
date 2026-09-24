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

export interface HomeAssistantConfig {
  enabled: boolean;
  url: string;
  token: string;
  feedUrl: string;
  cosmeticsEnabled: boolean;
  autoSync: boolean;
}

export interface ExtensionMessage {
  type:
    | 'GET_TAB_TELEMETRY'
    | 'SYNC_RULES_NOW'
    | 'TOGGLE_SITE_BLOCKING'
    | 'ADD_CUSTOM_RULE'
    | 'GET_MV3_STATUS'
    | 'START_ELEMENT_PICKER'
    | 'ELEMENT_PICKED'
    | 'GET_HA_CONFIG'
    | 'SET_HA_CONFIG'
    | 'GET_SSE_STATUS'
    | 'REPORT_BROWSER_TELEMETRY'
    | 'TOGGLE_COSMETICS';
  payload?: any;
}
