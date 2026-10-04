import React from 'react';
import type { HubPaneProps } from './paneProps';

/**
 * The browser extension: the install that lives inside the page.
 *
 * Every other target in this Hub is a downstream consumer of one compiled list — a resolver, a
 * sinkhole, a subscription file. The extension is different in kind: it ships the Mini-AI, the
 * site controls and the hit ledger into the browser itself, so its "deploy" is a browser-side
 * load, not a feed subscription. The hub's part ends at writing a current build somewhere the
 * browser can read it; the browser's part is the load button, which no app may press for the
 * user.
 *
 * The pane is also the Hub's index: the same protection installs into Home Assistant, the DNS
 * targets and the phone apps through their own tabs, so the pane links each one rather than
 * duplicating instructions it would only drift from.
 */

/**
 * The fields of the Hub bundle this pane reads. The registry carries the same list, so the type
 * the pane is written against and the object it is handed are the one declaration — a field added
 * here reaches the pane, and a field read but not declared does not compile.
 */
export const browserExtensionPaneKeys = [
  'extensionSaving',
  'extensionSavedPath',
  'extensionMessage',
  'handleDownloadExtension',
  'siblingTargets',
  'onSelectTarget',
  'handleCopy',
  'copiedKey',
  'serverStatus',
  'feedToken',
] as const satisfies readonly (keyof HubPaneProps)[];

export type BrowserExtensionPaneProps = Pick<
  HubPaneProps,
  (typeof browserExtensionPaneKeys)[number]
>;

export const BrowserExtensionPane: React.FC<BrowserExtensionPaneProps> = ({
  extensionSaving,
  extensionSavedPath,
  extensionMessage,
  handleDownloadExtension,
  siblingTargets,
  onSelectTarget,
  handleCopy,
  copiedKey,
  serverStatus,
  feedToken,
}) => {
  // Same machine, so the loopback feed — the LAN URL is for devices that are not this one.
  const feedUrl = serverStatus?.localUrl
    ? `${serverStatus.localUrl}/browser.txt`
    : 'http://localhost:9191/browser.txt';
  return (
    <div className="deploy-single-platform-wrap">
      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">🧩</span>
            <div>
              <h3 className="deploy-pane-title">Browser Extension Package</h3>
              <p className="deploy-pane-subtitle">
                Chrome, Edge, Brave, Arc — and Firefox
              </p>
            </div>
          </div>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
          The build is written fresh on every download, so the folder the browser loads is always
          the code this hub is running — never whatever <code>dist/</code> happened to hold.
        </p>

        <div className="deploy-feed-input-row">
          <button
            type="button"
            className="deploy-copy-feed-btn"
            onClick={() => void handleDownloadExtension()}
            disabled={extensionSaving}
          >
            {extensionSaving ? 'Building…' : 'Download extension package…'}
          </button>
          {extensionSavedPath && (
            <button
              type="button"
              className={`deploy-copy-feed-btn ${copiedKey === 'extension-path' ? 'copied' : ''}`}
              onClick={() => handleCopy(extensionSavedPath, 'extension-path')}
            >
              {copiedKey === 'extension-path' ? '✓ Copied' : 'Copy saved path'}
            </button>
          )}
        </div>
        {extensionMessage && (
          <p
            style={{
              fontSize: '12px',
              margin: 0,
              color: extensionMessage.type === 'error' ? 'var(--danger-color, #ff6b6b)' : '#10b981',
            }}
          >
            {extensionMessage.text}
          </p>
        )}
        {extensionSavedPath && (
          <p
            style={{
              fontSize: '12px',
              color: 'var(--secondary-color)',
              margin: 0,
              wordBreak: 'break-all',
            }}
          >
            Saved to <code>{extensionSavedPath}</code>
          </p>
        )}
      </div>

      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">📋</span>
            <div>
              <h3 className="deploy-pane-title">Load it in the browser</h3>
              <p className="deploy-pane-subtitle">
                The browser holds the install button — these are the clicks
              </p>
            </div>
          </div>
        </div>

        <div className="deploy-numbered-stepper">
          <div className="stepper-step">
            <div className="stepper-num">1</div>
            <div className="stepper-content">
              <h4>Chromium — Chrome, Edge, Brave, Arc</h4>
              <p>
                Open <code>chrome://extensions</code>, switch on{' '}
                <strong>Developer mode</strong>, choose{' '}
                <strong>Load unpacked</strong> and select the{' '}
                <code>blockingmachine-extension</code> folder the download wrote.
              </p>
            </div>
          </div>
          <div className="stepper-step">
            <div className="stepper-num">2</div>
            <div className="stepper-content">
              <h4>Firefox</h4>
              <p>
                Open <code>about:debugging#/runtime/this-firefox</code>, choose{' '}
                <strong>Load Temporary Add-on…</strong> and select{' '}
                <code>manifest.json</code> inside the same folder. Temporary installs unload when
                the browser restarts — a permanent install needs a Mozilla-signed build.
              </p>
            </div>
          </div>
          <div className="stepper-step">
            <div className="stepper-num">3</div>
            <div className="stepper-content">
              <h4>Point it at this hub</h4>
              <p>
                In the popup's <strong>Hub &amp; Home Assistant</strong> section, set the feed URL
                to <code>{feedUrl}</code>
                {feedToken
                  ? ' and paste the feed token you configured — the hub refuses mutations without it.'
                  : '.'}{' '}
                The extension then syncs this hub's compiled rules and reports what it actually
                blocked back into the tier plan.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="deploy-info-card deploy-info-card-wide">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">🗂</span>
            <div>
              <h3 className="deploy-pane-title">Everywhere else it installs</h3>
              <p className="deploy-pane-subtitle">
                The same protection, for the places a browser does not reach
              </p>
            </div>
          </div>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: '0 0 2px 0' }}>
          Each target has its own tab in this hub with the full instructions — the list below is
          the index, not the recipe.
        </p>
        <div className="deploy-sibling-grid">
          {siblingTargets.map((target) => (
            <button
              key={target.id}
              type="button"
              className="deploy-sibling-tile"
              onClick={() => onSelectTarget(target.id)}
            >
              {target.icon && <span className="deploy-sibling-tile-icon">{target.icon}</span>}
              <span className="deploy-sibling-tile-text">
                <span className="deploy-sibling-tile-label">{target.label}</span>
                <span className="deploy-sibling-tile-summary">{target.summary}</span>
              </span>
              <svg
                className="deploy-sibling-tile-arrow"
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export const renderBrowserExtensionPane = (props: BrowserExtensionPaneProps) => (
  <BrowserExtensionPane {...props} />
);
