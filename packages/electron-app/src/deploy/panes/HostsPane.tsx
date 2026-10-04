import React from 'react';
import type { HubPaneProps } from './paneProps';

/**
 * `/etc/hosts`, the deployment that needs nothing installed.
 *
 * Every other pane here assumes a program is running somewhere to hold the list. This one does not:
 * the compiled output is already `0.0.0.0 domain` lines, and copying it over the system file makes
 * the machine itself answer. That is why the pane is mostly a copy button — the whole procedure is
 * one command, and the rest of it is what to do when the machine stops resolving anything.
 */

/**
 * The fields of the Hub bundle this pane reads. The registry carries the same list, so the type
 * the pane is written against and the object it is handed are the one declaration — a field added
 * here reaches the pane, and a field read but not declared does not compile.
 */
export const hostsPaneKeys = [
  'handleCopy',
  'copiedKey',
  'savePath',
] as const satisfies readonly (keyof HubPaneProps)[];

export type HostsPaneProps = Pick<HubPaneProps, (typeof hostsPaneKeys)[number]>;

export const HostsPane: React.FC<HostsPaneProps> = ({ handleCopy, copiedKey, savePath }) => {
  return (
    <div className="deploy-single-platform-wrap">
      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">📄</span>
            <div>
              <h3 className="deploy-pane-title">System /etc/hosts Export</h3>
              <p className="deploy-pane-subtitle">Apply DNS sinkhole directly to local machine OS</p>
            </div>
          </div>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
          Export format must be set to <code>hosts</code> in Format Settings to generate standard IP mapping lines (<code>0.0.0.0 domain.com</code>).
        </p>

        <div className="deploy-feed-box">
          <div className="deploy-feed-box-top">
            <span className="deploy-feed-box-label">One-Click Terminal Command</span>
            <span className="deploy-feed-box-tag">macOS — the flush is mDNSResponder</span>
          </div>
          <div className="deploy-feed-input-row">
            <input
              type="text"
              readOnly
              value={`sudo cp "${savePath}" /etc/hosts && sudo killall -HUP mDNSResponder`}
              className="deploy-feed-input"
            />
            <button
              type="button"
              className={`deploy-copy-feed-btn ${copiedKey === 'hosts-cmd' ? 'copied' : ''}`}
              onClick={() =>
                handleCopy(
                  `sudo cp "${savePath}" /etc/hosts && sudo killall -HUP mDNSResponder`,
                  'hosts-cmd'
                )
              }
            >
              {copiedKey === 'hosts-cmd' ? '✓ Copied' : 'Copy Command'}
            </button>
          </div>
        </div>
      </div>

      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">⚙️</span>
            <div>
              <h3 className="deploy-pane-title">Manual Installation</h3>
              <p className="deploy-pane-subtitle">Safe application instructions</p>
            </div>
          </div>
        </div>

        <div className="deploy-numbered-stepper">
          <div className="stepper-step">
            <div className="stepper-num">1</div>
            <div className="stepper-content">
              <h4>Backup Existing Hosts File</h4>
              <p>In Terminal: <code>sudo cp /etc/hosts /etc/hosts.bak</code></p>
            </div>
          </div>

          <div className="stepper-step">
            <div className="stepper-num">2</div>
            <div className="stepper-content">
              <h4>Overwrite or Append</h4>
              <p>Copy compiled output over <code>/etc/hosts</code> using the command on the left.</p>
            </div>
          </div>

          <div className="stepper-step">
            <div className="stepper-num">3</div>
            <div className="stepper-content">
              <h4>Flush DNS Cache</h4>
              <p>
                macOS: <code>sudo killall -HUP mDNSResponder</code>. Linux has no system DNS cache
                to flush — where <code>systemd-resolved</code> runs it is{' '}
                <code>sudo resolvectl flush-caches</code>.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const renderHostsPane = (props: HostsPaneProps) => (
  <HostsPane {...props} />
);
