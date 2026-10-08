import {
  DnrManager,
  computeSiteControlDrift,
  customRulesAreInstalled,
  planListRules,
  ruleFamily,
  userDecisionsAreInstalled,
} from './dnrManager.js';
import { RulesetManager } from './rulesetManager.js';
import { ALARM_PERIODIC_SYNC, ALARM_TELEMETRY_PUSH, reconcileAlarms } from './alarmSchedule.js';
import { RuleHitStats } from './ruleHitStats.js';
import { LedgerSessionRecorder } from './ledgerSession.js';
import { exportElementHarvest, previewElementHarvest, storeHarvestRecords } from './elementHarvestStore.js';
import { StaticRuleIndex } from './staticRuleIndex.js';
import { TierBenefitIndex } from './tierBenefit.js';
import { computeTierRedundancy } from './tierRedundancy.js';
import { SyncClient } from './syncClient.js';
import { Mv3Guard } from './mv3Guard.js';
import { LiveListener } from './liveListener.js';
import {
  DEFAULT_MATCHED_RULES_BUDGET,
  canRequestMatchedRules,
  dedupePolledRecords,
  hostFromFilter,
  ledgerLineFor,
  liveMatchKey,
  makeKeyedSerializer,
  matchIsBlock,
  matchedRulesQuotaView,
  readMatchedRuleRecords,
  recordLiveMatch,
  summarizeMatches,
  type LiveMatchLog,
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
  AppliedRuleSource,
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
import { categoryForTier } from '../shared/trackerCategory.js';
import {
  DEFAULT_FEED_URL,
  DEFAULT_HUB_PORT,
  DEFAULT_SSE_ENDPOINT,
  STORAGE_KEY_COSMETICS,
  STORAGE_KEY_COSMETICS_ENABLED,
  STORAGE_KEY_CUSTOM_RULES,
  STORAGE_KEY_LAST_SYNC_AT,
  STORAGE_KEY_RULE_SOURCE,
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

/**
 * Push the stored HA config's feed URL/token into the two clients that actually
 * use them — the popup writes `feedUrl`/`feedToken` but nothing reached the rule
 * sync or the live event stream, so a configured remote server (or a feed token)
 * was dead config. A feed-URL change also re-syncs so the new source applies
 * immediately rather than at the next alarm.
 */
let appliedFeedUrl: string | null = null;
async function applyHubConfig(): Promise<void> {
  const cfg = await haBridge.loadConfig();
  const feedUrl = cfg.feedUrl?.trim() || DEFAULT_FEED_URL;
  const feedToken = cfg.feedToken?.trim() || undefined;
  let sseEndpoint = DEFAULT_SSE_ENDPOINT;
  try {
    sseEndpoint = `${new URL(feedUrl).origin}/v1/events`;
  } catch {
    /* malformed configured URL — keep the localhost default */
  }
  const feedChanged = appliedFeedUrl !== null && feedUrl !== appliedFeedUrl;
  sync.setFeed(feedUrl, feedToken);
  liveListener.setSource(sseEndpoint, feedToken);
  appliedFeedUrl = feedUrl;
  if (feedChanged) await syncAndApplyRules();
}

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

/**
 * The view the popup renders — storage's claim *plus* the browser's own answer about whether
 * it is enforcing it.
 *
 * The drift is composed from the same read `reconcileDynamicRules` runs (`installedFamilies`
 * against the user's decisions and saved rules), so the notice and the repair see the same
 * disagreement — and a response built without the read would describe state the browser may
 * not be in, which is exactly the failure this field exists to end.
 */
async function siteControlView(url?: string): Promise<SiteControlView> {
  const site = siteFromUrl(url);
  const [families, customRules] = await Promise.all([
    dnr.installedFamilies(),
    loadCustomRules(),
  ]);
  return {
    globalPaused: siteControl.globalPaused,
    site,
    sitePaused: site ? siteControl.pausedSites.some((s) => s === site || site.endsWith(`.${s}`)) : false,
    pausedSites: [...siteControl.pausedSites],
    allowedDomains: [...siteControl.allowedDomains],
    drift: computeSiteControlDrift(families, siteControl, customRules),
    ...(lastApplyError !== null ? { applyError: lastApplyError } : {}),
  };
}

// ─── In-memory telemetry accumulator for periodic batch reporting ─────────────

let sessionTrackersBlocked = 0;
let sessionElementsHidden = 0;
let sessionThreatsDetected = 0;
const sessionRecentTrackers: Map<string, number> = new Map();

/**
 * Most recent blocklist lines, kept so site toggles can re-apply without a fetch.
 *
 * In memory, and deliberately not the only copy of anything: when this is empty — which is the state
 * of every service worker that has not fetched yet, and MV3 tears workers down constantly — the
 * installed dynamic rules from the last successful compilation stand in for it. See
 * `applyCurrentRules`, which asks the DNR manager to keep what the browser holds rather than replace
 * it with nothing.
 */
let lastSyncedNetworkRules: string[] = [];
/**
 * The measured hot set from the last successful sync, or `null` when the deployment has none.
 *
 * Held beside the full list rather than inside it, and passed to the planner on every application
 * rather than substituted into the lines here. The planner decides which of the two to install from
 * the budget alone, so the same full export plus the same hot set always gives the same answer —
 * including on the local-change path that has no network at all, which is the path that runs when
 * the user pauses a site.
 */
let lastSyncedHotRules: string[] | null = null;
/**
 * What the browser is holding, as of the last read.
 *
 * A reading rather than a ledger of this worker's own calls: the popup shows this next to a live
 * quota bar, and two numbers about the same rules that disagree is worse than one that is missing.
 */
let lastAppliedRuleCount = 0;
/**
 * Why the last `updateDynamicRules` call refused, or `null` when it last succeeded.
 *
 * Kept beside `lastAppliedRuleCount` because it is the same kind of reading — the answer the
 * browser gave, not a ledger entry. The popup's drift notice names it so a disagreement the
 * reconcile finds can say *why* rather than only *that*, and a successful apply clears it so a
 * repaired state does not keep wearing the old failure.
 */
let lastApplyError: string | null = null;
let lastSyncAt: number | null = null;

/** Persists when the list was last fetched, so the readout survives the worker that fetched it. */
async function saveLastSyncAt(at: number): Promise<void> {
  lastSyncAt = at;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_LAST_SYNC_AT]: at });
  } catch (err) {
    console.warn('[Blockingmachine] Could not persist the last sync time:', err);
  }
}

