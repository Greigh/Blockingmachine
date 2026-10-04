import React from 'react';
import {
  PRIVOXY_CONF_DIR,
  PRIVOXY_STEPS,
  privoxyActionsFileDirective,
  privoxyFeedFileName,
  privoxyFeedUrl,
  privoxyFetchCommand,
  privoxyFormatWarning,
  privoxyHomeAssistantUrl,
  privoxyReloadCommand,
  privoxySyntaxNote,
} from '../../privoxyDeploy';
import type { HubPaneProps } from './paneProps';

/**
 * Privoxy, the filtering proxy, reading a local action file.
 *
 * Privoxy filters by URL rather than by host, so what it wants is not a blocklist at all but a
 * stack of `{+block}` sections with patterns under them — the artifact the Privoxy format emits.
 * What it does with that artifact is local: `actionsfile` names a file in the config directory, it
 * has never taken a URL, and a subscribe box here would describe a deployment that loads nothing.
 * That is why this pane is shaped like the BIND one — a file to copy, a config line to add, and a
 * restart — rather than like the feed targets.
 *
 * The LAN feed still earns its place, but as transport: it serves the compiled file for the `curl`
 * copy one-liner when the proxy runs on another host.
 */

/**
 * The fields of the Hub bundle this pane reads. The registry carries the same list, so the type
 * the pane is written against and the object it is handed are the one declaration — a field added
 * here reaches the pane, and a field read but not declared does not compile.
 */
export const privoxyPaneKeys = [
  'handleCopy',
  'copiedKey',
  'savePath',
  'serverStatus',
  'exportFormat',
] as const satisfies readonly (keyof HubPaneProps)[];

export type PrivoxyPaneProps = Pick<HubPaneProps, (typeof privoxyPaneKeys)[number]>;

export const PrivoxyPane: React.FC<PrivoxyPaneProps> = ({
  handleCopy,
  copiedKey,
  savePath,
  serverStatus,
  exportFormat,
}) => {
  const actionFileName = privoxyFeedFileName(exportFormat, savePath);
  const privoxyFeedLanUrl = privoxyFeedUrl(serverStatus?.lanUrl || '', exportFormat, savePath);
  const privoxyFormatNotice = privoxyFormatWarning(exportFormat);
  return (
    <div className="deploy-single-platform-wrap">
      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">🧱</span>
            <div>
              <h3 className="deploy-pane-title">Privoxy Action File</h3>
              <p className="deploy-pane-subtitle">Privoxy on Linux, BSD, macOS and router packages</p>
            </div>
          </div>
        </div>

        <div className="deploy-feed-box">
          <div className="deploy-feed-box-top">
            <span className="deploy-feed-box-label">Action file to save as</span>
            <span className="deploy-feed-box-tag">&#123;+block&#125; sections</span>
          </div>
          <div className="deploy-feed-input-row">
            <input type="text" readOnly value={actionFileName} className="deploy-feed-input" />
            <button
              type="button"
              className={`deploy-copy-feed-btn ${copiedKey === 'privoxy-path' ? 'copied' : ''}`}
              onClick={() => handleCopy(actionFileName, 'privoxy-path')}
            >
              {copiedKey === 'privoxy-path' ? '✓ Copied' : 'Copy file name'}
            </button>
          </div>
        </div>

        <div className="deploy-feed-box">
          <div className="deploy-feed-box-top">
            <span className="deploy-feed-box-label">Same action file from the Home Assistant add-on</span>
            <span className="deploy-feed-box-tag">Stays up when this desktop is off</span>
          </div>
          <div className="deploy-feed-input-row">
            <input type="text" readOnly value={privoxyHomeAssistantUrl()} className="deploy-feed-input" />
            <button
              type="button"
              className={`deploy-copy-feed-btn ${copiedKey === 'privoxy-addon' ? 'copied' : ''}`}
              onClick={() => handleCopy(privoxyHomeAssistantUrl(), 'privoxy-addon')}
            >
              {copiedKey === 'privoxy-addon' ? '✓ Copied' : 'Copy Add-on URL'}
            </button>
          </div>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
          Privoxy cannot read an AdGuard or hosts list. It reads an action file, where every URL
          pattern belongs to the <code>&#123;+block&#125;</code> section above it — which is what
          the Privoxy format emits. The add-on renders that file from the published DNS feed, so
          its address answers whatever export format this desktop compiles.
        </p>
        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
          There is no subscribe URL: <code>actionsfile</code> names a file inside{' '}
          <code>{PRIVOXY_CONF_DIR}</code>, and Privoxy re-reads it only on a restart — so each
          compile is a copy and a restart, the way the BIND recipe is.
        </p>
        {privoxyFormatNotice && (
          <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
            ⚠︎ {privoxyFormatNotice}
          </p>
        )}
        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
          {privoxySyntaxNote()}
        </p>

        <div className="deploy-actions-row">
          <button
            type="button"
            className={`deploy-tool-btn ${copiedKey === 'privoxy-actionsfile' ? 'copied' : ''}`}
            onClick={() =>
              handleCopy(privoxyActionsFileDirective(actionFileName), 'privoxy-actionsfile')
            }
          >
            <span>{copiedKey === 'privoxy-actionsfile' ? '✓ Copied' : 'Copy actionsfile line'}</span>
          </button>
          <button
            type="button"
            className={`deploy-tool-btn ${copiedKey === 'privoxy-fetch' ? 'copied' : ''}`}
            onClick={() =>
              handleCopy(privoxyFetchCommand(privoxyFeedLanUrl, actionFileName), 'privoxy-fetch')
            }
          >
            <span>{copiedKey === 'privoxy-fetch' ? '✓ Copied' : 'Copy LAN fetch'}</span>
          </button>
          <button
            type="button"
            className={`deploy-tool-btn ${copiedKey === 'privoxy-reload' ? 'copied' : ''}`}
            onClick={() => handleCopy(privoxyReloadCommand(), 'privoxy-reload')}
          >
            <span>{copiedKey === 'privoxy-reload' ? '✓ Copied' : 'Copy restart command'}</span>
          </button>
        </div>
      </div>

      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">📋</span>
            <div>
              <h3 className="deploy-pane-title">Privoxy Setup Recipe</h3>
              <p className="deploy-pane-subtitle">A local file, a config line, a restart</p>
            </div>
          </div>
        </div>

        <div className="deploy-numbered-stepper">
          {PRIVOXY_STEPS.map((step, index) => (
            <div className="stepper-step" key={step.id}>
              <div className="stepper-num">{index + 1}</div>
              <div className="stepper-content">
                <h4>{step.title}</h4>
                <p>
                  {step.detail}
                  {step.id === 'copy' && (
                    <>
                      <br />
                      <code>{privoxyFetchCommand(privoxyFeedLanUrl, actionFileName)}</code>
                    </>
                  )}
                  {step.id === 'addon' && (
                    <>
                      <br />
                      <code>{privoxyFetchCommand(privoxyHomeAssistantUrl(), actionFileName)}</code>
                    </>
                  )}
                  {step.id === 'actionsfile' && (
                    <>
                      <br />
                      <code>{privoxyActionsFileDirective(actionFileName)}</code>
                    </>
                  )}
                  {step.id === 'reload' && (
                    <>
                      <br />
                      <code>{privoxyReloadCommand()}</code>
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

export const renderPrivoxyPane = (props: PrivoxyPaneProps) => (
  <PrivoxyPane {...props} />
);
