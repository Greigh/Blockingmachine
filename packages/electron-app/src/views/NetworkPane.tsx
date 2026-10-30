/**
 * NetworkPane — the LAN feed & pairing home under Distribute › Network.
 *
 * The LAN Access & Mobile Pairing card lived in Settings because Settings was
 * the junk drawer; the feed server and the phone pairing are distribution
 * features, so the card moved here verbatim — same state, same IPC calls, same
 * handlers. The Network Sinkholes card did not move: every field it rendered
 * already lives in the deploy pane that owns the credential (Pi-hole URL and
 * key in PiholePane, the AdGuard/HA modes in AdGuardHomePane and
 * HomeAssistantPane, syncOnCompile beside them).
 *
 * Orphan-field audit (Settings sinkhole card → deploy panes): every field was
 * grepped against deploy/panes/*.tsx. All resolved except `customWebhookUrl` —
 * the arbitrary-webhook URL no pane renders — which lands in the Connection
 * options card below rather than disappearing.
 */
import React, { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { SinkholeConfig } from '../types/';

export const NetworkPane: React.FC = () => {
  const [feedToken, setFeedToken] = useState('');
  const [feedTokenConfigured, setFeedTokenConfigured] = useState(false);
  const [lanAuthMode, setLanAuthMode] = useState<'required' | 'open' | 'legacy'>('legacy');
  const [feedTokenMessage, setFeedTokenMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [generatedFeedToken, setGeneratedFeedToken] = useState('');
  // Flag 127's data-port token — a second credential beside the feed token,
  // guarding the :9294 proxy listener instead of the feed API.
  const [httpsDataToken, setHttpsDataToken] = useState('');
  const [httpsDataTokenConfigured, setHttpsDataTokenConfigured] = useState(false);
  const [httpsDataTokenMessage, setHttpsDataTokenMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [generatedHttpsDataToken, setGeneratedHttpsDataToken] = useState('');
  const [pairingPayload, setPairingPayload] = useState<{ url: string; payload: string; running: boolean; tokenConfigured: boolean; httpsCaConfigured?: boolean; httpsTokenConfigured?: boolean } | null>(null);
  const [startingFeedForPairing, setStartingFeedForPairing] = useState(false);
  // The one field the dead sinkhole card owned that no deploy pane renders:
  // the arbitrary-webhook URL. Loaded/saved through the same get/set pair.
  const [customWebhookUrl, setCustomWebhookUrl] = useState('');
  const [customWebhookSaved, setCustomWebhookSaved] = useState<string | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, []);

  const safeSetTimeout = (fn: () => void, delay: number) => {
    const id = setTimeout(() => {
      timersRef.current = timersRef.current.filter((t) => t !== id);
      fn();
    }, delay);
    timersRef.current.push(id);
    return id;
  };

  useEffect(() => {
    let isMounted = true;

    if (window.electron?.getFeedToken) {
      window.electron.getFeedToken().then((res) => {
        // Write-only like the sinkhole secrets — presence flag, never the value.
        if (isMounted && res) {
          setFeedTokenConfigured(res.configured);
          setLanAuthMode(res.mode ?? 'legacy');
        }
      }).catch(console.error);
    }

    if (window.electron?.getHttpsFilterDataToken) {
      window.electron.getHttpsFilterDataToken().then((res) => {
        if (isMounted && res) setHttpsDataTokenConfigured(res.configured);
      }).catch(console.error);
    }

    if (window.electron?.getSinkholeConfig) {
      window.electron.getSinkholeConfig().then((cfg) => {
        if (isMounted && cfg?.customWebhookUrl) setCustomWebhookUrl(cfg.customWebhookUrl);
      }).catch(console.error);
    }

    return () => {
      isMounted = false;
    };
  }, []);

  const handleSaveFeedToken = async () => {
    if (!window.electron?.setFeedToken) return;
    try {
      const res = await window.electron.setFeedToken(feedToken);
      if (res?.success) {
        if (res.unchanged) {
          setFeedTokenMessage({ text: 'Feed token unchanged — the saved token is still in effect', type: 'success' });
        } else {
          setFeedTokenConfigured(true);
          setFeedToken('');
          setGeneratedFeedToken('');
          setFeedTokenMessage({ text: 'Feed token saved — mutations now require Authorization: Bearer', type: 'success' });
        }
      } else {
        setFeedTokenMessage({ text: res?.error || 'Failed to save feed token', type: 'error' });
      }
      safeSetTimeout(() => setFeedTokenMessage(null), 4000);
    } catch (err) {
      console.error('Failed to save feed token:', err);
      setFeedTokenMessage({ text: 'Failed to save feed token', type: 'error' });
    }
  };

  const handleSetLanAuthMode = async (mode: 'required' | 'open') => {
    if (!window.electron?.setLanAuthMode) return;
    try {
      const res = await window.electron.setLanAuthMode(mode);
      if (res?.success) {
        setLanAuthMode(mode);
        if (res.tokenMinted) setFeedTokenConfigured(true);
        setFeedTokenMessage({
          text: mode === 'required'
            ? 'Required mode on — every LAN mutation and telemetry read now needs Authorization: Bearer'
            : 'Compatibility mode on — a token is still honoured when sent, but never required',
          type: 'success',
        });
      } else {
        setFeedTokenMessage({ text: res?.error || 'Failed to set LAN auth mode', type: 'error' });
      }
      safeSetTimeout(() => setFeedTokenMessage(null), 4000);
    } catch {
      setFeedTokenMessage({ text: 'Failed to set LAN auth mode', type: 'error' });
    }
  };

  const handleClearFeedToken = async () => {
    if (!window.electron?.clearFeedToken) return;
    try {
      const res = await window.electron.clearFeedToken();
      if (res?.success) {
        if (res.rotated) {
          // Required mode: "clear" is a rotation — the surface never sits without a credential.
          setFeedTokenConfigured(true);
          setGeneratedFeedToken('');
          setFeedTokenMessage({ text: 'Feed token rotated — clients need the new token (show the pairing QR to re-pair)', type: 'success' });
        } else {
          setFeedTokenConfigured(false);
          setFeedTokenMessage({ text: 'Feed token cleared — mutations are guarded by origin only', type: 'success' });
        }
        setFeedToken('');
      } else {
        setFeedTokenMessage({ text: res?.error || 'Failed to clear feed token', type: 'error' });
      }
      safeSetTimeout(() => setFeedTokenMessage(null), 4000);
    } catch {
      setFeedTokenMessage({ text: 'Failed to clear feed token', type: 'error' });
    }
  };

  const handleGenerateFeedToken = async () => {
    if (!window.electron?.generateFeedToken) return;
    try {
      const res = await window.electron.generateFeedToken();
      if (res?.success && res.token) {
        setFeedTokenConfigured(true);
        setFeedToken('');
        setGeneratedFeedToken(res.token);
        setFeedTokenMessage({ text: 'Strong token generated and saved — shown once below and embedded in the pairing QR', type: 'success' });
      } else {
        setFeedTokenMessage({ text: res?.error || 'Failed to generate feed token', type: 'error' });
      }
      safeSetTimeout(() => setFeedTokenMessage(null), 4000);
    } catch {
      setFeedTokenMessage({ text: 'Failed to generate feed token', type: 'error' });
    }
  };

  // Flag 127's data-port token — same write-only convention as the feed
  // token; it is the credential a token-gated :9294 listener demands from
  // non-loopback peers, and the pairing QR carries it to phones.
  const handleSaveHttpsDataToken = async () => {
    if (!window.electron?.setHttpsFilterDataToken) return;
    try {
      const res = await window.electron.setHttpsFilterDataToken(httpsDataToken);
      if (res?.success) {
        const cleared = res.cleared === true;
        setHttpsDataTokenConfigured(!cleared);
        setHttpsDataToken('');
        setGeneratedHttpsDataToken('');
        setHttpsDataTokenMessage({
          text: cleared
            ? 'Data-port token cleared — the listener runs the open trusted-LAN fallback on next start'
            : 'Data-port token saved — applies to the filter engine on its next start',
          type: 'success',
        });
      } else {
        setHttpsDataTokenMessage({ text: res?.error || 'Failed to save data-port token', type: 'error' });
      }
      safeSetTimeout(() => setHttpsDataTokenMessage(null), 4000);
    } catch {
      setHttpsDataTokenMessage({ text: 'Failed to save data-port token', type: 'error' });
    }
  };

  const handleClearHttpsDataToken = async () => {
    if (!window.electron?.setHttpsFilterDataToken) return;
    try {
      const res = await window.electron.setHttpsFilterDataToken('');
      if (res?.success) {
        setHttpsDataTokenConfigured(false);
        setHttpsDataToken('');
        setGeneratedHttpsDataToken('');
        setHttpsDataTokenMessage({
          text: 'Data-port token cleared — the listener runs the open trusted-LAN fallback on next start',
          type: 'success',
        });
      } else {
        setHttpsDataTokenMessage({ text: res?.error || 'Failed to clear data-port token', type: 'error' });
      }
      safeSetTimeout(() => setHttpsDataTokenMessage(null), 4000);
    } catch {
      setHttpsDataTokenMessage({ text: 'Failed to clear data-port token', type: 'error' });
    }
  };

  const handleGenerateHttpsDataToken = async () => {
    if (!window.electron?.generateHttpsFilterDataToken) return;
    try {
      const res = await window.electron.generateHttpsFilterDataToken();
      if (res?.success && res.token) {
        setHttpsDataTokenConfigured(true);
        setHttpsDataToken('');
        setGeneratedHttpsDataToken(res.token);
        setHttpsDataTokenMessage({
          text: 'Strong token generated and saved — shown once below and embedded in the pairing QR',
          type: 'success',
        });
      } else {
        setHttpsDataTokenMessage({ text: res?.error || 'Failed to generate data-port token', type: 'error' });
      }
      safeSetTimeout(() => setHttpsDataTokenMessage(null), 4000);
    } catch {
      setHttpsDataTokenMessage({ text: 'Failed to generate data-port token', type: 'error' });
    }
  };

  const handleTogglePairingQr = async () => {
    if (pairingPayload) {
      setPairingPayload(null);
      return;
    }
    if (!window.electron?.getFeedPairingPayload) return;
    try {
      const res = await window.electron.getFeedPairingPayload();
      if (res?.success) setPairingPayload(res);
    } catch (err) {
      console.error('Failed to build pairing payload:', err);
    }
  };

  // The QR is only useful while the feed server answers, and it defaults to off —
  // so the pairing block gets its own start path rather than pointing at a
  // checkbox elsewhere in the page. Refreshing the payload after start keeps the
  // rendered URL honest.
  const handleStartFeedForPairing = async () => {
    if (!window.electron?.startFeedServer || startingFeedForPairing) return;
    setStartingFeedForPairing(true);
    try {
      await window.electron.startFeedServer();
      const res = await window.electron.getFeedPairingPayload?.();
      if (res?.success) setPairingPayload(res);
    } catch (err) {
      console.error('Failed to start feed server for pairing:', err);
    } finally {
      setStartingFeedForPairing(false);
    }
  };


  const handleSaveCustomWebhook = async () => {
    if (!window.electron?.getSinkholeConfig || !window.electron?.setSinkholeConfig) return;
    try {
      const cfg = (await window.electron.getSinkholeConfig()) ?? {};
      await window.electron.setSinkholeConfig({ ...cfg, customWebhookUrl } as SinkholeConfig);
      setCustomWebhookSaved('saved');
      safeSetTimeout(() => setCustomWebhookSaved(null), 3000);
    } catch (err) {
      setCustomWebhookSaved('error');
      safeSetTimeout(() => setCustomWebhookSaved(null), 4000);
      console.error('Failed to save webhook URL:', err);
    }
  };

  return (
    <div className="network-pane">
        <div className="setting-card" id="settings-pairing">
          <div className="setting-card-header">
            <h2>
              <span className="setting-icon-svg">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                </svg>
              </span>
              LAN Access & Mobile Pairing
            </h2>
            <span className="setting-badge secondary">Network</span>
          </div>
          <p>Secure this hub on the local network and pair companion apps.</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px' }}>
            <h3 className="setting-subsection-title">
              LAN Authentication
              <span className={`setting-badge ${lanAuthMode === 'required' ? 'success' : lanAuthMode === 'open' ? 'warning' : 'secondary'}`}>
                {lanAuthMode === 'required' ? 'Required' : lanAuthMode === 'open' ? 'Compatibility' : 'Legacy'}
              </span>
            </h3>
            <p className="setting-subsection-desc">
              {lanAuthMode === 'required'
                ? 'Secured default: every LAN mutation and telemetry read requires Authorization: Bearer, and this install has a generated token. Native clients pair via QR below; use compatibility mode only on a LAN you fully trust.'
                : lanAuthMode === 'open'
                  ? 'Compatibility mode: a stored token is honoured when sent but never required — mutations and reads rely on the origin guard alone.'
                  : 'Legacy posture: a token is enforced only while one is configured. New installs default to required; migrate to get the same behaviour here.'}
              {feedTokenConfigured ? ' A token is currently configured.' : ''}
            </p>
            {(lanAuthMode === 'legacy' || lanAuthMode === 'open') && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '2px' }}>
                <button type="button" className="browse-button secondary" onClick={() => void handleSetLanAuthMode('required')}>
                  {lanAuthMode === 'legacy' ? 'Migrate to required (recommended)' : 'Re-enable required auth'}
                </button>
              </div>
            )}
            {lanAuthMode === 'required' && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '2px' }}>
                <button type="button" className="browse-button secondary" onClick={() => void handleSetLanAuthMode('open')}>
                  Compatibility mode (no token required)
                </button>
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="password"
                className="path-input"
                placeholder={feedTokenConfigured ? 'Token configured — enter a new one to replace' : 'Leave empty to keep origin-guarded'}
                value={feedToken}
                onChange={(e) => setFeedToken(e.target.value)}
                style={{ flex: '1 1 220px', minWidth: 0 }}
                autoComplete="off"
              />
              <button type="button" className="browse-button secondary" onClick={() => void handleSaveFeedToken()}>
                Save
              </button>
              <button type="button" className="browse-button secondary" onClick={() => void handleGenerateFeedToken()}>
                Generate
              </button>
              {feedTokenConfigured && (
                <button type="button" className="browse-button secondary" onClick={() => void handleClearFeedToken()}>
                  {lanAuthMode === 'required' ? 'Rotate' : 'Clear'}
                </button>
              )}
            </div>
            {generatedFeedToken && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ fontSize: '0.72rem', wordBreak: 'break-all', opacity: 0.85 }}>{generatedFeedToken}</code>
                <button
                  type="button"
                  className="browse-button secondary"
                  onClick={() => setGeneratedFeedToken('')}
                >
                  Dismiss
                </button>
              </div>
            )}
            {feedTokenMessage && (
              <p className={`setting-message ${feedTokenMessage.type}`} role={feedTokenMessage.type === 'error' ? 'alert' : 'status'} style={{ marginTop: '2px' }}>
                {feedTokenMessage.text}
              </p>
            )}
          </div>

          <div className="setting-subsection">
            <h3 className="setting-subsection-title">HTTPS Data-Port Token</h3>
            <p className="setting-subsection-desc">
              The filter engine&apos;s :9294 listener (CONNECT/PROXY-v2/plain-HTTP — the port a
              captured phone talks to) can require this shared token from network clients. When
              set, non-loopback peers must present it — phones receive it through the pairing QR
              below; the engine reads it on its next start. When unset, the port stays open: the
              deliberate trusted-LAN fallback for a single-user network.
              {httpsDataTokenConfigured ? ' A token is currently configured.' : ''}
            </p>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="password"
                className="path-input"
                placeholder={httpsDataTokenConfigured ? 'Token configured — enter a new one to replace, or Clear' : 'Leave empty to keep the listener open'}
                value={httpsDataToken}
                onChange={(e) => setHttpsDataToken(e.target.value)}
                style={{ flex: '1 1 220px', minWidth: 0 }}
                autoComplete="off"
              />
              <button type="button" className="browse-button secondary" onClick={() => void handleSaveHttpsDataToken()}>
                Save
              </button>
              <button type="button" className="browse-button secondary" onClick={() => void handleGenerateHttpsDataToken()}>
                Generate
              </button>
              {httpsDataTokenConfigured && (
                <button type="button" className="browse-button secondary" onClick={() => void handleClearHttpsDataToken()}>
                  Clear
                </button>
              )}
            </div>
            {generatedHttpsDataToken && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ fontSize: '0.72rem', wordBreak: 'break-all', opacity: 0.85 }}>{generatedHttpsDataToken}</code>
                <button
                  type="button"
                  className="browse-button secondary"
                  onClick={() => setGeneratedHttpsDataToken('')}
                >
                  Dismiss
                </button>
              </div>
            )}
            {httpsDataTokenMessage && (
              <p className={`setting-message ${httpsDataTokenMessage.type}`} role={httpsDataTokenMessage.type === 'error' ? 'alert' : 'status'} style={{ marginTop: '2px' }}>
                {httpsDataTokenMessage.text}
              </p>
            )}
          </div>

          <div className="setting-subsection">
            <h3 className="setting-subsection-title">Pair Mobile App</h3>
            <p className="setting-subsection-desc">
              The Blockingmachine iOS/Android app can scan a QR code instead of typing the
              server address{feedTokenConfigured ? ' and token' : ''}. The hub also advertises
              itself over mDNS (_blockingmachine._tcp) while the feed server is running.
            </p>
            <div>
              <button type="button" className="browse-button secondary" onClick={() => void handleTogglePairingQr()}>
                {pairingPayload ? 'Hide pairing QR' : 'Show pairing QR'}
              </button>
            </div>
            {pairingPayload && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
                {!pairingPayload.running && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <p className="setting-message error" role="alert" style={{ marginTop: '2px' }}>
                      The feed server is not running — the app can't reach this Mac until it is.
                    </p>
                    <div>
                      <button
                        type="button"
                        className="browse-button"
                        disabled={startingFeedForPairing}
                        onClick={() => void handleStartFeedForPairing()}
                      >
                        {startingFeedForPairing ? 'Starting…' : 'Start feed server'}
                      </button>
                    </div>
                    <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                      Enable "Auto-Start Local LAN Feed Server on Launch" under Startup &amp; Background Services to keep it reachable after restarts.
                    </span>
                  </div>
                )}
                <div style={{ alignSelf: 'flex-start', background: '#fff', padding: '12px', borderRadius: '8px' }}>
                  <QRCodeSVG value={pairingPayload.payload} size={160} level="M" />
                </div>
                <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>
                  {pairingPayload.url}
                  {pairingPayload.tokenConfigured
                    ? ' — this code carries your feed token; treat it like a password.'
                    : ' — no feed token is configured, so the code carries only the address.'}
                  {pairingPayload.httpsCaConfigured
                    ? ' It also carries the hub CA + fingerprint, so the phone can install it without trusting the network.'
                    : ''}
                  {pairingPayload.httpsTokenConfigured
                    ? ' The data-port token rides along too.'
                    : ''}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Network Sinkholes & DNS Integration Card */}
      <div className="setting-card">
        <div className="setting-card-header">
          <h2>Connection options</h2>
        </div>
        <p>
          The fields the old network card owned that no deploy pane renders. If you
          pointed a sinkhole at a webhook URL other than Home Assistant's, it is
          kept here — the deploy panes carry everything else.
        </p>
        <label className="setting-field-label" htmlFor="custom-webhook-url">Custom webhook URL</label>
        <div className="setting-field-row">
          <input
            id="custom-webhook-url"
            type="url"
            className="setting-field-input"
            placeholder="https://example.com/hooks/blocklist"
            value={customWebhookUrl}
            onChange={(e) => setCustomWebhookUrl(e.target.value)}
          />
          <button type="button" className="browse-button secondary" onClick={() => void handleSaveCustomWebhook()}>
            Save
          </button>
        </div>
        {customWebhookSaved === 'saved' && (
          <p className="setting-message success" role="status">Webhook URL saved.</p>
        )}
        {customWebhookSaved === 'error' && (
          <p className="setting-message error" role="alert">Failed to save — check the hub log.</p>
        )}
      </div>
    </div>
  );
};
