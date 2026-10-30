/**
 * Protect tab — filtering that runs on this phone: the platform on-device
 * filter (Android VPN/proxy or the iOS packet tunnel), the standalone synced
 * ruleset, per-app bypass, HTTPS capture, hub-mediated iOS web filtering,
 * and the local DNS responder. These cards moved out of the old Settings
 * scroll unchanged; only their home changed.
 */

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Linking from 'expo-linking';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClient } from '../../src/api/useClient';
import { useServers } from '../../src/state/servers';
import { useFilter } from '../../src/state/filter';
import { LocalVpn, isLocalVpnSupported } from '../../src/filter/localVpn';
import {
  fetchHubCa,
  HUB_DATA_PORT,
  hostFromUrl,
  hubDataUrl,
  isValidIpLiteral,
  loadCaFingerprint,
  loadHubHost,
  loadHubPort,
  loadHubToken,
  loadPairedCa,
  saveCaFingerprint,
  saveHubHost,
  type HubCa,
  type PairedCa,
} from '../../src/filter/httpsCapture';
import {
  localDnsStatus,
  startLocalDns,
  stopLocalDns,
  subscribeLocalDns,
  type LocalDnsStatus,
} from '../../src/filter/localDns';
import { nativeRulesPath } from '../../src/filter/ruleset';
import { parsePackageList, SELF_PACKAGE, toggledSelfList } from '../../src/filter/perAppBypass';
import {
  getIosTunnelStatus,
  isIosTunnelSupported,
  setIosTunnelEnabled,
} from '../../src/filter/iosTunnel';
import { readTunnelStatus } from '../../src/filter/dnsProxy';
import { styles } from '../../src/components/screenStyles';
import { ActionButton, Card, Grid, Pill, SectionTitle } from '../../src/components/ui';
import { describeError, UserError, type FriendlyError } from '../../src/errors';
import { GlassBackdrop } from '../../src/components/GlassBackdrop';
import { gridColumnsFor, hasEdgeUtilityStrip, useWidthTier } from '../../src/hooks/useWidthTier';
import { chrome, colors, layout, spacing } from '../../src/theme';
import { relativeTime } from '../../src/format';
import { haptics } from '../../src/haptics';
import { ScreenHeader } from '../../src/components/ScreenHeader';


/**
 * Android-only card: run the synced ruleset as a device-wide DNS filter (local
 * VPN service) and/or as a LAN HTTP/CONNECT proxy other devices can use.
 * VPN consent is a one-time system dialog — Start requests it via
 * startActivityForResult, then starts the service automatically on grant.
 */
