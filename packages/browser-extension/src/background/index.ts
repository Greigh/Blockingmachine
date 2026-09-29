import { DnrManager } from './dnrManager.js';
import { RulesetManager } from './rulesetManager.js';
import { RuleHitStats } from './ruleHitStats.js';
import { LedgerSessionRecorder } from './ledgerSession.js';
import { StaticRuleIndex } from './staticRuleIndex.js';
import { SyncClient } from './syncClient.js';
import { Mv3Guard } from './mv3Guard.js';
import { LiveListener } from './liveListener.js';
import {
  DEFAULT_MATCHED_RULES_BUDGET,
  canRequestMatchedRules,
  hostFromFilter,
  matchedRulesQuotaView,
  readMatchedRuleRecords,
  summarizeMatches,
} from './matchedRules.js';
import { HaBridge } from './haBridge.js';
import {
  MENU_ITEMS,
  cleanUrlFor,
  describeElementVerdict,
  describeTabActivity,
  registrableDomainOf,
  resolveMenuClick,
  scopeForAction,
  urlFilterFor,
} from './contextMenu.js';
import type {
  ExtensionMessage,
  ExtensionStatus,
  SiteControlView,
  TabTelemetry,
  TrackerDetection,
} from '../shared/types.js';
import { STATIC_RULE_TIERS, type StaticTierId } from '../shared/rulesetTiers.js';
import {
  ledgerFeedForSession,
  ledgerFeedFromAvailability,
  type LedgerStatus,
} from '../shared/ledgerStatus.js';
import { tierFromRulesetId } from '../shared/tierAttribution.js';
import {
  DEFAULT_HUB_PORT,
  STORAGE_KEY_COSMETICS,
  STORAGE_KEY_COSMETICS_ENABLED,
  STORAGE_KEY_CUSTOM_RULES,
  STORAGE_KEY_SITE_CONTROL,
  STORAGE_KEY_USER_COSMETICS,
} from '../shared/constants.js';
import {
  EMPTY_SITE_CONTROL,
  blockRuleFor,
  isDomainAllowed,
  isSitePaused,
  normalizeSite,
  normalizeSiteControl,
  setDomainAllowed,
  setGlobalPaused,
  setSitePaused,
  siteFromUrl,
  badgeTextFor,
  type SiteControlState,
} from '../shared/siteControl.js';

const dnr = new DnrManager();
const rulesets = new RulesetManager();
const ruleHits = new RuleHitStats();
const ledger = new LedgerSessionRecorder();
const sync = new SyncClient();
const haBridge = new HaBridge();

// ─── Site control state ───────────────────────────────────────────────────────

let siteControl: SiteControlState = { ...EMPTY_SITE_CONTROL };

async function loadSiteControl(): Promise<SiteControlState> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_SITE_CONTROL);
    siteControl = normalizeSiteControl(stored[STORAGE_KEY_SITE_CONTROL]);
  } catch (err) {
    console.warn('[Blockingmachine] Could not load site control state:', err);
    siteControl = { ...EMPTY_SITE_CONTROL };
  }
  return siteControl;
}

async function saveSiteControl(next: SiteControlState): Promise<SiteControlState> {
  siteControl = next;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_SITE_CONTROL]: siteControl });
  } catch (err) {
    console.warn('[Blockingmachine] Could not persist site control state:', err);
  }
  return siteControl;
}

/**
 * Reads the persisted state, applies a change, and writes it back. The read is
 * deliberate: a service worker can be woken by a single message with no state
 * in memory, and mutating a stale default would silently drop prior decisions.
 */
async function mutateSiteControl(
  change: (current: SiteControlState) => SiteControlState,
): Promise<SiteControlState> {
  const current = await loadSiteControl();
  return saveSiteControl(change(current));
}

async function loadCustomRules(): Promise<string[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_CUSTOM_RULES);
    const rules = stored[STORAGE_KEY_CUSTOM_RULES];
    if (!Array.isArray(rules)) return [];
    return rules.filter((rule): rule is string => typeof rule === 'string' && rule.trim().length > 0);
  } catch {
    return [];
  }
}

async function saveCustomRules(rules: string[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_CUSTOM_RULES]: rules });
  } catch (err) {
    console.warn('[Blockingmachine] Could not persist custom rules:', err);
  }
}

function siteControlView(url?: string): SiteControlView {
  const site = siteFromUrl(url);
  return {
    globalPaused: siteControl.globalPaused,
    site,
    sitePaused: site ? siteControl.pausedSites.some((s) => s === site || site.endsWith(`.${s}`)) : false,
    pausedSites: [...siteControl.pausedSites],
    allowedDomains: [...siteControl.allowedDomains],
  };
}

// ─── In-memory telemetry accumulator for periodic batch reporting ─────────────

let sessionTrackersBlocked = 0;
let sessionElementsHidden = 0;
let sessionThreatsDetected = 0;
const sessionRecentTrackers: Map<string, number> = new Map();

