import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  HomeAssistantConfig,
  SiteControlView,
  TabTelemetry,
  TrackerDetection,
} from '../shared/types.js';
import { ElementScanPanel, type ElementScanResult } from './ElementScanPanel.js';
import { LedgerStatusCard } from './LedgerStatusCard.js';
import type { LedgerStatus } from '../shared/ledgerStatus.js';
import { formatTierCapacity, type StaticTierStatus } from '../shared/rulesetTiers.js';
import { formatTierPlan, planTierSelection } from '../shared/tierPlanner.js';
import {
  buildTierBlocking,
  formatTierBlocking,
  type TierBlockingView,
  type TierHitCounts,
} from '../shared/tierAttribution.js';

import {
  deriveShieldStatus,
  filterTrackers,
  formatBlockedCount,
  isDomainAllowed,
  resolveSitePaused,
  shieldStatusDetail,
  shieldStatusLabel,
  siteFromUrl,
  sortTrackers,
  type ShieldStatus,
  type TrackerSortMode,
} from '../shared/siteControl.js';

interface Mv3QuotaInfo {
  dynamicRulesCount: number;
  maxDynamicRules: number;
  isWithinQuota: boolean;
  utilizationPercent: number;
}

function sendMessage<T = any>(message: any): Promise<T> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        // Reading lastError marks it handled, which keeps the console clean when
        // the service worker is asleep or was just reloaded.
        void chrome.runtime.lastError;
        resolve(response as T);
      });
    } catch {
      resolve({ success: false } as T);
    }
  });
}

function emptyTelemetry(tabId: number, url: string, domain: string): TabTelemetry {
  return {
    tabId,
    url,
    domain,
    blockedRequests: 0,
    blockedDomains: 0,
    elementsHidden: 0,
    trackers: [],
    scriptletsApplied: [],
  };
}