/**
 * Persists which list source a successful application installed — the full export or the measured
 * hot set. Recorded rather than recomputed because the question the popup answers is "what is the
 * browser running", and nothing outside this extension can change its own dynamic rules, so the
 * record stays true until the next application replaces it.
 */
async function saveRuleSource(source: AppliedRuleSource): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_RULE_SOURCE]: source });
  } catch (err) {
    console.warn('[Blockingmachine] Could not persist the applied rule source:', err);
  }
}

/** The recorded source, or null when no application has been recorded (a fresh install). */
async function loadRuleSource(): Promise<AppliedRuleSource | null> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_RULE_SOURCE);
    const record = (stored as { [STORAGE_KEY_RULE_SOURCE]?: AppliedRuleSource })[
      STORAGE_KEY_RULE_SOURCE
    ];
    return record && (record.source === 'full' || record.source === 'hot') ? record : null;
  } catch {
    return null;
  }
}

/** Restores the last sync time, which belongs to the profile rather than to this worker. */
async function loadLastSyncAt(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_LAST_SYNC_AT);
    const at = stored?.[STORAGE_KEY_LAST_SYNC_AT];
    if (typeof at === 'number' && Number.isFinite(at)) lastSyncAt = at;
  } catch {
    // A missing timestamp is reported as never synced, which is the honest answer when unknown.
  }
}

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
async function applyCurrentRulesInner(): Promise<number> {
  try {
    // Reconciling the static tiers belongs here, on every rule application, not only on a package
    // update: the global pause clears the dynamic rules, so a paused extension has to silence the
    // shipped tiers in the same breath or it keeps blocking from the tier files. The same call
    // also re-asserts the saved selection against the browser's own ruleset state while not
    // paused, which is what repairs an update that reset those rulesets to the manifest defaults.
    await rulesets.setSuspended(siteControl.globalPaused);
    const customRules = await loadCustomRules();
    // Built on the first apply: the tier files are local reads and the tally is whatever
    // `ruleHits` holds by then — a worker that had not finished its startup load simply ranks
    // by compile order alone, which is still a measured answer.
    await tierBenefitIndex.ensure();
    // `replaceInstalledList` is the whole guard: this runs on every local decision — a paused site,
    // an allowed domain, a new custom rule — and a worker that has not fetched the list yet holds no
    // lines to compile. Rebuilding the dynamic rules from an empty list would spend a site pause by
    // deleting the entire blocklist, and the popup would still report the shield as active because
    // the decisions are in storage. The installed rules are the last compilation's own output, so a
    // call without the list keeps them and replaces only the user's decisions.
    lastAppliedRuleCount = await dnr.updateDynamicRules(
      [...customRules, ...lastSyncedNetworkRules],
      siteControl,
      {
        replaceInstalledList: lastSyncedNetworkRules.length > 0,
        // No hot set held means the planner prunes the full export — by measured tier benefit
        // when the ranking placed any of the list's hosts, list order only when it could not.
        // `ownRuleLines` rides beside the shipped set rather than replacing it: the browser's
        // own ledger is the deployment's measured traffic, and its fired rules lead the merge.
        hotRuleLines: lastSyncedHotRules,
        ownRuleLines: ledger.firedRules().map((hit) => hit.rule),
        benefitRank: (host) => tierBenefitIndex.rankFor(host),
        onRuleSource: (source) => void saveRuleSource(source),
      },
    );
    lastApplyError = null;
    return lastAppliedRuleCount;
  } catch (err) {
    // The drift read will still name the disagreement — what it could never name before is
    // the cause, so the refusal is kept for the popup to read rather than only logged.
    lastApplyError = err instanceof Error ? err.message : String(err);
    console.warn('[Blockingmachine] Failed to apply dynamic rules:', err);
    return 0;
  }
}