/** Most recent blocklist lines, kept so site toggles can re-apply without a fetch. */
let lastSyncedNetworkRules: string[] = [];
let lastAppliedRuleCount = 0;
let lastSyncAt: number | null = null;

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
        await appendCustomRule(`||${threat.domain}^`);
      } catch (err) {
        console.warn('[Blockingmachine Background] Failed to add quarantine rule:', err);
      }
    }
  },
  onRemoteControl: async (command) => {
    console.log('[Blockingmachine Background] Remote control command:', command);
    if (command.action === 'toggle_cosmetics') {
      const enabled = command.enabled !== false;
      await chrome.storage.local.set({ [STORAGE_KEY_COSMETICS_ENABLED]: enabled });
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (t.id) {
          chrome.tabs.sendMessage(t.id, { type: 'TOGGLE_COSMETICS', enabled }).catch(() => {});
        }
      }
    } else if (command.action === 'reload_rules') {
      await syncAndApplyRules();
    } else if (command.action === 'set_global_pause') {
      await saveSiteControl(setGlobalPaused(siteControl, command.paused !== false));
      await applyCurrentRules();
    }
  },
  onStatusChange: (status) => {
    console.log(`[Blockingmachine Background] SSE live listener status: ${status}`);
  },
});

// ─── Per-tab telemetry ────────────────────────────────────────────────────────

const MAX_TRACKERS_PER_TAB = 100;

function emptyTabTelemetry(tabId: number, url: string, domain: string): TabTelemetry {
  return {
    tabId,
    url,
    domain,
    blockedRequests: 0,
    blockedDomains: 0,
    elementsHidden: 0,
    trackers: [],
    scriptletsApplied: ['generic-defusers', 'google-funding-choices'],
  };
}

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
    data.blockedDomains = data.trackers.length;

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

/** Keeps the toolbar badge in sync with what was blocked on a tab. */
async function updateBadge(tabId: number, blockedRequests: number): Promise<void> {
  try {
    if (!chrome.action?.setBadgeText) return;
    await chrome.action.setBadgeText({ tabId, text: badgeTextFor(blockedRequests) });
    if (chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#06b6d4' });
    }
  } catch {
    // Badge updates are cosmetic; never let them break request accounting.
  }
}

// ─── Rule application ─────────────────────────────────────────────────────────

/**
 * Applies the last fetched blocklist plus the user's custom rules and site
 * decisions. Used after any local change so toggling a site never needs a fetch.
 */
async function applyCurrentRules(): Promise<number> {
  try {
    // Reconciling the static tiers belongs here, on every rule application, not only on a package
    // update: the global pause clears the dynamic rules, so a paused extension has to silence the
    // shipped tiers in the same breath or it keeps blocking from the tier files. The same call
    // also re-asserts the saved selection against the browser's own ruleset state while not
    // paused, which is what repairs an update that reset those rulesets to the manifest defaults.
    await rulesets.setSuspended(siteControl.globalPaused);
    const customRules = await loadCustomRules();
    lastAppliedRuleCount = await dnr.updateDynamicRules(
      [...customRules, ...lastSyncedNetworkRules],
      siteControl,
    );
    return lastAppliedRuleCount;
  } catch (err) {
    console.warn('[Blockingmachine] Failed to apply dynamic rules:', err);
    return 0;
  }
}

async function syncAndApplyRules(): Promise<number> {
  try {
    console.log('[Blockingmachine] Fetching latest compiled rules from hub...');
    const { networkRules, cosmeticSelectors } = await sync.fetchCompiledRules();
    if (networkRules.length > 0) {
      lastSyncedNetworkRules = networkRules;
    }
    if (cosmeticSelectors.length > 0) {
      await chrome.storage.local.set({ [STORAGE_KEY_COSMETICS]: cosmeticSelectors });
      console.log(
        `[Blockingmachine] Stored ${cosmeticSelectors.length} dynamic cosmetic element-hiding selectors.`
      );
    }
    lastSyncAt = Date.now();
    const count = await applyCurrentRules();
    console.log(`[Blockingmachine] Successfully applied ${count} dynamic DNR network rules.`);
    await pruneOrphanedTabTelemetry();
    return count;
  } catch (err) {
    console.warn('[Blockingmachine] Rule synchronization encountered an error:', err);
  }
  return 0;
}

/** Adds a user rule (idempotently) and re-applies the rule set. */
async function appendCustomRule(rule: string): Promise<boolean> {
  const trimmed = rule.trim();
  if (!trimmed) return false;
  const existing = await loadCustomRules();
  if (existing.includes(trimmed)) return false;
  await saveCustomRules([...existing, trimmed].slice(-500));
  await applyCurrentRules();
  return true;
}

/**
 * Maps a matched rule back to the filter line that produced it.
 *
 * Dynamic rules are resolved from the live rule list. Static tier rules come from the shipped
 * ruleset files, indexed lazily and once per worker lifetime — without this the counts would be
 * keyed by an opaque `ruleset#id` pair that cannot be compared with the compiled list.
 */
const staticRuleIndex = new StaticRuleIndex({
  tiers: STATIC_RULE_TIERS,
  readTier: async (path) => {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
});

async function flushTelemetryReport(): Promise<void> {
  await ruleHits.flush();
  // The hit ledger is persisted on the same beat, so a torn-down worker resumes the day it was
  // browsing rather than starting a fresh session for the same date.
  await ledger.flush();
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

// ─── Right-click menu ─────────────────────────────────────────────────────────

/** Sends a message to one frame and resolves with its response. */
async function frameMessage(tabId: number, frameId: number, message: Record<string, unknown>): Promise<any> {
  try {
    return await chrome.tabs.sendMessage(tabId, message as any, { frameId });
  } catch {
    // The frame may have navigated away, or have no content script (e.g. a
    // restricted page). Callers treat a missing response as a failed action.
    return undefined;
  }
}

async function toastInTab(
  tabId: number,
  frameId: number,
  message: string,
  tone: 'info' | 'success' | 'warn' = 'info',
): Promise<void> {
  await frameMessage(tabId, frameId, { type: 'SHOW_PAGE_TOAST', payload: { message, tone } });
}

/** Rebuilds the menu tree. Safe to call repeatedly; used on install and wake. */
function setupContextMenus(): void {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create(
        {
          id: item.id,
          title: item.title,
          contexts: item.contexts,
          parentId: item.parentId,
        } as unknown as chrome.contextMenus.CreateProperties,
        () => void chrome.runtime.lastError,
      );
    }
  });
}

