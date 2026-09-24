import { DnrManager } from './dnrManager.js';
import { SyncClient } from './syncClient.js';
import { TabTelemetry, ExtensionMessage } from '../shared/types.js';

const dnr = new DnrManager();
const sync = new SyncClient();

// Helper to interact with session storage across Service Worker sleeps
async function getTabTelemetry(tabId: number): Promise<TabTelemetry | null> {
  const key = `bm_tab_${tabId}`;
  try {
    if (chrome.storage?.session) {
      const res = await chrome.storage.session.get(key);
      return (res[key] as TabTelemetry) || null;
    } else if (chrome.storage?.local) {
      const res = await chrome.storage.local.get(key);
      return (res[key] as TabTelemetry) || null;
    }
  } catch (err) {
    console.warn('[Storage Error] Failed to read tab telemetry:', err);
  }
  return null;
}

async function setTabTelemetry(tabId: number, data: TabTelemetry): Promise<void> {
  const key = `bm_tab_${tabId}`;
  try {
    if (chrome.storage?.session) {
      await chrome.storage.session.set({ [key]: data });
    } else if (chrome.storage?.local) {
      await chrome.storage.local.set({ [key]: data });
    }
  } catch (err) {
    console.warn('[Storage Error] Failed to write tab telemetry:', err);
  }
}

async function removeTabTelemetry(tabId: number): Promise<void> {
  const key = `bm_tab_${tabId}`;
  try {
    if (chrome.storage?.session) {
      await chrome.storage.session.remove(key);
    } else if (chrome.storage?.local) {
      await chrome.storage.local.remove(key);
    }
  } catch (err) {
    console.warn('[Storage Error] Failed to remove tab telemetry:', err);
  }
}

async function syncAndApplyRules(): Promise<number> {
  try {
    console.log('[Blockingmachine] Fetching latest compiled rules from hub...');
    const rules = await sync.fetchCompiledRules();
    if (rules.length > 0) {
      const count = await dnr.updateDynamicRules(rules);
      console.log(`[Blockingmachine] Successfully applied ${count} dynamic DNR rules.`);
      return count;
    }
  } catch (err) {
    console.warn('[Blockingmachine] Rule synchronization encountered an error:', err);
  }
  return 0;
}

// Lifecycle: Install & update
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Blockingmachine Extension] Installed. Initializing alarm and rules...');
  // Configure alarms for persistent rule updates across service worker sleeps
  chrome.alarms.create('bm-periodic-sync', { periodInMinutes: 60 });
  await syncAndApplyRules();
});

// Periodic alarm trigger
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'bm-periodic-sync') {
    await syncAndApplyRules();
  }
});

// Track network requests and matched DNR rules for in-tab telemetry
if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
    const tabId = info.request.tabId;
    if (tabId < 0) return;

    let host = '';
    try {
      host = new URL(info.request.url).hostname;
    } catch {
      return;
    }

    const current: TabTelemetry = (await getTabTelemetry(tabId)) || {
      tabId,
      url: info.request.url,
      domain: host,
      totalRequests: 0,
      blockedRequests: 0,
      trackers: [],
      scriptletsApplied: ['generic-defusers', 'google-funding-choices']
    };

    current.blockedRequests += 1;
    current.totalRequests += 1;

    const existing = current.trackers.find((t) => t.domain === host);
    if (existing) {
      existing.blockedCount += 1;
    } else {
      current.trackers.push({
        domain: host,
        category: 'tracker',
        entropy: 3.5,
        blockedCount: 1,
        firstParty: false
      });
    }

    await setTabTelemetry(tabId, current);
  });
}

// Clean up closed tabs from persistent session storage
chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabTelemetry(tabId);
});

// Handle messages from popup UI
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'GET_TAB_TELEMETRY') {
    const tabId = message.payload?.tabId;
    if (tabId) {
      getTabTelemetry(tabId).then((data) => {
        sendResponse({ success: true, data });
      });
      return true; // asynchronous response
    }
    sendResponse({ success: false, data: null });
  } else if (message.type === 'SYNC_RULES_NOW') {
    syncAndApplyRules().then((count) => {
      sendResponse({ success: true, count });
    });
    return true; // asynchronous response
  }
});
