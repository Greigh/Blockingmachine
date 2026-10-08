import React from 'react';
import { resolveLanFeedUrl } from '../feedUrls';
import type { HubPaneProps } from './paneProps';

/**
 * Pi-hole, fed by pushing the compiled list into its gravity database.
 *
 * The simplest of the three sinkhole panes, and the only one whose job is a single command: the
 * compiled AdGuard syntax is already a gravity list, so "deploy" means "save it, then let gravity
 * rebuild". There is no rewriting and no zone to configure, which is why this pane is short next to
 * the AdGuard one even though both do the same underlying work.
 *
 * The API key field accepts a v5 web password or a v6 app password because both exist and the error
 * from the wrong one is a 401 that reads like a network problem.
 */

/**
 * The fields of the Hub bundle this pane reads. The registry carries the same list, so the type
 * the pane is written against and the object it is handed are the one declaration — a field added
 * here reaches the pane, and a field read but not declared does not compile.
 */
export const piholePaneKeys = [
  'handleCopy',
  'copiedKey',
  'savePath',
  'serverStatus',
  'sinkholeConfig',
  'setSinkholeConfig',
  'showPiholeKey',
  'setShowPiholeKey',
  'testingService',
  'isSavingSinkhole',
  'isSyncingSinkhole',
  'sinkholeMessage',
  'testResult',
  'lastSyncResult',
  'handleTestConnection',
  'handleSaveSinkholeConfig',
  'handleTriggerLiveSync',
  'handleToggleSyncOnCompile',
  'secretStorageAvailable',
] as const satisfies readonly (keyof HubPaneProps)[];

export type PiholePaneProps = Pick<HubPaneProps, (typeof piholePaneKeys)[number]>;