/**
 * Rewrites the labels for the element that was actually right-clicked, so the
 * menu names the domain it is about to block instead of describing it in the
 * abstract.
 */
function describeMenuFor(info: chrome.contextMenus.OnClickData): void {
  if (!chrome.contextMenus) return;

  const pageDomain = registrableDomainOf(info.pageUrl || info.frameUrl);
  const linkedDomain = registrableDomainOf(info.linkUrl || info.srcUrl);

  const update = (id: string, title: string, visible = true): void => {
    chrome.contextMenus.update(id, { title, visible }, () => void chrome.runtime.lastError);
  };

  update('block_domain', pageDomain ? `Block ${pageDomain} everywhere` : 'Block this domain everywhere');
  if (linkedDomain) {
    update('block_link_domain', `Block ${linkedDomain}`);
    update('allow_domain', `Allow ${linkedDomain}`);
    update('block_url', 'Block this exact URL');
  }
  update('toggle_pause', siteControl.globalPaused ? 'Resume everywhere' : 'Pause everywhere');
  update('copy_rule', pageDomain ? `Blocking rule \`||${pageDomain}^\`` : 'Blocking rule for this domain');
}

async function handleMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  const tabId = tab?.id;
  const frameId = typeof info.frameId === 'number' ? info.frameId : 0;
  const resolved = resolveMenuClick({
    menuItemId: info.menuItemId as string,
    pageUrl: info.pageUrl,
    frameUrl: info.frameUrl,
    linkUrl: info.linkUrl,
    srcUrl: info.srcUrl,
    selectionText: info.selectionText,
  });
  const { action, domain, url } = resolved;

  if (action === 'none') return;
  if (scopeForAction(action) === 'frame' && typeof tabId !== 'number') return;

  switch (action) {
    case 'pick_element':
      await frameMessage(tabId as number, frameId, { type: 'START_ELEMENT_PICKER' });
      return;

    case 'block_element': {
      const res = await frameMessage(tabId as number, frameId, { type: 'BLOCK_CONTEXT_TARGET' });
      if (!res?.success) {
        await toastInTab(
          tabId as number,
          frameId,
          res?.error === 'The right-clicked element is no longer available.'
            ? 'That element is gone — use “Pick a different element”.'
            : 'Could not build a safe selector for that element.',
          'warn',
        );
      }
      return;
    }

    case 'block_similar': {
      const res = await frameMessage(tabId as number, frameId, { type: 'BLOCK_SIMILAR_CONTEXT_TARGET' });
      if (!res?.success) {
        await toastInTab(tabId as number, frameId, 'No “similar elements” rule could be built here.', 'warn');
      }
      return;
    }

    // ── Element AI ─────────────────────────────────────────────────────────────

    case 'ai_verdict': {
      const res = await frameMessage(tabId as number, frameId, { type: 'ELEMENT_AI_VERDICT' });
      await toastInTab(tabId as number, frameId, describeElementVerdict(res?.verdict ?? null), 'info');
      return;
    }

    case 'ai_highlight': {
      const res = await frameMessage(tabId as number, frameId, { type: 'HIGHLIGHT_AI_CANDIDATES' });
      if (!res?.success) await toastInTab(tabId as number, frameId, 'The element AI could not scan this page.', 'warn');
      return;
    }

    case 'ai_block_all': {
      const res = await frameMessage(tabId as number, frameId, { type: 'BLOCK_AI_CANDIDATES' });
      if (!res?.success || !res?.blocked) {
        await toastInTab(tabId as number, frameId, 'Nothing on this page needed hiding.', 'info');
      }
      return;
    }

    case 'ai_mark_ad': {
      const res = await frameMessage(tabId as number, frameId, {
        type: 'ELEMENT_AI_FEEDBACK',
        payload: { action: 'hide' },
      });
      await toastInTab(
        tabId as number,
        frameId,
        res?.success
          ? 'Learned: this kind of element is now hidden on every site.'
          : 'Could not record that decision.',
        res?.success ? 'success' : 'warn',
      );
      return;
    }

    case 'ai_mark_content': {
      const res = await frameMessage(tabId as number, frameId, {
        type: 'ELEMENT_AI_FEEDBACK',
        payload: { action: 'keep' },
      });
      await toastInTab(
        tabId as number,
        frameId,
        res?.success
          ? 'Learned: this kind of element is always left visible.'
          : 'Could not record that decision.',
        res?.success ? 'success' : 'warn',
      );
      return;
    }

    case 'copy_selector': {
      const res = await frameMessage(tabId as number, frameId, { type: 'COPY_CONTEXT_SELECTOR' });
      if (!res?.success) {
        await toastInTab(
          tabId as number,
          frameId,
          res?.error ?? 'Could not read a selector for that element.',
          'warn',
        );
      }
      return;
    }

    case 'block_domain': {
      const rule = blockRuleFor(domain);
      if (!rule) {
        await toastInTab(tabId as number, frameId, 'No domain to block here.', 'warn');
        return;
      }
      await appendCustomRule(rule);
      await toastInTab(tabId as number, frameId, `Blocked ${domain} everywhere.`, 'success');
      return;
    }

    case 'block_link_domain': {
      const rule = blockRuleFor(domain);
      if (!rule) {
        await toastInTab(tabId as number, frameId, 'That element has no linked address.', 'warn');
        return;
      }
      await appendCustomRule(rule);
      await toastInTab(tabId as number, frameId, `Blocked ${domain}.`, 'success');
      return;
    }

    case 'block_url': {
      const filter = urlFilterFor(url);
      if (!filter) {
        await toastInTab(tabId as number, frameId, 'That element has no blockable URL.', 'warn');
        return;
      }
      await appendCustomRule(filter);
      await toastInTab(tabId as number, frameId, 'Blocked that exact URL.', 'success');
      return;
    }

    case 'allow_domain': {
      if (!domain) {
        await toastInTab(tabId as number, frameId, 'That element has no linked domain.', 'warn');
        return;
      }
      await mutateSiteControl((current) => setDomainAllowed(current, domain, true));
      await applyCurrentRules();
      await toastInTab(tabId as number, frameId, `${domain} is now allowed everywhere.`, 'success');
      return;
    }

    case 'allow_site':
    case 'resume_site': {
      const site = siteFromUrl(url);
      if (!site) return;
      const paused = action === 'allow_site';
      await mutateSiteControl((current) => setSitePaused(current, site, paused));
      await applyCurrentRules();
      await toastInTab(
        tabId as number,
        frameId,
        paused ? `Blocking paused on ${site}.` : `Blocking resumed on ${site}.`,
        paused ? 'warn' : 'success',
      );
      return;
    }

    case 'toggle_pause': {
      const paused = !siteControl.globalPaused;
      await mutateSiteControl((current) => setGlobalPaused(current, paused));
      await applyCurrentRules();
      await toastInTab(
        tabId as number,
        frameId,
        paused ? 'Blocking paused on every site.' : 'Blocking active on every site.',
        paused ? 'warn' : 'success',
      );
      return;
    }

    case 'copy_domain':
      await copyIntoTab(tabId as number, frameId, domain ?? '');
      return;

    case 'copy_url':
      await copyIntoTab(tabId as number, frameId, cleanUrlFor(info.pageUrl || info.frameUrl));
      return;

    case 'copy_rule':
      await copyIntoTab(tabId as number, frameId, blockRuleFor(domain) ?? '');
      return;

    case 'analyse_page': {
      const telemetry = typeof tabId === 'number' ? await getTabTelemetry(tabId) : null;
      await toastInTab(tabId as number, frameId, describeTabActivity(telemetry));
      return;
    }

    case 'show_status': {
      const site = siteFromUrl(url) || 'this site';
      const isPaused = isSitePaused(siteControl, site);
      const state = siteControl.globalPaused
        ? 'Blocking is paused everywhere.'
        : isPaused
        ? `Blocking is paused on ${site}.`
        : `Blocking is active on ${site}.`;
      const allowed = domain && isDomainAllowed(siteControl, domain) ? ' This domain is allowed.' : '';
      await toastInTab(tabId as number, frameId, `${state}${allowed}`);
      return;
    }

    case 'open_hub':
      await chrome.tabs.create({ url: `http://127.0.0.1:${DEFAULT_HUB_PORT}/` });
      return;

    default:
      return;
  }
}