function LocalFilterCard({ ready }: { ready: boolean }) {
  const vpn = useQuery({
    queryKey: ['localvpn'],
    queryFn: () => LocalVpn.status(),
    refetchInterval: 4000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const s = vpn.data;
  const rules = nativeRulesPath();

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      // Native calls are near-instant and consent resolves false when no
      // activity can return a result, so anything past ~45s is a wedged system
      // call — surface it rather than leaving the button dead until restart.
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new UserError('The system didn\u2019t answer — try again.')), 45_000)),
      ]);
      haptics.success();
    } catch (e) {
      haptics.error();
      setErr(describeError(e));
    } finally {
      setBusy(null);
      void vpn.refetch();
    }
  };

  const startVpn = () =>
    act('vpn', async () => {
      const granted = await LocalVpn.requestVpnConsent();
      if (!granted) throw new UserError('VPN access was declined — the filter needs it to run. Tap Start to try again.');
      // Quad9 — the same upstream the desktop daemon, the add-on resolver,
      // and localDns all default to (was 8.8.8.8, the lone holdout).
      await LocalVpn.startVpn(rules, '9.9.9.9', 'Blockingmachine');
    });

  const toggleVpn = () =>
    s?.vpnRunning ? act('vpn', () => LocalVpn.stopVpn()) : startVpn();

  const toggleProxy = () =>
    s?.proxyRunning
      ? act('proxy', () => LocalVpn.stopProxy())
      : act('proxy', () => LocalVpn.startProxy(rules, 8890));

  return (
    <Card>
      <View style={styles.rowBetween}>
        <SectionTitle icon="funnel-outline" label="On-device filter" style={{ marginBottom: 0 }} />
        {s?.vpnRunning ? <Pill label="vpn on" tone="ok" /> : null}
        {s?.proxyRunning ? <Pill label="proxy on" tone="info" /> : null}
      </View>
      <Text style={styles.meta}>
        {ready
          ? 'Filter this device\u2019s DNS (local VPN) and serve a proxy other devices on the network can use. HTTPS is covered at the domain level — no certificate install, no MITM.'
          : 'Sync rules above first — the local filter runs on the synced ruleset.'}
      </Text>
      {err ? (
        <>
          <Text style={styles.syncError}>{err.title}</Text>
          {err.detail ? <Text style={styles.syncErrorDetail}>{err.detail}</Text> : null}
        </>
      ) : null}
      <View style={styles.buttonRow}>
        <View style={styles.buttonFlex}>
          <ActionButton
            label={s?.vpnRunning ? 'Stop VPN filter' : 'Start VPN filter'}
            tone={s?.vpnRunning ? 'ghost' : 'primary'}
            disabled={!ready || busy === 'vpn'}
            loading={busy === 'vpn'}
            onPress={() => void toggleVpn()}
          />
        </View>
        <View style={styles.buttonFlex}>
          <ActionButton
            label={s?.proxyRunning ? 'Stop proxy' : 'Start proxy'}
            tone={s?.proxyRunning ? 'ghost' : 'primary'}
            disabled={!ready || busy === 'proxy'}
            loading={busy === 'proxy'}
            onPress={() => void toggleProxy()}
          />
        </View>
      </View>
      {s?.vpnRunning || s?.proxyRunning ? (
        <Text style={styles.meta}>
          {s.vpnRunning
            ? `DNS: ${s.dnsBlocked.toLocaleString()} blocked · ${s.dnsForwarded.toLocaleString()} forwarded\n`
            : ''}
          {s.proxyRunning
            ? `Proxy: :${s.proxyPort} · PAC http://<this phone>:${s.proxyPort}/proxy.pac · ${s.proxyBlocked.toLocaleString()} blocked`
            : ''}
        </Text>
      ) : null}
    </Card>
  );
}


/**
 * Android-only card: route this device's web traffic through a LAN hub's HTTPS
 * engine. TCP :80/:443 is spliced onto a `protect()`ed socket to
 * `<hub>:9294` (PROXY-v2), every other TCP port relays through unchanged,
 * other UDP relays through protected datagram sockets, and UDP/443 (QUIC) is
 * dropped so HTTP/3 falls back into the TCP path. The hub's data port must
 * be bound to its LAN address (BM_BIND_HOST) for :9294 to answer; :9293 —
 * the control port the CA fetch below uses — stays on the hub's loopback by
 * design, so that fetch only reaches the hub from a dev emulator (flag 129).
 */
