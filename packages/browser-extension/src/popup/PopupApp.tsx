import React, { useEffect, useState } from 'react';
import { TabTelemetry, TrackerDetection } from '../shared/types.js';

interface Mv3QuotaInfo {
  dynamicRulesCount: number;
  maxDynamicRules: number;
  isWithinQuota: boolean;
  utilizationPercent: number;
}

function extractDomain(rawUrl?: string): string {
  if (!rawUrl) return 'Current Page';
  try {
    const u = new URL(rawUrl);
    if (u.protocol.startsWith('http')) return u.hostname;
    return `${u.protocol.replace(':', '')} internal`;
  } catch {
    return 'Active Tab';
  }
}

export const PopupApp: React.FC = () => {
  const [telemetry, setTelemetry] = useState<TabTelemetry | null>(null);
  const [mv3Status, setMv3Status] = useState<Mv3QuotaInfo | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let isMounted = true;

    // Fetch MV3 compliance quota status
    chrome.runtime.sendMessage({ type: 'GET_MV3_STATUS' }, (res) => {
      if (res?.data && isMounted) {
        setMv3Status(res.data);
      }
    });

    // Query active tab telemetry
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (!activeTab?.id || !isMounted) return;

      const domain = extractDomain(activeTab.url);

      chrome.runtime.sendMessage(
        { type: 'GET_TAB_TELEMETRY', payload: { tabId: activeTab.id } },
        (response) => {
          if (!isMounted) return;
          if (response?.data) {
            setTelemetry(response.data);
          } else {
            setTelemetry({
              tabId: activeTab.id!,
              url: activeTab.url || '',
              domain,
              totalRequests: 0,
              blockedRequests: 0,
              trackers: [],
              scriptletsApplied: ['google-funding-choices', 'generic-defusers']
            });
          }
        }
      );
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const handleSyncNow = () => {
    setSyncing(true);
    chrome.runtime.sendMessage({ type: 'SYNC_RULES_NOW' }, () => {
      setSyncing(false);
      // Refresh MV3 quota after sync
      chrome.runtime.sendMessage({ type: 'GET_MV3_STATUS' }, (res) => {
        if (res?.data) setMv3Status(res.data);
      });
    });
  };

  const handleWhitelistSite = async () => {
    if (!telemetry?.domain || telemetry.domain.includes('internal')) return;
    const rule = `@@||${telemetry.domain}^`;
    try {
      await navigator.clipboard.writeText(rule);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="popup-container">
      <div className="popup-header">
        <div className="brand-row">
          <span className="brand-title">Blockingmachine</span>
          <span className="status-badge">Shield Active</span>
        </div>
        <button
          className="action-btn"
          style={{ flex: 'none', padding: '4px 8px', fontSize: '10px' }}
          onClick={handleSyncNow}
          disabled={syncing}
        >
          {syncing ? 'Syncing...' : 'Sync Rules'}
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          background: 'rgba(255, 255, 255, 0.04)',
          borderRadius: '6px',
          margin: '4px 0 10px 0',
          fontSize: '10px',
          border: '1px solid rgba(255, 255, 255, 0.06)'
        }}
      >
        <span style={{ color: 'var(--text-secondary)' }}>MV3 DNR Quota</span>
        <span
          style={{
            color: mv3Status?.isWithinQuota !== false ? '#10b981' : '#f59e0b',
            fontWeight: 600
          }}
        >
          {mv3Status
            ? `${mv3Status.dynamicRulesCount.toLocaleString()} / ${mv3Status.maxDynamicRules.toLocaleString()} (${mv3Status.utilizationPercent}%)`
            : 'Compliant'}
        </span>
      </div>

      <div className="metrics-grid">
        <div className="metric-card">
          <span className="metric-label">Blocked Requests</span>
          <span className="metric-value">{telemetry?.blockedRequests ?? 0}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Total Requests</span>
          <span className="metric-value">{telemetry?.totalRequests ?? 0}</span>
        </div>
      </div>

      <div className="trackers-section">
        <span className="section-title">Intercepted Trackers ({telemetry?.trackers.length ?? 0})</span>
        <div className="tracker-list">
          {telemetry?.trackers && telemetry.trackers.length > 0 ? (
            telemetry.trackers.map((t: TrackerDetection, idx: number) => (
              <div key={idx} className="tracker-item">
                <span className="tracker-domain" title={t.domain}>
                  {t.domain}
                </span>
                <span className="tracker-count">{t.blockedCount}</span>
              </div>
            ))
          ) : (
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', padding: '8px 0' }}>
              No ad beacons or trackers detected on this tab.
            </div>
          )}
        </div>
      </div>

      <div className="popup-footer">
        <button
          className="action-btn"
          onClick={handleWhitelistSite}
          disabled={!telemetry?.domain || telemetry.domain.includes('internal')}
        >
          {copied ? 'Copied Rule!' : 'Whitelist Site'}
        </button>
        <button
          className="action-btn"
          onClick={() => {
            chrome.tabs.create({ url: 'http://127.0.0.1:9191' });
          }}
        >
          Open Hub
        </button>
      </div>
    </div>
  );
};