/** Copies text using the page's own clipboard access, which needs a gesture. */
async function copyIntoTab(tabId: number, frameId: number, text: string): Promise<void> {
  const value = (text || '').trim();
  if (!value) {
    await toastInTab(tabId, frameId, 'Nothing to copy here.', 'warn');
    return;
  }
  const res = await frameMessage(tabId, frameId, { type: 'COPY_FROM_PAGE', payload: { text: value } });
  if (!res?.success) {
    await toastInTab(tabId, frameId, `Copy failed — the value was: ${value}`, 'warn');
  }
}

/** `onShown` and `refresh` are newer than the bundled type definitions. */
interface ModernContextMenus {
  onShown?: {
    addListener: (callback: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void) => void;
  };
  refresh?: () => void;
}

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void handleMenuClick(info, tab);
  });

  const modern = chrome.contextMenus as unknown as ModernContextMenus;
  if (modern.onShown) {
    modern.onShown.addListener((info) => {
      describeMenuFor(info);
      // Naming the domain in the label requires the labels to be re-rendered.
      modern.refresh?.();
    });
  }

  setupContextMenus();
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Blockingmachine Extension] Installed. Initializing alarms, live listener, and rules...');
  chrome.alarms.create('bm-periodic-sync', { periodInMinutes: 60 });
  chrome.alarms.create('bm-telemetry-push', { periodInMinutes: 2 });
  setupContextMenus();
  liveListener.start();
  await rulesets.load();
  await loadSiteControl();
  await ruleHits.load();
  await ledger.load();
  // `syncAndApplyRules` reconciles the tiers (and any active global pause) as part of applying
  // the rule set, so an update cannot leave the manifest defaults enabled against the user's choice.
  await syncAndApplyRules();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'bm-periodic-sync') {
    await syncAndApplyRules();
  } else if (alarm.name === 'bm-telemetry-push') {
    // In a packed build this is the only thing that keeps per-tab counters moving between popup
    // visits; `reconcileActiveTab` no-ops outright when the debug event is available.
    await reconcileActiveTab();
    await flushTelemetryReport();
  }
});

// Restore persisted site decisions before the first sync of this worker lifetime.
void loadSiteControl();