/**
 * Applies must never interleave. Each call reads the browser's rules before it writes, so two
 * overlapping applies can both plan as if the other's rules were absent — the second then pushes
 * the family past the browser's dynamic-rule budget and gets its whole batch refused (which used
 * to read as "applied 0" in the log). Queuing is safe because applies are idempotent and ordered:
 * a later call only ever sees an earlier call's committed state.
 */
let applyChain: Promise<unknown> = Promise.resolve();

async function applyCurrentRules(): Promise<number> {
  const queued = applyChain.then(() => applyCurrentRulesInner());
  // The inner apply never rejects — refusals land on `lastApplyError` — but a rejection would
  // poison every later call without the reset branch.
  applyChain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

/**
 * Reads the browser's dynamic rules and repairs whatever storage says should be installed.
 *
 * The dynamic half of the extension had no reconcile at all: the tiers were repaired on every worker
 * start (`RulesetManager.setSuspended`) while the rules the user's own decisions produce were only
 * ever installed at the moment the decision was made. A decision whose `applyCurrentRules` call threw
 * — a quota rejection, a torn-down worker, a browser that was mid-update — therefore stayed in
 * storage and never reached the browser, and the popup read the storage back and reported a pause
 * that was not pausing. **Both** halves of what the user asked for are checked, because they arrive
 * in different families: the pause and allow decisions are the high-priority rules, and a rule saved
 * by hand is compiled by the list planner and lands with the blocklist.
 *
 * This is the same reconcile the rulesets get, against a different API: read the browser, keep the
 * count it reports, and install only when there is a difference. Nothing is remembered from the last
 * worker — there is nothing to remember, because the browser is holding the answer.
 *
 * The list family is repaired by fetching rather than by keeping a copy. An empty list family means
 * there is no compiled blocklist installed at all — a fresh profile, or a browser that lost its
 * rules — and re-fetching is the only repair that does not need a multi-megabyte list duplicated
 * into storage. It is self-limiting: once a sync has succeeded the family is not empty, so this asks
 * for a fetch once per profile rather than once per worker start. While blocking is paused
 * everywhere the family is *supposed* to be empty, so the pause is not mistaken for damage.
 */
async function reconcileDynamicRules(): Promise<void> {
  const families = await dnr.installedFamilies();
  // No reading, no safe repair: leaving the browser alone is the only honest option, and the next
  // worker start will ask again.
  if (!families) return;

  const installed = families.user.length + families.list.length;
  lastAppliedRuleCount = installed;

  // Both halves of what the user asked for, since they arrive in different families: the pause and
  // allow decisions are the high-priority rules, and a rule the user saved by hand is compiled by
  // the list planner and lands with the blocklist.
  const customRules = await loadCustomRules();
  if (
    !userDecisionsAreInstalled(families, siteControl) ||
    !customRulesAreInstalled(families, customRules, siteControl)
  ) {
    await applyCurrentRules();
    return;
  }
  if (families.list.length === 0 && !siteControl.globalPaused) {
    await syncAndApplyRules();
  }
}

/**
 * Syncs are single-flight: install, worker-start reconcile, the live stream and the popup's
 * manual sync can all ask inside the same window, and a second fetch while the first is still
 * ingesting is pure duplicate work — hundreds of thousands of rules parsed twice, and a second
 * apply racing the first past the browser's rule budget. A caller that asks mid-sync gets the
 * in-flight answer: it is fetching the same feed, so "the latest" is the same list either way.
 */
let syncInFlight: Promise<number> | null = null;

async function syncAndApplyRules(): Promise<number> {
  syncInFlight ??= syncAndApplyRulesInner().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function syncAndApplyRulesInner(): Promise<number> {
  try {
    console.log('[Blockingmachine] Fetching latest compiled rules from hub...');
    const { networkRules, cosmeticSelectors, hotRuleLines } = await sync.fetchCompiledRules();
    if (networkRules.length > 0) {
      lastSyncedNetworkRules = networkRules;
    }
    // Assigned unconditionally, including when it comes back null. A deployment that has dropped
    // its hot set must stop being offered the stale one, and the only way to know it dropped it is
    // a sync that says so — the same reason `networkRules` above is guarded but this is not.
    lastSyncedHotRules = hotRuleLines;
    if (cosmeticSelectors.length > 0) {
      await chrome.storage.local.set({ [STORAGE_KEY_COSMETICS]: cosmeticSelectors });
      console.log(
        `[Blockingmachine] Stored ${cosmeticSelectors.length} dynamic cosmetic element-hiding selectors.`
      );
    }
    await saveLastSyncAt(Date.now());
    const count = await applyCurrentRules();
    // The apply reports failures as `lastApplyError` and returns 0 — logging "applied 0" after
    // a refused batch would claim an empty ruleset while the previous rules are still installed.
    if (lastApplyError === null) {
      console.log(`[Blockingmachine] Successfully applied ${count} dynamic DNR network rules.`);
    }
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
/** Reads one shipped tier ruleset inside the extension bundle. */
async function readTierFile(path: string): Promise<unknown> {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const staticRuleIndex = new StaticRuleIndex({
  tiers: STATIC_RULE_TIERS,
  readTier: readTierFile,
});

/**
 * The measured-benefit ranking behind the no-hot-set fallback trim: each shipped tier file's
 * host order is the compile's evidence rank, and the deployment's own per-tier hit tally
 * (`bm_tier_hits`) weights the order across tiers. Built lazily on the first apply — the
 * files ship inside the package, so the ranking can never be absent for a missing file.
 */
const tierBenefitIndex = new TierBenefitIndex({
  tiers: STATIC_RULE_TIERS,
  readTier: readTierFile,
  tierHits: () => ruleHits.snapshot().tiers,
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

// `onStartup` fires once per browser launch and `onInstalled` does not, so this is the one event
// that can notice a browser which came back without its alarms. The worker-start block below asks
// the same question for the case where the worker is woken for some other reason first.
chrome.runtime.onStartup.addListener(() => {
  void reconcileAlarms();
});

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Blockingmachine Extension] Installed. Initializing alarms, live listener, and rules...');
  // Reconciled rather than created outright, like everywhere else the browser holds the state:
  // an update keeps the alarms it already had, and `onInstalled` is not the only caller.
  await reconcileAlarms();
  setupContextMenus();
  liveListener.start();
  await rulesets.load();
  await loadSiteControl();
  await loadLastSyncAt();
  await ruleHits.load();
  await ledger.load();
  // `syncAndApplyRules` reconciles the tiers (and any active global pause) as part of applying
  // the rule set, so an update cannot leave the manifest defaults enabled against the user's choice.
  await syncAndApplyRules();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_PERIODIC_SYNC) {
    await syncAndApplyRules();
  } else if (alarm.name === ALARM_TELEMETRY_PUSH) {
    // The poll is what keeps per-tab counters moving between popup visits — on a packed build it
    // is the whole report, and on an unpacked one it recovers the matches live delivery dropped
    // across a worker wake.
    await reconcileRecentMatches();
    await flushTelemetryReport();
  }
});

// Restore persisted site decisions before the first sync of this worker lifetime.
void loadSiteControl();

// A service worker is torn down and restarted constantly, so everything the extension persists is
// reconciled against the browser on every start rather than trusted to have survived:
//
//   - the tiers, including the paused case, where they must come back silenced;
//   - the rules the user's own decisions produce, which are compared against the browser's own
//     dynamic rules and re-installed when a decision never made it (see `reconcileDynamicRules`);
//   - the periodic alarms, which are browser state that Chrome documents as clearable, and without
//     which nothing would ever sync again.
//
// Reading the browser is what makes each of these a reconcile rather than a blind re-issue: an
// update that reset the rulesets to the manifest defaults, a user who disabled and re-enabled the
// extension, or a profile that came back without its alarms is repaired here instead of leaving the
// popup reporting tiers the browser has switched off. The rule hit ledger is restored likewise, so
// counts survive the worker being killed mid-page.
void (async () => {
  await rulesets.load();
  await loadSiteControl();
  await loadLastSyncAt();
  await ruleHits.load();
  await ledger.load();
  await rulesets.setSuspended(siteControl.globalPaused);
  await reconcileAlarms();
  await reconcileDynamicRules();
})().catch(() => {});

// Apply the stored feed URL/token *before* the first connect so a token-gated
// server never sees an unauthenticated attempt (which now stops the retry loop).
// The race is covered anyway: setSource restarts the listener if the endpoint or
// credential it lands on differs from the defaults it first connected with.
void applyHubConfig();

liveListener.start();

// ─── Matched-rule accounting ──────────────────────────────────────────────────
//
// There are two ways the browser can report that a DNR rule matched, and they are not equivalent.
//
// `onRuleMatchedDebug` is the honest one: it carries the request URL, the initiator and the tab
// for every match, live — but delivery across a worker wake is lossy. A suspended worker does
// wake on a match, yet events in flight during the cold start are dropped: measured live, a
// three-request burst at a sleeping worker delivered a single event. An MV3 worker suspends
// roughly thirty seconds after its last event, so most page loads begin inside that window.
//
// `getMatchedRules` is the catch-up: a poll returns every match from the last five minutes, live
// or not, at the costs Chrome imposes — no request URL, only a tab the user has granted
// `activeTab` on (or any tab when the feedback permission exists), and a hard rate limit. It runs
// on every build because a suspended worker is not an edge case but the normal state.
//
// Both paths converge on `applyMatches`, so they can never disagree about what a block is. What
// they can disagree about is whether a match is new: the poll re-reports matches the live event
// already counted, so the live log in `matchedRules.ts` pairs each polled record with the live
// arrival that claimed it before anything is counted twice.

interface DynamicRuleEntry {
  urlFilter?: string;
  priority?: number;
  /** What the rule did to the request — `allow`/`allowAllRequests` matches are not blocks. */
  action?: string;
  /** `$domain=` scope the installed rule carries, when it was scoped. */
  initiatorDomains?: readonly string[];
  excludedInitiatorDomains?: readonly string[];
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
        action: rule.action?.type,
        initiatorDomains: rule.condition?.initiatorDomains,
        excludedInitiatorDomains: rule.condition?.excludedInitiatorDomains,
        source: ruleFamily(rule.priority),
      });
    }
  } catch {
    // Rule introspection is best-effort; the block count is what matters.
  }
  return snapshot;
}

