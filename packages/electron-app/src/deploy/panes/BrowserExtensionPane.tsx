import React from 'react';
import type { HubPaneProps } from './paneProps';
import { ExtensionTierPlanCard } from '../../components/ExtensionTierPlanCard';

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
  'extensionBrowser',
  'setExtensionBrowser',
  'extensionSaving',
  'extensionSavedPath',
  'extensionMessage',
  'handleDownloadExtension',
  'handleInstallExtension',
  'siblingTargets',
  'onSelectTarget',
  'handleCopy',
  'copiedKey',
  'serverStatus',
  'feedTokenConfigured',
  'tierPlanState',
  'tierPlan',
  'tierPlanError',
  'loadTierPlan',
  'chooseTierLedger',
  'clearTierLedger',
] as const satisfies readonly (keyof HubPaneProps)[];

export type BrowserExtensionPaneProps = Pick<
  HubPaneProps,
  (typeof browserExtensionPaneKeys)[number]
>;

export const BrowserExtensionPane: React.FC<BrowserExtensionPaneProps> = ({
  extensionBrowser,
  setExtensionBrowser,
  extensionSaving,
  extensionSavedPath,
  extensionMessage,
  handleDownloadExtension,
  handleInstallExtension,
  siblingTargets,
  onSelectTarget,
  handleCopy,
  copiedKey,
  serverStatus,
  feedTokenConfigured,
  tierPlanState,
  tierPlan,
  tierPlanError,
  loadTierPlan,
  chooseTierLedger,
  clearTierLedger,
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
              <h2 className="deploy-pane-title">Browser Extension Package</h2>
              <p className="deploy-pane-subtitle">
                Chrome, Edge, Brave, Arc — and Firefox
              </p>
            </div>
          </div>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
          <strong>Install into browser</strong> stages the build this app already carries into its
          own stable folder — <code>Application Support/Blockingmachine/extension/</code> — puts
          the path on your clipboard and opens the browser&apos;s load page. The stable path keeps
          the unpacked extension&apos;s ID — and its synced rules, pairing and decisions — the same
          across app updates. <strong>Download release package</strong> pulls the GitHub release
          zip to a folder you pick instead — for a build the app does not manage.
        </p>

        <div className="deploy-field-group" style={{ margin: '10px 0' }}>
          <label htmlFor="extensionBrowser" className="deploy-field-label">Browser:</label>
          <select
            id="extensionBrowser"
            className="deploy-field-input"
            value={extensionBrowser}
            onChange={(e) => setExtensionBrowser(e.target.value as 'chromium' | 'firefox' | 'both')}
          >
            <option value="chromium">Chromium — Chrome, Edge, Brave, Arc</option>
            <option value="firefox">Firefox</option>
            <option value="both">Both</option>
          </select>
        </div>

        <div className="deploy-feed-input-row">
          <button
            type="button"
            className="deploy-copy-feed-btn"
            onClick={() =>
              void handleInstallExtension(extensionBrowser === 'firefox' ? 'firefox' : 'chromium')
            }
            disabled={extensionSaving || extensionBrowser === 'both'}
            title={
              extensionBrowser === 'both'
                ? 'Pick one browser — guided install stages one at a time so the clipboard holds the right path.'
                : 'Stages the bundled build at the app\'s stable extension path, opens the browser\'s load page, and copies the path for the file picker.'
            }
          >
            {extensionSaving ? 'Staging…' : 'Install into browser →'}
          </button>
          <button
            type="button"
            className="deploy-copy-feed-btn"
            onClick={() => void handleDownloadExtension(extensionBrowser)}
            disabled={extensionSaving}
            title="Downloads the release zip to a folder you pick instead — for a build the app does not manage."
          >
            {extensionSaving ? 'Downloading…' : 'Download release package…'}
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
              color: extensionMessage.type === 'error' ? 'var(--danger-color, #ff6b6b)' : 'var(--tone-success)',
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
              <h2 className="deploy-pane-title">Load it in the browser</h2>
              <p className="deploy-pane-subtitle">
                The browser holds the install button — these are the clicks
              </p>
            </div>
          </div>
        </div>

        <div className="deploy-numbered-stepper">
          {extensionBrowser !== 'firefox' && (
            <div className="stepper-step">
              <div className="stepper-num">1</div>
              <div className="stepper-content">
                <h3>Chromium — Chrome, Edge, Brave, Arc</h3>
                <p>
                  Open <code>chrome://extensions</code>, switch on{' '}
                  <strong>Developer mode</strong>, choose <strong>Load unpacked</strong>, press{' '}
                  <strong>⌘⇧G</strong> and paste — the staged folder&apos;s path is already on your
                  clipboard (or select the <code>blockingmachine-extension</code> folder the
                  download wrote). Re-installing over the same path keeps the extension&apos;s
                  identity and stored rules.
                </p>
              </div>
            </div>
          )}
          {extensionBrowser !== 'chromium' && (
            <div className="stepper-step">
              <div className="stepper-num">{extensionBrowser === 'both' ? 2 : 1}</div>
              <div className="stepper-content">
                <h3>Firefox</h3>
                <p>
                  Open <code>about:debugging#/runtime/this-firefox</code>, choose{' '}
                  <strong>Load Temporary Add-on…</strong>, press <strong>⌘⇧G</strong>, paste the
                  staged path and select <code>manifest.json</code> (or find{' '}
                  <code>manifest.json</code> inside the <code>blockingmachine-extension-firefox</code>{' '}
                  folder the download wrote). Temporary installs unload when the browser restarts —
                  a permanent install needs a Mozilla-signed build.
                </p>
              </div>
            </div>
          )}
          <div className="stepper-step">
            <div className="stepper-num">{extensionBrowser === 'both' ? 3 : 2}</div>
            <div className="stepper-content">
              <h3>Point it at this hub</h3>
              <p>
                In the popup's <strong>Hub &amp; Home Assistant</strong> section, set the feed URL
                to <code>{feedUrl}</code>
                {feedTokenConfigured
                  ? ' and paste the feed token you configured — the hub refuses mutations without it.'
                  : '.'}{' '}
                The extension then syncs this hub's compiled rules and reports what it actually
                blocked back into the tier plan.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Extension static tier capacity — the four tier rulesets the extension
          ships, whether they fit, and what the plan is worth. Lives in the
          browser pane because it is about this deploy target: the extension
          popup answers the same question against a live grant the hub cannot
          see, so this card asks for a capacity explicitly rather than
          reporting Chrome's guaranteed floor as though it were the real one. */}
      <div className="deploy-info-card-wide">
        <ExtensionTierPlanCard
          state={tierPlanState}
          result={tierPlan}
          error={tierPlanError}
          enabled={[]}
          onRefresh={loadTierPlan}
          onChooseLedger={chooseTierLedger}
          onClearLedger={clearTierLedger}
        />
      </div>

      <div className="deploy-info-card deploy-info-card-wide">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">🗂</span>
            <div>
              <h2 className="deploy-pane-title">Everywhere else it installs</h2>
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