// A service worker is torn down and restarted constantly, so the browser's rulesets are reconciled
// against storage on every start rather than trusted to have survived — including the paused case,
// where they must come back silenced. Reading the browser is what makes this a reconcile rather
// than a blind re-issue: an update that reset the rulesets to the manifest defaults, or a user who
// disabled and re-enabled the extension, is repaired here instead of leaving the popup reporting
// tiers the browser has switched off. The rule hit ledger is restored likewise, so counts survive
// the worker being killed mid-page.
void (async () => {
  await rulesets.load();
  await loadSiteControl();
  await ruleHits.load();
  await ledger.load();
  await rulesets.setSuspended(siteControl.globalPaused);
})().catch(() => {});

liveListener.start();

// ─── Matched-rule accounting ──────────────────────────────────────────────────
//
// There are two ways the browser can report that a DNR rule matched, and they are not equivalent.
//
// `onRuleMatchedDebug` is the honest one: it carries the request URL, the initiator and the tab
// for every match, live. Chrome only exposes it to *unpacked* extensions though, so a packed build
// used to receive nothing at all from it — no per-tab counts, no badge, and an empty rule-hit
// ledger for `blockingmachine coverage --hits`. `getMatchedRules` is the packed-build path, at the
// costs Chrome imposes on it: no request URL, only the last five minutes, only a tab the user has
// granted `activeTab` on, and a hard rate limit.
//
// Both paths converge on `applyMatches`, so they can never disagree about what a block is.

interface DynamicRuleEntry {
  urlFilter?: string;
  priority?: number;
  source: TrackerDetection['source'];
}

type DynamicRuleIndex = Map<number, DynamicRuleEntry>;

interface BrowserMatch {
  tabId: number;
  /** Request URL, when the browser disclosed it (unpacked builds only). */
  url?: string;
  /** Blocked host: exact from the debug path, inferred from the rule on the polling path. */
  host: string;
  ruleId?: number;
  rulesetId?: string;
  /** Matches this entry stands for; the polling path reports batches. */
  count?: number;
}

/** Snapshot of the dynamic rules, so a batch of matches resolves against one read. */
async function snapshotDynamicRules(): Promise<DynamicRuleIndex> {
  const snapshot: DynamicRuleIndex = new Map();
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    for (const rule of rules) {
      snapshot.set(rule.id, {
        urlFilter: rule.condition?.urlFilter,
        priority: rule.priority,
        source: (rule.priority ?? 0) >= 500 ? 'user' : 'list',
      });
    }
  } catch {
    // Rule introspection is best-effort; the block count is what matters.
  }
  return snapshot;
}

/** The filter line a match came from, plus where it came from. */
async function resolveMatchedFilter(
  dynamicRules: DynamicRuleIndex,
  ruleId?: number,
  rulesetId?: string,
): Promise<{
  filter?: string;
  priority?: number;
  source: TrackerDetection['source'];
  tier?: StaticTierId;
}> {
  if (typeof ruleId !== 'number') return { source: 'list' };

  const dynamic = dynamicRules.get(ruleId);
  if (dynamic?.urlFilter !== undefined) {
    return { filter: dynamic.urlFilter, priority: dynamic.priority, source: dynamic.source };
  }

  // Not a dynamic rule, so it came from a shipped static tier. The tier is readable straight off
  // the reported ruleset id; the *filter* needs the rule file, which can fail to load. The two
  // lookups are independent on purpose, so a tier is still credited for a match when only the
  // filter question cannot be answered.
  const tier = tierFromRulesetId(rulesetId);
  if (tier) {
    await staticRuleIndex.ensure();
    return { filter: staticRuleIndex.filterFor(rulesetId, ruleId), source: 'list', tier };
  }

  return { source: 'list' };
}

/** Applies browser-reported matches to the session counters and the per-tab ledgers. */
async function applyMatches(
  matches: readonly BrowserMatch[],
  dynamicRules?: DynamicRuleIndex,
): Promise<void> {
  if (matches.length === 0) return;

  // Stamp the source onto every session this batch may open, so an export says which reporting
  // path produced the numbers rather than leaving the reader to assume the better one.
  ledger.setFeed(ledgerFeedForSession(ledgerStatus().feed));

  const index = dynamicRules ?? (await snapshotDynamicRules());
  const touched = new Map<number, TabTelemetry>();

  for (const match of matches) {
    if (!Number.isInteger(match.tabId) || match.tabId < 0) continue;
    const count =
      Number.isFinite(match.count) && (match.count as number) > 0
        ? Math.floor(match.count as number)
        : 1;

    sessionTrackersBlocked += count;
    if (match.host) {
      sessionRecentTrackers.set(match.host, (sessionRecentTrackers.get(match.host) || 0) + count);
    }

    const current =
      touched.get(match.tabId) ??
      (await getTabTelemetry(match.tabId)) ??
      emptyTabTelemetry(match.tabId, match.url ?? '', match.host);
    current.blockedRequests += count;

    const { filter, priority, source, tier } = await resolveMatchedFilter(
      index,
      match.ruleId,
      match.rulesetId,
    );
    // Real browsing is the only honest source for coverage, so record what actually matched.
    if (filter) ruleHits.record(filter, count);
    // Attribution to the tier that shipped the rule, which is what lets a tier be judged on real
    // traffic rather than on how many rules it happens to contain.
    if (tier) ruleHits.recordTier(tier, count);
    // The same match, dated into a session: this is the evidence the hot set is built from, where
    // durability is distinct days rather than a hit total. A match whose filter could not be
    // resolved is counted as unattributed — "we cannot say what matched" and "nothing matched" are
    // different findings, and only one of them is a hole in the ledger.
    ledger.record(filter ?? null, count, Date.now());

    if (match.host) {
      const existing = current.trackers.find((t) => t.domain === match.host);
      if (existing) {
        existing.blockedCount += count;
        existing.lastSeen = Date.now();
      } else {
        current.trackers.push({
          domain: match.host,
          category: 'tracker',
          blockedCount: count,
          firstParty: false,
          priority,
          source,
          lastSeen: Date.now(),
        });
      }
    }

    touched.set(match.tabId, current);
  }

  for (const [tabId, telemetry] of touched) {
    await setTabTelemetry(tabId, telemetry);
    await updateBadge(tabId, telemetry.blockedRequests);
  }
}

