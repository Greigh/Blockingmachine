import React from 'react';
import { ExtensionTierPlanCard } from '../../components/ExtensionTierPlanCard';
import type { HubPaneProps } from './paneProps';

/**
 * Home Assistant: the add-on that serves the feed when this laptop is off, and the integration that
 * reads live metrics back out of it.
 *
 * Unlike the two panes beside it, this one is not primarily a place to type an address. The add-on
 * already published the feed from the Hub's own summary, and the integration needs only a host and a
 * port, so the right column is five endpoints and a token rather than a form.
 *
 * The tier plan sits here because it answers a question about the browser extension, and this is the
 * one pane that already talks to Home Assistant on its behalf: the add-on serves the extension's
 * rulesets from a machine that is not the user's laptop, so the popup's own capacity reading is the
 * wrong one to act on. It asks for a capacity explicitly instead of reporting Chrome's guaranteed
 * floor as though it were a live grant.
 */

/**
 * The fields of the Hub bundle this pane reads. The registry carries the same list, so the type
 * the pane is written against and the object it is handed are the one declaration — a field added
 * here reaches the pane, and a field read but not declared does not compile.
 */
export const homeAssistantPaneKeys = [
  'handleCopy',
  'copiedKey',
  'serverStatus',
  'sinkholeConfig',
  'setSinkholeConfig',
  'showHaToken',
  'setShowHaToken',
  'testingService',
  'isSavingSinkhole',
  'isSyncingSinkhole',
  'sinkholeMessage',
  'testResult',
  'handleTestConnection',
  'handleSaveSinkholeConfig',
  'handleTriggerLiveSync',
  'handleToggleSyncOnCompile',
  'haApiPreview',
  'isTestingHaApi',
  'handleInspectHaApi',
  'tierPlanState',
  'tierPlan',
  'tierPlanError',
  'loadTierPlan',
  'chooseTierLedger',
  'clearTierLedger',
  'secretStorageAvailable',
] as const satisfies readonly (keyof HubPaneProps)[];

export type HomeAssistantPaneProps = Pick<HubPaneProps, (typeof homeAssistantPaneKeys)[number]>;

