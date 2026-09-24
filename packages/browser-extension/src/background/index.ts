import { DnrManager } from './dnrManager';
import { SyncClient } from './syncClient';
import { TabTelemetry, ExtensionMessage } from '../shared/types';

const dnr = new DnrManager();
const sync = new SyncClient();

const tabTelemetryMap = new Map<number, TabTelemetry>();

// Initialize extension rules on launch
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Blockingmachine Extension] Installed. Fetching initial rules...');
  const rules = await sync.fetchCompiledRules();
  if (rules.length > 0) {
    const count = await dnr.updateDynamicRules(rules);
    console.log(`[Blockingmachine Extension] Loaded ${count} DNR rules.`);
  }
});

// Track network requests and matched DNR rules for in-tab telemetry
if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const tabId = info.request.tabId;
    if (tabId < 0) return;

    const current = tabTelemetryMap.get(tabId) || {
      tabId,
      url: info.request.url,
      domain: new URL(info.request.url).hostname,
      totalRequests: 0,
      blockedRequests: 0,
      trackers: [],
      scriptletsApplied: []
    };

    current.blockedRequests += 1;
    current.totalRequests += 1;

    try {
      const blockedHost = new URL(info.request.url).hostname;
      const existing = current.trackers.find((t) => t.domain === blockedHost);
      if (existing) {
        existing.blockedCount += 1;
      } else {
        current.trackers.push({
          domain: blockedHost,
          category: 'tracker',
          entropy: 3.5,
          blockedCount: 1,
          firstParty: false
        });
      }
    } catch {
      // Ignore URL parsing errors
    }

    tabTelemetryMap.set(tabId, current);
  });
}

// Clean up closed tabs
chrome.tabs.onRemoved.addListener((tabId) => {
  tabTelemetryMap.delete(tabId);
});

// Handle messages from popup UI
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'GET_TAB_TELEMETRY') {
    const tabId = message.payload?.tabId;
    const data = tabId ? tabTelemetryMap.get(tabId) : null;
    sendResponse({ success: true, data });
  } else if (message.type === 'SYNC_RULES_NOW') {
    sync.fetchCompiledRules().then((rules) => {
      dnr.updateDynamicRules(rules).then((count) => {
        sendResponse({ success: true, count });
      });
    });
    return true; // asynchronous response
  }
});
