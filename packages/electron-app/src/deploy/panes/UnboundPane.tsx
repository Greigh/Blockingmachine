import React from 'react';
import { UnboundReachabilityCard } from '../../components/UnboundReachabilityCard';
import { DeployCommandBlock } from '../DeployCommandBlock';
import {
  FEED_TOKEN_ENV_PLACEHOLDER,
  UNBOUND_TARGETS,
  unboundFeedUrl,
  unboundFetchCommand,
  unboundFormatWarning,
  unboundIncludeDirective,
  unboundReportUrl,
} from '../../unboundDeploy';
import type { HubPaneProps } from './paneProps';

/**
 * Unbound, dropped in as a local zone and kept current by a scheduled fetch.
 *
 * The recipe-shaped panes are the ones where nothing talks back: BIND, Privoxy and the router tabs
 * are a file to copy and a line to paste, and this one is the same except that it also carries a
 * live reachability check, because an Unbound install is easy to get subtly wrong — an include line
 * that never took effect, an address that resolves to nothing — and nothing in `named-checkconf`
 * says so.
 *
 * The status card is fed entirely by props so it can be rendered on its own in a test, and it is the
 * only part of this pane that can fail: the recipes below it are text, and they are right or wrong
 * regardless of what the resolver is doing.
 */

/**
 * The fields of the Hub bundle this pane reads. The registry carries the same list, so the type
 * the pane is written against and the object it is handed are the one declaration — a field added
 * here reaches the pane, and a field read but not declared does not compile.
 */
export const unboundPaneKeys = [
  'handleCopy',
  'copiedKey',
  'savePath',
  'serverStatus',
  'feedTokenConfigured',
  'exportFormat',
  'unboundReachability',
  'unboundSnapshot',
  'unboundResolver',
  'resolverDraft',
  'setResolverDraft',
  'referenceDraft',
  'setReferenceDraft',
  'isCheckingUnbound',
  'resolverMessage',
  'handleCheckUnboundReachability',
  'handleSaveUnboundResolver',
] as const satisfies readonly (keyof HubPaneProps)[];

export type UnboundPaneProps = Pick<HubPaneProps, (typeof unboundPaneKeys)[number]>;

