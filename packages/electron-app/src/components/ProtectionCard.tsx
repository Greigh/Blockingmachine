import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonStatusInfo } from '../types';

/**
 * DNS protection state on the main surface.
 *
 * Until now the daemon's only controls were the tray row and the Deploy pane —
 * a stopped daemon left the main window with nothing to act on. The card polls
 * `daemon:get-status`, drives the same `daemon:start` / `daemon:toggle` IPC the
 * tray calls, and points at Deploy & Sync for the device-wide layer: the daemon
 * binds rootless 127.0.0.1:5353, so routing the OS resolver at it (port 53 via
 * the LaunchDaemon install scripts) is deliberately a separate step there.
 */
interface ProtectionCardProps {
  onNavigate?: (view: string) => void;
}

const POLL_MS = 10_000;

export const ProtectionCard: React.FC<ProtectionCardProps> = ({ onNavigate }) => {
  const [status, setStatus] = useState<DaemonStatusInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!window.electron?.getDaemonStatus) return;
    try {
      const s = await window.electron.getDaemonStatus();
      if (isMountedRef.current) setStatus(s);
    } catch {
      // status probe failures read as daemon-down through last-known state
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      isMountedRef.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const runAction = useCallback(
    async (action: () => Promise<{ success: boolean; message?: string } | undefined>) => {
      setBusy(true);
      setMessage(null);
      try {
        const res = await action();
        if (isMountedRef.current && res && !res.success) {
          setMessage(res.message || 'Action failed.');
        }
      } catch (err: any) {
        if (isMountedRef.current) setMessage(err?.message || 'Action failed.');
      } finally {
        if (isMountedRef.current) setBusy(false);
      }
      await refresh();
    },
    [refresh],
  );

  const running = status?.status === 'running';
  const paused = status?.status === 'paused';
  const stopped = !status || status.status === 'stopped';

  const pill = running ? (
    <span className="deploy-pane-status-pill">
      <span className="status-indicator-dot active" />
      Active
    </span>
  ) : paused ? (
    <span className="deploy-pane-status-pill">
      <span className="status-indicator-dot" />
      Paused
    </span>
  ) : (
    <span className="deploy-pane-status-pill">
      <span className="status-indicator-dot" />
      Daemon off
    </span>
  );

  const detail = running
    ? `Filtering on ${status?.port ?? 5353}/UDP · ${status?.rulesLoaded?.toLocaleString() ?? '0'} rules loaded` +
      (status?.stats ? ` · ${status.stats.blockRatePercent}% of ${status.stats.totalQueries.toLocaleString()} queries blocked` : '')
    : paused
      ? `Daemon is up on ${status?.port ?? 5353}/UDP but blocking is paused.`
      : 'The filtering daemon is not running — start it to protect this machine\'s loopback resolver.';

  return (
    <div className="desktop-card protection-card">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: 'var(--heading-color)', flexShrink: 0 }}
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--heading-color)' }}>
                DNS Protection
              </h3>
              {pill}
            </div>
            <p className="deploy-feed-box-desc" style={{ margin: '4px 0 0' }}>
              {detail}
            </p>
          </div>
        </div>

        <div className="deploy-actions-row" style={{ marginTop: 0 }}>
          {stopped ? (
            <button
              type="button"
              className="deploy-btn primary"
              disabled={busy || !window.electron?.startDaemonProcess}
              onClick={() =>
                void runAction(() => window.electron.startDaemonProcess!())
              }
            >
              {busy ? 'Starting…' : 'Start DNS Protection'}
            </button>
          ) : (
            <button
              type="button"
              className="deploy-btn"
              disabled={busy || !window.electron?.toggleDaemonProtection}
              onClick={() =>
                void runAction(() =>
                  window.electron.toggleDaemonProtection!(status?.status !== 'running'),
                )
              }
            >
              {busy ? 'Working…' : paused ? 'Resume Protection' : 'Pause Protection'}
            </button>
          )}
          <button
            type="button"
            className="deploy-btn"
            onClick={() => onNavigate?.('deploy')}
          >
            Deploy &amp; Sync →
          </button>
        </div>
      </div>

      {message && (
        <div className="dashboard-alert error-banner" style={{ marginTop: '10px', marginBottom: 0 }}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <span>{message}</span>
        </div>
      )}
    </div>
  );
};
