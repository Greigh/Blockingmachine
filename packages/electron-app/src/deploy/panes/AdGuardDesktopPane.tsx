import React from 'react';
import { resolveFileUrl, resolveLocalFeedUrl } from '../feedUrls';
import type { HubPaneProps } from './paneProps';

/**
 * The desktop AdGuard app, subscribed to a file or to the local feed server.
 *
 * The one sinkhole client here that is neither a server nor a resolver: it filters on the machine it
 * runs on and takes the list as a subscription like any browser would. That is why the pane has no
 * credentials and no connection test — there is nothing to authenticate against and nothing to push
 * to. It has two addresses instead, because the app accepts both a `file://` path and an HTTP URL,
 * and which one is the right answer depends on where the list lives rather than on the user.
 */

/**
 * The fields of the Hub bundle this pane reads. The registry carries the same list, so the type
 * the pane is written against and the object it is handed are the one declaration — a field added
 * here reaches the pane, and a field read but not declared does not compile.
 */
export const adGuardDesktopPaneKeys = [
  'handleCopy',
  'copiedKey',
  'savePath',
  'serverStatus',
] as const satisfies readonly (keyof HubPaneProps)[];

export type AdGuardDesktopPaneProps = Pick<HubPaneProps, (typeof adGuardDesktopPaneKeys)[number]>;

export const AdGuardDesktopPane: React.FC<AdGuardDesktopPaneProps> = ({
  handleCopy,
  copiedKey,
  savePath,
  serverStatus,
}) => {
  const fileUrl = resolveFileUrl(savePath);
  const localHttpUrl = resolveLocalFeedUrl(serverStatus, savePath);
  return (
    <div className="deploy-single-platform-wrap">
      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">💻</span>
            <div>
              <h3 className="deploy-pane-title">Local Subscription Endpoints</h3>
              <p className="deploy-pane-subtitle">Direct file:// or HTTP subscription for AdGuard Desktop</p>
            </div>
          </div>
        </div>

        <div className="deploy-feed-box">
          <div className="deploy-feed-box-top">
            <span className="deploy-feed-box-label">Local File URL (AdGuard for Mac / Mini)</span>
          </div>
          <div className="deploy-feed-input-row">
            <input type="text" readOnly value={fileUrl} className="deploy-feed-input" />
            <button
              type="button"
              className={`deploy-copy-feed-btn ${copiedKey === 'app-file' ? 'copied' : ''}`}
              onClick={() => handleCopy(fileUrl, 'app-file')}
            >
              {copiedKey === 'app-file' ? '✓ Copied' : 'Copy file:// URL'}
            </button>
          </div>
        </div>

        <div className="deploy-feed-box">
          <div className="deploy-feed-box-top">
            <span className="deploy-feed-box-label">Localhost HTTP URL</span>
          </div>
          <div className="deploy-feed-input-row">
            <input type="text" readOnly value={localHttpUrl} className="deploy-feed-input" />
            <button
              type="button"
              className={`deploy-copy-feed-btn ${copiedKey === 'app-http' ? 'copied' : ''}`}
              onClick={() => handleCopy(localHttpUrl, 'app-http')}
            >
              {copiedKey === 'app-http' ? '✓ Copied' : 'Copy Localhost URL'}
            </button>
          </div>
        </div>
      </div>

      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">📖</span>
            <div>
              <h3 className="deploy-pane-title">Setup in AdGuard for Mac / Windows</h3>
              <p className="deploy-pane-subtitle">Steps to add custom filter list</p>
            </div>
          </div>
        </div>

        <div className="deploy-numbered-stepper">
          <div className="stepper-step">
            <div className="stepper-num">1</div>
            <div className="stepper-content">
              <h4>Open Preferences / Settings</h4>
              <p>Launch AdGuard and open <strong>Settings</strong> (or press <code>⌘,</code> on macOS).</p>
            </div>
          </div>

          <div className="stepper-step">
            <div className="stepper-num">2</div>
            <div className="stepper-content">
              <h4>Navigate to Filters → Custom</h4>
              <p>Select the <strong>Filters</strong> tab, scroll down to <strong>Custom</strong>, and click <strong>Add custom filter</strong>.</p>
            </div>
          </div>

          <div className="stepper-step">
            <div className="stepper-num">3</div>
            <div className="stepper-content">
              <h4>Paste URL & Subscribe</h4>
              <p>
                Paste the copied <code>file://</code> or <code>http://localhost:9191</code> URL
                into the address field and click <strong>Subscribe</strong>. The{' '}
                <code>file://</code> form is verified on AdGuard for Mac and AdGuard Mini — on
                Windows the localhost URL is the one to use.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const renderAdGuardDesktopPane = (props: AdGuardDesktopPaneProps) => (
  <AdGuardDesktopPane {...props} />
);
