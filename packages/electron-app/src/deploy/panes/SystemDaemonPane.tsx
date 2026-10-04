import React from 'react';
import type { HubPaneProps } from './paneProps';

/**
 * The bundled DNS daemon, and the OS resolver pointed at it.
 *
 * The one pane that starts and stops something. Every other deployment here ends with a subscription
 * URL or a file to copy; this one installs a process, points the machine's own resolver at
 * `127.0.0.1`, and has to be reversible — a user who stops the daemon without restoring DNS gets a
 * machine that resolves nothing, which is why "Restore DHCP Default" sits beside "Set as System DNS"
 * rather than in a menu somewhere.
 *
 * State that only this pane shows — the install scripts, the selected interface — is read from props
 * and written through the handlers it is given, so the Hub does not accumulate fields it never
 * renders. The refresh the tab triggers on selection is the one state action the registry declares,
 * because the service's status is live and a stale reading would be worse than no reading.
 */

/**
 * The fields of the Hub bundle this pane reads. The registry carries the same list, so the type
 * the pane is written against and the object it is handed are the one declaration — a field added
 * here reaches the pane, and a field read but not declared does not compile.
 */
export const systemDaemonPaneKeys = [
  'handleCopy',
  'copiedKey',
  'daemonStatus',
  'isDaemonLoading',
  'daemonMessage',
  'networkServices',
  'selectedService',
  'setSelectedService',
  'showInstallScripts',
  'serviceScripts',
  'refreshDaemonStatus',
  'handleStartDaemon',
  'handleStopDaemon',
  'handleToggleDaemonProtection',
  'handleReloadDaemon',
  'handleSetSystemDns',
  'handleRestoreSystemDns',
  'handleFlushCache',
  'handleToggleInstallScripts',
] as const satisfies readonly (keyof HubPaneProps)[];

export type SystemDaemonPaneProps = Pick<HubPaneProps, (typeof systemDaemonPaneKeys)[number]>;