/** True when the browser reports matches live, rather than only when asked. */
function hasLiveMatchFeedback(): boolean {
  return Boolean(chrome.declarativeNetRequest?.onRuleMatchedDebug);
}

/**
 * Which reporting path is feeding the per-tab ledger, and how much polling budget is left.
 *
 * The popup shows this so a count can be read for what it is: a live debug match carries its
 * request URL, a polled one does not, and a polled ledger that has gone quiet is usually the
 * quota rather than an absence of blocking. The quota is read off the same call log the poll gate
 * uses, so the number reported is the number that decides the next call.
 */
function ledgerStatus(): LedgerStatus {
  const api = chrome.declarativeNetRequest;
  const liveAvailable = hasLiveMatchFeedback();
  const pollAvailable = typeof api?.getMatchedRules === 'function';
  return {
    feed: ledgerFeedFromAvailability({ liveAvailable, pollAvailable }),
    liveAvailable,
    pollAvailable,
    quota: matchedRulesQuotaView(matchedRuleCalls, Date.now()),
  };
}

/**
 * Forgets the ledger for tiers that were switched *on* just now.
 *
 * A tier that has been off collected no matches for the only reason that matters: it was off. Left
 * in place those stale counts would let a tier that fired once months ago look productive forever,
 * hiding the verdict the toggle is actually for — a tier that has had traffic since it was turned
 * on and still never fired. Re-applying a selection that leaves a tier enabled changes nothing, so
 * applying a plan does not wipe the attribution of every tier it keeps.
 */
function noteTierTransitions(
  before: readonly StaticTierId[],
  after: readonly StaticTierId[],
): void {
  for (const id of after) {
    if (!before.includes(id)) ruleHits.clearTier(id);
  }
}

// The polling path's own state: a cursor so a poll cannot count the tail of the previous batch
// twice, a log of recent calls to stay inside Chrome's quota, and per-tab spacing so a refreshing
// popup cannot hammer the API.
const matchedRuleCalls: number[] = [];
let matchedRuleCursor = 0;
let matchedRuleQuotaWarned = false;
const lastReconcileAt = new Map<number, number>();
const MATCHED_RULES_MIN_INTERVAL_MS = 15_000;

/**
 * Reconciles one tab from `getMatchedRules`.
 *
 * `gesture` marks a call the browser ties to a user gesture — the popup asking for telemetry —
 * which is exempt from the quota and, more importantly, the moment `activeTab` is certain to be
 * granted for the tab being asked about.
 */
async function reconcileMatchedRules(
  tabId: number,
  options: { gesture?: boolean } = {},
): Promise<number> {
  const api = chrome.declarativeNetRequest;
  if (hasLiveMatchFeedback()) return 0;
  if (!api || typeof api.getMatchedRules !== 'function') return 0;
  if (!Number.isInteger(tabId) || tabId < 0) return 0;

  const now = Date.now();
  const last = lastReconcileAt.get(tabId);
  if (last !== undefined && now - last < MATCHED_RULES_MIN_INTERVAL_MS) return 0;

  if (!options.gesture && !canRequestMatchedRules(matchedRuleCalls, now)) {
    if (!matchedRuleQuotaWarned) {
      matchedRuleQuotaWarned = true;
      console.warn('[MatchedRules] Quota reached; per-tab counts update on the next interval.');
    }
    return 0;
  }

  lastReconcileAt.set(tabId, now);
  matchedRuleCalls.push(now);
  // Keep the call log bounded: this worker can outlive thousands of polls.
  const windowStart = now - DEFAULT_MATCHED_RULES_BUDGET.windowMs;
  while (matchedRuleCalls.length > 0 && matchedRuleCalls[0] <= windowStart) matchedRuleCalls.shift();

  let delta;
  try {
    const result = await api.getMatchedRules({ tabId, minTimeStamp: matchedRuleCursor });
    delta = summarizeMatches(readMatchedRuleRecords(result), matchedRuleCursor);
  } catch (err) {
    // No `activeTab` grant for this tab, or the quota was already exhausted.
    console.warn('[MatchedRules] Could not read matched rules:', err);
    return 0;
  }

  matchedRuleCursor = delta.cursor;

  const dynamicRules = await snapshotDynamicRules();
  const matches: BrowserMatch[] = [];
  for (const tally of delta.tallies) {
    const { filter } = await resolveMatchedFilter(
      dynamicRules,
      tally.rule.ruleId,
      tally.rule.rulesetId,
    );
    matches.push({
      tabId: tally.tabId,
      // The browser withholds the request URL here, so the host comes from the rule that fired.
      host: filter ? hostFromFilter(filter) ?? '' : '',
      ruleId: tally.rule.ruleId,
      rulesetId: tally.rule.rulesetId,
      count: tally.count,
    });
  }

  await applyMatches(matches, dynamicRules);
  return delta.counted;
}

