import React from 'react';
import {
  SHADOWROCKET_STEPS,
  shadowrocketFeedUrl,
  shadowrocketFormatWarning,
  shadowrocketHomeAssistantUrl,
  shadowrocketSyntaxNote,
} from '../../shadowrocketDeploy';
import type { HubPaneProps } from './paneProps';

/**
 * Shadowrocket, and Surge, reading a Surge-style rule set.
 *
 * The pane carries a warning the others need less, because this is the clearest case in the app of a
 * format that cannot be substituted: a client expecting `DOMAIN-SUFFIX` rules is handed an AdGuard
 * list and reads nothing, with no error to explain why. So the notice says so in the app rather
 * than leaving it to the docs, and the recipe is written to the format the client actually parses.
 *
 * It also offers the same rule set from the Home Assistant add-on, which is the only version of this
 * feed that survives the laptop being shut.
 */

/**
 * The fields of the Hub bundle this pane reads. The registry carries the same list, so the type
 * the pane is written against and the object it is handed are the one declaration — a field added
 * here reaches the pane, and a field read but not declared does not compile.
 */
export const shadowrocketPaneKeys = [
  'handleCopy',
  'copiedKey',
  'savePath',
  'serverStatus',
  'exportFormat',
] as const satisfies readonly (keyof HubPaneProps)[];

export type ShadowrocketPaneProps = Pick<HubPaneProps, (typeof shadowrocketPaneKeys)[number]>;

export const ShadowrocketPane: React.FC<ShadowrocketPaneProps> = ({
  handleCopy,
  copiedKey,
  savePath,
  serverStatus,
  exportFormat,
}) => {
  const shadowrocketFeedLanUrl = shadowrocketFeedUrl(
    serverStatus?.lanUrl || '',
    exportFormat,
    savePath,
  );
  const shadowrocketFormatNotice = shadowrocketFormatWarning(exportFormat);
  return (
    <div className="deploy-single-platform-wrap">
      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">📱</span>
            <div>
              <h3 className="deploy-pane-title">Shadowrocket Rule Set Feed</h3>
              <p className="deploy-pane-subtitle">iPhone, iPad, Apple-silicon Mac — and Surge</p>
            </div>
          </div>
        </div>

        <div className="deploy-feed-box">
          <div className="deploy-feed-box-top">
            <span className="deploy-feed-box-label">Shadowrocket Feed URL</span>
            <span className="deploy-feed-box-tag">DOMAIN-SUFFIX rules</span>
          </div>
          <div className="deploy-feed-input-row">
            <input type="text" readOnly value={shadowrocketFeedLanUrl} className="deploy-feed-input" />
            <button
              type="button"
              className={`deploy-copy-feed-btn ${copiedKey === 'shadowrocket-feed' ? 'copied' : ''}`}
              onClick={() => handleCopy(shadowrocketFeedLanUrl, 'shadowrocket-feed')}
            >
              {copiedKey === 'shadowrocket-feed' ? '✓ Copied' : 'Copy Feed URL'}
            </button>
          </div>
        </div>

        <div className="deploy-feed-box">
          <div className="deploy-feed-box-top">
            <span className="deploy-feed-box-label">Same rule set from the Home Assistant add-on</span>
            <span className="deploy-feed-box-tag">Stays up when this desktop is off</span>
          </div>
          <div className="deploy-feed-input-row">
            <input type="text" readOnly value={shadowrocketHomeAssistantUrl()} className="deploy-feed-input" />
            <button
              type="button"
              className={`deploy-copy-feed-btn ${copiedKey === 'shadowrocket-addon' ? 'copied' : ''}`}
              onClick={() => handleCopy(shadowrocketHomeAssistantUrl(), 'shadowrocket-addon')}
            >
              {copiedKey === 'shadowrocket-addon' ? '✓ Copied' : 'Copy Add-on URL'}
            </button>
          </div>
        </div>

        {shadowrocketFormatNotice && (
          <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
            ⚠︎ {shadowrocketFormatNotice}
          </p>
        )}

        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
          Shadowrocket cannot read an AdGuard or hosts list. It subscribes to a Surge-style rule
          set, which is what the Shadowrocket format emits: one{' '}
          <code>DOMAIN-SUFFIX,host,REJECT</code> line per blocked domain under a{' '}
          <code>[Rule]</code> section.
        </p>
        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
          {shadowrocketSyntaxNote()}
        </p>
      </div>

      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">📋</span>
            <div>
              <h3 className="deploy-pane-title">Shadowrocket Setup Recipe</h3>
              <p className="deploy-pane-subtitle">Serve it here, subscribe on the device</p>
            </div>
          </div>
        </div>

        <div className="deploy-numbered-stepper">
          {SHADOWROCKET_STEPS.map((step, index) => (
            <div className="stepper-step" key={step.id}>
              <div className="stepper-num">{index + 1}</div>
              <div className="stepper-content">
                <h4>{step.title}</h4>
                <p>
                  {step.detail}
                  {step.id === 'subscribe' && (
                    <>
                      <br />
                      <code>{shadowrocketFeedLanUrl}</code>
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

export const renderShadowrocketPane = (props: ShadowrocketPaneProps) => (
  <ShadowrocketPane {...props} />
);
