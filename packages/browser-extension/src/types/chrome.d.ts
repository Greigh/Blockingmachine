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
      domains?: string[];
      excludedDomains?: string[];
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

    export interface MatchedRuleInfo {
      request: {
        requestId: string;
        url: string;
        method: string;
        frameId: number;
        tabId: number;
        type: ResourceType;
        initiator?: string;
      };
      rule: {
        ruleId: number;
        rulesetId: string;
      };
    }

    export function getDynamicRules(): Promise<Rule[]>;
    export function updateDynamicRules(options: UpdateRuleOptions): Promise<void>;

    export interface RuleMatchedDebugEvent {
      addListener(callback: (info: MatchedRuleInfo) => void): void;
    }

    export const onRuleMatchedDebug: RuleMatchedDebugEvent | undefined;
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

    export function query(queryInfo: QueryInfo, callback: (result: Tab[]) => void): Promise<Tab[]>;
    export function create(createProperties: CreateProperties, callback?: (tab: Tab) => void): Promise<Tab>;

    export interface TabRemovedEvent {
      addListener(callback: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void): void;
    }

    export const onRemoved: TabRemovedEvent;
  }

  export namespace runtime {
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