function HttpsCaptureCard() {
  const { activeServer } = useServers();
  const capture = useQuery({
    queryKey: ['httpscapture'],
    queryFn: () => LocalVpn.httpsCaptureStatus(),
    refetchInterval: 4000,
  });
  const [hub, setHub] = useState('');
  const [savedHub, setSavedHub] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const [caLine, setCaLine] = useState<string | null>(null);
  const s = capture.data;
  const running = !!s?.running;

  useEffect(() => {
    void loadHubHost().then((h) => {
      setSavedHub(h);
      if (h) setHub(h);
    });
  }, []);

  // The paired server is usually the capture hub — offer its host as the
  // default when it is already a literal address (names can't be verified
  // to resolve identically inside the tunnel).
  useEffect(() => {
    if (savedHub || hub) return;
    const host = activeServer ? hostFromUrl(activeServer.baseUrl) : null;
    if (host && isValidIpLiteral(host)) setHub(host);
  }, [activeServer, savedHub, hub]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    setCaLine(null);
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new UserError('The system didn\u2019t answer — try again.')), 45_000)),
      ]);
      haptics.success();
    } catch (e) {
      haptics.error();
      setErr(describeError(e));
    } finally {
      setBusy(null);
      void capture.refetch();
    }
  };

  const start = () =>
    act('capture', async () => {
      const host = hub.trim();
      if (!isValidIpLiteral(host)) {
        throw new UserError('Enter the hub\u2019s LAN IP address (e.g. 192.168.1.20) — HTTPS capture needs a numeric address, not a name.');
      }
      const granted = await LocalVpn.requestVpnConsent();
      if (!granted) throw new UserError('VPN access was declined — HTTPS capture needs it to run. Tap Start to try again.');
      await saveHubHost(host);
      setSavedHub(host);
      // Flag 127/129: the paired data-port token + port ride the splice —
      // an unpaired hub on the open fallback just gets null/9294.
      const [token, port] = await Promise.all([loadHubToken(), loadHubPort()]);
      await LocalVpn.startHttpsCapture(host, token, port ?? HUB_DATA_PORT);
    });

  const stop = () => act('capture', () => LocalVpn.stopHttpsCapture());

  const installCa = () =>
    act('ca', async () => {
      const host = (savedHub ?? hub).trim();
      if (!host) throw new UserError('Set the hub IP first.');
      // Flag 129: a QR-paired CA is already on-device and re-verified by
      // loadPairedCa — prefer it over a LAN fetch entirely; only fall back
      // to the data port when pairing never carried one.
      const paired = await loadPairedCa();
      const ca: HubCa =
        paired ??
        (await fetchHubCa(host, fetch, (await loadHubPort()) ?? HUB_DATA_PORT));
      confirmCaInstall(ca, await loadCaFingerprint());
    });

  /**
   * The fingerprint gate (flag 129): the CA either rode the QR or arrived
   * over cleartext LAN HTTP — neither channel authenticates itself, so the
   * confirm step is the flow's only authenticity check. Show the SHA-256
   * this device computed and have the user compare it against the hub's own
   * HTTPS Filtering card before the install intent ever fires. A changed
   * fingerprint vs. the last confirmed one is called out as drift. No
   * fingerprint, no install — the gate refuses rather than warns.
   */
  const confirmCaInstall = (ca: HubCa | PairedCa, previousFingerprint: string | null) => {
    const fp = ca.sha256Fingerprint;
    if (!fp) {
      setErr({
        title: 'No CA fingerprint to check',
        detail: 'The hub didn\u2019t identify its CA — refusing to install a certificate that can\u2019t be verified.',
      });
      return;
    }
    const drifted = !!previousFingerprint && previousFingerprint !== fp;
    const body =
      'Compare this fingerprint with the one shown in the hub\u2019s HTTPS Filtering card — matching it is the only check that the CA wasn\u2019t swapped on the network.\n\n' +
      `SHA-256\n${fp}` +
      (drifted
        ? '\n\nIt changed since you last confirmed it — make sure the hub\u2019s CA really was rotated.'
        : '');
    Alert.alert('Trust this hub CA?', body, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Install CA',
        onPress: () =>
          void act('ca', async () => {
            await LocalVpn.installCaCertificate('Blockingmachine Hub CA', ca.certPem);
            await saveCaFingerprint(fp);
            setCaLine(`Install prompt sent — Android asks you to confirm. CA sha256: ${fp}`);
          }),
      },
    ]);
  };

  return (
    <Card>
      <View style={styles.rowBetween}>
        <SectionTitle icon="lock-closed-outline" label="HTTPS capture" style={{ marginBottom: 0 }} />
        {running ? <Pill label="capturing" tone="ok" /> : null}
      </View>
      <Text style={styles.meta}>
        Route this device&rsquo;s web traffic (ports 80/443) through a hub&rsquo;s HTTPS engine — hostname blocking for every app, content filtering where the CA is trusted. The hub must listen on your LAN.
      </Text>
      {err ? (
        <>
          <Text style={styles.syncError}>{err.title}</Text>
          {err.detail ? <Text style={styles.syncErrorDetail}>{err.detail}</Text> : null}
        </>
      ) : null}
      {running ? (
        <>
          <Text style={styles.meta}>
            {`Hub ${savedHub ?? hub}:9294 · ${s!.flowsOpened.toLocaleString()} flows · ${s!.flowsClosed.toLocaleString()} closed · ${s!.quicDropped.toLocaleString()} QUIC dropped`}
          </Text>
          <Text style={styles.meta}>
            While capture runs: QUIC stays dropped so HTTPS uses TCP, other UDP relays through the tunnel — LAN broadcast/multicast (mDNS, SSDP) still pauses.
          </Text>
          <View style={styles.buttonRow}>
            <View style={styles.buttonFlex}>
              <ActionButton
                label="Install hub CA"
                disabled={busy === 'ca'}
                loading={busy === 'ca'}
                onPress={() => void installCa()}
              />
            </View>
            <View style={styles.buttonFlex}>
              <ActionButton
                label="Stop capture"
                tone="ghost"
                disabled={busy === 'capture'}
                loading={busy === 'capture'}
                onPress={() => void stop()}
              />
            </View>
          </View>
          {caLine ? <Text style={styles.meta}>{caLine}</Text> : null}
        </>
      ) : (
        <>
          <TextInput
            style={styles.input}
            value={hub}
            onChangeText={setHub}
            placeholder="hub IP — e.g. 192.168.1.20"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <View style={styles.buttonRow}>
            <View style={styles.buttonFlex}>
              <ActionButton
                label="Start capture"
                disabled={!hub.trim() || busy === 'capture'}
                loading={busy === 'capture'}
                onPress={() => void start()}
              />
            </View>
          </View>
        </>
      )}
      <Text style={styles.meta}>
        Browsers and opted-in apps get content filtering after you install the hub&rsquo;s CA on this device — other apps get hostname-level blocking (Android user-CA restriction).
      </Text>
    </Card>
  );
}


