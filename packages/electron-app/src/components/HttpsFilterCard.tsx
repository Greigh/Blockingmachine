import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HttpsFilterStatus, HttpsFilterPin } from '../types';
import { DeployCommandBlock } from '../deploy/DeployCommandBlock';

/**
 * HTTPS filter-proxy state on the main surface — ProtectionCard's sibling.
 *
 * The engine answers a loopback control API on :9293 (spawned by the app, or
 * by launchd when the macOS capture install owns it), so the card polls the
 * `httpsfilter:*` IPC the same way ProtectionCard polls `daemon:*`. Two
 * controls stay deliberately separate, because they are different things:
 * "Run proxy / Stop proxy" is the process lifecycle, while "Pause filtering"
 * is the engine's own toggle — a paused proxy keeps every flow alive by
 * blind-tunnelling it (verdicts are skipped; connectivity is never held
 * hostage), where a stopped proxy answers nothing at all.
 *
 * The CA row manages OS trust through the Task 4 IPC: an unprivileged
 * `security add-trusted-cert` first, and only when the engine answers
 * `needsAdmin` does the card offer the administrator-approval path — the
 * macOS auth sheet is the consent UI; we never pop it unprompted.
 */
const POLL_MS = 10_000;
// CA trust probes spawn `security` subprocesses — too heavy for the 10s tick,
// so they refresh on mount, on engine transitions, after CA actions, and on
// a slower cadence while the engine is alive.
const CA_TRUST_REFRESH_MS = 60_000;

interface CaTrustInfo {
  success: boolean;
  state: string;
  message: string;
  sha256Fingerprint?: string;
  keyWrapped?: boolean;
  notAfter?: string;
  needsAdmin?: boolean;
}

const TRUST_LABEL: Record<string, string> = {
  trusted: 'trusted',
  'installed-untrusted': 'in keychain, not trusted',
  absent: 'not installed',
  unsupported: 'unsupported on this OS',
  unavailable: 'engine down',
  error: 'check failed',
};

/**
 * Loopback spellings for the data-bind check — mirrors the engine's own
 * `isLoopbackBindHost` (the card can't import engine code): `localhost`,
 * any 127.x, `::1` and its expanded/mapped forms. A bind that reads as
 * anything else means the data port accepts flows from the network.
 */
