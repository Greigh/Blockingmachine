import React, { useEffect, useState } from 'react';
import { TabTelemetry, TrackerDetection, HomeAssistantConfig } from '../shared/types.js';

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
  const [activeTab, setActiveTab] = useState<'shield' | 'bridge'>('shield');
  const [telemetry, setTelemetry] = useState<TabTelemetry | null>(null);
  const [mv3Status, setMv3Status] = useState<Mv3QuotaInfo | null>(null);
  const [sseStatus, setSseStatus] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected');
  const [syncing, setSyncing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [haConfig, setHaConfig] = useState<HomeAssistantConfig>({
    enabled: false,
    url: 'http://homeassistant.local:8123',
    token: '',
    feedUrl: 'http://127.0.0.1:9191/browser.txt',
    cosmeticsEnabled: true,
    autoSync: true,
  });
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    // Fetch MV3 compliance quota status
    chrome.runtime.sendMessage({ type: 'GET_MV3_STATUS' }, (res) => {
      if (res?.data && isMounted) {
        setMv3Status(res.data);
      }
    });

    // Fetch SSE Status
    chrome.runtime.sendMessage({ type: 'GET_SSE_STATUS' }, (res) => {
      if (res?.status && isMounted) {
        setSseStatus(res.status);
      }
    });

    // Fetch HA Config
    chrome.runtime.sendMessage({ type: 'GET_HA_CONFIG' }, (res) => {
      if (res?.config && isMounted) {
        setHaConfig(res.config);
      }
    });

    // Query active tab telemetry
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id || !isMounted) return;

      const domain = extractDomain(tab.url);

      chrome.runtime.sendMessage(
        { type: 'GET_TAB_TELEMETRY', payload: { tabId: tab.id } },
        (response) => {
          if (!isMounted) return;
          if (response?.data) {
            setTelemetry(response.data);
          } else {
            setTelemetry({
              tabId: tab.id!,
              url: tab.url || '',
              domain,
              totalRequests: 0,
              blockedRequests: 0,
              trackers: [],
              scriptletsApplied: ['google-funding-choices', 'generic-defusers'],
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
      chrome.runtime.sendMessage({ type: 'GET_MV3_STATUS' }, (res) => {
        if (res?.data) setMv3Status(res.data);
      });
      chrome.runtime.sendMessage({ type: 'GET_SSE_STATUS' }, (res) => {
        if (res?.status) setSseStatus(res.status);
      });
    });
  };

  const handleStartPicker = () => {
    chrome.runtime.sendMessage({ type: 'START_ELEMENT_PICKER' }, () => {
      window.close();
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

  const handleSaveHaConfig = () => {
    setTestResult('Saving...');
    chrome.runtime.sendMessage({ type: 'SET_HA_CONFIG', payload: haConfig }, (res) => {
      if (res?.config) {
        setHaConfig(res.config);
        setTestResult('Settings saved.');
        setTimeout(() => setTestResult(null), 2500);
      }
    });
  };

  const handlePushTelemetryNow = () => {
    chrome.runtime.sendMessage({ type: 'REPORT_BROWSER_TELEMETRY' }, () => {
      setTestResult('Telemetry reported to hub.');
      setTimeout(() => setTestResult(null), 2500);
    });
  };

  return (
    <div className="popup-container">
      <div className="popup-header">
        <div className="brand-row">
          <span className="brand-title">Blockingmachine</span>
          <span className="status-badge">Active</span>
        </div>
        <div
          className="sse-badge"
          style={{
            background:
              sseStatus === 'connected'
                ? 'rgba(6, 182, 212, 0.15)'
                : sseStatus === 'connecting'
                ? 'rgba(245, 158, 11, 0.15)'
                : 'rgba(148, 163, 184, 0.15)',
            color:
              sseStatus === 'connected'
                ? '#06b6d4'
                : sseStatus === 'connecting'
                ? '#f59e0b'
                : '#94a3b8',
          }}
          title={
            sseStatus === 'connected'
              ? 'Real-time Server-Sent Events stream active'
              : 'Connecting to local desktop hub / HA feed'
          }
        >
          <span>{sseStatus === 'connected' ? '⚡️' : '⚪️'}</span>
          <span>{sseStatus === 'connected' ? 'Live Push' : sseStatus}</span>
        </div>
      </div>

      <div className="nav-tabs">
        <button
          className={`nav-tab ${activeTab === 'shield' ? 'active' : ''}`}
          onClick={() => setActiveTab('shield')}
        >
          Shield
        </button>
        <button
          className={`nav-tab ${activeTab === 'bridge' ? 'active' : ''}`}
          onClick={() => setActiveTab('bridge')}
        >
          Home Assistant & Hub
        </button>
      </div>

      {activeTab === 'shield' ? (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 10px',
              background: 'rgba(255, 255, 255, 0.04)',
              borderRadius: '6px',
              fontSize: '10px',
              border: '1px solid rgba(255, 255, 255, 0.06)',
            }}
          >
            <span style={{ color: 'var(--text-secondary)' }}>MV3 DNR Quota</span>
            <span
              style={{
                color: mv3Status?.isWithinQuota !== false ? '#10b981' : '#f59e0b',
                fontWeight: 600,
              }}
            >
              {mv3Status
                ? `${mv3Status.dynamicRulesCount.toLocaleString()} / ${mv3Status.maxDynamicRules.toLocaleString()} (${mv3Status.utilizationPercent}%)`
                : 'Compliant'}
            </span>
          </div>

          <div className="metrics-grid">
            <div className="metric-card">
              <span className="metric-label">Blocked Trackers</span>
              <span className="metric-value">{telemetry?.blockedRequests ?? 0}</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Total Requests</span>
              <span className="metric-value">{telemetry?.totalRequests ?? 0}</span>
            </div>
          </div>

          <div className="trackers-section">
            <span className="section-title">
              Intercepted Trackers ({telemetry?.trackers.length ?? 0})
            </span>
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
                <div
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-secondary)',
                    padding: '8px 0',
                    textAlign: 'center',
                  }}
                >
                  No ad beacons or trackers detected on this tab.
                </div>
              )}
            </div>
          </div>

          <div className="popup-footer">
            <button className="action-btn primary" onClick={handleStartPicker} title="Point-and-click to block any ad container on this webpage">
              🎯 Block Element
            </button>
            <button
              className="action-btn"
              onClick={handleWhitelistSite}
              disabled={!telemetry?.domain || telemetry.domain.includes('internal')}
            >
              {copied ? 'Copied Rule!' : 'Whitelist Site'}
            </button>
            <button className="action-btn" onClick={handleSyncNow} disabled={syncing}>
              {syncing ? 'Syncing...' : 'Sync Rules'}
            </button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div className="settings-card">
            <div className="card-title">
              <span>Home Assistant Bridge</span>
              <span style={{ fontSize: '10px', color: haConfig.enabled ? '#10b981' : '#94a3b8' }}>
                {haConfig.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>

            <div className="toggle-row">
              <span>Sync with Home Assistant</span>
              <input
                type="checkbox"
                checked={haConfig.enabled}
                onChange={(e) => setHaConfig({ ...haConfig, enabled: e.target.checked })}
              />
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
              <label className="form-label">Long-Lived Access Token</label>
              <input
                className="form-input"
                type="password"
                placeholder="Paste HA Bearer Token (optional)"
                value={haConfig.token}
                onChange={(e) => setHaConfig({ ...haConfig, token: e.target.value })}
              />
            </div>

            <div className="toggle-row">
              <span>Cosmetic Element Shield</span>
              <input
                type="checkbox"
                checked={haConfig.cosmeticsEnabled}
                onChange={(e) => setHaConfig({ ...haConfig, cosmeticsEnabled: e.target.checked })}
              />
            </div>
          </div>

          <div className="settings-card">
            <div className="card-title">
              <span>Desktop Hub & Ingress</span>
              <span style={{ fontSize: '10px', color: sseStatus === 'connected' ? '#06b6d4' : '#94a3b8' }}>
                Port 9191
              </span>
            </div>
            <div className="form-group">
              <label className="form-label">Feed Server URL</label>
              <input
                className="form-input"
                type="text"
                value={haConfig.feedUrl}
                onChange={(e) => setHaConfig({ ...haConfig, feedUrl: e.target.value })}
              />
            </div>
          </div>

          {testResult && (
            <div
              style={{
                fontSize: '11px',
                textAlign: 'center',
                color: '#38bdf8',
                padding: '4px',
              }}
            >
              {testResult}
            </div>
          )}

          <div style={{ display: 'flex', gap: '6px' }}>
            <button className="action-btn primary" onClick={handleSaveHaConfig}>
              Save Config
            </button>
            <button className="action-btn" onClick={handlePushTelemetryNow}>
              Push Telemetry
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