/**
 * iOS on-device filtering VPN — the standalone path that ships today. The
 * packet-tunnel extension (`packet-tunnel-provider`, a standard Network
 * Extensions capability — no Apple grant needed) advertises an on-tunnel DNS
 * resolver; the system sends it every DNS query, blocked names sinkhole from
 * the synced ruleset, and the rest forward to the configured upstream.
 * The OS "Add VPN Configuration" consent is the first-enable gate. Honest
 * scope: DNS-only — apps on DoH/DoT bypass it, and HTTPS MITM (the CA path)
 * remains flag-125's on-device engine, not this tunnel.
 */
function IosTunnelCard({ ready }: { ready: boolean }) {
  const { pendingObservations } = useFilter();
  const client = useClient();
  const status = useQuery({
    queryKey: ['iostunnel'],
    queryFn: getIosTunnelStatus,
    refetchInterval: 4000,
  });
  const heartbeat = useQuery({
    queryKey: ['iostunnel-heartbeat'],
    queryFn: readTunnelStatus,
    refetchInterval: 4000,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const s = status.data;
  const beat = heartbeat.data;
  const active = s?.enabled && s.connection === 'connected';

  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      await Promise.race([
        setIosTunnelEnabled(!s?.enabled),
        new Promise((_, reject) => setTimeout(() => reject(new UserError('The system didn’t answer — try again.')), 45_000)),
      ]);
      haptics.success();
    } catch (e) {
      haptics.error();
      setErr(describeError(e));
    } finally {
      setBusy(false);
      void status.refetch();
    }
  };

  return (
    <Card>
      <View style={styles.rowBetween}>
        <SectionTitle icon="lock-closed-outline" label="On-device filter" style={{ marginBottom: 0 }} />
        {active ? <Pill label="active" tone="ok" /> : null}
      </View>
      <Text style={styles.meta}>
        {ready
          ? 'A local VPN filters every app’s DNS on this device — no hub needed. The system shows the VPN icon while it runs and asks permission the first time.'
          : 'Fetch feeds or sync a hub first — the tunnel answers against those rules.'}
      </Text>
      {err ? (
        <>
          <Text style={styles.syncError}>{err.title}</Text>
          {err.detail ? <Text style={styles.syncErrorDetail}>{err.detail}</Text> : null}
        </>
      ) : null}
      <View style={styles.buttonRow}>
        <View style={styles.buttonFlex}>
          <ActionButton
            label={s?.enabled ? 'Disable VPN filter' : 'Enable VPN filter'}
            tone={s?.enabled ? 'ghost' : 'primary'}
            disabled={!ready || busy}
            loading={busy}
            onPress={() => void toggle()}
          />
        </View>
      </View>
      {s && !s.installed ? (
        <Text style={styles.meta}>
          VPN profile not installed yet — enabling installs its configuration.
        </Text>
      ) : null}
      {s?.enabled && s.connection !== 'connected' ? (
        <Text style={styles.meta}>Tunnel {s.connection}…</Text>
      ) : null}
      {beat?.state === 'unavailable' ? (
        <Text style={styles.syncErrorDetail}>
          Tunnel diagnostics: the shared app-group container is unreachable on this build — the extension cannot see the ruleset or report observations.
        </Text>
      ) : null}
      {beat?.state === 'absent' && s?.enabled ? (
        <Text style={styles.meta}>
          Tunnel diagnostics: the extension hasn’t reported yet — look for the VPN icon, then browse.
        </Text>
      ) : null}
      {beat?.state === 'ok' ? (
        <Text style={styles.meta}>
          Tunnel: {beat.report.rules} rules · {beat.report.packets} queries ({beat.report.blocked} blocked, {beat.report.relayed} relayed) · seen {relativeTime(beat.report.at)}
        </Text>
      ) : null}
      {s?.enabled ? (
        <Text style={styles.meta}>
          {client
            ? `Shadow observation: every query this tunnel answers feeds the hub’s AI evidence — ${pendingObservations} pending upload.`
            : 'Shadow observation: this tunnel records every query it answers; the evidence uploads once a hub is paired.'}
        </Text>
      ) : null}
    </Card>
  );
}