/** Reconciles the active tab — the only one `activeTab` can have been granted on. */
async function reconcileActiveTab(): Promise<void> {
  if (hasLiveMatchFeedback()) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (typeof tabId === 'number' && tabId >= 0) await reconcileMatchedRules(tabId);
  } catch {
    // Best effort: the popup reconciles on demand as well.
  }
}

// Unpacked builds get the real thing: every match, live, with the request URL attached.
if (chrome.declarativeNetRequest?.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const tabId = info.request?.tabId ?? -1;
    const url = info.request?.url;
    if (!url || tabId < 0) return;

    let host = '';
    try {
      const parsedUrl = new URL(url);
      if (!parsedUrl.protocol.startsWith('http')) return;
      host = parsedUrl.hostname;
    } catch {
      return;
    }

    void applyMatches([
      { tabId, url, host, ruleId: info.rule?.ruleId, rulesetId: info.rule?.rulesetId },
    ]).catch(() => {});
  });
}

// Clear per-tab ledgers and badges when a tab goes away or navigates away.
chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabTelemetry(tabId);
  lastReconcileAt.delete(tabId);
});

// A fresh navigation starts a fresh ledger, so the badge reflects this page only.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  await removeTabTelemetry(tabId);
  await updateBadge(tabId, 0);
});