/** The filter line a match came from, plus where it came from and what it did to the request. */
async function resolveMatchedFilter(
  dynamicRules: DynamicRuleIndex,
  ruleId?: number,
  rulesetId?: string,
): Promise<{
  filter?: string;
  /** The ledger-ready text — `@@`-prefixed and `$domain=`-scoped as the installed rule was. */
  line?: string;
  action?: string;
  priority?: number;
  source: TrackerDetection['source'];
  tier?: StaticTierId;
}> {
  if (typeof ruleId !== 'number') return { source: 'list' };

  const dynamic = dynamicRules.get(ruleId);
  if (dynamic?.urlFilter !== undefined) {
    return {
      filter: dynamic.urlFilter,
      line: ledgerLineFor(dynamic.urlFilter, dynamic.action, dynamic, dynamic.priority),
      action: dynamic.action,
      priority: dynamic.priority,
      source: dynamic.source,
    };
  }

  // Not a dynamic rule, so it came from a shipped static tier. The tier is readable straight off
  // the reported ruleset id; the *filter* needs the rule file, which can fail to load. The two
  // lookups are independent on purpose, so a tier is still credited for a match when only the
  // filter question cannot be answered.
  const tier = tierFromRulesetId(rulesetId);
  if (tier) {
    await staticRuleIndex.ensure();
    const entry = staticRuleIndex.entryFor(rulesetId, ruleId);
    return {
      filter: entry?.filter,
      line: entry ? ledgerLineFor(entry.filter, entry.action, {}) : undefined,
      action: entry?.action,
      source: 'list',
      tier,
    };
  }

  return { source: 'list' };
}