function IosHubFilterCard() {
  const { activeServer } = useServers();
  const [hub, setHub] = useState('');
  const [savedHub, setSavedHub] = useState<string | null>(null);
  const [port, setPort] = useState(HUB_DATA_PORT);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const [line, setLine] = useState<string | null>(null);

  useEffect(() => {
    void loadHubHost().then((h) => {
      setSavedHub(h);
      if (h) setHub(h);
    });
    void loadHubPort().then((p) => {
      if (p) setPort(p);
    });
  }, []);

  // The paired server is usually the hub — offer its host as the default
  // when it is already a literal address (same defaulting HttpsCaptureCard
  // uses on Android).
  useEffect(() => {
    if (savedHub || hub) return;
    const host = activeServer ? hostFromUrl(activeServer.baseUrl) : null;
    if (host && isValidIpLiteral(host)) setHub(host);
  }, [activeServer, savedHub, hub]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    setLine(null);
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new UserError('The system didn\u2019t answer — try again.')), 45_000)),
      ]);
      haptics.success();
    } catch (e) {
      haptics.error();
      setErr(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const host = (savedHub ?? hub).trim();
  const pacUrl = isValidIpLiteral(host) ? hubDataUrl(host, '/proxy.pac', port) : null;

  const installCa = () =>
    act('ca', async () => {
      if (!isValidIpLiteral(host)) {
        throw new UserError('Enter the hub\u2019s LAN IP address first — the CA and the proxy both come from it.');
      }
      await saveHubHost(host);
      setSavedHub(host);
      const paired = await loadPairedCa();
      const ca: HubCa | PairedCa =
        paired ?? (await fetchHubCa(host, fetch, port));
      const fp = ca.sha256Fingerprint;
      if (!fp) {
        setErr({
          title: 'No CA fingerprint to check',
          detail: 'The hub didn\u2019t identify its CA — refusing to install a certificate that can\u2019t be verified.',
        });
        return;
      }
      const previous = await loadCaFingerprint();
      const drifted = !!previous && previous !== fp;
      const body =
        'Compare this fingerprint with the one shown in the hub\u2019s HTTPS Filtering card — matching it is the only check that the CA wasn\u2019t swapped on the network.\n\n' +
        `SHA-256\n${fp}` +
        (drifted
          ? '\n\nIt changed since you last confirmed it — make sure the hub\u2019s CA really was rotated.'
          : '');
      Alert.alert('Trust this hub CA?', body, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Install profile',
          onPress: () =>
            void act('ca', async () => {
              await saveCaFingerprint(fp);
              await Linking.openURL(hubDataUrl(host, '/v1/proxy/ca.mobileconfig', port));
              setLine(
                `Safari has the profile — install it under Settings › Profile Downloaded, then enable full trust under Settings › General › About › Certificate Trust Settings. CA sha256: ${fp}`,
              );
            }),
        },
      ]);
    });

  return (
    <Card>
      <SectionTitle icon="globe-outline" label="Web filtering via hub" />
      <Text style={styles.meta}>
        iOS has no VPN-based filter — instead, point this Wi-Fi network at the hub&apos;s proxy and Safari plus most apps get the engine&apos;s verdicts. Install the CA first: the engine terminates TLS, so every site errors until the CA is trusted.
      </Text>
      {err ? (
        <>
          <Text style={styles.syncError}>{err.title}</Text>
          {err.detail ? <Text style={styles.syncErrorDetail}>{err.detail}</Text> : null}
        </>
      ) : null}
      {line ? <Text style={styles.meta}>{line}</Text> : null}
      <TextInput
        style={styles.input}
        placeholder="hub LAN IP (e.g. 192.168.1.20)"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="numbers-and-punctuation"
        value={hub}
        onChangeText={setHub}
        onBlur={() => {
          const h = hub.trim();
          if (isValidIpLiteral(h)) {
            void saveHubHost(h);
            setSavedHub(h);
          }
        }}
      />
      <View style={styles.buttonRow}>
        <View style={styles.buttonFlex}>
          <ActionButton
            label="1. Install hub CA profile"
            tone="primary"
            disabled={busy !== null}
            loading={busy === 'ca'}
            onPress={() => void installCa()}
          />
        </View>
      </View>
      {pacUrl ? (
        <>
          <Text style={styles.meta}>
            2. Settings › Wi-Fi › ⓘ next to this network › Configure Proxy › Automatic — paste:
          </Text>
          <Text style={styles.feedUrl} selectable>
            {pacUrl}
          </Text>
          <Text style={styles.meta}>
            Set per Wi-Fi network; cellular and other networks are unaffected, and apps that ignore the system proxy bypass it. Device-wide filtering for every app waits on Apple&apos;s Network Extension entitlement.
          </Text>
        </>
      ) : null}
    </Card>
  );
}


