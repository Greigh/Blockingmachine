import React from 'react';
import { AdGuardDirectWarning } from '../../components/AdGuardDirectWarning';
import { ServiceMismatchBanner } from '../../components/ServiceMismatchBanner';
import { resolveLanFeedUrl } from '../feedUrls';
import { isServiceMismatch } from '../../sinkholeIdentity';
import {
  localTlsBypassNote,
  normalizeAdguardDirectPort,
  replaceMatchingExplicitPort,
} from '../../sinkholeNet';
import type { HubPaneProps } from './paneProps';

/**
 * AdGuard Home, driven over its API and subscribed to the LAN feed.
 *
 * The widest of the sinkhole panes, because AdGuard Home is reachable three different ways and the
 * failure mode for guessing wrong is quiet: a Home Assistant address pasted into a field expecting
 * AdGuard answers with a login page, the token is never checked, and the user is told to use AdGuard
 * credentials. So the integration method is chosen explicitly, the mismatch banner names the mistake
 * when the response says which one it is, and the direct-mode port is a separate field that rewrites
 * the URL's port in place rather than leaving two boxes to disagree.
 *
 * The port is deliberately not a plain controlled number. Clearing it means "use the default", not
 * "use zero", and editing it renames the port in the URL it belongs to — otherwise saving a new port
 * leaves the old one still in the address bar and the connection test fails for a reason that looks
 * like a network problem.
 */

/**
 * The fields of the Hub bundle this pane reads. The registry carries the same list, so the type
 * the pane is written against and the object it is handed are the one declaration — a field added
 * here reaches the pane, and a field read but not declared does not compile.
 */
export const adGuardHomePaneKeys = [
  'handleCopy',
  'copiedKey',
  'savePath',
  'serverStatus',
  'sinkholeConfig',
  'setSinkholeConfig',
  'showHaToken',
  'setShowHaToken',
  'showAdguardPass',
  'setShowAdguardPass',
  'adguardEnv',
  'setAdguardEnv',
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
  'selectAdguardMode',
  'applyDetectedMode',
  'directPortFocusRef',
  'secretStorageAvailable',
] as const satisfies readonly (keyof HubPaneProps)[];

export type AdGuardHomePaneProps = Pick<HubPaneProps, (typeof adGuardHomePaneKeys)[number]>;