export const SystemDaemonPane: React.FC<SystemDaemonPaneProps> = ({
  handleCopy,
  copiedKey,
  daemonStatus,
  isDaemonLoading,
  daemonMessage,
  networkServices,
  selectedService,
  setSelectedService,
  showInstallScripts,
  serviceScripts,
  refreshDaemonStatus,
  handleStartDaemon,
  handleStopDaemon,
  handleToggleDaemonProtection,
  handleReloadDaemon,
  handleSetSystemDns,
  handleRestoreSystemDns,
  handleFlushCache,
  handleToggleInstallScripts,
}) => {
  return (
    <div className="deploy-dual-pane">
      {/* Left Column: Local Daemon Status & System DNS */}
      <div className="deploy-pane-column">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">🖥️</span>
            <div>
              <h3 className="deploy-pane-title">Local DNS Filtering Proxy</h3>
              <p className="deploy-pane-subtitle">
                Zero-latency, on-device loopback filtering for all system apps and network traffic
              </p>
            </div>
          </div>
          <div
            className={`deploy-pane-status-pill ${
              daemonStatus?.status === 'running'
                ? 'connected'
                : daemonStatus?.status === 'paused'
                ? 'testing'
                : 'idle'
            }`}
          >
            {daemonStatus?.status === 'running'
              ? '● Active Shield'
              : daemonStatus?.status === 'paused'
              ? '⏸ Paused'
              : '○ Daemon Inactive'}
          </div>
        </div>

        <div className="deploy-pane-body">
          {/* Daemon Status Summary Box */}
          <div className="deploy-feed-box">
            <div className="deploy-feed-box-top">
              <span className="deploy-feed-box-label">⚙️ Daemon Process Status</span>
              <span className="deploy-feed-box-tag">
                {daemonStatus?.managedByApp ? 'Managed by App' : 'External / Service'}
              </span>
            </div>
            <div className="deploy-form-fields-grid" style={{ marginTop: '8px' }}>
              <div className="deploy-field-group">
                <span className="deploy-field-label">DNS Port</span>
                <strong style={{ fontSize: '13px', color: 'var(--text-color, #e0e0e0)' }}>
                  {daemonStatus?.port || 5353} (UDP)
                </strong>
              </div>
              <div className="deploy-field-group">
                <span className="deploy-field-label">Control Port</span>
                <strong style={{ fontSize: '13px', color: 'var(--text-color, #e0e0e0)' }}>
                  {daemonStatus?.controlPort || 9292} (HTTP)
                </strong>
              </div>
              <div className="deploy-field-group">
                <span className="deploy-field-label">Loaded Rules</span>
                <strong style={{ fontSize: '13px', color: 'var(--tone-success)' }}>
                  {daemonStatus?.rulesLoaded?.toLocaleString() || '0'}
                </strong>
              </div>
              <div className="deploy-field-group">
                <span className="deploy-field-label">Upstream DoH</span>
                <span style={{ fontSize: '12px', color: 'var(--muted-text)' }} title={daemonStatus?.upstream}>
                  {daemonStatus?.upstream ? new URL(daemonStatus.upstream).hostname : 'dns.quad9.net'}
                </span>
              </div>
            </div>

            <div className="deploy-actions-row" style={{ marginTop: '14px' }}>
              {daemonStatus?.status === 'stopped' ? (
                <button
                  type="button"
                  className="deploy-btn primary"
                  onClick={handleStartDaemon}
                  disabled={isDaemonLoading}
                >
                  {isDaemonLoading ? 'Starting...' : 'Start Local Daemon'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="deploy-btn"
                    onClick={handleToggleDaemonProtection}
                    disabled={isDaemonLoading}
                  >
                    {daemonStatus?.status === 'running' ? 'Pause Protection' : 'Resume Protection'}
                  </button>
                  <button
                    type="button"
                    className="deploy-btn"
                    onClick={handleReloadDaemon}
                    disabled={isDaemonLoading}
                  >
                    Reload Rules
                  </button>
                  {daemonStatus?.managedByApp && (
                    <button
                      type="button"
                      className="deploy-btn danger"
                      onClick={handleStopDaemon}
                      disabled={isDaemonLoading}
                    >
                      Stop Daemon
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                className="deploy-btn"
                onClick={refreshDaemonStatus}
                disabled={isDaemonLoading}
              >
                Refresh
              </button>
            </div>
          </div>

          {/* OS Resolver Configuration Box */}
          <div className="deploy-feed-box" style={{ marginTop: '16px' }}>
            <div className="deploy-feed-box-top">
              <span className="deploy-feed-box-label">🌐 Operating System DNS Resolver</span>
              <span className="deploy-feed-box-tag">macOS / Linux</span>
            </div>
            <p className="deploy-feed-box-desc">
              Point your computer's network interface directly to <code>127.0.0.1</code> to block ads across all native desktop applications:
            </p>

            <div className="deploy-field-group" style={{ marginBottom: '10px' }}>
              <label className="deploy-field-label">Network Interface:</label>
              <select
                className="deploy-field-input"
                value={selectedService}
                onChange={(e) => setSelectedService(e.target.value)}
              >
                {networkServices.map((svc) => (
                  <option key={svc} value={svc}>
                    {svc}
                  </option>
                ))}
              </select>
            </div>

            <div className="deploy-actions-row">
              <button
                type="button"
                className="deploy-btn primary"
                onClick={handleSetSystemDns}
                disabled={isDaemonLoading}
              >
                Set as System DNS (127.0.0.1)
              </button>
              <button
                type="button"
                className="deploy-btn"
                onClick={handleRestoreSystemDns}
                disabled={isDaemonLoading}
              >
                Restore DHCP Default
              </button>
              <button
                type="button"
                className="deploy-btn"
                onClick={handleFlushCache}
                disabled={isDaemonLoading}
              >
                Flush DNS Cache
              </button>
            </div>
          </div>

          {daemonMessage && (
            <div className="deploy-message-banner success" style={{ marginTop: '12px' }}>
              {daemonMessage}
            </div>
          )}
        </div>
      </div>

      {/* Right Column: Live Telemetry & OS Service Installation */}
      <div className="deploy-pane-column">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">📊</span>
            <div>
              <h3 className="deploy-pane-title">DNS Telemetry &amp; Service Setup</h3>
              <p className="deploy-pane-subtitle">
                Live loopback traffic metrics and OS background daemon configuration
              </p>
            </div>
          </div>
        </div>

        <div className="deploy-pane-body">
          {/* Telemetry Stat Cards */}
          <div className="deploy-feed-box">
            <div className="deploy-feed-box-top">
              <span className="deploy-feed-box-label">📈 Real-Time DNS Traffic</span>
              <span className="deploy-feed-box-tag">Live Feed</span>
            </div>
            <div className="deploy-form-fields-grid" style={{ marginTop: '8px' }}>
              <div className="deploy-field-group">
                <span className="deploy-field-label">Total Queries</span>
                <strong style={{ fontSize: '16px', color: 'var(--text-color, #fff)' }}>
                  {daemonStatus?.stats?.totalQueries?.toLocaleString() || '0'}
                </strong>
              </div>
              <div className="deploy-field-group">
                <span className="deploy-field-label">Blocked Trackers</span>
                <strong style={{ fontSize: '16px', color: '#ff4d4f' }}>
                  {daemonStatus?.stats?.blockedQueries?.toLocaleString() || '0'}
                </strong>
              </div>
              <div className="deploy-field-group">
                <span className="deploy-field-label">Allowed Queries</span>
                <strong style={{ fontSize: '16px', color: '#00d26a' }}>
                  {daemonStatus?.stats?.allowedQueries?.toLocaleString() || '0'}
                </strong>
              </div>
              <div className="deploy-field-group">
                <span className="deploy-field-label">Block Rate</span>
                <strong style={{ fontSize: '16px', color: '#1890ff' }}>
                  {daemonStatus?.stats?.blockRatePercent != null ? `${daemonStatus.stats.blockRatePercent}%` : '0%'}
                </strong>
              </div>
            </div>
          </div>

          {/* OS Background Service Installation */}
          <div className="deploy-instructions-box" style={{ marginTop: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 className="deploy-instructions-title" style={{ margin: 0 }}>
                Install as OS Background Service (Port 53)
              </h4>
              <button
                type="button"
                className="deploy-tool-btn"
                onClick={handleToggleInstallScripts}
              >
                {showInstallScripts ? 'Hide Scripts' : 'View Install Scripts'}
              </button>
            </div>
            <p className="deploy-feed-box-desc" style={{ marginTop: '8px' }}>
              Running Blockingmachine as a system daemon on port 53 starts automatically at boot and protects all users, background tasks, and browsers with zero overhead.
            </p>

            {showInstallScripts && serviceScripts && (
              <div style={{ marginTop: '12px' }}>
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600 }}>macOS launchd Plist &amp; Commands</span>
                    <button
                      type="button"
                      className="deploy-copy-feed-btn"
                      onClick={() => handleCopy(serviceScripts.mac, 'mac-daemon-script')}
                    >
                      {copiedKey === 'mac-daemon-script' ? '✓ Copied' : 'Copy Commands'}
                    </button>
                  </div>
                  <pre className="deploy-json-preview" style={{ maxHeight: '160px' }}>{serviceScripts.mac}</pre>
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600 }}>Linux systemd Unit &amp; Commands</span>
                    <button
                      type="button"
                      className="deploy-copy-feed-btn"
                      onClick={() => handleCopy(serviceScripts.linux, 'linux-daemon-script')}
                    >
                      {copiedKey === 'linux-daemon-script' ? '✓ Copied' : 'Copy Commands'}
                    </button>
                  </div>
                  <pre className="deploy-json-preview" style={{ maxHeight: '160px' }}>{serviceScripts.linux}</pre>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export const renderSystemDaemonPane = (props: SystemDaemonPaneProps) => (
  <SystemDaemonPane {...props} />
);
