import React from 'react';
import { resolveLanFeedUrl } from '../feedUrls';
import {
  DNSMASQ_HOSTS_FILE,
  DNSMASQ_OPENWRT_HOSTS_DIR,
  DNSMASQ_STEPS,
  dnsmasqAddnHostsDirective,
  dnsmasqCronLine,
  dnsmasqFormatWarning,
} from '../../dnsmasqDeploy';
import type { HubPaneProps } from './paneProps';

/**
 * Routers and network DNS servers, reached by the feed rather than by a copy.
 *
 * The clients named here agree on HTTP and disagree on everything else, so this pane shows the
 * address once and gives the three shapes a config entry actually takes — a block-list URL, a
 * scheduled fetch into a hosts file, a feed object. What they also share is the format: every
 * consumer on this page reads hosts files, so the warning below is load-bearing — an AdGuard
 * feed handed to any of them is a subscription that silently filters nothing.
 *
 * For dnsmasq the recipe deliberately fetches into an `addn-hosts` file and reloads, not into a
 * conf-dir plus restart: dnsmasq re-reads hosts inputs on SIGHUP and never re-reads its
 * configuration, so this is the one shape where `reload` is the honest verb.
 */

/**
 * The fields of the Hub bundle this pane reads. The registry carries the same list, so the type
 * the pane is written against and the object it is handed are the one declaration — a field added
 * here reaches the pane, and a field read but not declared does not compile.
 */
export const dnsmasqPaneKeys = [
  'handleCopy',
  'copiedKey',
  'savePath',
  'serverStatus',
  'exportFormat',
] as const satisfies readonly (keyof HubPaneProps)[];

export type DnsmasqPaneProps = Pick<HubPaneProps, (typeof dnsmasqPaneKeys)[number]>;

export const DnsmasqPane: React.FC<DnsmasqPaneProps> = ({
  handleCopy,
  copiedKey,
  savePath,
  serverStatus,
  exportFormat,
}) => {
  const lanFeedUrl = resolveLanFeedUrl(serverStatus, savePath);
  const dnsmasqFormatNotice = dnsmasqFormatWarning(exportFormat);
  return (
    <div className="deploy-single-platform-wrap">
      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">🌐</span>
            <div>
              <h3 className="deploy-pane-title">Network DNS Stream URL</h3>
              <p className="deploy-pane-subtitle">Technitium, dnsmasq, pfSense, OPNsense</p>
            </div>
          </div>
        </div>

        <div className="deploy-feed-box">
          <div className="deploy-feed-box-top">
            <span className="deploy-feed-box-label">HTTP Feed Stream URL</span>
            <span className="deploy-feed-box-tag">LAN Broadcast</span>
          </div>
          <div className="deploy-feed-input-row">
            <input type="text" readOnly value={lanFeedUrl} className="deploy-feed-input" />
            <button
              type="button"
              className={`deploy-copy-feed-btn ${copiedKey === 'router-lan' ? 'copied' : ''}`}
              onClick={() => handleCopy(lanFeedUrl, 'router-lan')}
            >
              {copiedKey === 'router-lan' ? '✓ Copied' : 'Copy Feed URL'}
            </button>
          </div>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
          Technitium and pfBlockerNG subscribe to this address on their own schedules. dnsmasq
          cannot subscribe at all — the recipe below schedules a fetch into a{' '}
          <code>addn-hosts</code> file, the one input a reload actually re-reads.
        </p>
        {dnsmasqFormatNotice && (
          <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
            ⚠︎ {dnsmasqFormatNotice}
          </p>
        )}
      </div>

      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">📋</span>
            <div>
              <h3 className="deploy-pane-title">Router Setup Recipes</h3>
              <p className="deploy-pane-subtitle">A subscription, or a fetch into a hosts file</p>
            </div>
          </div>
        </div>

        <div className="deploy-numbered-stepper">
          {DNSMASQ_STEPS.map((step, index) => (
            <div className="stepper-step" key={step.id}>
              <div className="stepper-num">{index + 1}</div>
              <div className="stepper-content">
                <h4>{step.title}</h4>
                <p>
                  {step.detail}
                  {step.id === 'openwrt' && (
                    <>
                      <br />
                      <code>
                        {dnsmasqCronLine(
                          lanFeedUrl,
                          `${DNSMASQ_OPENWRT_HOSTS_DIR}/blockingmachine.hosts`,
                        )}
                      </code>
                    </>
                  )}
                  {step.id === 'dnsmasq' && (
                    <>
                      <br />
                      <code>{dnsmasqAddnHostsDirective(DNSMASQ_HOSTS_FILE)}</code>
                      <br />
                      <code>{dnsmasqCronLine(lanFeedUrl, DNSMASQ_HOSTS_FILE)}</code>
                    </>
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export const renderDnsmasqPane = (props: DnsmasqPaneProps) => (
  <DnsmasqPane {...props} />
);
