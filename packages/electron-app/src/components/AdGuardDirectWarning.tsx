import React from 'react';
import { directModeWarning } from '../sinkholeNet';

/**
 * The "this URL cannot reach AdGuard Direct" banner, shared by Settings and the Deploy Hub's
 * AdGuard Home pane.
 *
 * Direct mode fails quietly in two specific ways — the address is Home Assistant's web frontend
 * (port 8123 or an HA path), or it is a Nabu Casa cloud URL, which only proxies HA itself. Both
 * leave the user pasting a working-looking address at an API that is not there, and the warning
 * existed only in Settings: the pane offered the same field without it. The component computes
 * the warning itself rather than taking it as a prop, so the two surfaces cannot disagree about
 * when it shows — only about where on the page it sits.
 */
export const AdGuardDirectWarning: React.FC<{ url: string; port?: number }> = ({ url, port }) => {
  const warning = directModeWarning(url, port);
  if (!warning) return null;
  return (
    <div style={{ marginTop: '6px', padding: '6px 8px', background: 'rgba(245, 158, 11, 0.15)', border: '1px solid rgba(245, 158, 11, 0.3)', borderRadius: '6px', fontSize: '0.72rem', color: '#f59e0b', display: 'flex', alignItems: 'flex-start', gap: '5px' }}>
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: '2px' }}>
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span>{warning.message}</span>
    </div>
  );
};