/**
 * Local DNS responder — the mobile counterpart of the desktop daemon's UDP
 * listener. Both platforms: serves LAN devices (and this one, via a manual
 * Wi-Fi DNS entry) while the app is open; on Android the VPN filter above is
 * still the device-wide path.
 */
function LocalDnsCard({ ready }: { ready: boolean }) {
  const [s, setS] = useState<LocalDnsStatus>(localDnsStatus);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FriendlyError | null>(null);
  useEffect(() => subscribeLocalDns(() => setS(localDnsStatus())), []);

  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (s.running) stopLocalDns();
      else await startLocalDns();
      haptics.success();
    } catch (e) {
      haptics.error();
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <View style={styles.rowBetween}>
        <SectionTitle icon="radio-outline" label="Local DNS service" style={{ marginBottom: 0 }} />
        {s.running ? <Pill label="listening" tone="ok" /> : null}
      </View>
      <Text style={styles.meta}>
        {ready
          ? `Answers DNS on :${s.port} (UDP) while the app is open — blocked names sinkhole, the rest resolve through ${s.upstream}. Point another device's DNS at this phone's LAN address to filter it.`
          : 'Sync rules above first — the service answers against the synced ruleset.'}
      </Text>
      {err ? (
        <>
          <Text style={styles.syncError}>{err.title}</Text>
          {err.detail ? <Text style={styles.syncErrorDetail}>{err.detail}</Text> : null}
        </>
      ) : null}
      <View style={styles.buttonRow}>
        <View style={styles.buttonFlex}>
          <ActionButton
            label={s.running ? 'Stop service' : 'Start service'}
            tone={s.running ? 'ghost' : 'primary'}
            disabled={!ready || busy}
            loading={busy}
            onPress={() => void toggle()}
          />
        </View>
      </View>
      {s.running ? (
        <Text style={styles.meta}>
          {s.queries.toLocaleString()} queries · {s.blocked.toLocaleString()} blocked · {s.forwarded.toLocaleString()} forwarded
        </Text>
      ) : null}
      {s.lastError ? <Text style={styles.syncError}>{s.lastError}</Text> : null}
    </Card>
  );
}