function relativeTime(epochMs: number | null): string {
  if (!epochMs) return 'never';
  const delta = Date.now() - epochMs;
  if (delta < 15_000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

const CATEGORY_COLORS: Record<TrackerDetection['category'], string> = {
  advertising: '#f97316',
  tracker: '#06b6d4',
  telemetry: '#a78bfa',
  malware: '#ef4444',
  unknown: '#94a3b8',
};

export const PopupApp: React.FC = () => {
  const [tab, setTab] = useState<'shield' | 'hub'>('shield');
  const [tabId, setTabId] = useState<number | null>(null);
  const [pageUrl, setPageUrl] = useState<string>('');
  const [telemetry, setTelemetry] = useState<TabTelemetry | null>(null);
  const [view, setView] = useState<SiteControlView | null>(null);

  const [mv3Status, setMv3Status] = useState<Mv3QuotaInfo | null>(null);
  const [ledgerStatus, setLedgerStatus] = useState<LedgerStatus | null>(null);
  const [sseStatus, setSseStatus] = useState<'connected' | 'connecting' | 'disconnected'>(
    'disconnected',
  );
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [ruleCount, setRuleCount] = useState(0);

  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<TrackerSortMode>('count');
  const [showDecisions, setShowDecisions] = useState(false);

  const [aiScan, setAiScan] = useState<ElementScanResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const [tierStatus, setTierStatus] = useState<StaticTierStatus | null>(null);
  const [tierHits, setTierHits] = useState<TierHitCounts>({});
  const [tierBusy, setTierBusy] = useState<string | null>(null);

  const [haConfig, setHaConfig] = useState<HomeAssistantConfig>({
    enabled: false,
    url: 'http://homeassistant.local:8123',
    token: '',
    feedUrl: 'http://127.0.0.1:9191/browser.txt',
    cosmeticsEnabled: true,
    autoSync: true,
  });
  const [testResult, setTestResult] = useState<string | null>(null);

  const flash = useCallback((text: string, tone: 'ok' | 'warn' = 'ok') => {
    setToast({ text, tone });
  }, []);

  /** Asks the page's element Mini-AI what it would act on, without acting. */
  const runAiScan = useCallback(async () => {
    setAiBusy(true);
    try {
      const res = await sendMessage<{ success?: boolean; error?: string } & ElementScanResult>({
        type: 'SCAN_PAGE_FOR_ADS',
      });
      if (!res?.success) {
        flash(res?.error ?? 'This page cannot be scanned by the element AI.', 'warn');
        return;
      }
      setAiScan({
        scanned: res.scanned ?? 0,
        hideCount: res.hideCount ?? 0,
        suggestCount: res.suggestCount ?? 0,
        groups: res.groups ?? [],
      });
    } finally {
      setAiBusy(false);
    }
  }, [flash]);

  const highlightAiFindings = useCallback(async () => {
    const res = await sendMessage({ type: 'HIGHLIGHT_AI_CANDIDATES' });
    flash(res?.success ? 'Outlined on the page — click one to block it.' : 'Could not outline them.', res?.success ? 'ok' : 'warn');
  }, [flash, setAiScan]);

  const blockAiFindings = useCallback(
    async (selectors?: string[]) => {
      setAiBusy(true);
      try {
        const res = await sendMessage({
          type: 'BLOCK_AI_CANDIDATES',
          payload: selectors ? { selectors } : undefined,
        });
        const blocked = typeof res?.blocked === 'number' ? res.blocked : 0;
        flash(blocked > 0 ? `Hid ${blocked} element group${blocked === 1 ? '' : 's'}.` : 'Nothing was hidden.', blocked > 0 ? 'ok' : 'warn');
        if (blocked > 0) void runAiScan();
      } finally {
        setAiBusy(false);
      }
    },
    [flash, runAiScan],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  /**
   * What each tier has actually blocked, read off the ledger rather than computed here.
   *
   * Fetched together with the tiers themselves because a toggle is exactly the moment the
   * attribution is worth re-reading: switching a tier on clears its stale counts in the
   * background, so the number that comes back is about the window that tier has actually had.
   */
  const refreshTierHits = useCallback(async () => {
    const res = await sendMessage({ type: 'GET_RULE_HIT_STATS' });
    if (res?.success && res.data?.tiers) setTierHits(res.data.tiers as TierHitCounts);
  }, []);

  /** Static ruleset tiers — shipped rules that never consume the dynamic quota. */
  const refreshTiers = useCallback(async () => {
    const res = await sendMessage({ type: 'GET_RULESET_TIERS' });
    if (res?.success && res.status) setTierStatus(res.status as StaticTierStatus);
    await refreshTierHits();
  }, [refreshTierHits]);

  const refreshStatus = useCallback(async () => {
    const [sse, mv3, ledger] = await Promise.all([
      sendMessage({ type: 'GET_SSE_STATUS' }),
      sendMessage({ type: 'GET_MV3_STATUS' }),
      sendMessage({ type: 'GET_LEDGER_STATUS' }),
    ]);
    if (sse?.status) setSseStatus(sse.status);
    if (typeof sse?.lastSyncAt === 'number') setLastSyncAt(sse.lastSyncAt);
    if (typeof sse?.ruleCount === 'number') setRuleCount(sse.ruleCount);
    if (mv3?.data) setMv3Status(mv3.data);
    if (ledger?.status) setLedgerStatus(ledger.status as LedgerStatus);
  }, []);

  const refreshTab = useCallback(async (id: number, url: string) => {
    const [telemetryRes, controlRes] = await Promise.all([
      sendMessage({ type: 'GET_TAB_TELEMETRY', payload: { tabId: id } }),
      sendMessage({ type: 'GET_SITE_CONTROL', payload: { url } }),
    ]);

    const site = siteFromUrl(url) || '';
    setTelemetry(telemetryRes?.data ?? emptyTelemetry(id, url, site));
    if (controlRes?.view) setView(controlRes.view);
  }, []);

  useEffect(() => {
    let mounted = true;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!mounted) return;
      const active = tabs[0];
      if (active?.id) {
        setTabId(active.id);
        setPageUrl(active.url || '');
        void refreshTab(active.id, active.url || '');
      } else {
        setView({
          globalPaused: false,
          site: null,
          sitePaused: false,
          pausedSites: [],
          allowedDomains: [],
        });
      }
    });

    void refreshStatus();
    void refreshTiers();
    sendMessage({ type: 'GET_HA_CONFIG' }).then((res) => {
      if (mounted && res?.config) setHaConfig(res.config);
    });

    return () => {
      mounted = false;
    };
  }, [refreshStatus, refreshTab]);

  const site = view?.site || siteFromUrl(pageUrl);
  // One resolver for both the header and the switch, so the two can never
  // contradict each other.
  const sitePaused = resolveSitePaused(view, site);
  const shieldStatus: ShieldStatus = view ? deriveShieldStatus(view, site) : 'active';

  const trackers = useMemo(() => {
    const list = telemetry?.trackers ?? [];
    return sortTrackers(filterTrackers(list, query), sortMode);
  }, [telemetry, query, sortMode]);

  const blockedOnPage = telemetry?.blockedRequests ?? 0;
  const domainsOnPage = telemetry?.blockedDomains ?? 0;
  const hiddenOnPage = telemetry?.elementsHidden ?? 0;

  // ─── Actions ────────────────────────────────────────────────────────────────

  const applyViewResult = useCallback(
    (res: any) => {
      if (res?.success && res.view) setView(res.view);
      void refreshStatus();
      if (tabId !== null) void refreshTab(tabId, pageUrl);
    },
    [refreshStatus, refreshTab, tabId, pageUrl],
  );

  const handleToggleSite = useCallback(async () => {
    if (!site) return;
    setBusy('site');
    const next = !sitePaused;
    const res = await sendMessage({
      type: 'TOGGLE_SITE_BLOCKING',
      payload: { url: pageUrl, paused: next },
    });
    applyViewResult(res);
    if (res?.success) {
      flash(next ? `Blocking paused on ${site}` : `Blocking resumed on ${site}`, next ? 'warn' : 'ok');
    }
    setBusy(null);
  }, [site, sitePaused, pageUrl, applyViewResult, flash]);

  const handleToggleGlobal = useCallback(async () => {
    setBusy('global');
    const next = !view?.globalPaused;
    const res = await sendMessage({ type: 'SET_GLOBAL_PAUSE', payload: { paused: next, url: pageUrl } });
    applyViewResult(res);
    if (res?.success) {
      flash(next ? 'Blocking paused on all sites' : 'Blocking active on all sites', next ? 'warn' : 'ok');
    }
    setBusy(null);
  }, [view?.globalPaused, pageUrl, applyViewResult, flash]);

  const handleToggleDomain = useCallback(
    async (domain: string) => {
      const allowed = view ? isDomainAllowed(view, domain) : false;
      setBusy(domain);
      const res = await sendMessage({
        type: 'SET_DOMAIN_ALLOWED',
        payload: { domain, allowed: !allowed, url: pageUrl },
      });
      applyViewResult(res);
      if (res?.success) {
        flash(allowed ? `Blocking ${domain} again` : `${domain} is now allowed`);
      }
      setBusy(null);
    },
    [view, pageUrl, applyViewResult, flash],
  );

  const handleSync = useCallback(async () => {
    setSyncing(true);
    const res = await sendMessage({ type: 'SYNC_RULES_NOW' });
    await refreshStatus();
    if (tabId !== null) await refreshTab(tabId, pageUrl);
    setSyncing(false);
    flash(res?.success ? `Rules synced (${res.count?.toLocaleString?.() ?? 0} active)` : 'Sync failed', res?.success ? 'ok' : 'warn');
  }, [refreshStatus, refreshTab, tabId, pageUrl, flash]);

  const handleToggleTier = useCallback(
    async (id: string, label: string, enabled: boolean) => {
      setTierBusy(id);
      const res = await sendMessage({ type: 'SET_RULESET_TIER', payload: { id, enabled } });
      if (!res?.success) {
        flash(res?.error ?? `Could not ${enabled ? 'enable' : 'disable'} ${label}.`, 'warn');
      } else {
        flash(`${label} ${enabled ? 'enabled' : 'disabled'}`);
      }
      await refreshTiers();
      setTierBusy(null);
    },
    [flash, refreshTiers],
  );

  /**
   * The capacity-aware plan: which tiers are worth keeping on, given the static slots the
   * browser is *actually* granting and how full the synced list is.
   *
   * Recomputed from live status rather than assuming the guaranteed 30,000, because that
   * figure is a floor drawn from a pool shared with every other installed extension — when it
   * is congested, the tiers no longer all fit and something has to give.
   */
  const tierPlan = useMemo(() => {
    if (!tierStatus) return null;
    return planTierSelection({
      tiers: tierStatus.tiers.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        ruleCount: candidate.ruleCount,
      })),
      enabledRuleCount: tierStatus.enabledRules,
      availableStaticRules: tierStatus.availableStaticRules,
      dynamic: mv3Status
        ? { used: mv3Status.dynamicRulesCount, max: mv3Status.maxDynamicRules }
        : null,
      suspended: tierStatus.suspended,
      currentEnabled: tierStatus.tiers.filter((candidate) => candidate.enabled).map((c) => c.id),
    });
  }, [tierStatus, mv3Status]);

  /**
   * How much each tier has really blocked.
   *
   * Graded from the ledger instead of from rule counts, which is the whole point: a tier shipping
   * thousands of rules that has never fired looks exactly like a valuable one if all you show is
   * how many rules it carries. The verdicts are gated on there being enough traffic to judge, so a
   * freshly enabled tier is reported as unproven rather than idle.
   */
  const tierBlocking = useMemo(() => {
    if (!tierStatus) return null;
    return buildTierBlocking({
      tiers: tierStatus.tiers.map((tier) => ({
        id: tier.id,
        label: tier.label,
        category: tier.category,
      })),
      enabledIds: tierStatus.tiers.filter((tier) => tier.enabled).map((tier) => tier.id),
      hits: tierHits,
    });
  }, [tierStatus, tierHits]);

  const tierUsage = useMemo(() => {
    const byId = new Map<string, TierBlockingView>();
    for (const view of tierBlocking?.tiers ?? []) byId.set(view.id, view);
    return byId;
  }, [tierBlocking]);

  const tierBlockTotalHits = tierBlocking?.totalHits ?? 0;

  const handleApplyTierPlan = useCallback(async () => {
    if (!tierPlan) return;
    setTierBusy('__plan__');
    const res = await sendMessage({
      type: 'SET_RULESET_TIERS',
      payload: { ids: tierPlan.enabled },
    });
    if (res?.success) {
      flash(`Plan applied — ${tierPlan.enabledRules.toLocaleString()} rules active`);
    } else {
      flash(res?.error ?? 'Could not apply the plan', 'warn');
    }
    await refreshTiers();
    setTierBusy(null);
  }, [tierPlan, flash, refreshTiers]);

  const handlePicker = useCallback(async () => {
    await sendMessage({ type: 'START_ELEMENT_PICKER' });
    window.close();
  }, []);

  const handleSaveHaConfig = useCallback(async () => {
    setTestResult('Saving…');
    const res = await sendMessage({ type: 'SET_HA_CONFIG', payload: haConfig });
    if (res?.config) setHaConfig(res.config);
    setTestResult('Saved.');
    setTimeout(() => setTestResult(null), 2200);
  }, [haConfig]);

  const handlePushTelemetry = useCallback(async () => {
    await sendMessage({ type: 'REPORT_BROWSER_TELEMETRY' });
    setTestResult('Telemetry pushed to hub.');
    setTimeout(() => setTestResult(null), 2200);
  }, []);

  // ─── Render ─────────────────────────────────────────────────────────────────

  const statusTone =
    shieldStatus === 'active' ? 'ok' : shieldStatus === 'site-paused' ? 'warn' : 'off';

  return (
    <div className="popup-container">
      <header className="popup-header">
        <div className="brand-row">
          <span className={`status-dot ${statusTone}`} aria-hidden />
          <span className="brand-title">Blockingmachine</span>
        </div>
        <button
          className={`live-chip ${sseStatus}`}
          onClick={() => void handleSync()}
          title={
            sseStatus === 'connected'
              ? `Live hub stream connected · last sync ${relativeTime(lastSyncAt)} · click to re-sync`
              : 'No live hub stream — click to sync rules manually'
          }
        >
          <span className="live-dot" />
          {sseStatus === 'connected' ? 'Live' : sseStatus}
        </button>
      </header>

      <nav className="nav-tabs">
        <button
          className={`nav-tab ${tab === 'shield' ? 'active' : ''}`}
          onClick={() => setTab('shield')}
        >
          Shield
        </button>
        <button className={`nav-tab ${tab === 'hub' ? 'active' : ''}`} onClick={() => setTab('hub')}>
          Hub &amp; Home Assistant
        </button>
      </nav>

      {tab === 'shield' ? (
        <>
          <section className={`protection-card ${statusTone}`}>
            <div className="protection-main">
              <div>
                <div className="protection-status">{shieldStatusLabel(shieldStatus)}</div>
                <div className="protection-detail">{shieldStatusDetail(shieldStatus, site)}</div>
              </div>
              {site && (
                <label className={`switch ${view?.globalPaused ? 'disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={!sitePaused}
                    disabled={!!view?.globalPaused || busy === 'site'}
                    onChange={() => void handleToggleSite()}
                  />
                  <span className="track" />
                </label>
              )}
            </div>
            <div className="protection-footer">
              <span className="protection-site" title={pageUrl}>
                {site || 'This page'}
              </span>
              <button
                className="link-btn"
                disabled={busy === 'global'}
                onClick={() => void handleToggleGlobal()}
              >
                {view?.globalPaused ? 'Resume everywhere' : 'Pause everywhere'}
              </button>
            </div>
          </section>

          <div className="metrics-grid">
            <div className="metric-card">
              <span className="metric-label">Blocked</span>
              <span className="metric-value">{formatBlockedCount(blockedOnPage)}</span>
              <span className="metric-sub">requests</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Domains</span>
              <span className="metric-value">{formatBlockedCount(domainsOnPage)}</span>
              <span className="metric-sub">blocked here</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Hidden</span>
              <span className="metric-value">{formatBlockedCount(hiddenOnPage)}</span>
              <span className="metric-sub">elements</span>
            </div>
          </div>

          <ElementScanPanel
            scan={aiScan}
            busy={aiBusy}
            onScan={() => void runAiScan()}
            onHide={(selectors) => void blockAiFindings(selectors)}
            onHighlight={() => void highlightAiFindings()}
          />

          <section className="trackers-section">
            <div className="section-head">
              <span className="section-title">
                Blocked here {trackers.length > 0 && <em>({trackers.length})</em>}
              </span>
              <button
                className="chip-btn"
                onClick={() => setSortMode(sortMode === 'count' ? 'name' : 'count')}
                title="Switch sort order"
              >
                {sortMode === 'count' ? 'Most blocked' : 'A–Z'}
              </button>
            </div>

            {(telemetry?.trackers.length ?? 0) > 4 && (
              <input
                className="form-input search-input"
                placeholder="Filter domains…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}

            <div className="tracker-list">
              {trackers.length > 0 ? (
                trackers.map((t) => {
                  const allowed = view ? isDomainAllowed(view, t.domain) : false;
                  return (
                    <div key={t.domain} className={`tracker-item ${allowed ? 'allowed' : ''}`}>
                      <span
                        className="category-dot"
                        style={{ background: CATEGORY_COLORS[t.category] ?? CATEGORY_COLORS.unknown }}
                        title={t.category}
                      />
                      <span className="tracker-domain" title={t.domain}>
                        {t.domain}
                      </span>
                      {t.source === 'user' && <span className="origin-tag">your rule</span>}
                      <span className={`tracker-count ${allowed ? 'muted' : ''}`}>
                        {allowed ? 'allowed' : formatBlockedCount(t.blockedCount)}
                      </span>
                      <button
                        className="row-action"
                        disabled={busy === t.domain}
                        onClick={() => void handleToggleDomain(t.domain)}
                        title={
                          allowed
                            ? `Block ${t.domain} again (remove the allowance)`
                            : `Allow ${t.domain} everywhere`
                        }
                      >
                        {allowed ? 'Block' : 'Allow'}
                      </button>
                    </div>
                  );
                })
              ) : (
                <div className="empty-state">
                  {(telemetry?.trackers.length ?? 0) > 0
                    ? 'No domains match your filter.'
                    : 'Nothing blocked on this page yet.'}
                </div>
              )}
            </div>
          </section>

          <div className="popup-footer">
            <button
              className="action-btn primary"
              onClick={() => void handlePicker()}
              title="Click any ad container on the page to hide it. While picking: ↑ parent · ↓ child · S similar · Esc cancel"
            >
              🎯 Pick element
            </button>
            <button className="action-btn" onClick={() => void handleSync()} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync rules'}
            </button>
          </div>

          <p className="hint-line">
            Right-click anything on the page to block that element, its domain, or an exact URL.
          </p>
        </>
      ) : (
        <>
          <section className="settings-card">
            <div className="card-title">
              <span>Hub connection</span>
              <span className={`mini-status ${sseStatus === 'connected' ? 'ok' : 'off'}`}>
                {sseStatus === 'connected' ? 'Live' : sseStatus}
              </span>
            </div>
            <div className="kv-row">
              <span>Last rule sync</span>
              <strong>{relativeTime(lastSyncAt)}</strong>
            </div>
            <div className="kv-row">
              <span>Dynamic rules</span>
              <strong>
                {mv3Status
                  ? `${mv3Status.dynamicRulesCount.toLocaleString()} / ${mv3Status.maxDynamicRules.toLocaleString()}`
                  : ruleCount.toLocaleString()}
              </strong>
            </div>
            {mv3Status && (
              <div className="quota-bar" title={`${mv3Status.utilizationPercent}% of the MV3 quota`}>
                <span
                  className={mv3Status.isWithinQuota ? 'ok' : 'warn'}
                  style={{ width: `${Math.min(100, mv3Status.utilizationPercent)}%` }}
                />
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Feed server URL</label>
              <input
                className="form-input"
                type="text"
                value={haConfig.feedUrl}
                onChange={(e) => setHaConfig({ ...haConfig, feedUrl: e.target.value })}
              />
            </div>
          </section>

          <LedgerStatusCard status={ledgerStatus} />

          <section className="settings-card">
            <div className="card-title">
              <span>Static rule tiers</span>
              <span className={`mini-status ${tierStatus && tierStatus.enabledTiers > 0 ? 'ok' : 'off'}`}>
                {tierStatus ? `${tierStatus.enabledTiers} of ${tierStatus.totalTiers} on` : 'Loading…'}
              </span>
            </div>
            <p className="card-hint">
              Shipped rulesets you switch on and off. They run alongside the synced rules and never
              count against the dynamic-rule quota, so a tier can add blocking the quota has no room
              for — and a disabled tier costs nothing at all.
            </p>

            {tierStatus && (
              <>
                <div className="ai-summary">
                  {formatTierCapacity(tierStatus)}
                  <span className="ai-summary-sub">{tierStatus.totalRules} shipped</span>
                </div>

                {tierBlocking && (
                  <div className="tier-usage-summary">
                    {formatTierBlocking(tierBlocking)}
                    {!tierBlocking.observed && (
                      <em>
                        {' '}
                        — not enough real traffic yet to tell an idle tier from an untested one
                      </em>
                    )}
                  </div>
                )}

                {tierPlan && (
                  <div className="tier-plan">
                    <div className="tier-plan-head">
                      <span className="tier-plan-title">Recommended plan</span>
                      {tierPlan.differsFromCurrent ? (
                        <button
                          type="button"
                          className="tier-plan-apply"
                          disabled={tierBusy === '__plan__'}
                          onClick={() => void handleApplyTierPlan()}
                        >
                          {tierBusy === '__plan__' ? 'Applying…' : 'Apply'}
                        </button>
                      ) : (
                        <span className="tier-plan-ok">Matches current</span>
                      )}
                    </div>
                    <div className="tier-plan-summary">{formatTierPlan(tierPlan)}</div>
                    <ul className="tier-plan-why">
                      {tierPlan.explanation.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {tierStatus.suspended && (
                  <div className="tier-note">
                    Silenced while blocking is paused everywhere — your selection comes back when you
                    resume.
                  </div>
                )}

                <div className="tier-list">
                  {tierStatus.tiers.map((tier) => {
                    const usage = tierUsage.get(tier.id);
                    return (
                      <div key={tier.id} className={`tier-row tone-${tier.category}`}>
                        <div className="tier-main">
                          <span className="tier-label">
                            {tier.label}
                            <em className="tier-count">{tier.ruleCount}</em>
                          </span>
                          <span className="tier-desc">{tier.description}</span>
                          {usage?.verdict === 'productive' && (
                            <span className="tier-usage">
                              {usage.hits.toLocaleString()} blocked · {Math.round(usage.share * 100)}%
                              of all tier blocks
                            </span>
                          )}
                          {usage?.verdict === 'idle' && (
                            <span className="tier-usage idle">
                              Never fired in {tierBlockTotalHits.toLocaleString()} tier blocks
                              <button
                                type="button"
                                className="tier-drop"
                                disabled={tierBusy === tier.id}
                                onClick={() => void handleToggleTier(tier.id, tier.label, false)}
                              >
                                Turn off
                              </button>
                            </span>
                          )}
                        </div>
                        <label className={`switch small ${tierBusy === tier.id ? 'disabled' : ''}`}>
                          <input
                            type="checkbox"
                            checked={tier.enabled}
                            disabled={tierBusy === tier.id}
                            onChange={(e) =>
                              void handleToggleTier(tier.id, tier.label, e.target.checked)
                            }
                          />
                          <span className="track" />
                        </label>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>

          <section className="settings-card">
            <div className="card-title">
              <span>Home Assistant bridge</span>
              <span className={`mini-status ${haConfig.enabled ? 'ok' : 'off'}`}>
                {haConfig.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>

            <div className="toggle-row">
              <span>Sync with Home Assistant</span>
              <label className="switch small">
                <input
                  type="checkbox"
                  checked={haConfig.enabled}
                  onChange={(e) => setHaConfig({ ...haConfig, enabled: e.target.checked })}
                />
                <span className="track" />
              </label>
            </div>

            <div className="form-group">
              <label className="form-label">Home Assistant URL</label>
              <input
                className="form-input"
                type="text"
                placeholder="http://homeassistant.local:8123"
                value={haConfig.url}
                onChange={(e) => setHaConfig({ ...haConfig, url: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Long-lived access token</label>
              <input
                className="form-input"
                type="password"
                placeholder="Paste token (optional)"
                value={haConfig.token}
                onChange={(e) => setHaConfig({ ...haConfig, token: e.target.value })}
              />
            </div>

            <div className="toggle-row">
              <span>Cosmetic element shield</span>
              <label className="switch small">
                <input
                  type="checkbox"
                  checked={haConfig.cosmeticsEnabled}
                  onChange={(e) => setHaConfig({ ...haConfig, cosmeticsEnabled: e.target.checked })}
                />
                <span className="track" />
              </label>
            </div>
          </section>

          <section className="settings-card">
            <button className="collapse-head" onClick={() => setShowDecisions((v) => !v)}>
              <span>Your decisions</span>
              <span className="mini-status off">
                {view?.pausedSites.length ?? 0} paused · {view?.allowedDomains.length ?? 0} allowed
              </span>
              <span className={`caret ${showDecisions ? 'open' : ''}`}>▾</span>
            </button>

            {showDecisions && (
              <div className="decisions">
                <div className="decisions-group">
                  <span className="section-title">Paused sites</span>
                  {(view?.pausedSites.length ?? 0) === 0 ? (
                    <div className="empty-state small">No sites paused.</div>
                  ) : (
                    view?.pausedSites.map((pausedSite) => (
                      <div key={pausedSite} className="decision-row">
                        <span className="decision-name">{pausedSite}</span>
                        <button
                          className="row-action"
                          onClick={async () => {
                            const res = await sendMessage({
                              type: 'TOGGLE_SITE_BLOCKING',
                              payload: { site: pausedSite, paused: false, url: pageUrl },
                            });
                            applyViewResult(res);
                          }}
                        >
                          Resume
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <div className="decisions-group">
                  <span className="section-title">Allowed domains</span>
                  {(view?.allowedDomains.length ?? 0) === 0 ? (
                    <div className="empty-state small">No domains allowed.</div>
                  ) : (
                    view?.allowedDomains.map((domain) => (
                      <div key={domain} className="decision-row">
                        <span className="decision-name">{domain}</span>
                        <button
                          className="row-action"
                          onClick={async () => {
                            const res = await sendMessage({
                              type: 'SET_DOMAIN_ALLOWED',
                              payload: { domain, allowed: false, url: pageUrl },
                            });
                            applyViewResult(res);
                          }}
                        >
                          Block
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </section>

          <div className="popup-footer">
            <button className="action-btn primary" onClick={() => void handleSaveHaConfig()}>
              Save
            </button>
            <button className="action-btn" onClick={() => void handlePushTelemetry()}>
              Push telemetry
            </button>
          </div>

          {testResult && <div className="inline-note">{testResult}</div>}
        </>
      )}

      {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    </div>
  );
};
