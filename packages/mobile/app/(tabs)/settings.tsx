/**
 * Settings: saved server list (add/select/remove), token editor for the active
 * server, and the feed URLs the server advertises. mDNS-derived servers show the
 * service name so a household with both a hub and an add-on stays legible.
 */

import React, { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClient } from '../../src/api/useClient';
import { useServers } from '../../src/state/servers';
import { useFilter } from '../../src/state/filter';
import { LocalVpn, isLocalVpnSupported } from '../../src/filter/localVpn';
import { nativeRulesPath } from '../../src/filter/ruleset';
import { ActionButton, Card, Pill, SectionTitle } from '../../src/components/ui';
import { GlassBackdrop } from '../../src/components/GlassBackdrop';
import { relativeTime } from '../../src/format';
import { haptics } from '../../src/haptics';
import { chrome, colors, glass, spacing } from '../../src/theme';

const ORIGIN_LABEL: Record<string, string> = {
  manual: 'manual',
  qr: 'paired via QR',
  mdns: 'discovered',
};

function formatSeen(iso: string): string {
  const rel = relativeTime(iso);
  return rel ? ` · seen ${rel}` : '';
}

const DOC_LINKS: { icon: keyof typeof Ionicons.glyphMap; label: string; hint: string; url: string }[] = [
  {
    icon: 'book-outline',
    label: 'User guide & setup',
    hint: 'README on GitHub',
    url: 'https://github.com/Greigh/Blockingmachine#readme',
  },
  {
    icon: 'home-outline',
    label: 'Home Assistant add-on',
    hint: 'add-on install & feed source config',
    url: 'https://github.com/Greigh/Blockingmachine/blob/main/packages/homeassistant-addon/DOCS.md',
  },
  {
    icon: 'documents-outline',
    label: 'Docs & design notes',
    hint: 'docs/ on GitHub',
    url: 'https://github.com/Greigh/Blockingmachine/tree/main/docs',
  },
  {
    icon: 'bug-outline',
    label: 'Report an issue',
    hint: 'GitHub issues',
    url: 'https://github.com/Greigh/Blockingmachine/issues',
  },
];