// ─── Messages ─────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    return false;
  }

  if (!message || typeof message !== 'object') {
    sendResponse({ success: false, error: 'Invalid message payload' });
    return false;
  }

  switch (message.type) {
    case 'GET_TAB_TELEMETRY': {
      const tabId = message.payload?.tabId;
      if (typeof tabId === 'number' && tabId > 0) {
        // Opening the popup is a user gesture, so this `getMatchedRules` call is exempt from
        // Chrome's quota — and it is the moment `activeTab` is granted for exactly this tab, which
        // is what makes the call legal in a packed build in the first place.
        reconcileMatchedRules(tabId, { gesture: true })
          .catch(() => {})
          .then(() => getTabTelemetry(tabId))
          .then((data) => sendResponse({ success: true, data }));
        return true;
      }
      sendResponse({ success: false, data: null });
      return false;
    }

    case 'SYNC_RULES_NOW':
      syncAndApplyRules().then((count) => sendResponse({ success: true, count }));
      return true;

    case 'GET_MV3_STATUS':
      Mv3Guard.getQuotaStatus().then((data) => sendResponse({ success: true, data }));
      return true;

    // ── Block-ledger source + `getMatchedRules` quota ───────────────────────────
    // A synchronous read of in-memory state, so it answers even while the polling quota is spent.
    case 'GET_LEDGER_STATUS':
      sendResponse({ success: true, status: ledgerStatus() });
      return false;

    // ── Static DNR ruleset tiers ────────────────────────────────────────────────
    // Static rules do not compete with the dynamic quota, so these toggles change the
    // extension's total capacity without re-syncing a single dynamic rule.
    case 'GET_RULESET_TIERS':
      rulesets.status().then((status) => sendResponse({ success: true, status }));
      return true;

    case 'SET_RULESET_TIER': {
      const id = message.payload?.id;
      if (typeof id !== 'string') {
        sendResponse({ success: false, error: 'A ruleset tier id is required.' });
        return false;
      }
      const before = rulesets.getEnabledTierIds();
      rulesets
        .setTierEnabled(id, message.payload?.enabled !== false)
        .then((enabled) => {
          noteTierTransitions(before, enabled);
          sendResponse({ success: true, enabled });
        })
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    // ── Rule hit ledger: what really fired during browsing ─────────────────────
    case 'GET_RULE_HIT_STATS': {
      // The ledger is read from the popup, so fold in whatever the active tab has matched since
      // the last read before answering.
      reconcileActiveTab()
        .catch(() => {})
        .then(() => sendResponse({ success: true, data: ruleHits.snapshot() }));
      return true;
    }

    case 'RESET_RULE_HIT_STATS':
      ruleHits
        .reset()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;

    // Reads only: exporting must not close today's session, or exporting twice would split one
    // day's evidence across two sessions and inflate every rule's recurrence count.
    case 'EXPORT_HIT_LEDGER':
      sendResponse({ success: true, ...ledger.exportPayload() });
      return false;

    case 'SET_RULESET_TIERS': {
      const ids = message.payload?.ids;
      if (!Array.isArray(ids)) {
        sendResponse({ success: false, error: 'A list of ruleset tier ids is required.' });
        return false;
      }
      const before = rulesets.getEnabledTierIds();
      rulesets
        .setEnabledTierIds(ids)
        .then((enabled) => {
          noteTierTransitions(before, enabled);
          sendResponse({ success: true, enabled });
        })
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'GET_EXTENSION_STATUS':
      Promise.all([Mv3Guard.getQuotaStatus(), loadSiteControl(), rulesets.status()]).then(
        ([quota, control, tiers]) => {
          const status: ExtensionStatus = {
            sseStatus: liveListener.getStatus(),
            mv3: {
              dynamicRulesCount: quota.dynamicRulesCount,
              maxDynamicRules: quota.maxDynamicRules,
              isWithinQuota: quota.isWithinQuota,
              utilizationPercent: quota.utilizationPercent,
            },
            globalPaused: control.globalPaused,
            pausedSites: control.pausedSites.length,
            allowedDomains: control.allowedDomains.length,
            staticRules: {
              enabledTiers: tiers.enabledTiers,
              totalTiers: tiers.totalTiers,
              enabledRules: tiers.enabledRules,
              totalRules: tiers.totalRules,
            },
          };
          sendResponse({ success: true, status });
        },
      );
      return true;

    case 'GET_SITE_CONTROL':
      loadSiteControl()
        .then(() => sendResponse({ success: true, view: siteControlView(message.payload?.url) }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;

    case 'TOGGLE_SITE_BLOCKING': {
      const site = siteFromUrl(message.payload?.url) || normalizeSite(message.payload?.site);
      if (!site) {
        sendResponse({ success: false, error: 'This page cannot be paused.' });
        return false;
      }
      const paused = message.payload?.paused === true;
      mutateSiteControl((current) => setSitePaused(current, site, paused))
        .then(() => applyCurrentRules())
        .then(() => sendResponse({ success: true, view: siteControlView(message.payload?.url) }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'SET_GLOBAL_PAUSE':
      mutateSiteControl((current) => setGlobalPaused(current, message.payload?.paused === true))
        .then(() => applyCurrentRules())
        .then(() => sendResponse({ success: true, view: siteControlView(message.payload?.url) }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;

    case 'SET_DOMAIN_ALLOWED': {
      const domain = normalizeSite(message.payload?.domain);
      if (!domain) {
        sendResponse({ success: false, error: 'Invalid domain.' });
        return false;
      }
      const allowed = message.payload?.allowed !== false;
      mutateSiteControl((current) => setDomainAllowed(current, domain, allowed))
        .then(() => applyCurrentRules())
        .then(() =>
          sendResponse({
            success: true,
            rule: allowed ? `@@||${domain}^` : null,
            view: siteControlView(message.payload?.url),
          }),
        )
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'ADD_CUSTOM_RULE': {
      const rule = typeof message.payload?.rule === 'string' ? message.payload.rule : '';
      if (!rule.trim()) {
        sendResponse({ success: false, error: 'Empty rule.' });
        return false;
      }
      appendCustomRule(rule)
        .then((added) => sendResponse({ success: true, added }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'START_ELEMENT_PICKER':
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

    // ── Element AI, relayed to the active tab's content script ──────────────────
    case 'SCAN_PAGE_FOR_ADS':
    case 'HIGHLIGHT_AI_CANDIDATES':
    case 'BLOCK_AI_CANDIDATES': {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        if (!activeTab?.id) {
          sendResponse({ success: false, error: 'No active tab' });
          return;
        }
        if (activeTab.id < 0) {
          sendResponse({ success: false, error: 'This page cannot be scanned.' });
          return;
        }
        chrome.tabs.sendMessage(
          activeTab.id,
          { type: message.type, payload: message.payload },
          (res) => {
            void chrome.runtime.lastError;
            sendResponse(res ?? { success: false, error: 'No response from the page.' });
          },
        );
      });
      return true;
    }

    case 'ELEMENT_PICKED': {
      sessionElementsHidden += 1;
      const selector = typeof message.payload?.selector === 'string' ? message.payload.selector : '';
      const senderTabId = sender.tab?.id;
      if (typeof senderTabId === 'number') {
        getTabTelemetry(senderTabId).then(async (data) => {
          const current =
            data || emptyTabTelemetry(senderTabId, sender.tab?.url || '', sender.tab?.url || '');
          current.elementsHidden += 1;
          await setTabTelemetry(senderTabId, current);
        });
      }
      console.log(`[Blockingmachine] Cosmetic rule saved: ${selector}`);
      sendResponse({ success: true });
      return false;
    }

    case 'REMOVE_USER_COSMETIC': {
      const selector = typeof message.payload?.selector === 'string' ? message.payload.selector : '';
      if (!selector) {
        sendResponse({ success: false, error: 'No selector supplied.' });
        return false;
      }
      (async () => {
        try {
          const stored = await chrome.storage.local.get(STORAGE_KEY_USER_COSMETICS);
          const existing: unknown = stored?.[STORAGE_KEY_USER_COSMETICS];
          const list: string[] = Array.isArray(existing)
            ? existing.filter((s): s is string => typeof s === 'string')
            : [];
          await chrome.storage.local.set({
            [STORAGE_KEY_USER_COSMETICS]: list.filter((s) => s !== selector),
          });
          // Other frames of the same page need the revert too.
          const tabs = await chrome.tabs.query({});
          for (const t of tabs) {
            if (t.id) {
              chrome.tabs.sendMessage(t.id, { type: 'TOGGLE_COSMETICS' }).catch(() => {});
            }
          }
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: String(err) });
        }
      })();
      return true;
    }

    case 'GET_HA_CONFIG':
      haBridge.loadConfig().then((cfg) => sendResponse({ success: true, config: cfg }));
      return true;

    case 'SET_HA_CONFIG':
      haBridge.saveConfig(message.payload || {}).then((cfg) => sendResponse({ success: true, config: cfg }));
      return true;

    case 'TEST_HA_CONNECTION':
      haBridge
        .testConnection(message.payload?.url, message.payload?.token)
        .then((result) => sendResponse({ success: true, result }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;

    case 'GET_SSE_STATUS':
      sendResponse({ success: true, status: liveListener.getStatus(), lastSyncAt, ruleCount: lastAppliedRuleCount });
      return false;

    case 'REPORT_BROWSER_TELEMETRY':
      flushTelemetryReport().then(() => sendResponse({ success: true }));
      return true;

    default:
      sendResponse({ success: false, error: `Unsupported message type: ${message.type}` });
      return false;
  }
});