function isLoopbackBind(host: string): boolean {
  let h = host.trim().toLowerCase().replace(/\.+$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h.startsWith('127.')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // ::ffff:<v4> mapped forms — the tail decides by the same 127.x rule.
  if (h.startsWith('::ffff:')) return h.slice('::ffff:'.length).startsWith('127.');
  if (h.startsWith('0:0:0:0:ffff:')) return h.slice('0:0:0:0:ffff:'.length).startsWith('127.');
  return /^0{1,4}(:0{1,4}){6}:0{0,3}1$/.test(h);
}

/**
 * The capture-install hint's per-platform wording: which machine is being
 * described, how the installer is invoked (`sudo` for the posix scripts;
 * an elevated Administrator PowerShell for the ps1 — Windows has no sudo
 * verb to paste), and the script name the fallback message names.
 */
interface CaptureHint {
  device: string;
  how: string;
  scriptName: string;
}
const CAPTURE_HINTS: Record<string, CaptureHint> = {
  darwin: {
    device: "this Mac's",
    how: 'the installer (administrator rights, once)',
    scriptName: 'install-macos-capture.sh',
  },
  win32: {
    device: "this PC's",
    how: 'the installer from an elevated (Administrator) PowerShell, once',
    scriptName: 'install-windows-capture.ps1',
  },
  linux: {
    device: "this machine's",
    how: 'the installer with sudo, once',
    scriptName: 'install-linux-capture.sh',
  },
};

export const HttpsFilterCard: React.FC = () => {
  const [status, setStatus] = useState<HttpsFilterStatus | null>(null);
  const [caTrust, setCaTrust] = useState<CaTrustInfo | null>(null);
  const [pins, setPins] = useState<HttpsFilterPin[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [awaitingAdmin, setAwaitingAdmin] = useState(false);
  // The rendered install-macos-capture.sh invocation for the capture hint —
  // absolute paths, so it pastes on a machine with no repo checkout.
  const [installHint, setInstallHint] = useState<{ command?: string; message?: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const lastCaRefreshRef = useRef(0);

  const refreshCa = useCallback(async () => {
    if (!window.electron?.getHttpsFilterCaTrust) return;
    try {
      const ca = await window.electron.getHttpsFilterCaTrust();
      if (isMountedRef.current) setCaTrust(ca);
    } catch {
      // a CA probe failure leaves the last-known row in place
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!window.electron?.getHttpsFilterStatus) return;
    try {
      const s = await window.electron.getHttpsFilterStatus();
      if (!isMountedRef.current) return;
      setStatus(s);
      const alive = s.status === 'running' || s.status === 'paused' || s.status === 'degraded';
      if (!alive) return;
      // The pin ledger learns on client handshake aborts, so it polls with
      // status — one loopback GET, cheap enough for the 10s tick.
      if (window.electron.getHttpsFilterPins) {
        try {
          const p = await window.electron.getHttpsFilterPins();
          if (isMountedRef.current && p?.success) setPins(p.pins);
        } catch {
          // keep the last-known list
        }
      }
      if (Date.now() - lastCaRefreshRef.current > CA_TRUST_REFRESH_MS) {
        lastCaRefreshRef.current = Date.now();
        void refreshCa();
      }
    } catch {
      // status probe failures read as engine-down through last-known state
    }
  }, [refreshCa]);

  useEffect(() => {
    isMountedRef.current = true;
    lastCaRefreshRef.current = Date.now();
    void refresh();
    void refreshCa();
    const timer = setInterval(() => void refresh(), POLL_MS);
    // A hidden (menu-bar) window's interval is clamped by Chromium — refresh on
    // resurface so the card never shows minute-stale engine state.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      isMountedRef.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, refreshCa]);

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

  /**
   * The Task-4 contract: try the unprivileged keychain write; when the engine
   * (or the CA trust op) answers needsAdmin, hold for an explicit user click
   * before re-invoking with {elevate:true} — the macOS auth sheet only ever
   * appears on that second, consented call.
   */
  const installCa = useCallback(
    async (elevate: boolean) => {
      setBusy(true);
      setMessage(null);
      try {
        const res = await window.electron.installHttpsFilterCa!(elevate ? { elevate: true } : undefined);
        if (!isMountedRef.current) return;
        if (res?.needsAdmin) {
          setAwaitingAdmin(true);
          // darwin: the consent strip pops the auth sheet on click. win32 /
          // linux have no in-app elevation — the strip surfaces the manual
          // command and the affirmative button still re-asks (which answers
          // needs-admin again with the remediation line).
          setMessage(
            status?.platform === 'linux'
              ? 'Trust install needs root — run the printed sudo command in a terminal.'
              : status?.platform === 'win32'
                ? 'Trust install was denied — re-run certutil from an elevated prompt.'
                : 'Administrator approval required — confirm below to show the macOS prompt.',
          );
        } else {
          setAwaitingAdmin(false);
          if (res && !res.success) setMessage(res.message || 'CA install failed.');
        }
      } catch (err: any) {
        if (isMountedRef.current) setMessage(err?.message || 'CA install failed.');
      } finally {
        if (isMountedRef.current) setBusy(false);
      }
      await refreshCa();
    },
    [refreshCa],
  );

  const running = status?.status === 'running';
  const paused = status?.status === 'paused';
  const degraded = status?.status === 'degraded';
  const starting = status?.status === 'starting';
  const stopped = !status || status.status === 'stopped';
  const engineAlive = running || paused || degraded;
  // LAN hub mode (P4): the answering engine's data listener is bound off
  // loopback, so it accepts flows from the whole network — the posture
  // Android capture uses. The control API stays loopback by construction;
  // the hint names the flag-127 posture honestly (token required, or the
  // open trusted-LAN fallback).
  const lanHub = engineAlive && typeof status?.bindHost === 'string' && !isLoopbackBind(status.bindHost);
  // The capture service owning the engine is NOT a stopped-and-startable
  // state — an unanswered probe is a transient KeepAlive gap, and a
  // user-context spawn on those ports would self-capture.
  const captureOwned = status?.captureServiceInstalled === true;

  const handleCopy = useCallback((text: string, key: string) => {
    try {
      void window.electron?.copyToClipboard?.(text);
    } catch {
      // the clipboard is best-effort — the pre block stays selectable
    }
    setCopiedKey(key);
    setTimeout(() => {
      if (isMountedRef.current) setCopiedKey((cur) => (cur === key ? null : cur));
    }, 1600);
  }, []);

  const formatUptime = (s: number): string => {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  const pill = running ? (
    <span className="deploy-pane-status-pill">
      <span className="status-indicator-dot active" />
      Active
    </span>
  ) : starting ? (
    <span className="deploy-pane-status-pill">
      <span className="status-indicator-dot" />
      Starting
    </span>
  ) : paused ? (
    <span className="deploy-pane-status-pill">
      <span className="status-indicator-dot" />
      Paused
    </span>
  ) : degraded ? (
    <span
      className="deploy-pane-status-pill"
      title="The pin/bypass ledger fell back to in-memory — pins apply for this session only"
    >
      <span className="status-indicator-dot" />
      Degraded
    </span>
  ) : (
    <span className="deploy-pane-status-pill">
      <span className="status-indicator-dot" />
      Proxy off
    </span>
  );

  const detail = running
    ? `Filtering HTTPS on :${status?.port ?? 9294} · control :${status?.controlPort ?? 9293} · ${status?.rulesLoaded?.toLocaleString() ?? '0'} rules loaded` +
      (status?.uptimeSeconds ? ` · up ${formatUptime(status.uptimeSeconds)}` : '') +
      (status?.managedByApp === false
        ? status?.captureServiceInstalled
          ? ' · run by the capture service'
          : ' · run externally'
        : '')
    : starting
      ? 'Engine spawned — waiting for its control API to answer.'
      : paused
        ? 'Proxy is up but filtering is paused — every flow is being tunnelled uninspected.'
        : degraded
          ? 'Filtering is live but the pin/bypass ledger is in-memory only — entries will not persist across restarts.'
          : captureOwned
            ? 'The capture service owns the engine and it is not answering — launchd KeepAlive recovers a stopped instance; a wedge means re-run the installer or uninstall capture.'
            : 'The HTTPS filter proxy is not running — start it to terminate and filter encrypted traffic.';

  // The pins endpoint returns the raw applied ledger (pin → bypass → remove
  // journal, oldest first). What the user owns is the effective state: each
  // host's last action, with the 'remove' retractions collapsing the row away.
  const effectivePins = useMemo(() => {
    const byHost = new Map<string, HttpsFilterPin>();
    for (const entry of pins) byHost.set(entry.host, entry);
    return [...byHost.values()]
      .filter((entry) => entry.action !== 'remove')
      .sort((a, b) => b.ts - a.ts);
  }, [pins]);

  // Flag 129: the FULL fingerprint renders — it is the out-of-band trust
  // anchor a phone's install prompt compares against, so a truncated view
  // would make the comparison the whole flow exists for impossible.
  const fingerprint = useMemo(() => caTrust?.sha256Fingerprint ?? null, [caTrust]);

  // The content-depth line (P2 Task 4) — a secondary line under the strip
  // rather than more cells: every segment hides at zero so the ribbon stays
  // clean while the surface exists. The cosmetic index's populations lead so
  // "loaded but not injecting" reads differently from "0 rules" (an engine
  // predating the field reports nothing at all).
  const contentLine = useMemo(() => {
    const s = status?.stats;
    if (!s) return null;
    const parts: string[] = [];
    if (s.cosmetic != null) {
      parts.push(
        `${s.cosmetic.selectors.toLocaleString()} selectors · ${s.cosmetic.scriptlets.toLocaleString()} scriptlets` +
          (s.cosmetic.styles > 0 ? ` · ${s.cosmetic.styles.toLocaleString()} styles` : '') +
          ' loaded',
      );
    }
    if ((s.htmlInjected ?? 0) > 0)
      parts.push(`${(s.htmlInjected ?? 0).toLocaleString()} pages injected`);
    if ((s.responsesBlocked ?? 0) > 0)
      parts.push(`${(s.responsesBlocked ?? 0).toLocaleString()} responses blocked`);
    // "Emitted" is the honest verb — the count is invocations spliced into
    // page markup, not verified in-page executions (a defused or CSP-refused
    // scriptlet still counts here).
    if ((s.scriptletsInvoked ?? 0) > 0)
      parts.push(`${(s.scriptletsInvoked ?? 0).toLocaleString()} scriptlets emitted`);
    if ((s.cspRewrites ?? 0) > 0)
      parts.push(`${(s.cspRewrites ?? 0).toLocaleString()} CSP rewrites`);
    if ((s.skippedScriptlets ?? 0) > 0)
      parts.push(`${(s.skippedScriptlets ?? 0).toLocaleString()} scriptlets skipped`);
    if ((s.injectionsSkipped ?? 0) > 0)
      parts.push(`${(s.injectionsSkipped ?? 0).toLocaleString()} injections skipped`);
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [status?.stats]);

  const trustState = caTrust?.state;
  const showCaRow = engineAlive || (caTrust != null && caTrust.state !== 'unavailable');
  // The capture hint renders on every platform the installer exists for —
  // darwin's sudo line, linux's sudo line, win32's elevated-PowerShell ps1.
  // Unsupported platforms stay hidden; an installed capture service hides it.
  const captureSpec = status?.platform ? CAPTURE_HINTS[status.platform] : undefined;
  const showCaptureHint = captureSpec != null && status?.captureServiceInstalled === false;

  // The hint's command is the rendered-for-this-host invocation — resolved
  // once capture is confirmed absent (the IPC can fail on a packaged build
  // that does not ship scripts/, in which case the honest message shows).
  useEffect(() => {
    if (!showCaptureHint || !window.electron?.getHttpsFilterInstallScript) return;
    let live = true;
    window.electron
      .getHttpsFilterInstallScript()
      .then((res) => {
        if (!live) return;
        setInstallHint(res?.success && res.command ? { command: res.command } : { message: res?.message });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [showCaptureHint]);

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
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--heading-color)' }}>
                HTTPS Filtering
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
            captureOwned ? (
              // Never offer a user-context spawn under an installed capture
              // service — the engine's unanswered probe is a KeepAlive gap,
              // and a second engine on those ports would self-capture.
              <span
                className="deploy-feed-box-desc"
                title="The launchd capture service owns the engine — it recovers on its own; a wedge means re-run the installer or uninstall capture."
              >
                managed by the capture service
              </span>
            ) : (
              <button
                type="button"
                className="deploy-btn primary"
                disabled={busy || !window.electron?.startHttpsFilter}
                onClick={() => void runAction(() => window.electron.startHttpsFilter!())}
              >
                {busy ? 'Starting…' : 'Run proxy'}
              </button>
            )
          ) : (
            <>
              <button
                type="button"
                className="deploy-btn"
                disabled={busy || starting || !window.electron?.toggleHttpsFilterPause}
                title="Pause tunnels every flow without inspecting it — connectivity is never interrupted, verdicts are skipped."
                onClick={() =>
                  void runAction(() =>
                    window.electron.toggleHttpsFilterPause!(status?.protectionEnabled !== true),
                  )
                }
              >
                {busy ? 'Working…' : paused ? 'Resume filtering' : 'Pause filtering'}
              </button>
              {status?.managedByApp && (
                <button
                  type="button"
                  className="deploy-btn"
                  disabled={busy || !window.electron?.stopHttpsFilter}
                  onClick={() => void runAction(() => window.electron.stopHttpsFilter!())}
                >
                  Stop proxy
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {engineAlive && status?.stats && (
        <div className="protection-live-strip">
          <div className="protection-live-cell" title="TLS/HTTP flows the engine has seen">
            <span className="protection-live-name">Flows</span>
            <span className="protection-live-detail">{status.stats.flowsTotal.toLocaleString()}</span>
          </div>
          <div className="protection-live-cell" title="Flows terminated locally and inspected">
            <span className="protection-live-name">Terminated</span>
            <span className="protection-live-detail">{status.stats.flowsTerminated.toLocaleString()}</span>
          </div>
          <div className="protection-live-cell" title="Flows tunnelled without inspection (pinned, bypassed or paused)">
            <span className="protection-live-name">Tunnelled</span>
            <span className="protection-live-detail">{status.stats.flowsTunneled.toLocaleString()}</span>
          </div>
          <div className="protection-live-cell" title="Flows and requests blocked by the rule set">
            <span className="protection-live-name">Blocked</span>
            <span className="protection-live-detail">
              {status.stats.requestsBlocked.toLocaleString()} req · {status.stats.flowsBlocked.toLocaleString()} flows
            </span>
          </div>
          <div className="protection-live-cell" title="Share of flows refused">
            <span className="protection-live-name">Block rate</span>
            <span className="protection-live-detail">{status.stats.blockRatePercent}%</span>
          </div>
          <div className="protection-live-cell" title="Request rules loaded from browser.txt">
            <span className="protection-live-name">Rules</span>
            <span className="protection-live-detail">{status.rulesLoaded.toLocaleString()}</span>
          </div>
        </div>
      )}

      {engineAlive && contentLine !== null && (
        <p
          className="deploy-feed-box-desc"
          style={{ margin: '6px 0 0' }}
          title="Content depth since engine start — cosmetic rules indexed, pages that received injected markup, responses blocked on their content-type, and scriptlet invocations emitted into pages (emitted, not verified executions)."
        >
          Content filtering — {contentLine}
        </p>
      )}

      {/* LAN hub posture notice — a deliberate operator choice (BM_BIND_HOST),
          surfaced because the data port then trusts the whole network. The
          control API never joins it: /v1/proxy/* stays loopback-pinned. */}
      {lanHub && (
        <p
          className="deploy-feed-box-desc"
          style={{ margin: '6px 0 0', color: 'var(--tone-warning)' }}
          title="The engine's data listener is bound to a non-loopback address — LAN hub mode (BM_BIND_HOST). Any host that can route to this address can send traffic through the proxy; when a data-port token (BM_DATA_TOKEN) is configured, non-loopback peers must present it — phones receive it in the pairing QR as httpsToken. The /v1/proxy/* control API stays bound to loopback regardless."
        >
          LAN hub mode — the data listener accepts flows from the network on {status?.bindHost}:
          {status?.port}.
          {status?.dataAuthRequired === true
            ? ' A data-port token is required — paired phones carry it via the QR.'
            : ' No data-port token is set — any device on this network may use it (trusted-LAN fallback).'}
          {status?.denyPrivateDestinations === true &&
            ' Loopback/private destinations are refused for network clients.'}
          {' '}This is the mode Android capture uses to route a phone&apos;s traffic through
          this machine; the control API stays on loopback.
        </p>
      )}

      {/* The answering engine's CA differs from the recorded last-trusted
          one — the user-engine/launchd-engine store split (flag 100) means
          the user likely trusted the OTHER engine's mint, so leaf certs the
          current engine forges will not verify until this CA is trusted. */}
      {status?.caDrift === true && (
        <div
          className="dashboard-alert error-banner"
          style={{ marginTop: '10px', marginBottom: 0 }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <span>The answering engine&apos;s CA changed — re-verify trust (install the CA below) before filtering terminates TLS again.</span>
        </div>
      )}

      {showCaRow && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="protection-live-name">Device CA</span>
              <span className="deploy-pane-status-pill">
                <span className={`status-indicator-dot ${trustState === 'trusted' ? 'active' : ''}`} />
                {TRUST_LABEL[trustState ?? ''] ?? (engineAlive ? 'checking…' : 'unknown')}
              </span>
            </div>
            <p
              className="deploy-feed-box-desc"
              style={{ margin: '4px 0 0', wordBreak: 'break-all' }}
              title={
                fingerprint
                  ? `SHA-256 ${fingerprint} — compare this with the fingerprint a phone shows before installing the hub CA`
                  : undefined
              }
            >
              {fingerprint ? `SHA-256 ${fingerprint}` : 'Fingerprint unavailable'}
              {caTrust?.keyWrapped != null &&
                ` · key ${caTrust.keyWrapped ? 'wrapped by the OS keychain' : 'unwrapped'}`}
              {/* The trust reply's own message names the concrete posture
                  (e.g. "in the keychain but not anchored as a trust root") —
                  it beats the generic tail when the engine supplies one. */}
              {caTrust?.message
                ? ` — ${caTrust.message}`
                : trustState === 'trusted'
                  ? ' — HTTPS responses can be filtered.'
                  : ' — install it to let the proxy terminate TLS.'}
            </p>
          </div>
          <div className="deploy-actions-row" style={{ marginTop: 0 }}>
            {trustState !== 'trusted' && (
              <button
                type="button"
                className="deploy-btn primary"
                disabled={busy || !window.electron?.installHttpsFilterCa || !engineAlive}
                title="Adds the engine's CA to your login keychain as a trust root."
                onClick={() => void installCa(false)}
              >
                {busy ? 'Installing…' : 'Install CA'}
              </button>
            )}
            {(trustState === 'trusted' || trustState === 'installed-untrusted') && (
              <button
                type="button"
                className="deploy-btn"
                disabled={busy || !window.electron?.uninstallHttpsFilterCa}
                onClick={() =>
                  void runAction(() => window.electron.uninstallHttpsFilterCa!()).then(() => refreshCa())
                }
              >
                Remove CA
              </button>
            )}
          </div>
        </div>
      )}

      {awaitingAdmin && (
        <div
          className="deploy-feed-box-desc"
          style={{
            marginTop: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <span>
            {status?.platform === 'linux'
              ? 'Administrator rights required — the needs-admin reply carries the sudo line.'
              : status?.platform === 'win32'
                ? 'Administrator rights required — re-run the certutil line from an elevated prompt.'
                : 'Administrator approval required — macOS will ask for your password to trust the CA.'}
          </span>
          <div className="deploy-actions-row" style={{ marginTop: 0 }}>
            <button
              type="button"
              className="deploy-btn primary"
              disabled={busy}
              onClick={() => void installCa(true)}
            >
              Approve &amp; install
            </button>
            <button
              type="button"
              className="deploy-btn"
              disabled={busy}
              onClick={() => setAwaitingAdmin(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {engineAlive && (
        <details style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-color)' }}>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--heading-color)',
              listStyle: 'none',
            }}
          >
            Pins &amp; bypasses ({effectivePins.length})
            {typeof status?.corruptLineCount === 'number' && status.corruptLineCount > 0
              ? ` · ${status.corruptLineCount} corrupt ledger line${status.corruptLineCount === 1 ? '' : 's'} skipped`
              : ''}
          </summary>
          <div
            style={{
              marginTop: 8,
              maxHeight: 140,
              overflowY: 'auto',
              border: '1px solid var(--border-color)',
              borderRadius: 6,
              padding: '4px 10px',
            }}
          >
            {effectivePins.length === 0 ? (
              <p className="deploy-feed-box-desc" style={{ margin: '6px 0' }}>
                Nothing pinned — a host lands here when a client refuses the forged certificate, or
                when you bypass one from the CLI.
              </p>
            ) : (
              effectivePins.map((entry) => (
                <div
                  key={`${entry.host}-${entry.ts}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '5px 0',
                    borderBottom: '1px solid var(--border-color)',
                  }}
                >
                  <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                    <code style={{ fontSize: '12px', color: 'var(--text-color, #e0e0e0)' }}>{entry.host}</code>
                    <span
                      className="deploy-feed-box-tag"
                      style={{ color: entry.action === 'bypass' ? 'var(--tone-warning)' : undefined }}
                    >
                      {entry.action === 'bypass' ? 'bypass' : 'learned pin'}
                    </span>
                    {entry.reason && (
                      <span className="deploy-feed-box-desc" style={{ margin: 0 }}>{entry.reason}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="deploy-tool-btn"
                    disabled={busy || !window.electron?.removeHttpsFilterPin}
                    title="Remove this entry — the next connection gets a fresh verdict."
                    onClick={() =>
                      void runAction(() => window.electron.removeHttpsFilterPin!(entry.host))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
        </details>
      )}

      {showCaptureHint && captureSpec && (
        <div style={{ margin: '10px 0 0' }}>
          <p className="deploy-feed-box-desc" style={{ margin: 0 }}>
            Transparent capture is not installed — the proxy still answers manual CONNECT/HTTP
            proxying on :{status?.port ?? 9294}. To route {captureSpec.device} traffic through it
            automatically, run {captureSpec.how}; the app does not invoke it for you.
          </p>
          {installHint?.command ? (
            // Absolute script/bundle/runner/rulesPath — pasteable on a
            // machine with no repo checkout (getServiceInstallScript's
            // precedent); the copy button is the same DeployCommandBlock
            // pattern the feed panes use.
            <div style={{ marginTop: 8 }}>
              <DeployCommandBlock
                command={installHint.command}
                copyKey="httpsfilter-install"
                copiedKey={copiedKey}
                onCopy={handleCopy}
              />
            </div>
          ) : (
            <p className="deploy-feed-box-desc" style={{ margin: '6px 0 0' }}>
              {installHint?.message ??
                `Resolving the installer command… (packaged builds may not ship ${captureSpec.scriptName} — use a source checkout if this does not resolve.)`}
            </p>
          )}
        </div>
      )}

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