/**
 * Android-only card: per-app bypass. Excluded packages never enter the VPN
 * tunnel at all — their DNS is unfiltered, nothing they send reaches the
 * hub, and QUIC is untouched. The set persists natively (SharedPreferences)
 * and applies via `addDisallowedApplication` on the next tunnel establish;
 * writing while the tunnel runs re-establishes it (in-flight flows drop).
 */
function PerAppBypassCard() {
  const [apps, setApps] = useState<string[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const [rejected, setRejected] = useState<string[]>([]);

  useEffect(() => {
    void LocalVpn.getDisallowedApps().then((list) => {
      setApps(list);
      setDraft(list.join(', '));
    });
  }, []);

  const save = async (next: string[], opts?: { syncDraft?: boolean }) => {
    setBusy(true);
    setErr(null);
    try {
      const stored = await LocalVpn.setDisallowedApps(next);
      setApps(stored);
      if (opts?.syncDraft !== false) setDraft(stored.join(', '));
      haptics.success();
    } catch (e) {
      haptics.error();
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    const parsed = parsePackageList(draft);
    setRejected(parsed.rejected);
    void save(parsed.packages);
  };

  const toggleSelf = () => {
    if (apps === null) return;
    setRejected([]);
    // The toggle acts on the stored set, and a dirty draft is the user's
    // in-progress edit — save without clobbering it. A draft still mirroring
    // the stored set tracks the toggle so the box doesn't go stale.
    void save(toggledSelfList(apps), { syncDraft: draft === apps.join(', ') });
  };

  const selfExcluded = !!apps?.includes(SELF_PACKAGE);

  return (
    <Card>
      <View style={styles.rowBetween}>
        <SectionTitle icon="apps-outline" label="Per-app bypass" style={{ marginBottom: 0 }} />
        {apps && apps.length > 0 ? <Pill label={`${apps.length} excluded`} tone="info" /> : null}
      </View>
      <Text style={styles.meta}>
        Excluded apps bypass the VPN tunnel entirely — nothing they do is filtered or sent to the hub. Package names, separated by commas.
      </Text>
      {err ? (
        <>
          <Text style={styles.syncError}>{err.title}</Text>
          {err.detail ? <Text style={styles.syncErrorDetail}>{err.detail}</Text> : null}
        </>
      ) : null}
      <TextInput
        style={styles.input}
        value={draft}
        onChangeText={setDraft}
        placeholder="com.example.app, org.other.app"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {rejected.length > 0 ? (
        <Text style={styles.syncErrorDetail}>Skipped: {rejected.join(', ')}</Text>
      ) : null}
      <View style={styles.buttonRow}>
        <View style={styles.buttonFlex}>
          <ActionButton
            label="Apply"
            disabled={busy || apps === null}
            loading={busy}
            onPress={apply}
          />
        </View>
        <View style={styles.buttonFlex}>
          <ActionButton
            label="Clear all"
            tone="ghost"
            disabled={busy || !apps || apps.length === 0}
            onPress={() => {
              setRejected([]);
              void save([]);
            }}
          />
        </View>
      </View>
      <Pressable
        style={styles.docRow}
        accessibilityRole="button"
        accessibilityLabel="Exclude this app from the tunnel"
        onPress={toggleSelf}
      >
        <Ionicons
          name={selfExcluded ? 'checkbox-outline' : 'square-outline'}
          size={18}
          color={colors.accent}
        />
        <Text style={styles.docLabel}>Exclude this app ({SELF_PACKAGE})</Text>
      </Pressable>
      <Text style={styles.meta}>
        Applies on the next tunnel start — a running tunnel re-establishes, briefly dropping active connections.
      </Text>
    </Card>
  );
}

/**
 * Standalone ruleset — the synced copy of the hub's compiled rules that lets
 * Check answer on-device while the hub is unreachable (or no hub is paired).
 */
function StandaloneFilterCard() {
  const { activeServer, activeToken } = useServers();
  const filter = useFilter();
  const [syncError, setSyncError] = useState<FriendlyError | null>(null);
  return (
    <Card>
      <View style={styles.rowBetween}>
        <SectionTitle icon="phone-portrait-outline" label="Standalone filter" style={{ marginBottom: 0 }} />
        {filter.ready ? <Pill label="on-device" tone="ok" /> : null}
      </View>
      <Text style={styles.meta}>
        {filter.ready && filter.meta
          ? `${filter.meta.ruleCount.toLocaleString()} rules stored on this device — synced ${relativeTime(filter.meta.syncedAt) ?? 'recently'} from ${filter.meta.sourceUrl}. Domain checks keep working when the hub is unreachable.`
          : 'Download the hub\u2019s compiled rules once and the app answers domain checks on-device \u2014 even with the hub unreachable or no server configured.'}
      </Text>
      {syncError ? (
        <>
          <Text style={styles.syncError}>{syncError.title}</Text>
          {syncError.detail ? <Text style={styles.syncErrorDetail}>{syncError.detail}</Text> : null}
        </>
      ) : null}
      <View style={styles.buttonRow}>
        <View style={styles.buttonFlex}>
          <ActionButton
            label={filter.syncing ? 'Syncing…' : filter.ready ? 'Re-sync rules' : 'Sync rules from hub'}
            loading={filter.syncing}
            disabled={!activeServer}
            onPress={() => {
              if (!activeServer) return;
              setSyncError(null);
              filter
                .sync(activeServer.baseUrl, activeToken)
                .then(() => haptics.success())
                .catch((e) => {
                  haptics.error();
                  setSyncError(describeError(e));
                });
            }}
          />
        </View>
        {filter.ready ? (
          <View style={styles.buttonFlex}>
            <ActionButton
              label="Clear rules"
              tone="ghost"
              onPress={() =>
                Alert.alert('Clear on-device rules?', 'Checks will go back to asking the hub — and won\u2019t work while it\u2019s unreachable.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Clear', style: 'destructive', onPress: () => void filter.clear() },
                ])
              }
            />
          </View>
        ) : null}
      </View>
      {!activeServer && !filter.ready ? (
        <Text style={styles.meta}>Add a hub server in Settings first — the rules feed comes from a hub.</Text>
      ) : null}
    </Card>
  );
}


