import React from 'react';
import type { FeedServerStatus, FilterFormat } from '../types/';
import { resolveLanFeedUrl } from './feedUrls';

/**
 * The Deploy Hub's top bar: the compiled artifact's identity on the left, the LAN feed server's
 * state on the right.
 *
 * This is markup, not state — the same rule the panes under `deploy/panes/` follow. The view keeps
 * every `useState` and effect and hands this component values plus handlers, so the header can be
 * rendered from an object literal with no Electron bridge, the way the panes are. The feed URL is
 * derived here from the same `resolveLanFeedUrl` the panes call, not passed in — a pane and the
 * header cannot disagree about the address they print because neither computes its own version.
 */
export interface DeployHubHeaderProps {
  /** Absolute path of the compiled list, or empty before one is chosen. */
  savePath: string;
  /** The format the list was written in — the badge text next to the count. */
  exportFormat: FilterFormat;
  /** Rule count the badge reports, or null until the first compile is read. */
  uniqueRulesCount: number | null;
  /** Last compile timestamp, or null when there is none to show. */
  lastProcessTime: string | null;
  /** Copies text and lights the button that asked for it. Shared with every pane. */
  handleCopy: (text: string, key: string) => void;
  /** The key currently showing "Copied", or null. */
  copiedKey: string | null;
  /** Recompiles now; the ⌘R button is absent when the app did not pass one. */
  onTriggerCompile?: () => void;
  /** Opens the format/export settings; the button is absent when not passed. */
  onNavigateSettings?: () => void;
  /** Live server state, or null before the first status read. */
  serverStatus: FeedServerStatus | null;
  /** True while a start/stop is in flight; disables the toggle. */
  isServerLoading: boolean;
  onToggleFeedServer: () => void;
  /** Whether the feed server starts with the app, and the toggle for it. */
  autoStartFeedServer: boolean;
  onToggleAutoStartFeedServer: (enabled: boolean) => void;
  /** Whether the app launches on login, and the toggle for it. */
  launchOnStartup: boolean;
  onToggleLaunchOnStartup: (enabled: boolean) => void;
}

export const DeployHubHeader: React.FC<DeployHubHeaderProps> = ({
  savePath,
  exportFormat,
  uniqueRulesCount,
  lastProcessTime,
  handleCopy,
  copiedKey,
  onTriggerCompile,
  onNavigateSettings,
  serverStatus,
  isServerLoading,
  onToggleFeedServer,
  autoStartFeedServer,
  onToggleAutoStartFeedServer,
  launchOnStartup,
  onToggleLaunchOnStartup,
}) => {
  const lanFeedUrl = resolveLanFeedUrl(serverStatus, savePath);
  return (
    <div className="deploy-hub-top-bar">
      {/* Left: Compiled Target List File Info */}
      <div className="deploy-top-file-info">
        <div className="deploy-file-main-row">
          <div className="deploy-file-badge-group">
            <span className="deploy-format-pill">{exportFormat.toUpperCase()}</span>
            <span className="deploy-count-pill">
              {uniqueRulesCount ? `${uniqueRulesCount.toLocaleString()} Active Rules` : 'Ready to Deploy'}
            </span>
            {lastProcessTime && (
              <span className="deploy-time-pill">
                • Updated {new Date(lastProcessTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          <div className="deploy-file-path-row">
            <span className="deploy-file-path" title={savePath}>{savePath || 'No save path configured'}</span>
          </div>
        </div>

        <div className="deploy-file-actions-row">
          {onTriggerCompile && (
            <button
              type="button"
              className="deploy-tool-btn primary"
              onClick={onTriggerCompile}
              title="Recompile blocklists now (⌘R)"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              <span>Compile (⌘R)</span>
            </button>
          )}
          <button
            type="button"
            className={`deploy-tool-btn ${copiedKey === 'local-path' ? 'copied' : ''}`}
            onClick={() => handleCopy(savePath, 'local-path')}
            title="Copy absolute filesystem path"
          >
            <span>{copiedKey === 'local-path' ? 'Copied Path!' : 'Copy Path'}</span>
          </button>
          {window.electron?.showItemInFolder && (
            <button
              type="button"
              className="deploy-tool-btn"
              onClick={() => window.electron.showItemInFolder(savePath)}
              title="Reveal file in macOS Finder"
            >
              <span>Reveal in Finder</span>
            </button>
          )}
          {onNavigateSettings && (
            <button
              type="button"
              className="deploy-tool-btn"
              onClick={onNavigateSettings}
              title="Format & export settings"
            >
              <span>Format Settings</span>
            </button>
          )}
        </div>
      </div>

      {/* Right: LAN Feed Server Cardlet */}
      <div className={`deploy-top-server-cardlet ${serverStatus?.isRunning ? 'online' : 'offline'}`}>
        <div className="deploy-server-top-row">
          <div className="deploy-server-status-indicator">
            <span className={`deploy-server-dot ${serverStatus?.isRunning ? 'online' : 'offline'}`} />
            <span className="deploy-server-title">
              {serverStatus?.isRunning ? `LAN Server :${serverStatus.port || 9191} (Live)` : 'LAN Feed Server (Offline)'}
            </span>
          </div>
          <button
            type="button"
            className={`deploy-server-toggle-btn ${serverStatus?.isRunning ? 'stop' : 'start'}`}
            onClick={onToggleFeedServer}
            disabled={isServerLoading}
          >
            {isServerLoading ? '…' : serverStatus?.isRunning ? 'Stop Server' : 'Start Server'}
          </button>
        </div>

        <div className="deploy-server-url-row">
          <code className="deploy-server-url" title={lanFeedUrl}>{lanFeedUrl}</code>
          <button
            type="button"
            className={`deploy-server-copy-btn ${copiedKey === 'lan-url' ? 'copied' : ''}`}
            onClick={() => handleCopy(lanFeedUrl, 'lan-url')}
            title="Copy LAN subscription URL for remote devices"
          >
            {copiedKey === 'lan-url' ? '✓ Copied' : 'Copy'}
          </button>
        </div>

        <div className="deploy-server-options-row">
          <label className="deploy-checkbox-label" title="Start LAN server when Blockingmachine launches">
            <input
              type="checkbox"
              checked={autoStartFeedServer}
              onChange={(e) => onToggleAutoStartFeedServer(e.target.checked)}
            />
            <span>Auto-start on launch</span>
          </label>
          <label className="deploy-checkbox-label" title="Launch Blockingmachine on computer startup">
            <input
              type="checkbox"
              checked={launchOnStartup}
              onChange={(e) => onToggleLaunchOnStartup(e.target.checked)}
            />
            <span>Launch on computer startup</span>
          </label>
        </div>
      </div>
    </div>
  );
};
