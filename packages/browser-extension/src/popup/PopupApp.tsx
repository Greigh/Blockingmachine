import React, { useEffect, useState } from 'react';
import { TabTelemetry, TrackerDetection } from '../shared/types';

export const PopupApp: React.FC = () => {
  const [telemetry, setTelemetry] = useState<TabTelemetry | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    // Query active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab?.id) {
        chrome.runtime.sendMessage(
          { type: 'GET_TAB_TELEMETRY', payload: { tabId: activeTab.id } },
          (response) => {
            if (response?.data) {
              setTelemetry(response.data);
            } else {
              setTelemetry({
                tabId: activeTab.id!,
                url: activeTab.url || '',
                domain: activeTab.url ? new URL(activeTab.url).hostname : 'localhost',
                totalRequests: 0,
                blockedRequests: 0,
                trackers: [],
                scriptletsApplied: ['google-funding-choices', 'generic-defusers']
              });
            }
          }
        );
      }
    });
  }, []);

  const handleSyncNow = () => {
    setSyncing(true);
    chrome.runtime.sendMessage({ type: 'SYNC_RULES_NOW' }, () => {
      setSyncing(false);
    });
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
          onClick={() => {
            if (telemetry?.domain) {
              navigator.clipboard.writeText(`@@||${telemetry.domain}^`);
              alert(`Copied whitelist exception @@||${telemetry.domain}^ to clipboard`);
            }
          }}
        >
          Whitelist Site
        </button>
        <button
          className="action-btn"
          onClick={() => {
            chrome.tabs.create({ url: 'http://localhost:9191' });
          }}
        >
          Open Hub
        </button>
      </div>
    </div>
  );
};