// A per-tab commit is a read-modify-write on session storage, so two matches arriving together —
// which is every page load — would otherwise race: each applies against the pre-write counter and
// the loser's increment silently vanishes. Chaining commits per tab makes the stored count the
// sum of what actually matched, in arrival order.
const enqueueTabCommit = makeKeyedSerializer<number>();

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
  const perTab = new Map<
    number,
    Array<{
      match: BrowserMatch;
      count: number;
      priority?: number;
      source: TrackerDetection['source'];
      tier?: StaticTierId;
    }>
  >();

  for (const match of matches) {
    const count =
      Number.isFinite(match.count) && (match.count as number) > 0
        ? Math.floor(match.count as number)
        : 1;

    const { line, action, priority, source, tier } = await resolveMatchedFilter(
      index,
      match.ruleId,
      match.rulesetId,
    );

    if (!matchIsBlock(action)) {
      // The rule *allowed* the request — a paused site's allowAllRequests or an `@@` exception.
      // It goes to the ledger's exceptions axis, where the `@@` line lands it, and nowhere else:
      // a blocked-request count, a badge number, a per-host tally or a hot-set entry built from
      // an allow match would each be the block/exception inversion this branch exists to stop.
      ledger.record(line ?? null, count, Date.now(), {});
      continue;
    }

    sessionTrackersBlocked += count;
    if (match.host) {
      sessionRecentTrackers.set(match.host, (sessionRecentTrackers.get(match.host) || 0) + count);
    }

    // Real browsing is the only honest source for coverage, so record what actually matched.
    if (line) ruleHits.record(line, count);
    // Attribution to the tier that shipped the rule, which is what lets a tier be judged on real
    // traffic rather than on how many rules it happens to contain.
    if (tier) ruleHits.recordTier(tier, count);
    // The same match, dated into a session: this is the evidence the hot set is built from, where
    // durability is distinct days rather than a hit total. A match whose filter could not be
    // resolved is counted as unattributed — "we cannot say what matched" and "nothing matched" are
    // different findings, and only one of them is a hole in the ledger. The tier rides along so the
    // export carries the split the tier plan is weighted by, which the filter text cannot give: a
    // tier is named whether or not its rule file could be read, and one filter can ship in two.
    ledger.record(line ?? null, count, Date.now(), { tier: tier ?? null });

    // A polled record can outlive its tab — `getMatchedRules` reports tabId -1 for one that
    // closed — and the block still happened, so everything above counts it. Only the per-tab
    // telemetry and the badge have nowhere left to go.
    if (!Number.isInteger(match.tabId) || match.tabId < 0) continue;

    const batch = perTab.get(match.tabId) ?? [];
    batch.push({ match, count, priority, source, tier });
    perTab.set(match.tabId, batch);
  }

  // The stored-telemetry half is the part that races, so each tab's read-modify-write is chained
  // onto the last commit for the same tab — two overlapping batches can no longer drop a count.
  for (const [tabId, batch] of perTab) {
    await enqueueTabCommit(tabId, async () => {
      const current =
        (await getTabTelemetry(tabId)) ??
        emptyTabTelemetry(tabId, batch[0].match.url ?? '', batch[0].match.host);
      for (const { match, count, priority, source, tier } of batch) {
        current.blockedRequests += count;
        if (match.host) {
          const existing = current.trackers.find((t) => t.domain === match.host);
          if (existing) {
            existing.blockedCount += count;
            existing.lastSeen = Date.now();
          } else {
            current.trackers.push({
              domain: match.host,
              category: categoryForTier(tier),
              blockedCount: count,
              firstParty: false,
              priority,
              source,
              lastSeen: Date.now(),
            });
          }
        }
      }
      await setTabTelemetry(tabId, current);
      await updateBadge(tabId, current.blockedRequests);
    });
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

// The reporting state: a cursor so a poll cannot count the tail of the previous batch twice, a
// log of live-counted matches so the same poll cannot count a live match again, a log of recent
// calls to stay inside Chrome's quota, and per-tab spacing so a refreshing popup cannot hammer
// the API. The cursor and the live log are persisted in session storage because a suspended
// worker is the normal state of an MV3 build — an in-memory cursor restarting at zero would let
// the first poll after every restart re-count the whole five-minute window.
const matchedRuleCalls: number[] = [];
let matchedRuleCursor = 0;
const liveMatchLog: LiveMatchLog = new Map();
let matchedRuleQuotaWarned = false;
const lastReconcileAt = new Map<number, number>();
const MATCHED_RULES_MIN_INTERVAL_MS = 15_000;
// The `lastReconcileAt` key for an all-tabs poll — tab ids start at 0, so -1 cannot collide.
const ALL_TABS_SCOPE = -1;

const MATCH_STATE_KEY = 'bm_match_state';
const MATCH_STATE_SAVE_MS = 5_000;
let matchStateReady: Promise<void> | null = null;
let matchStateSavedAt = 0;

/** The storage area tab telemetry already prefers: session, falling back to local where absent. */
function matchStateStorage(): typeof chrome.storage.session | undefined {
  return chrome.storage?.session ?? chrome.storage?.local;
}

/**
 * Restores the cursor and the live-match log a previous worker generation left behind. Every
 * caller awaits the same in-flight restore, so a poll arriving mid-restore cannot dedupe against
 * a half-loaded log.
 */
function ensureMatchState(): Promise<void> {
  if (!matchStateReady) matchStateReady = restoreMatchState();
  return matchStateReady;
}

async function restoreMatchState(): Promise<void> {
  try {
    const stored = (await matchStateStorage()?.get(MATCH_STATE_KEY))?.[MATCH_STATE_KEY] as
      | { cursor?: unknown; live?: unknown }
      | undefined;
    const cursor = Number(stored?.cursor);
    if (Number.isFinite(cursor) && cursor > matchedRuleCursor) matchedRuleCursor = cursor;
    if (stored?.live && typeof stored.live === 'object') {
      for (const [key, stamps] of Object.entries(stored.live as Record<string, unknown>)) {
        if (!Array.isArray(stamps)) continue;
        const kept = stamps.filter((s): s is number => Number.isFinite(s));
        if (kept.length === 0) continue;
        liveMatchLog.set(key, [...(liveMatchLog.get(key) ?? []), ...kept].sort((a, b) => a - b));
      }
    }
  } catch {
    // Match accounting is best-effort; a restore failure just means the window is re-read.
  }
}

/**
 * Checkpoints the cursor and the live-match log so a worker restart does not lose the dedup state.
 * Live events throttle themselves — a blocked-request burst writes at most once per interval —
 * while polls always save, since a poll is exactly what the cursor exists to bound.
 */
function persistMatchState(immediate = false): void {
  const now = Date.now();
  if (!immediate && now - matchStateSavedAt < MATCH_STATE_SAVE_MS) return;
  matchStateSavedAt = now;
  const live: Record<string, number[]> = {};
  for (const [key, stamps] of liveMatchLog) {
    if (stamps.length > 0) live[key] = [...stamps];
  }
  void matchStateStorage()
    ?.set({ [MATCH_STATE_KEY]: { cursor: matchedRuleCursor, live } })
    .catch(() => {});
}

/**
 * Reconciles one tab from `getMatchedRules`.
 *
 * `gesture` marks a call the browser ties to a user gesture — the popup asking for telemetry —
 * which is exempt from the quota and, more importantly, the moment `activeTab` is certain to be
 * granted for the tab being asked about.
 */
async function reconcileMatchedRules(
  tabId: number | null,
  options: { gesture?: boolean } = {},
): Promise<number> {
  const api = chrome.declarativeNetRequest;
  if (!api || typeof api.getMatchedRules !== 'function') return 0;
  // `null` is the all-tabs query, which only the feedback permission makes legal — a packed
  // build must name the one tab its `activeTab` grant covers.
  if (tabId === null ? !hasLiveMatchFeedback() : !Number.isInteger(tabId) || tabId < 0) return 0;

  const scope = tabId ?? ALL_TABS_SCOPE;
  const now = Date.now();
  const last = lastReconcileAt.get(scope);
  if (last !== undefined && now - last < MATCHED_RULES_MIN_INTERVAL_MS) return 0;

  if (!options.gesture && !canRequestMatchedRules(matchedRuleCalls, now)) {
    if (!matchedRuleQuotaWarned) {
      matchedRuleQuotaWarned = true;
      console.warn('[MatchedRules] Quota reached; per-tab counts update on the next interval.');
    }
    return 0;
  }

  lastReconcileAt.set(scope, now);
  matchedRuleCalls.push(now);
  // Keep the call log bounded: this worker can outlive thousands of polls.
  const windowStart = now - DEFAULT_MATCHED_RULES_BUDGET.windowMs;
  while (matchedRuleCalls.length > 0 && matchedRuleCalls[0] <= windowStart) matchedRuleCalls.shift();

  let delta;
  try {
    await ensureMatchState();
    const result = await api.getMatchedRules(
      tabId === null
        ? { minTimeStamp: matchedRuleCursor }
        : { tabId, minTimeStamp: matchedRuleCursor },
    );
    const records = readMatchedRuleRecords(result);
    // The live debug path may already have counted some of these — the poll cannot see its own
    // blind spots, so a record is only fresh when no live arrival claimed the same match.
    delta = summarizeMatches(dedupePolledRecords(records, liveMatchLog), matchedRuleCursor);
    // The cursor advances over every record the browser returned, including deduplicated ones —
    // they were counted, just on the other path, and re-reading them only makes the next poll
    // repeat this same dedup work.
    delta.cursor = records.reduce(
      (cursor, record) => Math.max(cursor, record.timeStamp),
      delta.cursor,
    );
  } catch (err) {
    // No `activeTab` grant for this tab, or the quota was already exhausted.
    console.warn('[MatchedRules] Could not read matched rules:', err);
    return 0;
  }

  matchedRuleCursor = delta.cursor;
  persistMatchState(true);

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

/**
 * Reconciles whatever the build can see — every open tab when the feedback permission makes the
 * all-tabs query legal, else just the active tab an `activeTab` grant can cover. Scoping to the
 * active tab on an unpacked build would leave background tabs' blocks uncounted even though the
 * same one call could have recovered them. The poll costs quota, so it stays on the telemetry
 * interval rather than shadowing the live event.
 */
async function reconcileRecentMatches(): Promise<void> {
  try {
    if (hasLiveMatchFeedback()) {
      await reconcileMatchedRules(null);
      return;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (typeof tabId === 'number' && tabId >= 0) await reconcileMatchedRules(tabId);
  } catch {
    // Best effort: the popup reconciles on demand as well.
  }
}

// Unpacked builds get the real thing while the worker runs: every match, live, with the request
// URL attached. Delivery across a wake is lossy, so each live match is also logged here for the
// poll to deduplicate against — what the live listener missed is exactly what the poll recovers,
// and this log is what keeps the recovery from counting the live half again.
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

    // The stamp is written before anything awaits: a poll that passes in between must already
    // see this match as live-counted, or the same block counts once here and once there.
    recordLiveMatch(
      liveMatchLog,
      liveMatchKey(tabId, info.rule?.rulesetId, info.rule?.ruleId),
      Date.now(),
    );
    void ensureMatchState()
      .then(() => {
        persistMatchState();
        return applyMatches([
          { tabId, url, host, ruleId: info.rule?.ruleId, rulesetId: info.rule?.rulesetId },
        ]);
      })
      .catch(() => {});
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
        // is what makes the call legal in a packed build in the first place. A feedback build has
        // no grant to wait for, so the same one call reconciles every open tab instead.
        reconcileMatchedRules(hasLiveMatchFeedback() ? null : tabId, { gesture: true })
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
      Promise.all([Mv3Guard.getQuotaStatus(), loadRuleSource()]).then(([data, ruleSource]) =>
        sendResponse({ success: true, data: { ...data, ruleSource } }),
      );
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

    // The redundancy read the tier card shows — the same diff the hub and CLI report, answered
    // against the dynamic rules the browser actually holds rather than the list's source text.
    // Read-only on purpose: opening the popup asks a question, and a question must not reconcile
    // anything. A refusal to list the rules becomes `synced: null` inside a successful report,
    // not an error, because "could not look" is a displayable state.
    case 'GET_TIER_REDUNDANCY': {
      const rulesPromise = (
        chrome.declarativeNetRequest?.getDynamicRules() ?? Promise.resolve(null)
      ).catch(() => null);
      // The filters the user's own rules plan into — the provenance record. Custom rules share
      // the list's priority band on purpose, so the recorded patterns are the only way the read
      // can name a hand-typed rule as the user's rather than the list's. A storage refusal here
      // loses the split, not the read: `userPatterns` stays undefined and every rule reads as
      // list-derived, which is the pre-split answer rather than a wrong one.
      const userPatternsPromise = Promise.all([loadCustomRules(), loadSiteControl()])
        .then(
          ([customRules, control]) =>
            new Set(planListRules([...customRules], control).rules.map((rule) => rule.pattern)),
        )
        .catch(() => undefined);
      Promise.all([rulesPromise, userPatternsPromise])
        .then(([rules, userPatterns]) =>
          computeTierRedundancy({ rules, userPatterns, readTier: readTierFile }),
        )
        .then((report) => sendResponse({ success: true, report }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    // Reads the browser and repairs it to the state it should be in — the saved selection while
    // blocking is active, silence while it is paused everywhere. `GET_RULESET_TIERS` can only
    // report a disagreement; this is the call that can end one, which is why the drift notice
    // offers it as a button rather than repairing behind the user's back.
    case 'RECONCILE_RULESET_TIERS':
      loadSiteControl()
        .then((control) => rulesets.setSuspended(control.globalPaused))
        .then(() => rulesets.status())
        .then((status) => sendResponse({ success: true, status }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;

    // The dynamic half of the same repair: read the browser, install what storage says should
    // be enforced, and answer with a view read *after* the repair — a view read first would
    // still show the drift it just fixed, or promise a fix that never ran. The notice's button
    // is the only caller; the popup's reads stay read-only.
    case 'RECONCILE_SITE_CONTROL':
      loadSiteControl()
        .then(() => reconcileDynamicRules())
        .then(() => siteControlView(message.payload?.url))
        .then((view) => sendResponse({ success: true, view }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
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
      // The ledger is read from the popup, so fold in whatever the browser has matched since the
      // last read before answering.
      reconcileRecentMatches()
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

    // The element corpus is hand-written, which is how it came to miss 52 wrong verdicts
    // across five real pages (`docs/element-classifier-live-scan.md`). These two messages
    // are the other half of that: content scripts push what they saw, and the hub drains
    // the buffer into the candidate queue. Nothing here labels anything — a record
    // carries a label only if a person made a decision about that element.
    case 'HARVEST_ELEMENTS':
      storeHarvestRecords(message.payload?.records).then((kept) =>
        sendResponse({ success: true, kept }),
      );
      return true;

    case 'EXPORT_ELEMENT_HARVEST': {
      // Reading the buffer and taking it are separate, the way they are for the hit
      // ledger: the popup asks what an export would cover every time it opens, and a
      // preview that drained would make the count on screen unexportable.
      const take = message.payload?.drain === true;
      const pending = take ? exportElementHarvest() : previewElementHarvest();
      pending.then(
        (payload) => sendResponse({ success: true, ...payload }),
        (err) => sendResponse({ success: false, error: String(err) }),
      );
      return true;
    }

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
        .then(async () =>
          sendResponse({ success: true, view: await siteControlView(message.payload?.url) }),
        )
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
        .then(async () =>
          sendResponse({ success: true, view: await siteControlView(message.payload?.url) }),
        )
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }

    case 'SET_GLOBAL_PAUSE':
      mutateSiteControl((current) => setGlobalPaused(current, message.payload?.paused === true))
        .then(() => applyCurrentRules())
        .then(async () =>
          sendResponse({ success: true, view: await siteControlView(message.payload?.url) }),
        )
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
        .then(async () =>
          sendResponse({
            success: true,
            rule: allowed ? `@@||${domain}^` : null,
            view: await siteControlView(message.payload?.url),
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
          const pageUrl = sender.tab?.url || '';
          const current =
            data || emptyTabTelemetry(senderTabId, pageUrl, siteFromUrl(pageUrl) || '');
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
      haBridge.saveConfig(message.payload || {}).then((cfg) => {
        void applyHubConfig();
        sendResponse({ success: true, config: cfg });
      });
      return true;

    case 'TEST_HA_CONNECTION':
      haBridge
        .testConnection(message.payload?.url, message.payload?.token, message.payload?.feedToken)
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
