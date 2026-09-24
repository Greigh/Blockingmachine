import { DnrManager } from './dnrManager.js';
import { SyncClient } from './syncClient.js';
import { Mv3Guard } from './mv3Guard.js';
import { TabTelemetry, ExtensionMessage } from '../shared/types.js';

const dnr = new DnrManager();
const sync = new SyncClient();

const MAX_TRACKERS_PER_TAB = 100;

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
    // Memory leak prevention: bound the tracker list size per tab
    if (data.trackers.length > MAX_TRACKERS_PER_TAB) {
      data.trackers.sort((a, b) => b.blockedCount - a.blockedCount);
      data.trackers = data.trackers.slice(0, MAX_TRACKERS_PER_TAB);
    }

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

/**
 * Prunes orphaned session telemetry for tabs that closed while the Service Worker was sleeping.
 */
async function pruneOrphanedTabTelemetry(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    const activeTabIds = new Set(tabs.map((t) => t.id).filter((id): id is number => typeof id === 'number'));

    const storageArea = chrome.storage?.session || chrome.storage?.local;
    if (!storageArea) return;

    const allData = await storageArea.get(null);
    const keysToRemove: string[] = [];

    for (const key of Object.keys(allData)) {
      if (key.startsWith('bm_tab_')) {
        const tabId = parseInt(key.replace('bm_tab_', ''), 10);
        if (!isNaN(tabId) && !activeTabIds.has(tabId)) {
          keysToRemove.push(key);
        }
      }
    }

    if (keysToRemove.length > 0) {
      await storageArea.remove(keysToRemove);
      console.log(`[Blockingmachine] Pruned ${keysToRemove.length} orphaned tab storage entries.`);
    }
  } catch (err) {
    console.warn('[Storage] Prune orphaned tabs error:', err);
  }
}

async function syncAndApplyRules(): Promise<number> {
  try {
    console.log('[Blockingmachine] Fetching latest compiled rules from hub...');
    const rules = await sync.fetchCompiledRules();
    if (rules.length > 0) {
      const count = await dnr.updateDynamicRules(rules);
      console.log(`[Blockingmachine] Successfully applied ${count} dynamic DNR rules.`);
      await pruneOrphanedTabTelemetry();
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
      const parsedUrl = new URL(info.request.url);
      if (!parsedUrl.protocol.startsWith('http')) return;
      host = parsedUrl.hostname;
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

// Handle messages from popup UI with origin security checks
chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  // Security: only accept messages from our own extension contexts (popup / content script)
  if (sender.id !== chrome.runtime.id) {
    return false;
  }

  if (!message || typeof message !== 'object') {
    sendResponse({ success: false, error: 'Invalid message payload' });
    return false;
  }

  if (message.type === 'GET_TAB_TELEMETRY') {
    const tabId = message.payload?.tabId;
    if (typeof tabId === 'number' && tabId > 0) {
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
  } else if (message.type === 'GET_MV3_STATUS') {
    Mv3Guard.getQuotaStatus().then((data) => {
      sendResponse({ success: true, data });
    });
    return true; // asynchronous response
  }
});