export const AdGuardHomePane: React.FC<AdGuardHomePaneProps> = ({
  handleCopy,
  copiedKey,
  savePath,
  serverStatus,
  sinkholeConfig,
  setSinkholeConfig,
  showHaToken,
  setShowHaToken,
  showAdguardPass,
  setShowAdguardPass,
  adguardEnv,
  setAdguardEnv,
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
  selectAdguardMode,
  applyDetectedMode,
  directPortFocusRef,
  secretStorageAvailable,
}) => {
  const directPort = normalizeAdguardDirectPort(sinkholeConfig.adguardDirectPort);
  const activeTlsUrl =
    sinkholeConfig.adguardMode === 'webhook'
      ? (sinkholeConfig.haWebhookUrl || '')
      : (sinkholeConfig.adguardHomeUrl || '');
  const tlsScopeNote = localTlsBypassNote(activeTlsUrl, Boolean(sinkholeConfig.allowInsecureLocalTls));
  const lanFeedUrl = resolveLanFeedUrl(serverStatus, savePath);
  return (
    <div className="deploy-dual-pane">
      {/* Left Column: Live API Automation */}
      <div className="deploy-pane-column">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">⚡</span>
            <div>
              <h3 className="deploy-pane-title">Live API Automation</h3>
              <p className="deploy-pane-subtitle">
                Automate zero-touch reloads when compiling rules
              </p>
            </div>
          </div>
          <div className="deploy-pane-status-pill">
            <span className={`status-indicator-dot ${sinkholeConfig.adguardHomeUrl ? 'active' : 'idle'}`} />
            <span>{sinkholeConfig.adguardHomeUrl ? 'Configured' : 'Not Connected'}</span>
          </div>
        </div>

        <ServiceMismatchBanner
          details={testResult?.service === 'adguard' ? testResult.details : lastSyncResult?.service?.toLowerCase().includes('adguard') ? lastSyncResult.details : undefined}
          message={testResult?.service === 'adguard' ? testResult.message : lastSyncResult?.service?.toLowerCase().includes('adguard') ? lastSyncResult.message : undefined}
          onUseDirect={() => { void applyDetectedMode('direct'); }}
          onUseHaApi={() => { void applyDetectedMode('ha-api'); }}
        />

        {/* Integration Method Selector */}
        <div className="deploy-field-group">
          <label className="deploy-field-label">Integration Method</label>
          <div className="deploy-segmented-selector">
            <button
              type="button"
              className={`deploy-segment-btn ${(!sinkholeConfig.adguardMode || sinkholeConfig.adguardMode === 'direct') ? 'active' : ''}`}
              onClick={() => selectAdguardMode('direct')}
            >
              Direct Port {directPort} (Recommended)
            </button>
            <button
              type="button"
              className={`deploy-segment-btn ${sinkholeConfig.adguardMode === 'ha-api' ? 'active' : ''}`}
              onClick={() => selectAdguardMode('ha-api')}
            >
              HA REST API
            </button>
            <button
              type="button"
              className={`deploy-segment-btn ${sinkholeConfig.adguardMode === 'webhook' ? 'active' : ''}`}
              onClick={() => selectAdguardMode('webhook')}
            >
              Webhook
            </button>
          </div>
        </div>

        {/* Fast Presets Chips */}
        <div className="deploy-fast-presets-wrap">
          <span className="fast-presets-title">Quick Presets:</span>
          <div className="fast-presets-chips">
            <button
              type="button"
              className="preset-chip"
              onClick={() => selectAdguardMode('direct', { adguardHomeUrl: `http://homeassistant.local:${directPort}` })}
            >
              homeassistant.local:{directPort}
            </button>
            <button
              type="button"
              className="preset-chip"
              onClick={() => selectAdguardMode('ha-api', { adguardHomeUrl: 'http://homeassistant.local:8123' })}
            >
              HA API (:8123)
            </button>
            <button
              type="button"
              className="preset-chip"
              onClick={() => selectAdguardMode('direct', { adguardHomeUrl: `http://localhost:${directPort}` })}
            >
              Docker (localhost)
            </button>
            <button
              type="button"
              className="preset-chip"
              onClick={() => selectAdguardMode('direct', { adguardHomeUrl: `http://192.168.8.1:${directPort}` })}
            >
              GL.iNet (192.168.8.1)
            </button>
            <button
              type="button"
              className="preset-chip"
              onClick={() => selectAdguardMode('ha-api', { adguardHomeUrl: 'https://your-instance.ui.nabu.casa' })}
            >
              Nabu Casa Cloud
            </button>
          </div>
        </div>

        {/* Credentials & Endpoint Form */}
        <div className="deploy-form-fields-grid">
          {secretStorageAvailable === false && (
            <p className="setting-message error" style={{ gridColumn: '1 / -1', marginTop: 0 }}>
              OS keychain encryption is unavailable — the secrets on this pane are stored as plaintext on disk.
            </p>
          )}
          {sinkholeConfig.adguardMode === 'ha-api' ? (
            <>
              <div className="deploy-field-group">
                <label className="deploy-field-label">Home Assistant URL</label>
                <input
                  type="text"
                  className="deploy-field-input"
                  placeholder="http://homeassistant.local:8123 or https://*.ui.nabu.casa"
                  value={sinkholeConfig.adguardHomeUrl || ''}
                  onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: e.target.value })}
                />
              </div>
              <div className="deploy-field-group">
                <label className="deploy-field-label">Long-Lived Access Token</label>
                <div className="deploy-input-with-eye">
                  <input
                    type={showHaToken ? 'text' : 'password'}
                    className="deploy-field-input"
                    placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6..."
                    value={sinkholeConfig.haToken || ''}
                    onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, haToken: e.target.value })}
                  />
                  <button
                    type="button"
                    className="deploy-eye-btn"
                    onClick={() => setShowHaToken(!showHaToken)}
                  >
                    {showHaToken ? '👁' : '🔒'}
                  </button>
                </div>
              </div>
              <div className="deploy-field-row">
                <div className="deploy-field-group">
                  <label className="deploy-field-label">AdGuard Username</label>
                  <input
                    type="text"
                    className="deploy-field-input"
                    placeholder="admin"
                    value={sinkholeConfig.adguardHomeUser || ''}
                    onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUser: e.target.value })}
                  />
                </div>
                <div className="deploy-field-group">
                  <label className="deploy-field-label">AdGuard Password</label>
                  <div className="deploy-input-with-eye">
                    <input
                      type={showAdguardPass ? 'text' : 'password'}
                      className="deploy-field-input"
                      placeholder="••••••••"
                      value={sinkholeConfig.adguardHomePassword || ''}
                      onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomePassword: e.target.value })}
                    />
                    <button
                      type="button"
                      className="deploy-eye-btn"
                      onClick={() => setShowAdguardPass(!showAdguardPass)}
                      title={showAdguardPass ? 'Hide password' : 'Show password'}
                    >
                      {showAdguardPass ? '👁' : '🔒'}
                    </button>
                  </div>
                </div>
              </div>
              <p style={{ fontSize: 10.5, color: 'var(--secondary-color)', margin: '2px 0 0', lineHeight: 1.4 }}>
                Used for the AI Radar live query log feed. Requires AdGuard Home admin credentials.
              </p>
            </>
          ) : sinkholeConfig.adguardMode === 'webhook' ? (
            <>
              <div className="deploy-field-group">
                <label className="deploy-field-label">Home Assistant Webhook URL</label>
                <input
                  type="text"
                  className="deploy-field-input"
                  placeholder="http://homeassistant.local:8123/api/webhook/... or https://hooks.nabu.casa/..."
                  value={sinkholeConfig.haWebhookUrl || ''}
                  onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, haWebhookUrl: e.target.value })}
                />
              </div>
              <div className="deploy-field-row">
                <div className="deploy-field-group">
                  <label className="deploy-field-label">AdGuard Username</label>
                  <input
                    type="text"
                    className="deploy-field-input"
                    placeholder="admin"
                    value={sinkholeConfig.adguardHomeUser || ''}
                    onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUser: e.target.value })}
                  />
                </div>
                <div className="deploy-field-group">
                  <label className="deploy-field-label">AdGuard Password</label>
                  <input
                    type={showAdguardPass ? 'text' : 'password'}
                    className="deploy-field-input"
                    placeholder="••••••••"
                    value={sinkholeConfig.adguardHomePassword || ''}
                    onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomePassword: e.target.value })}
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="deploy-field-row">
                <div className="deploy-field-group" style={{ flex: 3 }}>
                  <label className="deploy-field-label">AdGuard Home URL</label>
                  <input
                    type="text"
                    className="deploy-field-input"
                    placeholder={`http://homeassistant.local:${directPort} or http://192.168.1.100:${directPort}`}
                    value={sinkholeConfig.adguardHomeUrl || ''}
                    onChange={(e) =>
                      setSinkholeConfig({
                        ...sinkholeConfig,
                        adguardHomeUrl: e.target.value,
                        adguardDirectUrl: e.target.value,
                      })
                    }
                  />
                </div>
                <div className="deploy-field-group" style={{ flex: 1 }}>
                  <label className="deploy-field-label">API Port</label>
                  <input
                    type="number"
                    className="deploy-field-input"
                    min={1}
                    max={65535}
                    value={sinkholeConfig.adguardDirectPort ?? ''}
                    onFocus={() => { directPortFocusRef.current = directPort; }}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === '') {
                        setSinkholeConfig({ ...sinkholeConfig, adguardDirectPort: undefined });
                        return;
                      }
                      const next = Number.parseInt(raw, 10);
                      if (Number.isInteger(next)) {
                        setSinkholeConfig({ ...sinkholeConfig, adguardDirectPort: next });
                      }
                    }}
                    onBlur={(e) => {
                      const previous = directPortFocusRef.current;
                      const next = normalizeAdguardDirectPort(e.target.value);
                      const nextUrl = replaceMatchingExplicitPort(sinkholeConfig.adguardHomeUrl || '', previous, next);
                      setSinkholeConfig({
                        ...sinkholeConfig,
                        adguardDirectPort: next,
                        adguardHomeUrl: nextUrl,
                        adguardDirectUrl: replaceMatchingExplicitPort(sinkholeConfig.adguardDirectUrl || nextUrl, previous, next),
                      });
                    }}
                  />
                </div>
              </div>
              {/* The same banner Settings shows for this field pair — an HA frontend or Nabu Casa
                  address here is a working-looking URL pointed at the wrong API. */}
              <AdGuardDirectWarning url={sinkholeConfig.adguardHomeUrl || ''} port={directPort} />

              <div className="deploy-field-row">
                <div className="deploy-field-group">
                  <label className="deploy-field-label">Username</label>
                  <input
                    type="text"
                    className="deploy-field-input"
                    placeholder="admin"
                    value={sinkholeConfig.adguardHomeUser || ''}
                    onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUser: e.target.value })}
                  />
                </div>
                <div className="deploy-field-group">
                  <label className="deploy-field-label">Password</label>
                  <div className="deploy-input-with-eye">
                    <input
                      type={showAdguardPass ? 'text' : 'password'}
                      className="deploy-field-input"
                      placeholder="••••••••"
                      value={sinkholeConfig.adguardHomePassword || ''}
                      onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomePassword: e.target.value })}
                    />
                    <button
                      type="button"
                      className="deploy-eye-btn"
                      onClick={() => setShowAdguardPass(!showAdguardPass)}
                    >
                      {showAdguardPass ? '👁' : '🔒'}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Local TLS Bypass Option */}
          <label className="deploy-checkbox-label" title={tlsScopeNote || undefined}>
            <input
              type="checkbox"
              checked={Boolean(sinkholeConfig.allowInsecureLocalTls)}
              onChange={(e) =>
                setSinkholeConfig({ ...sinkholeConfig, allowInsecureLocalTls: e.target.checked })
              }
            />
            <span>Allow self-signed HTTPS / local TLS certificate bypass</span>
          </label>
        </div>

        {/* Actions Row */}
        <div className="deploy-actions-row">
          <button
            type="button"
            className="deploy-btn"
            onClick={() => handleTestConnection('adguard')}
            disabled={testingService === 'adguard'}
          >
            <span>{testingService === 'adguard' ? 'Testing…' : '⚡ Test Connection'}</span>
          </button>
          <button
            type="button"
            className="deploy-btn"
            onClick={() => handleSaveSinkholeConfig('adguard')}
            disabled={isSavingSinkhole}
          >
            <span>{isSavingSinkhole ? 'Saving…' : '💾 Save Settings'}</span>
          </button>
          <button
            type="button"
            className="deploy-btn primary"
            onClick={() => handleTriggerLiveSync('adguard')}
            disabled={isSyncingSinkhole || (!sinkholeConfig.adguardHomeUrl && !sinkholeConfig.haWebhookUrl)}
          >
            <span>{isSyncingSinkhole ? 'Reloading…' : '▶ Push Live Reload Now'}</span>
          </button>
        </div>

        {/* Auto-Push Toggle & Status Feedback */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          <label className="deploy-checkbox-label" title="Automatically reload AdGuard Home whenever you compile rules (⌘R)">
            <input
              type="checkbox"
              checked={sinkholeConfig.syncOnCompile}
              onChange={(e) => handleToggleSyncOnCompile(e.target.checked)}
            />
            <span style={{ fontWeight: 600, color: 'var(--heading-color)' }}>
              Auto-Push to AdGuard on Compile (⌘R)
            </span>
          </label>

          {sinkholeMessage && (
            <span style={{ fontSize: '11px', color: 'var(--primary-color)', fontWeight: 500 }}>
              {sinkholeMessage}
            </span>
          )}
          {testResult?.service === 'adguard' && !isServiceMismatch(testResult.details) && (
            <span className={`test-status-pill ${testResult.success ? 'success' : 'error'}`} style={{ alignSelf: 'flex-start' }}>
              {testResult.message}
            </span>
          )}
          {lastSyncResult?.service?.toLowerCase().includes('adguard') && !isServiceMismatch(lastSyncResult.details) && (
            <span className={`test-status-pill ${lastSyncResult.status === 'success' ? 'success' : 'error'}`} style={{ alignSelf: 'flex-start' }}>
              Last Reload: {lastSyncResult.message} ({lastSyncResult.timestamp})
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
                Subscribe inside AdGuard Home web console
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
              className={`deploy-copy-feed-btn ${copiedKey === 'agh-lan' ? 'copied' : ''}`}
              onClick={() => handleCopy(lanFeedUrl, 'agh-lan')}
            >
              {copiedKey === 'agh-lan' ? '✓ Copied' : 'Copy Feed URL'}
            </button>
          </div>
          <div className="deploy-feed-sublink-row">
            <button
              type="button"
              className="deploy-sublink-btn"
              title="AdGuard Home accepts a bare absolute path, not a file:// URL — and only when it runs on this filesystem and the path matches filtering.safe_fs_patterns (data/userfilters is covered by default)."
              onClick={() => handleCopy(savePath, 'agh-file')}
            >
              {copiedKey === 'agh-file' ? '✓ Copied path' : 'Or copy the file path (only if AdGuard Home runs on this machine) →'}
            </button>
          </div>
        </div>

        {/* Environment Tabs */}
        <div className="deploy-env-bar">
          <span className="deploy-env-title">Environment:</span>
          <div className="deploy-env-tabs">
            <button
              type="button"
              className={`env-tab-btn ${adguardEnv === 'homeassistant' ? 'active' : ''}`}
              onClick={() => setAdguardEnv('homeassistant')}
            >
              Home Assistant
            </button>
            <button
              type="button"
              className={`env-tab-btn ${adguardEnv === 'docker' ? 'active' : ''}`}
              onClick={() => setAdguardEnv('docker')}
            >
              Docker / NAS
            </button>
            <button
              type="button"
              className={`env-tab-btn ${adguardEnv === 'router' ? 'active' : ''}`}
              onClick={() => setAdguardEnv('router')}
            >
              GL.iNet / Router
            </button>
            <button
              type="button"
              className={`env-tab-btn ${adguardEnv === 'standalone' ? 'active' : ''}`}
              onClick={() => setAdguardEnv('standalone')}
            >
              Standalone
            </button>
          </div>
        </div>

        {/* 3-Step Setup Stepper */}
        <div className="deploy-numbered-stepper">
          <div className="stepper-step">
            <div className="stepper-num">1</div>
            <div className="stepper-content">
              <h4>Open AdGuard Home Web Interface</h4>
              <p>
                {adguardEnv === 'homeassistant'
                  ? `Open Home Assistant > AdGuard Home, or navigate directly to http://homeassistant.local:${directPort}`
                  : adguardEnv === 'router'
                  ? `Navigate to your router web dashboard (default: http://192.168.8.1:${directPort})`
                  : `Open your browser to your AdGuard Home IP: http://<ip>:${directPort}`}
              </p>
            </div>
          </div>

          <div className="stepper-step">
            <div className="stepper-num">2</div>
            <div className="stepper-content">
              <h4>Navigate to DNS Blocklists</h4>
              <p>In the top navigation menu, click on <strong>Filters</strong>, then choose <strong>DNS blocklists</strong>.</p>
            </div>
          </div>

          <div className="stepper-step">
            <div className="stepper-num">3</div>
            <div className="stepper-content">
              <h4>Add Custom Blocklist & Paste Feed URL</h4>
              <p>
                Click <strong>Add blocklist → Add a custom list</strong>. Name it <code>Blockingmachine Compiled</code> and paste the copied LAN URL above.
              </p>
            </div>
          </div>
        </div>

        {/* Contextual Guidance */}
        {adguardEnv === 'homeassistant' && (
          <div className="deploy-contextual-note">
            <span className="note-icon">💡</span>
            <div className="note-text">
              <strong>Nabu Casa & Remote Access:</strong> AdGuard Home runs locally on your home network. Even if you access Home Assistant remotely using Nabu Casa, paste the <strong>LAN Feed URL</strong> above into AdGuard so it fetches blocklists over your local Wi-Fi.
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const renderAdGuardHomePane = (props: AdGuardHomePaneProps) => (
  <AdGuardHomePane {...props} />
);
