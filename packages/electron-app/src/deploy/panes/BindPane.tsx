import React from 'react';
import {
  BIND_MECHANISMS,
  BIND_NULL_STEPS,
  BIND_STEPS,
  bindFetchCommand,
  bindFormatWarning,
  bindHomeAssistantUrl,
  bindIncludeLine,
  bindReconfigCommand,
  bindNamedConfZoneLine,
  bindNullZoneContents,
  bindReloadCommand,
  bindResponsePolicyLine,
  bindSyntaxNote,
  bindZoneFileName,
} from '../../bindDeploy';
import type { HubPaneProps } from './paneProps';

/**
 * BIND, blocked by a response policy zone or by a shared null zone.
 *
 * Two mechanisms behind one tab, because they differ in what you re-copy per compile rather than in
 * who runs them: the RPZ is a policy zone written with CNAME records, and the null zone is a
 * three-line file shared by every zone declaration. A user picks once and the pane rewrites its
 * recipe, rather than choosing between two tabs that would otherwise differ only in their filenames.
 *
 * No feed URL here, and that is the point. BIND has no remote blocklist feature, so the zone file is
 * something the user copies to the resolver and reloads; a subscribe box would be a lie about how
 * the deployment works.
 *
 * The choice lives in the Hub rather than in this component, so it survives a tab switch — a recipe
 * you are halfway through writing does not reset because you went to look at another target.
 */

/**
 * The fields of the Hub bundle this pane reads. The registry carries the same list, so the type
 * the pane is written against and the object it is handed are the one declaration — a field added
 * here reaches the pane, and a field read but not declared does not compile.
 */
export const bindPaneKeys = [
  'handleCopy',
  'copiedKey',
  'savePath',
  'exportFormat',
  'bindMechanism',
  'setBindMechanism',
] as const satisfies readonly (keyof HubPaneProps)[];

export type BindPaneProps = Pick<HubPaneProps, (typeof bindPaneKeys)[number]>;