export const PiholePane: React.FC<PiholePaneProps> = ({
  handleCopy,
  copiedKey,
  savePath,
  serverStatus,
  sinkholeConfig,
  setSinkholeConfig,
  showPiholeKey,
  setShowPiholeKey,
  testingService,
  isSavingSinkhole,
  isSyncingSinkhole,
  sinkholeMessage,
  testResult,
  lastSyncResult,
  handleTestConnection,
  handleSaveSinkholeConfig,
  handleTriggerLiveSync,
  handleToggleSyncOnCompile,
  secretStorageAvailable,
}) => {
  const lanFeedUrl = resolveLanFeedUrl(serverStatus, savePath);
  return (
    <div className="deploy-dual-pane">
      {/* Left Column: Pi-hole Live API Automation */}
      <div className="deploy-pane-column">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">⚡</span>
            <div>
              <h3 className="deploy-pane-title">Pi-hole Gravity Automation</h3>
              <p className="deploy-pane-subtitle">
                Automate Pi-hole Gravity updates (`pihole -g`) over API
              </p>
            </div>
          </div>
          <div className="deploy-pane-status-pill">
            <span className={`status-indicator-dot ${sinkholeConfig.piholeUrl ? 'active' : 'idle'}`} />
            <span>{sinkholeConfig.piholeUrl ? 'Configured' : 'Not Connected'}</span>
          </div>
        </div>

        {/* Quick Presets */}
        <div className="deploy-fast-presets-wrap">
          <span className="fast-presets-title">Quick Presets:</span>
          <div className="fast-presets-chips">
            <button
              type="button"
              className="preset-chip"
              onClick={() => setSinkholeConfig({ ...sinkholeConfig, piholeUrl: 'http://pi.hole/admin' })}
            >
              pi.hole/admin
            </button>
            <button
              type="button"
              className="preset-chip"
              onClick={() => setSinkholeConfig({ ...sinkholeConfig, piholeUrl: 'http://homeassistant.local:8080/admin' })}
            >
              HA Pi-hole (:8080)
            </button>
            <button
              type="button"
              className="preset-chip"
              onClick={() => setSinkholeConfig({ ...sinkholeConfig, piholeUrl: 'http://localhost:80/admin' })}
            >
              Docker (localhost)
            </button>
          </div>
        </div>

        {/* Credentials Form */}
        <div className="deploy-form-fields-grid">
          <div className="deploy-field-group">
            <label className="deploy-field-label">Pi-hole Admin URL</label>
            <input
              type="text"
              className="deploy-field-input"
              placeholder="http://pi.hole/admin or http://192.168.1.50/admin"
              value={sinkholeConfig.piholeUrl || ''}
              onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, piholeUrl: e.target.value })}
            />
          </div>

          {secretStorageAvailable === false && (
            <p className="setting-message error" style={{ gridColumn: '1 / -1', marginTop: 0 }}>
              OS keychain encryption is unavailable — this token is stored as plaintext on disk.
            </p>
          )}
          <div className="deploy-field-group">
            <label className="deploy-field-label">API Key / App Password (v5 & v6)</label>
            <div className="deploy-input-with-eye">
              <input
                type={showPiholeKey ? 'text' : 'password'}
                className="deploy-field-input"
                placeholder="Pi-hole API token (WEBPASSWORD hash or v6 app password)"
                value={sinkholeConfig.piholeApiKey || ''}
                onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, piholeApiKey: e.target.value })}
              />
              <button
                type="button"
                className="deploy-eye-btn"
                onClick={() => setShowPiholeKey(!showPiholeKey)}
              >
                {showPiholeKey ? '👁' : '🔒'}
              </button>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="deploy-actions-row">
          <button
            type="button"
            className="deploy-btn"
            onClick={() => handleTestConnection('pihole')}
            disabled={testingService === 'pihole'}
          >
            <span>{testingService === 'pihole' ? 'Testing…' : '⚡ Test Connection'}</span>
          </button>
          <button
            type="button"
            className="deploy-btn"
            onClick={() => handleSaveSinkholeConfig('pihole')}
            disabled={isSavingSinkhole}
          >
            <span>{isSavingSinkhole ? 'Saving…' : '💾 Save Settings'}</span>
          </button>
          <button
            type="button"
            className="deploy-btn primary"
            onClick={() => handleTriggerLiveSync('pihole')}
            disabled={isSyncingSinkhole || !sinkholeConfig.piholeUrl}
          >
            <span>{isSyncingSinkhole ? 'Reloading…' : '▶ Trigger Gravity Reload Now'}</span>
          </button>
        </div>

        {/* Auto-Push Toggle */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          <label className="deploy-checkbox-label" title="Trigger automated Gravity update after each rule compile">
            <input
              type="checkbox"
              checked={sinkholeConfig.syncOnCompile}
              onChange={(e) => handleToggleSyncOnCompile(e.target.checked)}
            />
            <span style={{ fontWeight: 600, color: 'var(--heading-color)' }}>
              Auto-Push to Pi-hole on Compile (⌘R)
            </span>
          </label>

          {sinkholeMessage && (
            <span style={{ fontSize: '11px', color: 'var(--primary-color)', fontWeight: 500 }}>
              {sinkholeMessage}
            </span>
          )}
          {testResult?.service === 'pihole' && (
            <span className={`test-status-pill ${testResult.success ? 'success' : 'error'}`} style={{ alignSelf: 'flex-start' }}>
              {testResult.message}
            </span>
          )}
          {lastSyncResult?.service?.toLowerCase().includes('pi-hole') && (
            <span className={`test-status-pill ${lastSyncResult.status === 'success' ? 'success' : lastSyncResult.status === 'warning' ? 'warning' : 'error'}`} style={{ alignSelf: 'flex-start' }}>
              Last Gravity Reload: {lastSyncResult.message} ({lastSyncResult.timestamp})
            </span>
          )}
        </div>
      </div>

      {/* Right Column: Feed Subscription & Setup Instructions */}
      <div className="deploy-pane-column">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">📡</span>
            <div>
              <h3 className="deploy-pane-title">Feed Subscription & Setup</h3>
              <p className="deploy-pane-subtitle">
                Add subscription in Pi-hole Admin Console
              </p>
            </div>
          </div>
        </div>

        {/* Big Feed Subscription Box */}
        <div className="deploy-feed-box">
          <div className="deploy-feed-box-top">
            <span className="deploy-feed-box-label">LAN Subscription URL</span>
            <span className="deploy-feed-box-tag">● Live Wi-Fi Feed</span>
          </div>
          <div className="deploy-feed-input-row">
            <input type="text" readOnly value={lanFeedUrl} className="deploy-feed-input" />
            <button
              type="button"
              className={`deploy-copy-feed-btn ${copiedKey === 'pi-lan' ? 'copied' : ''}`}
              onClick={() => handleCopy(lanFeedUrl, 'pi-lan')}
            >
              {copiedKey === 'pi-lan' ? '✓ Copied' : 'Copy Feed URL'}
            </button>
          </div>
        </div>

        {/* 3-Step Setup Stepper */}
        <div className="deploy-numbered-stepper">
          <div className="stepper-step">
            <div className="stepper-num">1</div>
            <div className="stepper-content">
              <h4>Open Pi-hole Admin Console</h4>
              <p>Open your browser to <code>http://pi.hole/admin</code> or your Pi-hole device IP.</p>
            </div>
          </div>

          <div className="stepper-step">
            <div className="stepper-num">2</div>
            <div className="stepper-content">
              <h4>Navigate to Adlists</h4>
              <p>In the left sidebar menu, click on <strong>Adlists</strong> (or <strong>Lists</strong> in v6).</p>
            </div>
          </div>

          <div className="stepper-step">
            <div className="stepper-num">3</div>
            <div className="stepper-content">
              <h4>Add Subscription Address & Update Gravity</h4>
              <p>
                Paste the LAN URL into the <strong>Address</strong> field and click <strong>Add</strong>. Then run Gravity update:
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <code style={{ background: 'var(--control-bg-color)', padding: '3px 8px', borderRadius: 4 }}>pihole -g</code>
                <button
                  type="button"
                  className="deploy-tool-btn"
                  onClick={() => handleCopy('pihole -g', 'pi-cmd')}
                >
                  {copiedKey === 'pi-cmd' ? 'Copied!' : 'Copy Command'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const renderPiholePane = (props: PiholePaneProps) => (
  <PiholePane {...props} />
);
