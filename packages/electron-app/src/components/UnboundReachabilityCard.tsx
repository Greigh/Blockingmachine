/**
 * The Unbound reachability readout.
 *
 * Presentational: it renders a verdict and the rows behind it, and owns no IPC. The Hub runs the
 * check and passes the result in, so this file can be render-tested with `react-dom/server` the way
 * the rest of the suite tests panels — there is no jsdom here, and a component that reaches for
 * `window.electron` cannot be rendered at all.
 *
 * The distinction the UI has to make legible is between *served*, *fetched* and *loaded*: a green
 * feed address with a warning underneath is the normal state of a deployment whose cron works but
 * whose include line is missing, and collapsing that into one green tick is what the check exists
 * to avoid.
 */

import React from 'react';
import {
  formatUnboundAge,
  type UnboundReachability,
  type UnboundReachabilitySnapshot,
} from '../unboundReachability';
import { unboundReferenceHint, unboundResolverHint } from '../unboundDeploy';

export interface UnboundReachabilityCardProps {
  /** Result of a check run in this session, when there is one. */
  result: UnboundReachability | null;
  /** The verdict remembered from a previous run, shown until a new check replaces it. */
  snapshot: UnboundReachabilitySnapshot | null;
  /** The field's current value, as typed. */
  resolverAddress: string;
  /** `host:port` the next check will query, or null when the address cannot be used. */
  resolverLabel: string | null;
  /** True when no address is set and the check will use the conventional one. */
  resolverIsDefault: boolean;
  /** Why the typed address cannot be used, when that is the case. */
  resolverError: string | null;
  /** The reference field's current value, as typed. */
  referenceAddress: string;
  /** `host:port` the existence check will query, or null when there is none. */
  referenceLabel: string | null;
  referenceError: string | null;
  referenceSource: 'explicit' | 'system' | 'none';
  /** This machine's configured DNS servers, for suggesting what to type. */
  systemServers: readonly string[];
  /** Feedback from the last save attempt. */
  resolverMessage: string | null;
  checking: boolean;
  /** ISO time to measure ages against, injected so a render is reproducible in tests. */
  now: string;
  onResolverAddressChange: (value: string) => void;
  onReferenceAddressChange: (value: string) => void;
  onSaveResolver: () => void;
  onCheck: () => void;
}

export function UnboundReachabilityCard(props: UnboundReachabilityCardProps): React.ReactElement {
  const view = props.result ?? props.snapshot;
  const rows = props.result?.rows ?? [];

  return (
    <div className="deploy-info-card">
      <div className="deploy-pane-header">
        <div className="deploy-pane-title-group">
          <span className="deploy-pane-icon-badge">🩺</span>
          <div>
            <h3 className="deploy-pane-title">Deployment Reachability</h3>
            <p className="deploy-pane-subtitle">Is the drop-in being fetched, and is Unbound using it?</p>
          </div>
        </div>
        <button
          type="button"
          className="deploy-tool-btn primary"
          onClick={props.onCheck}
          disabled={props.checking}
        >
          <span>{props.checking ? 'Checking…' : 'Check now'}</span>
        </button>
      </div>

      {view ? (
        <div className="unbound-reachability-summary">
          <div className={`unbound-reachability-badge ${view.tone}`}>{view.headline}</div>
          <p className="unbound-reachability-detail">{view.detail}</p>
          <p className="unbound-reachability-meta">
            Checked {formatUnboundAge(view.checkedAt, props.now)}
            {view.lastConfirmedAt ? ` · last confirmed live ${formatUnboundAge(view.lastConfirmedAt, props.now)}` : ''}
          </p>
        </div>
      ) : (
        <p className="unbound-reachability-detail">
          Run a check to see whether the file is being served, whether anything has fetched it, and
          whether Unbound answers with the drop-in loaded.
        </p>
      )}

      {rows.length > 0 && (
        <div className="unbound-reachability-rows">
          {rows.map((row) => (
            <div className="unbound-reachability-row" key={row.label}>
              <span className="unbound-reachability-row-label">{row.label}</span>
              <span className={`unbound-reachability-row-value ${row.tone}`}>{row.value}</span>
            </div>
          ))}
        </div>
      )}

      {props.result?.nextStep && (
        <p className="unbound-reachability-next">→ {props.result.nextStep}</p>
      )}

      <div className="unbound-resolver-field">
        <label htmlFor="unbound-resolver-address">Resolver address</label>
        <div className="unbound-resolver-row">
          <input
            id="unbound-resolver-address"
            type="text"
            value={props.resolverAddress}
            placeholder="127.0.0.1 or 192.168.1.1:5335"
            spellCheck={false}
            onChange={(event) => props.onResolverAddressChange(event.target.value)}
          />
        </div>
        <p className="unbound-resolver-hint">
          {unboundResolverHint({
            error: props.resolverError,
            effective: props.resolverLabel,
            usedDefault: props.resolverIsDefault,
            systemServers: props.systemServers,
          })}
          {props.resolverMessage ? ` ${props.resolverMessage}` : ''}
        </p>
      </div>

      <div className="unbound-resolver-field">
        <label htmlFor="unbound-resolver-reference">Reference resolver</label>
        <div className="unbound-resolver-row">
          <input
            id="unbound-resolver-reference"
            type="text"
            value={props.referenceAddress}
            placeholder="the resolver this machine already uses"
            spellCheck={false}
            onChange={(event) => props.onReferenceAddressChange(event.target.value)}
          />
        </div>
        <p className="unbound-resolver-hint">
          {unboundReferenceHint({
            error: props.referenceError,
            effective: props.referenceLabel,
            source: props.referenceSource,
          })}
        </p>
      </div>

      <div className="unbound-resolver-field">
        <div className="unbound-resolver-row">
          <button type="button" className="deploy-tool-btn" onClick={props.onSaveResolver}>
            <span>Save addresses</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default UnboundReachabilityCard;