export const HomeAssistantPane: React.FC<HomeAssistantPaneProps> = ({
  handleCopy,
  copiedKey,
  serverStatus,
  sinkholeConfig,
  setSinkholeConfig,
  showHaToken,
  setShowHaToken,
  testingService,
  isSavingSinkhole,
  isSyncingSinkhole,
  sinkholeMessage,
  testResult,
  handleTestConnection,
  handleSaveSinkholeConfig,
  handleTriggerLiveSync,
  handleToggleSyncOnCompile,
  haApiPreview,
  isTestingHaApi,
  handleInspectHaApi,
  tierPlanState,
  tierPlan,
  tierPlanError,
  loadTierPlan,
  chooseTierLedger,
  clearTierLedger,
  secretStorageAvailable,
}) => {
  // The five endpoint addresses, named once: the input shows the constant and the copy button
  // takes the same constant, so what is on screen and what lands on the clipboard cannot drift.
  const hubBase = `http://${serverStatus?.lanIp || '127.0.0.1'}:${serverStatus?.port || 9191}`;
  const statusUrl = `${hubBase}/v1/status`;
  const dnsFeedUrl = `${hubBase}/dns.txt`;
  const browserFeedUrl = `${hubBase}/browser.txt`;
  const threatsAbpUrl = `${hubBase}/threats.txt`;
  const threatsRawUrl = `${hubBase}/ai-threats.txt`;
  return (
    <div className="deploy-dual-pane">
      {/* Left Column: Home Assistant Automation & Live Sync */}
      <div className="deploy-pane-column">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">🏠</span>
            <div>
              <h3 className="deploy-pane-title">Home Assistant Hub Connection</h3>
              <p className="deploy-pane-subtitle">
                Control AdGuard & Pi-hole Add-ons via Home Assistant REST or Webhook
              </p>
            </div>
          </div>
          <div className="deploy-pane-status-pill">
            <span className={`status-indicator-dot ${sinkholeConfig.haToken || sinkholeConfig.haWebhookUrl ? 'active' : 'idle'}`} />
            <span>{sinkholeConfig.haToken || sinkholeConfig.haWebhookUrl ? 'Configured' : 'Not Connected'}</span>
          </div>
        </div>

        <div className="deploy-pane-body">
          <div className="deploy-field-group">
            <label className="deploy-field-label">Home Assistant Mode</label>
            <div className="deploy-segmented-selector">
              <button
                type="button"
                className={`deploy-segment-btn ${sinkholeConfig.adguardMode === 'ha-api' ? 'active' : ''}`}
                onClick={() => setSinkholeConfig({ ...sinkholeConfig, adguardMode: 'ha-api' })}
              >
                REST Service API
              </button>
              <button
                type="button"
                className={`deploy-segment-btn ${sinkholeConfig.adguardMode === 'webhook' ? 'active' : ''}`}
                onClick={() => setSinkholeConfig({ ...sinkholeConfig, adguardMode: 'webhook' })}
              >
                Webhook
              </button>
            </div>
          </div>

          {sinkholeConfig.adguardMode === 'ha-api' && (
            <>
              <div className="deploy-field-group">
                <label className="deploy-field-label">Home Assistant Instance URL</label>
                <input
                  type="url"
                  className="deploy-field-input"
                  placeholder="http://homeassistant.local:8123 or Nabu Casa Cloud URL"
                  value={sinkholeConfig.adguardHomeUrl || ''}
                  onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, adguardHomeUrl: e.target.value })}
                />
                <span className="deploy-field-hint">
                  Connects directly to your Home Assistant instance (Local or Nabu Casa Cloud)
                </span>
              </div>

              <div className="deploy-field-group">
                <label className="deploy-field-label">Long-Lived Access Token</label>
                <div className="deploy-input-with-eye">
                  <input
                    type={showHaToken ? 'text' : 'password'}
                    className="deploy-field-input"
                    placeholder="Bearer token from your Home Assistant profile"
                    value={sinkholeConfig.haToken || ''}
                    onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, haToken: e.target.value })}
                  />
                  <button
                    type="button"
                    className="deploy-eye-btn"
                    onClick={() => setShowHaToken(!showHaToken)}
                    title={showHaToken ? 'Hide token' : 'Show token'}
                  >
                    {showHaToken ? '👁️' : '🔒'}
                  </button>
                </div>
                <span className="deploy-field-hint">
                  Generate in Home Assistant: Profile &gt; Long-Lived Access Tokens
                </span>
                {secretStorageAvailable === false && (
                  <p className="setting-message error" style={{ marginTop: 6 }}>
                    OS keychain encryption is unavailable — this token is stored as plaintext on disk.
                  </p>
                )}
              </div>
            </>
          )}

          {sinkholeConfig.adguardMode === 'webhook' && (
            <div className="deploy-field-group">
              <label className="deploy-field-label">Home Assistant Webhook URL</label>
              <input
                type="url"
                className="deploy-field-input"
                placeholder="https://hooks.nabu.casa/... or http://homeassistant.local:8123/api/webhook/..."
                value={sinkholeConfig.haWebhookUrl || ''}
                onChange={(e) => setSinkholeConfig({ ...sinkholeConfig, haWebhookUrl: e.target.value })}
              />
              <span className="deploy-field-hint">
                Triggers your Home Assistant automation to reload AdGuard or Pi-hole
              </span>
              {secretStorageAvailable === false && (
                <p className="setting-message error" style={{ marginTop: 6 }}>
                  OS keychain encryption is unavailable — this URL is stored as plaintext on disk.
                </p>
              )}
            </div>
          )}

          <div className="deploy-field-group">
            <label className="deploy-checkbox-label">
              <input
                type="checkbox"
                checked={sinkholeConfig.syncOnCompile}
                onChange={(e) => handleToggleSyncOnCompile(e.target.checked)}
              />
              <span>Automatically push & reload Home Assistant when compiling filters</span>
            </label>
          </div>

          <div className="deploy-actions-row">
            <button
              type="button"
              className="deploy-btn primary"
              onClick={() => handleSaveSinkholeConfig('adguard')}
              disabled={isSavingSinkhole}
            >
              {isSavingSinkhole ? 'Saving...' : 'Save Connection'}
            </button>
            <button
              type="button"
              className="deploy-btn"
              onClick={() => handleTestConnection('adguard')}
              disabled={testingService !== null}
            >
              {testingService === 'adguard' ? 'Testing...' : 'Test Connection'}
            </button>
            <button
              type="button"
              className="deploy-btn"
              onClick={() => handleTriggerLiveSync('adguard')}
              disabled={isSyncingSinkhole}
            >
              {isSyncingSinkhole ? 'Reloading...' : 'Reload Home Assistant'}
            </button>
          </div>

          {sinkholeMessage && (
            <div className="deploy-message-banner success">{sinkholeMessage}</div>
          )}

          {testResult && testResult.service === 'adguard' && (
            <div className={`deploy-test-result-box ${testResult.success ? 'success' : 'error'}`}>
              <strong>{testResult.success ? '✓ Connection Verified' : '✕ Connection Error'}:</strong>{' '}
              {testResult.message}
            </div>
          )}
        </div>
      </div>

      {/* Right Column: Home Assistant Integration & Add-on Hub */}
      <div className="deploy-pane-column">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">🧩</span>
            <div>
              <h3 className="deploy-pane-title">Integration & Add-on Endpoints</h3>
              <p className="deploy-pane-subtitle">
                Expose live metrics, sensors, and controls into your Home Assistant dashboards
              </p>
            </div>
          </div>
        </div>

        <div className="deploy-pane-body">
          {/* Endpoint 1: REST API /v1/status */}
          <div className="deploy-feed-box">
            <div className="deploy-feed-box-top">
              <span className="deploy-feed-box-label">📡 Home Assistant Integration API</span>
              <span className="deploy-feed-box-tag">HACS / Custom Component</span>
            </div>
            <p className="deploy-feed-box-desc">
              Point the Home Assistant <code>blockingmachine</code> integration at this desktop app:
            </p>
            <div className="deploy-feed-input-row">
              <input
                type="text"
                readOnly
                value={statusUrl}
                title={statusUrl}
                className="deploy-feed-input"
              />
              <button
                type="button"
                className={`deploy-copy-feed-btn ${copiedKey === 'ha-status-url' ? 'copied' : ''}`}
                onClick={() => handleCopy(statusUrl, 'ha-status-url')}
              >
                {copiedKey === 'ha-status-url' ? '✓ Copied' : 'Copy API URL'}
              </button>
            </div>
          </div>

          {/* Endpoint 2: DNS Feed for AdGuard Home in HA */}
          <div className="deploy-feed-box">
            <div className="deploy-feed-box-top">
              <span className="deploy-feed-box-label">🛡️ Pure DNS Feed (AdGuard Home in HA)</span>
              <span className="deploy-feed-box-tag">Zero Browser Modifiers</span>
            </div>
            <div className="deploy-feed-input-row">
              <input
                type="text"
                readOnly
                value={dnsFeedUrl}
                title={dnsFeedUrl}
                className="deploy-feed-input"
              />
              <button
                type="button"
                className={`deploy-copy-feed-btn ${copiedKey === 'ha-dns-feed' ? 'copied' : ''}`}
                onClick={() => handleCopy(dnsFeedUrl, 'ha-dns-feed')}
              >
                {copiedKey === 'ha-dns-feed' ? '✓ Copied' : 'Copy DNS Feed'}
              </button>
            </div>
          </div>

          {/* Endpoint 3: Browser Feed */}
          <div className="deploy-feed-box">
            <div className="deploy-feed-box-top">
              <span className="deploy-feed-box-label">🌐 Browser Extension Feed</span>
              <span className="deploy-feed-box-tag">Network + Cosmetics</span>
            </div>
            <div className="deploy-feed-input-row">
              <input
                type="text"
                readOnly
                value={browserFeedUrl}
                title={browserFeedUrl}
                className="deploy-feed-input"
              />
              <button
                type="button"
                className={`deploy-copy-feed-btn ${copiedKey === 'ha-browser-feed' ? 'copied' : ''}`}
                onClick={() => handleCopy(browserFeedUrl, 'ha-browser-feed')}
              >
                {copiedKey === 'ha-browser-feed' ? '✓ Copied' : 'Copy Browser Feed'}
              </button>
            </div>
          </div>

          {/* Endpoint 4: AI Threat Quarantine Feed (ABP Format) */}
          <div className="deploy-feed-box">
            <div className="deploy-feed-box-top">
              <span className="deploy-feed-box-label">⚡ AI Threat Quarantine Feed (ABP Format)</span>
              <span className="deploy-feed-box-tag">Auto-updating DGA / Malware</span>
            </div>
            <div className="deploy-feed-input-row">
              <input
                type="text"
                readOnly
                value={threatsAbpUrl}
                title={threatsAbpUrl}
                className="deploy-feed-input"
              />
              <button
                type="button"
                className={`deploy-copy-feed-btn ${copiedKey === 'ha-threats-abp-feed' ? 'copied' : ''}`}
                onClick={() => handleCopy(threatsAbpUrl, 'ha-threats-abp-feed')}
              >
                {copiedKey === 'ha-threats-abp-feed' ? '✓ Copied' : 'Copy ABP Threats'}
              </button>
            </div>
          </div>

          {/* Endpoint 5: AI Threat Quarantine Feed (Domain List) */}
          <div className="deploy-feed-box">
            <div className="deploy-feed-box-top">
              <span className="deploy-feed-box-label">🛑 AI Threat Feed (Raw Domains)</span>
              <span className="deploy-feed-box-tag">Zero-Day High Entropy</span>
            </div>
            <div className="deploy-feed-input-row">
              <input
                type="text"
                readOnly
                value={threatsRawUrl}
                title={threatsRawUrl}
                className="deploy-feed-input"
              />
              <button
                type="button"
                className={`deploy-copy-feed-btn ${copiedKey === 'ha-threats-raw-feed' ? 'copied' : ''}`}
                onClick={() => handleCopy(threatsRawUrl, 'ha-threats-raw-feed')}
              >
                {copiedKey === 'ha-threats-raw-feed' ? '✓ Copied' : 'Copy Domain Feed'}
              </button>
            </div>
          </div>

          {/* Extension static tier capacity.

              Sits with the browser extension's own endpoints because that is what it is about:
              the four tier rulesets the extension ships, whether they fit, and what the plan
              is worth. The extension popup answers the same question against a live grant the
              hub cannot see, so this one asks for a capacity explicitly rather than reporting
              Chrome's guaranteed floor as though it were the real one. */}
          <ExtensionTierPlanCard
            state={tierPlanState}
            result={tierPlan}
            error={tierPlanError}
            enabled={[]}
            onRefresh={loadTierPlan}
            onChooseLedger={chooseTierLedger}
            onClearLedger={clearTierLedger}
          />

          {/* Live Status Inspector */}
          <div className="deploy-tool-box">
            <div className="deploy-tool-box-header">
              <strong>Inspect Live /v1/status Output</strong>
              <button
                type="button"
                className="deploy-tool-btn"
                onClick={handleInspectHaApi}
                disabled={isTestingHaApi}
              >
                {isTestingHaApi ? 'Querying...' : 'Fetch Live JSON'}
              </button>
            </div>
            {haApiPreview && (
              <pre className="deploy-json-preview">{haApiPreview}</pre>
            )}
          </div>

          {/* Setup Guide */}
          <div className="deploy-instructions-box">
            <h4 className="deploy-instructions-title">Quick Setup in Home Assistant:</h4>
            <ol className="deploy-instructions-list">
              <li>
                Copy <code>packages/homeassistant-integration/custom_components/blockingmachine</code> into your HA <code>config/custom_components/</code> folder (or install via HACS).
              </li>
              <li>Restart Home Assistant.</li>
              <li>
                Go to <strong>Settings</strong> &gt; <strong>Devices &amp; Services</strong> &gt; <strong>Add Integration</strong> &gt; search <strong>Blockingmachine</strong>.
              </li>
              <li>
                Enter Host <code>{serverStatus?.lanIp || '127.0.0.1'}</code> and Port <code>{serverStatus?.port || 9191}</code>.
              </li>
              <li>Your Home Assistant dashboard will automatically gain live sensors, compile buttons, and protection switches!</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
};

export const renderHomeAssistantPane = (props: HomeAssistantPaneProps) => (
  <HomeAssistantPane {...props} />
);
