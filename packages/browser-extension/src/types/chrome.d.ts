declare namespace chrome {
  export namespace declarativeNetRequest {
    export const MAX_NUMBER_OF_DYNAMIC_AND_MATCHED_RULES: number;

    export enum RuleActionType {
      BLOCK = 'block',
      ALLOW = 'allow',
      UPGRADE_SCHEME = 'upgradeScheme',
      MODIFY_HEADERS = 'modifyHeaders',
      ALLOW_ALL_REQUESTS = 'allowAllRequests'
    }

    export enum ResourceType {
      MAIN_FRAME = 'main_frame',
      SUB_FRAME = 'sub_frame',
      STYLESHEET = 'stylesheet',
      SCRIPT = 'script',
      IMAGE = 'image',
      FONT = 'font',
      OBJECT = 'object',
      XMLHTTPREQUEST = 'xmlhttprequest',
      PING = 'ping',
      CSP_REPORT = 'csp_report',
      MEDIA = 'media',
      WEBSOCKET = 'websocket',
      OTHER = 'other'
    }

    export interface RuleCondition {
      urlFilter?: string;
      regexFilter?: string;
      isUrlFilterCaseSensitive?: boolean;
      /** @deprecated Deprecated alias of `initiatorDomains`; the two cannot both be set. */
      domains?: string[];
      /** @deprecated Deprecated alias of `excludedInitiatorDomains`. */
      excludedDomains?: string[];
      /**
       * The rule only matches requests *initiated* by these domains (or a subdomain of one).
       * Canonical, lower-case ASCII domains; sub-domains are allowed. An empty list is not valid.
       * `excludedInitiatorDomains` takes precedence over this list.
       */
      initiatorDomains?: string[];
      /** Never matches requests initiated by these domains or their sub-domains. */
      excludedInitiatorDomains?: string[];
      resourceTypes?: ResourceType[];
      excludedResourceTypes?: ResourceType[];
    }

    export interface RuleAction {
      type: RuleActionType;
    }

    export interface Rule {
      id: number;
      priority?: number;
      action: RuleAction;
      condition: RuleCondition;
    }

    export interface UpdateRuleOptions {
      removeRuleIds?: number[];
      addRules?: Rule[];
    }

    export interface MatchedRule {
      ruleId: number;
      rulesetId: string;
    }

    export interface RequestDetails {
      requestId: string;
      url: string;
      method: string;
      frameId: number;
      tabId: number;
      type: ResourceType;
      initiator?: string;
    }

    /**
     * A match reported by `getMatchedRules`.
     *
     * Note the deliberate omission: this carries no request URL and no initiator. Chrome only
     * discloses those through the debug-only event below, so a packed build can attribute a match
     * to a rule and a tab but never to the request itself.
     */
    export interface MatchedRuleInfo {
      rule: MatchedRule;
      /** The tab the match came from, or `-1` when that tab is no longer open. */
      tabId: number;
      /** Milliseconds since the epoch. */
      timeStamp: number;
    }

    /** A match reported by `onRuleMatchedDebug`, which unpacked builds alone can observe. */
    export interface MatchedRuleInfoDebug {
      rule: MatchedRule;
      request: RequestDetails;
    }

    export interface MatchedRulesFilter {
      tabId?: number;
      /** Only matches *after* this timestamp; the window itself is capped at five minutes. */
      minTimeStamp?: number;
    }

    export interface RulesMatchedDetails {
      rulesMatchedInfo: MatchedRuleInfo[];
    }

    export function getDynamicRules(): Promise<Rule[]>;
    export function updateDynamicRules(options: UpdateRuleOptions): Promise<void>;

    // ── Static rulesets ──────────────────────────────────────────────────────
    // Rules loaded from the JSON files declared in the manifest's
    // `declarative_net_request.rule_resources`. They cannot be written at runtime,
    // only enabled and disabled as whole rulesets.
    export const MAX_NUMBER_OF_STATIC_RULESETS: number;

    export function getEnabledRulesets(): Promise<string[]>;
    export function updateEnabledRulesets(options: {
      enableRulesetIds?: string[];
      disableRulesetIds?: string[];
    }): Promise<void>;
    /** Static rule slots still available, or `undefined` if the count is unknown. */
    export function getAvailableStaticRuleCount(): Promise<number>;

    export interface RuleMatchedDebugEvent {
      addListener(callback: (info: MatchedRuleInfoDebug) => void): void;
    }

    export const onRuleMatchedDebug: RuleMatchedDebugEvent | undefined;

    /**
     * Rules the browser matched for this extension.
     *
     * Unlike `onRuleMatchedDebug`, this works in a packed build — for a tab the user has granted
     * `activeTab` on, since the `declarativeNetRequestFeedback` permission that also unlocks it is
     * only honoured for unpacked extensions. Rules matched more than five minutes ago, or against
     * a document that is no longer active, are not returned.
     */
    export function getMatchedRules(filter?: MatchedRulesFilter): Promise<RulesMatchedDetails>;

    /** Calls allowed to `getMatchedRules` within `GETMATCHEDRULES_QUOTA_INTERVAL`. */
    export const MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: number;
    /** The `getMatchedRules` quota window, in minutes. */
    export const GETMATCHEDRULES_QUOTA_INTERVAL: number;
  }

  export namespace storage {
    export interface StorageArea {
      get(keys?: string | string[] | Record<string, any> | null): Promise<Record<string, any>>;
      set(items: Record<string, any>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
    }

    export const session: StorageArea | undefined;
    export const local: StorageArea;
    export const sync: StorageArea;
  }

  export namespace alarms {
    export interface Alarm {
      name: string;
      scheduledTime: number;
      periodInMinutes?: number;
    }

    export interface AlarmCreateInfo {
      when?: number;
      delayInMinutes?: number;
      periodInMinutes?: number;
    }

    export function create(name: string, alarmInfo: AlarmCreateInfo): void;

    export interface AlarmEvent {
      addListener(callback: (alarm: Alarm) => void): void;
    }

    export const onAlarm: AlarmEvent;
  }

  export namespace tabs {
    export interface Tab {
      id?: number;
      url?: string;
      title?: string;
      active: boolean;
      windowId: number;
    }

    export interface QueryInfo {
      active?: boolean;
      currentWindow?: boolean;
      url?: string | string[];
    }

    export interface CreateProperties {
      url?: string;
      active?: boolean;
    }

    export function query(queryInfo: QueryInfo, callback?: (result: Tab[]) => void): Promise<Tab[]>;
    export function create(createProperties: CreateProperties, callback?: (tab: Tab) => void): Promise<Tab>;

    export interface TabRemovedEvent {
      addListener(callback: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void): void;
    }

    export const onRemoved: TabRemovedEvent;
  }

  export namespace runtime {
    export const id: string;

    /** Resolves a packaged resource (e.g. a static ruleset file) to an extension URL. */
    export function getURL(path: string): string;

    export interface InstalledDetails {
      reason: 'install' | 'update' | 'chrome_update' | 'shared_module_update';
      previousVersion?: string;
    }

    export interface MessageSender {
      tab?: tabs.Tab;
      frameId?: number;
      id?: string;
      url?: string;
    }

    export interface ExtensionInstalledEvent {
      addListener(callback: (details: InstalledDetails) => void): void;
    }

    export interface ExtensionMessageEvent {
      addListener(
        callback: (
          message: any,
          sender: MessageSender,
          sendResponse: (response?: any) => void
        ) => boolean | void
      ): void;
    }

    export const onInstalled: ExtensionInstalledEvent;
    export const onMessage: ExtensionMessageEvent;
    export function sendMessage(message: any, responseCallback?: (response: any) => void): Promise<any>;
  }
}
