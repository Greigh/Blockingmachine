import { DnrManager } from './dnrManager.js';
import { SyncClient } from './syncClient.js';
import { Mv3Guard } from './mv3Guard.js';
import { LiveListener } from './liveListener.js';
import { HaBridge } from './haBridge.js';
import { TabTelemetry, ExtensionMessage } from '../shared/types.js';
import {
  STORAGE_KEY_COSMETICS,
  STORAGE_KEY_COSMETICS_ENABLED,
  STORAGE_KEY_USER_COSMETICS,
} from '../shared/constants.js';

const dnr = new DnrManager();
const sync = new SyncClient();
const haBridge = new HaBridge();

// In-memory telemetry accumulator for periodic batch reporting
let sessionTrackersBlocked = 0;
let sessionElementsHidden = 0;
let sessionThreatsDetected = 0;
const sessionRecentTrackers: Map<string, number> = new Map();

const liveListener = new LiveListener('http://127.0.0.1:9191/v1/events', {
  onRulesUpdated: async () => {
    console.log('[Blockingmachine Background] Live SSE event received: re-syncing rules now.');
    await syncAndApplyRules();
  },
  onQuarantineAdded: async (threat) => {
    console.log('[Blockingmachine Background] Live quarantine threat added:', threat);
    sessionThreatsDetected += 1;
    if (threat?.domain) {
      try {
        await dnr.updateDynamicRules([`||${threat.domain}^`]);
      } catch (err) {
        console.warn('[Blockingmachine Background] Failed to add quarantine DNR rule:', err);
      }
    }
  },
  onRemoteControl: async (command) => {
    console.log('[Blockingmachine Background] Remote control command:', command);
    if (command.action === 'toggle_cosmetics') {
      const enabled = command.enabled !== false;
      await chrome.storage.local.set({ [STORAGE_KEY_COSMETICS_ENABLED]: enabled });
      // Notify active tabs
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (t.id) {
          chrome.tabs.sendMessage(t.id, { type: 'TOGGLE_COSMETICS', enabled }).catch(() => {});
        }
      }
    } else if (command.action === 'reload_rules') {
      await syncAndApplyRules();
    }
  },
  onStatusChange: (status) => {
    console.log(`[Blockingmachine Background] SSE live listener status: ${status}`);
  },
});

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
    const { networkRules, cosmeticSelectors } = await sync.fetchCompiledRules();
    let count = 0;
    if (networkRules.length > 0) {
      count = await dnr.updateDynamicRules(networkRules);
      console.log(`[Blockingmachine] Successfully applied ${count} dynamic DNR network rules.`);
    }
    if (cosmeticSelectors.length > 0) {
      await chrome.storage.local.set({ [STORAGE_KEY_COSMETICS]: cosmeticSelectors });
      console.log(
        `[Blockingmachine] Stored ${cosmeticSelectors.length} dynamic cosmetic element-hiding selectors.`
      );
    }
    await pruneOrphanedTabTelemetry();
    return count;
  } catch (err) {
    console.warn('[Blockingmachine] Rule synchronization encountered an error:', err);
  }
  return 0;
}

async function flushTelemetryReport(): Promise<void> {
  if (sessionTrackersBlocked === 0 && sessionElementsHidden === 0 && sessionThreatsDetected === 0) {
    return;
  }

  const trackerList: Array<{ domain: string; count: number }> = [];
  sessionRecentTrackers.forEach((count, domain) => {
    trackerList.push({ domain, count });
  });

  const success = await haBridge.reportTelemetry({
    trackersBlocked: sessionTrackersBlocked,
    elementsHidden: sessionElementsHidden,
    threatsDetected: sessionThreatsDetected,
    trackers: trackerList,
  });

  if (success) {
    sessionTrackersBlocked = 0;
    sessionElementsHidden = 0;
    sessionThreatsDetected = 0;
    sessionRecentTrackers.clear();
  }
}

// Lifecycle: Install & update
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Blockingmachine Extension] Installed. Initializing alarms, live listener, and rules...');
  chrome.alarms.create('bm-periodic-sync', { periodInMinutes: 60 });
  chrome.alarms.create('bm-telemetry-push', { periodInMinutes: 2 });
  liveListener.start();
  await syncAndApplyRules();
});

// Periodic alarm triggers
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'bm-periodic-sync') {
    await syncAndApplyRules();
  } else if (alarm.name === 'bm-telemetry-push') {
    await flushTelemetryReport();
  }
});

// Initialize live listener if not already running
liveListener.start();

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

    sessionTrackersBlocked += 1;
    sessionRecentTrackers.set(host, (sessionRecentTrackers.get(host) || 0) + 1);

    const current: TabTelemetry = (await getTabTelemetry(tabId)) || {
      tabId,
      url: info.request.url,
      domain: host,
      totalRequests: 0,
      blockedRequests: 0,
      trackers: [],
      scriptletsApplied: ['generic-defusers', 'google-funding-choices'],
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
        firstParty: false,
      });
    }

    await setTabTelemetry(tabId, current);
  });
}

// Clean up closed tabs from persistent session storage
chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabTelemetry(tabId);
});

// Handle messages from popup UI and content scripts with origin security checks
chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
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
      return true;
    }
    sendResponse({ success: false, data: null });
  } else if (message.type === 'SYNC_RULES_NOW') {
    syncAndApplyRules().then((count) => {
      sendResponse({ success: true, count });
    });
    return true;
  } else if (message.type === 'GET_MV3_STATUS') {
    Mv3Guard.getQuotaStatus().then((data) => {
      sendResponse({ success: true, data });
    });
    return true;
  } else if (message.type === 'START_ELEMENT_PICKER') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab?.id) {
        chrome.tabs.sendMessage(activeTab.id, { type: 'START_ELEMENT_PICKER' }, (res) => {
          sendResponse({ success: !!res?.success });
        });
      } else {
        sendResponse({ success: false, error: 'No active tab' });
      }
    });
    return true;
  } else if (message.type === 'ELEMENT_PICKED') {
    sessionElementsHidden += 1;
    sendResponse({ success: true });
    return false;
  } else if (message.type === 'GET_HA_CONFIG') {
    haBridge.loadConfig().then((cfg) => {
      sendResponse({ success: true, config: cfg });
    });
    return true;
  } else if (message.type === 'SET_HA_CONFIG') {
    haBridge.saveConfig(message.payload || {}).then((cfg) => {
      sendResponse({ success: true, config: cfg });
    });
    return true;
  } else if (message.type === 'GET_SSE_STATUS') {
    sendResponse({
      success: true,
      status: liveListener.getStatus(),
    });
    return false;
  } else if (message.type === 'REPORT_BROWSER_TELEMETRY') {
    flushTelemetryReport().then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
});