export default function ProtectScreen() {
  const insets = useSafeAreaInsets();
  const tier = useWidthTier();
  const gridCols = gridColumnsFor(tier);
  const filter = useFilter();
  return (
    <View style={styles.screen}>
      <GlassBackdrop />
      <ScrollView
        style={styles.scroll}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[
          styles.content,
          {
            maxWidth:
              tier === 'regular' ? layout.contentMaxWidthWide : layout.contentMaxWidth,
            paddingTop: insets.top + spacing.lg,
            paddingBottom:
              spacing.xl +
              insets.bottom +
              (tier === 'compact' && !hasEdgeUtilityStrip(insets.right)
                ? chrome.tabBarClearance
                : 0),
          },
        ]}
      >
        <ScreenHeader
          title="Protect"
          subtitle="Filtering that runs on this phone."
        />
        <Grid columns={gridCols}>
          <StandaloneFilterCard />
          {isLocalVpnSupported() ? <LocalFilterCard ready={filter.ready} /> : null}
          {isLocalVpnSupported() ? <HttpsCaptureCard /> : null}
          {isLocalVpnSupported() ? <PerAppBypassCard /> : null}
          {isIosTunnelSupported() ? <IosTunnelCard ready={filter.ready} /> : null}
          {Platform.OS === 'ios' ? <IosHubFilterCard /> : null}
          <LocalDnsCard ready={filter.ready} />
        </Grid>
      </ScrollView>
    </View>
  );
}