export const BindPane: React.FC<BindPaneProps> = ({
  handleCopy,
  copiedKey,
  savePath,
  exportFormat,
  bindMechanism,
  setBindMechanism,
}) => {
  const bindZonePath = bindZoneFileName(savePath, bindMechanism);
  const bindFormatNotice = bindFormatWarning(exportFormat, bindMechanism);
  const bindSteps = bindMechanism === 'rpz' ? BIND_STEPS : BIND_NULL_STEPS;
  return (
    <div className="deploy-single-platform-wrap">
      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">🗄️</span>
            <div>
              <h3 className="deploy-pane-title">BIND Response Policy Zone</h3>
              <p className="deploy-pane-subtitle">named 9.8 and later, on Linux and BSD</p>
              <div className="deploy-actions-row" style={{ marginTop: 8 }}>
                {BIND_MECHANISMS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setBindMechanism(option.id)}
                    className={`deploy-tool-btn ${bindMechanism === option.id ? 'active' : ''}`}
                    title={option.summary}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: '6px 0 0' }}>
                {BIND_MECHANISMS.find((option) => option.id === bindMechanism)?.summary}
              </p>
            </div>
          </div>
        </div>

        <div className="deploy-feed-box">
          <div className="deploy-feed-box-top">
            <span className="deploy-feed-box-label">
              {bindMechanism === 'rpz' ? 'RPZ zone file to save as' : 'Shared null zone file to save as'}
            </span>
            <span className="deploy-feed-box-tag">
              {bindMechanism === 'rpz' ? 'CNAME policy records' : 'One file, every origin'}
            </span>
          </div>
          <div className="deploy-feed-input-row">
            <input type="text" readOnly value={bindZonePath} className="deploy-feed-input" />
            <button
              type="button"
              className={`deploy-copy-feed-btn ${copiedKey === 'bind-path' ? 'copied' : ''}`}
              onClick={() => handleCopy(bindZonePath, 'bind-path')}
            >
              {copiedKey === 'bind-path' ? '✓ Copied' : 'Copy file name'}
            </button>
          </div>
        </div>

        {bindMechanism === 'rpz' && (
          <div className="deploy-feed-box">
            <div className="deploy-feed-box-top">
              <span className="deploy-feed-box-label">Same RPZ zone from the Home Assistant add-on</span>
              <span className="deploy-feed-box-tag">Stays up when this desktop is off</span>
            </div>
            <div className="deploy-feed-input-row">
              <input type="text" readOnly value={bindHomeAssistantUrl()} className="deploy-feed-input" />
              <button
                type="button"
                className={`deploy-copy-feed-btn ${copiedKey === 'bind-addon' ? 'copied' : ''}`}
                onClick={() => handleCopy(bindHomeAssistantUrl(), 'bind-addon')}
              >
                {copiedKey === 'bind-addon' ? '✓ Copied' : 'Copy Add-on URL'}
              </button>
            </div>
          </div>
        )}

        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
          BIND has no remote blocklist feature, so nothing subscribes to a URL: the zone file is
          a local artifact copied to the resolver and reloaded, and the address above is transport
          for that copy. The add-on renders the same zone from the published DNS feed — records
          plus the SOA a primary zone cannot load without — so it answers whatever export format
          this desktop compiles.
        </p>
        {bindFormatNotice && (
          <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
            ⚠︎ {bindFormatNotice}
          </p>
        )}
        <p style={{ fontSize: '12px', color: 'var(--secondary-color)', margin: 0 }}>
          {bindSyntaxNote()}
        </p>

        <div className="deploy-actions-row">
          {bindMechanism === 'rpz' ? (
            <>
              <button
                type="button"
                className={`deploy-tool-btn ${copiedKey === 'bind-zone-line' ? 'copied' : ''}`}
                onClick={() => handleCopy(bindNamedConfZoneLine(bindZonePath), 'bind-zone-line')}
              >
                <span>{copiedKey === 'bind-zone-line' ? '✓ Copied' : 'Copy zone stanza'}</span>
              </button>
              <button
                type="button"
                className={`deploy-tool-btn ${copiedKey === 'bind-policy-line' ? 'copied' : ''}`}
                onClick={() => handleCopy(bindResponsePolicyLine(), 'bind-policy-line')}
              >
                <span>{copiedKey === 'bind-policy-line' ? '✓ Copied' : 'Copy response-policy line'}</span>
              </button>
              <button
                type="button"
                className={`deploy-tool-btn ${copiedKey === 'bind-reload' ? 'copied' : ''}`}
                onClick={() => handleCopy(bindReloadCommand(), 'bind-reload')}
              >
                <span>{copiedKey === 'bind-reload' ? '✓ Copied' : 'Copy reload command'}</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`deploy-tool-btn ${copiedKey === 'bind-include-line' ? 'copied' : ''}`}
                onClick={() => handleCopy(bindIncludeLine(), 'bind-include-line')}
              >
                <span>{copiedKey === 'bind-include-line' ? '✓ Copied' : 'Copy include line'}</span>
              </button>
              <button
                type="button"
                className={`deploy-tool-btn ${copiedKey === 'bind-reconfig' ? 'copied' : ''}`}
                onClick={() => handleCopy(bindReconfigCommand(), 'bind-reconfig')}
              >
                <span>{copiedKey === 'bind-reconfig' ? '✓ Copied' : 'Copy reconfig command'}</span>
              </button>
            </>
          )}
        </div>
      </div>

      <div className="deploy-info-card">
        <div className="deploy-pane-header">
          <div className="deploy-pane-title-group">
            <span className="deploy-pane-icon-badge">📋</span>
            <div>
              <h3 className="deploy-pane-title">BIND Setup Recipe</h3>
              <p className="deploy-pane-subtitle">Local zone file, then a reload per compile</p>
            </div>
          </div>
        </div>

        <div className="deploy-numbered-stepper">
          {bindSteps.map((step, index) => (
            <div className="stepper-step" key={step.id}>
              <div className="stepper-num">{index + 1}</div>
              <div className="stepper-content">
                <h4>{step.title}</h4>
                <p>
                  {step.detail}
                  {step.id === 'namedconf' && (bindMechanism === 'rpz' ? (
                    <>
                      <br />
                      <code>{bindNamedConfZoneLine(bindZonePath)}</code>
                      <br />
                      <code>{bindResponsePolicyLine()}</code>
                    </>
                  ) : (
                    <>
                      <br />
                      <code>{bindIncludeLine()}</code>
                    </>
                  ))}
                  {step.id === 'save' && bindMechanism === 'null-zone' && (
                    <>
                      <br />
                      <code>{bindNullZoneContents()}</code>
                    </>
                  )}
                  {step.id === 'addon' && (
                    <>
                      <br />
                      <code>{bindFetchCommand(bindHomeAssistantUrl(), `/etc/bind/${bindZonePath}`)}</code>
                    </>
                  )}
                  {step.id === 'reload' && (
                    <>
                      <br />
                      <code>{bindReloadCommand()}</code>
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

export const renderBindPane = (props: BindPaneProps) => (
  <BindPane {...props} />
);