function DocLink({ icon, label, hint, url }: (typeof DOC_LINKS)[number]) {
  return (
    <Pressable
      style={styles.docRow}
      android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
      accessibilityRole="link"
      accessibilityLabel={`${label} — opens ${url}`}
      onPress={() => {
        haptics.select();
        void Linking.openURL(url);
      }}
    >
      <View style={styles.docIcon}>
        <Ionicons name={icon} size={16} color={colors.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.docLabel}>{label}</Text>
        <Text style={styles.docHint}>{hint}</Text>
      </View>
      <Ionicons name="open-outline" size={15} color={colors.textMuted} />
    </Pressable>
  );
}

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
  const [err, setErr] = useState<string | null>(null);
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out talking to the system — try again.')), 45_000)),
      ]);
      haptics.success();
    } catch (e) {
      haptics.error();
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      void vpn.refetch();
    }
  };

  const startVpn = () =>
    act('vpn', async () => {
      const granted = await LocalVpn.requestVpnConsent();
      if (!granted) throw new Error('VPN permission denied — the local filter needs it to run.');
      await LocalVpn.startVpn(rules, '8.8.8.8', 'Blockingmachine');
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
      {err ? <Text style={styles.syncError}>{err}</Text> : null}
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

export default function SettingsScreen() {
  const { servers, activeServerId, activeToken, setActive, removeServer, setToken } =
    useServers();
  const insets = useSafeAreaInsets();
  const client = useClient();
  const filter = useFilter();
  const activeServer = servers.find((s) => s.id === activeServerId);
  const [tokenDraft, setTokenDraft] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ['status', activeServer?.baseUrl ?? 'none'],
    queryFn: () => client!.getStatus(),
    enabled: !!client,
  });

  const feedUrls: { label: string; url?: string }[] = [
    { label: 'DNS feed', url: status.data?.feedServer?.dnsFeedUrl },
    { label: 'Browser feed', url: status.data?.feedServer?.browserFeedUrl },
    { label: 'AI threats', url: status.data?.feedServer?.aiThreatsFeedUrl },
    { label: 'ABP threats', url: status.data?.feedServer?.abpThreatsFeedUrl },
  ].filter((f) => typeof f.url === 'string');

  const confirmRemove = (id: string, label: string) => {
    Alert.alert('Remove server', `Remove ${label}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void removeServer(id) },
    ]);
  };

  return (
    <View style={styles.screen}>
      <GlassBackdrop />
      <ScrollView
        style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg, paddingBottom: spacing.xl + insets.bottom + chrome.tabBarClearance }]}
    >
      <Text style={styles.title}>Settings</Text>

      <Card>
        <View style={styles.rowBetween}>
          <SectionTitle icon="server-outline" label="Servers" style={{ marginBottom: 0 }} />
          <Pressable
            onPress={() => router.push('/add-server')}
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text style={styles.link}>Add</Text>
          </Pressable>
        </View>
        {servers.length === 0 ? (
          <Text style={styles.meta}>No servers yet — add one to get started.</Text>
        ) : (
          servers.map((s) => (
            <ReanimatedSwipeable
              key={s.id}
              friction={2}
              rightThreshold={40}
              renderRightActions={() => (
                <Pressable
                  style={styles.swipeDelete}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${s.label || s.baseUrl}`}
                  onPress={() => confirmRemove(s.id, s.label || s.baseUrl)}
                >
                  <Ionicons name="trash-outline" size={20} color={colors.text} />
                  <Text style={styles.swipeDeleteText}>Remove</Text>
                </Pressable>
              )}
            >
              <Pressable
                style={styles.serverRow}
                android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
                onPress={() => void setActive(s.id)}
                accessibilityRole="button"
              >
                <View style={{ flex: 1 }}>
                  <View style={styles.serverTitleRow}>
                    <Text style={styles.serverLabel}>{s.label || s.baseUrl}</Text>
                    {s.id === activeServerId ? <Pill label="active" tone="ok" /> : null}
                  </View>
                  <Text style={styles.meta}>
                    {s.baseUrl} · {ORIGIN_LABEL[s.origin] ?? s.origin}
                    {s.lastOkAt ? formatSeen(s.lastOkAt) : ''}
                  </Text>
                </View>
              </Pressable>
            </ReanimatedSwipeable>
          ))
        )}
      </Card>

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
        {syncError ? <Text style={styles.syncError}>{syncError}</Text> : null}
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
                    setSyncError(e instanceof Error ? e.message : String(e));
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
                  Alert.alert('Clear on-device rules', 'Domain checks will require the hub again.', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Clear', style: 'destructive', onPress: () => void filter.clear() },
                  ])
                }
              />
            </View>
          ) : null}
        </View>
        {!activeServer && !filter.ready ? (
          <Text style={styles.meta}>Add a server above first — the rules feed comes from a hub.</Text>
        ) : null}
      </Card>

      {isLocalVpnSupported() ? <LocalFilterCard ready={filter.ready} /> : null}

      {activeServerId ? (
        <Card>
          <SectionTitle icon="key-outline" label="Feed token" />
          <Text style={styles.meta}>
            Required only if the server has one configured. Stored in the device
            keychain.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="leave empty when the server is open"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            value={tokenDraft ?? activeToken}
            onChangeText={setTokenDraft}
          />
          <View style={styles.buttonRow}>
            <View style={styles.buttonFlex}>
              <ActionButton
                label="Save token"
                onPress={() => {
                  void setToken(activeServerId, (tokenDraft ?? '').trim());
                  setTokenDraft(null);
                }}
                disabled={tokenDraft === null}
              />
            </View>
            {tokenDraft !== null ? (
              <View style={styles.buttonFlex}>
                <ActionButton
                  label="Cancel"
                  tone="ghost"
                  onPress={() => setTokenDraft(null)}
                />
              </View>
            ) : null}
          </View>
        </Card>
      ) : null}

      {feedUrls.length > 0 ? (
        <Card>
          <SectionTitle icon="link-outline" label="Feed URLs" />
          {feedUrls.map((f) => (
            <View key={f.label} style={styles.feedRow}>
              <Text style={styles.feedLabel}>{f.label}</Text>
              <Text style={styles.feedUrl} selectable>
                {f.url}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      <Card>
        <SectionTitle icon="book-outline" label="Docs" />
        {DOC_LINKS.map((d) => (
          <DocLink key={d.url} {...d} />
        ))}
      </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  scroll: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', marginBottom: spacing.md },
  rowBetween: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  link: { color: colors.info, fontSize: 15, fontWeight: '600' },
  serverRow: {
    backgroundColor: glass.surface,
    borderTopColor: glass.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  swipeDelete: {
    alignItems: 'center',
    backgroundColor: colors.danger,
    borderTopColor: colors.cardBorder,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  swipeDeleteText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  serverTitleRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  serverLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  input: {
    backgroundColor: glass.surface,
    borderColor: glass.border,
    borderTopColor: glass.borderTop,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 15,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  buttonFlex: { flex: 1 },
  feedRow: { borderTopColor: glass.border, borderTopWidth: 1, paddingVertical: spacing.sm },
  docRow: {
    alignItems: 'center',
    borderTopColor: glass.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
  },
  docIcon: {
    alignItems: 'center',
    backgroundColor: 'rgba(63,185,80,0.12)',
    borderRadius: 8,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  docLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  docHint: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  feedLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  feedUrl: { color: colors.info, fontSize: 12, marginTop: 2 },
  syncError: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
});