export const UnboundPane: React.FC<UnboundPaneProps> = ({
  handleCopy,
  copiedKey,
  savePath,
  serverStatus,
  feedTokenConfigured,
  exportFormat,
  unboundReachability,
  unboundSnapshot,
  unboundResolver,
  resolverDraft,
  setResolverDraft,
  referenceDraft,
  setReferenceDraft,
  isCheckingUnbound,
  resolverMessage,
  handleCheckUnboundReachability,
  handleSaveUnboundResolver,
}) => {
  const unboundFeedLanUrl = unboundFeedUrl(serverStatus?.lanUrl || '', exportFormat, savePath);
  const unboundFormatNotice = unboundFormatWarning(exportFormat);
  // The report-back tail is what makes the cron's result a fact rather than an absence: the
  // command POSTs ok/fail after the reload, so a fetch that broke overnight is named on the
  // card instead of invisible. When a token is configured the command expands $FEED_TOKEN on
  // the target host — the plaintext never enters the renderer or the copied command.
  const refreshReport = {
    url: unboundReportUrl(serverStatus?.lanUrl || ''),
    token: feedTokenConfigured ? FEED_TOKEN_ENV_PLACEHOLDER : null,
  };
  return (
    <div className="deploy-single-platform-wrap">
      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">🧭</span>
            <div>
              <h3 className="deploy-pane-title">Unbound Local-Zone Feed</h3>
              <p className="deploy-pane-subtitle">OPNsense, pfSense, Linux, OpenWrt</p>
            </div>
          </div>
        </div>

        <div className="deploy-feed-box">
          <div className="deploy-feed-box-top">
            <span className="deploy-feed-box-label">Unbound Feed URL</span>
            <span className="deploy-feed-box-tag">local-zone rules</span>
          </div>
          <div className="deploy-feed-input-row">
            <input type="text" readOnly value={unboundFeedLanUrl} title={unboundFeedLanUrl} className="deploy-feed-input" />
            <button
              type="button"
              className={`deploy-copy-feed-btn ${copiedKey === 'unbound-feed' ? 'copied' : ''}`}
              onClick={() => handleCopy(unboundFeedLanUrl, 'unbound-feed')}
            >
              {copiedKey === 'unbound-feed' ? '✓ Copied' : 'Copy Feed URL'}
            </button>
          </div>
        </div>

        {unboundFormatNotice && (
          <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
            ⚠︎ {unboundFormatNotice}
          </p>
        )}

        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
          Unbound has no remote blocklist feature, so it cannot subscribe to an AdGuard or hosts
          feed. Point <code>unbound.conf</code> at a drop-in file once, then let the scheduled
          refresh below keep that file current.
        </p>

        <div className="deploy-actions-row">
          <button
            type="button"
            className={`deploy-tool-btn ${copiedKey === 'unbound-include' ? 'copied' : ''}`}
            onClick={() =>
              handleCopy(unboundIncludeDirective(UNBOUND_TARGETS[1].configPath), 'unbound-include')
            }
          >
            <span>{copiedKey === 'unbound-include' ? '✓ Copied' : 'Copy include: directive'}</span>
          </button>
          <button
            type="button"
            className={`deploy-tool-btn ${copiedKey === 'unbound-refresh' ? 'copied' : ''}`}
            onClick={() =>
              handleCopy(
                unboundFetchCommand(unboundFeedLanUrl, UNBOUND_TARGETS[1].configPath, refreshReport),
                'unbound-refresh',
              )
            }
          >
            <span>{copiedKey === 'unbound-refresh' ? '✓ Copied' : 'Copy refresh command'}</span>
          </button>
        </div>

        {feedTokenConfigured && (
          <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
            This hub requires a feed token for report-backs. The command reads it from the
            environment — set <code>export FEED_TOKEN=…</code> in the target host's crontab or
            profile (the value lives in this app's Settings, never inside the copied command).
          </p>
        )}
      </div>

      <UnboundReachabilityCard
        result={unboundReachability}
        snapshot={unboundSnapshot}
        resolverAddress={resolverDraft}
        resolverLabel={unboundResolver?.effective ?? null}
        resolverIsDefault={unboundResolver?.isDefault ?? true}
        resolverError={unboundResolver?.error ?? null}
        referenceAddress={referenceDraft}
        referenceLabel={unboundResolver?.referenceEffective ?? null}
        referenceError={unboundResolver?.referenceError ?? null}
        referenceSource={unboundResolver?.referenceSource ?? 'none'}
        systemServers={unboundResolver?.systemServers ?? []}
        resolverMessage={resolverMessage}
        checking={isCheckingUnbound}
        now={new Date().toISOString()}
        onResolverAddressChange={setResolverDraft}
        onReferenceAddressChange={setReferenceDraft}
        onSaveResolver={handleSaveUnboundResolver}
        onCheck={handleCheckUnboundReachability}
      />

      <div className="deploy-info-card deploy-info-card-wide">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">📋</span>
            <div>
              <h3 className="deploy-pane-title">Unbound Setup Recipes</h3>
              <p className="deploy-pane-subtitle">Drop-in file first, then a scheduled refresh</p>
            </div>
          </div>
        </div>

        <div className="deploy-numbered-stepper">
          {UNBOUND_TARGETS.map((target, index) => (
            <div className="stepper-step" key={target.id}>
              <div className="stepper-num">{index + 1}</div>
              <div className="stepper-content">
                <h4>{target.name}</h4>
                <p>
                  {target.includePlacement} — the line is{' '}
                  <code>{unboundIncludeDirective(target.configPath)}</code> — then schedule this
                  refresh so local-zone updates land without a full restart. Its second half
                  reports the result back, so a run that fails overnight is named on the card
                  above rather than invisible:
                </p>
                <DeployCommandBlock
                  command={unboundFetchCommand(unboundFeedLanUrl, target.configPath, refreshReport)}
                  copyKey={`unbound-refresh-${target.id}`}
                  copiedKey={copiedKey}
                  onCopy={handleCopy}
                />
              </div>
            </div>
          ))}

          <div className="stepper-step">
            <div className="stepper-num">4</div>
            <div className="stepper-content">
              <h4>Keep the hub address stable</h4>
              <p>
                Leave <strong>Auto-start on launch</strong> on so the feed answers at the same
                address after a restart, and turn on <strong>Launch on computer startup</strong>{' '}
                if this machine is the resolver host. A changed LAN address only needs the URL in
                the commands above updated — the feed itself does not move.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const renderUnboundPane = (props: UnboundPaneProps) => (
  <UnboundPane {...props} />
);
