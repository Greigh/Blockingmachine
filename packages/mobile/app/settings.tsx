/**
 * Settings: the connection sheet — saved server list (add/select/remove),
 * token editor for the active server, the feed URLs the server advertises, hub
 * HTTPS pins, and doc links. Feature surfaces live on their own tabs (Protect,
 * Rules); this is reached via the header gear. mDNS-derived servers show the
 * service name so a household with both a hub and an add-on stays legible.
 */

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
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
import { useClient } from '../src/api/useClient';
import { useServers, type SavedServer } from '../src/state/servers';
import { styles } from '../src/components/screenStyles';
import { ActionButton, Card, Grid, Pill, SectionTitle } from '../src/components/ui';
import { describeError, type FriendlyError } from '../src/errors';
import { GlassBackdrop } from '../src/components/GlassBackdrop';
import { gridColumnsFor, useWidthTier } from '../src/hooks/useWidthTier';
import { relativeTime } from '../src/format';
import { haptics } from '../src/haptics';
import { colors, layout, spacing } from '../src/theme';

type FeedKey = keyof NonNullable<SavedServer['feedUrls']>;

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
 * Hub pin/bypass ledger — which TLS hosts the engine learned to leave alone
 * (client certificate pinning aborts) or a user explicitly bypassed. A phone
 * browsing through the hub hits these failures, so the remove control lives
 * here rather than only in the desktop UI. Both surfaces serve the route —
 * the Electron hub and the HA add-on each proxy their engine's loopback
 * control API; a stopped engine answers 503 and the card says so.
 */
function HubPinsCard() {
  const client = useClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const { activeServer } = useServers();
  const pins = useQuery({
    queryKey: ['proxy-pins', activeServer?.baseUrl ?? 'none'],
    queryFn: () => client!.getProxyPins(),
    enabled: !!client,
    refetchInterval: 15_000,
  });

  // Collapse the ledger stream to per-host effective state — a host's LAST
  // action wins, and a `remove` retraction erases it entirely.
  const effective = new Map<string, { action: 'pin' | 'bypass'; ts: number }>();
  for (const e of pins.data?.pins ?? []) {
    if (e.action === 'remove') effective.delete(e.host);
    else effective.set(e.host, { action: e.action, ts: e.ts });
  }
  const rows = [...effective.entries()].sort((a, b) => b[1].ts - a[1].ts);

  const remove = (host: string) => {
    if (!client) return;
    setBusy(host);
    setErr(null);
    void client
      .removeProxyPin(host)
      .then((r) => {
        if (!r.success) setErr({ title: 'The hub refused the unpin', detail: r.message ?? r.error });
        else void pins.refetch();
      })
      .catch((e) => setErr(describeError(e)))
      .finally(() => setBusy(null));
  };

  return (
    <Card>
      <View style={styles.rowBetween}>
        <SectionTitle icon="pin-outline" label="Hub HTTPS pins" style={{ marginBottom: 0 }} />
        {rows.length > 0 ? <Pill label={`${rows.length} active`} tone="muted" /> : null}
      </View>
      <Text style={styles.meta}>
        Hosts the hub\u2019s HTTPS engine stops intercepting — learned when an app pins its certificate, or bypassed by hand. Removing an entry lets the engine filter that host again.
      </Text>
      {pins.error ? (
        <Text style={styles.syncErrorDetail}>
          {describeError(pins.error).title} — {describeError(pins.error).detail ?? 'the engine may be stopped'}
        </Text>
      ) : null}
      {err ? (
        <>
          <Text style={styles.syncError}>{err.title}</Text>
          {err.detail ? <Text style={styles.syncErrorDetail}>{err.detail}</Text> : null}
        </>
      ) : null}
      {rows.length === 0 && !pins.error ? (
        <Text style={styles.meta}>No pinned or bypassed hosts.</Text>
      ) : null}
      {rows.slice(0, 20).map(([host, e]) => (
        <View key={host} style={styles.rowBetween}>
          <Text style={styles.meta} numberOfLines={1}>{host}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pill label={e.action} tone={e.action === 'pin' ? 'warn' : 'info'} />
            <ActionButton
              label="Unpin"
              tone="ghost"
              loading={busy === host}
              disabled={busy !== null}
              onPress={() => remove(host)}
            />
          </View>
        </View>
      ))}
      {rows.length > 20 ? (
        <Text style={styles.meta}>+ {rows.length - 20} more — trim older entries on the hub.</Text>
      ) : null}
    </Card>
  );
}

export default function SettingsScreen() {
  const { servers, activeServerId, activeToken, setActive, removeServer, updateServer, setToken } =
    useServers();
  const insets = useSafeAreaInsets();
  const tier = useWidthTier();
  const gridCols = gridColumnsFor(tier);
  const client = useClient();
  const activeServer = servers.find((s) => s.id === activeServerId);
  const [tokenDraft, setTokenDraft] = useState<string | null>(null);
  const [editingFeed, setEditingFeed] = useState<FeedKey | null>(null);
  const [feedDraft, setFeedDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editErr, setEditErr] = useState<string | null>(null);

  // A draft belongs to the server it was opened on — a token typed for A
  // must never land on B when the active row is switched mid-edit.
  useEffect(() => {
    setTokenDraft(null);
    setEditingFeed(null);
    setEditingId(null);
    setEditErr(null);
  }, [activeServerId]);

  const status = useQuery({
    queryKey: ['status', activeServer?.baseUrl ?? 'none', activeToken],
    queryFn: () => client!.getStatus(),
    enabled: !!client,
  });

  // A stored override beats the hub-advertised URL — the hub may publish a
  // .local name the phone cannot resolve, so the app keeps the corrected one.
  const feedUrls: { key: FeedKey; label: string; url: string; advertised?: string; custom: boolean }[] = (
    [
      { key: 'dns', label: 'DNS feed', advertised: status.data?.feedServer?.dnsFeedUrl },
      { key: 'browser', label: 'Browser feed', advertised: status.data?.feedServer?.browserFeedUrl },
      { key: 'aiThreats', label: 'AI threats', advertised: status.data?.feedServer?.aiThreatsFeedUrl },
      { key: 'abpThreats', label: 'ABP threats', advertised: status.data?.feedServer?.abpThreatsFeedUrl },
    ] as const
  )
    .map((f) => {
      const override = activeServer?.feedUrls?.[f.key];
      return { ...f, url: override ?? f.advertised, custom: !!override };
    })
    .filter((f): f is typeof f & { url: string } => typeof f.url === 'string');

  const confirmRemove = (id: string, label: string) => {
    Alert.alert('Remove this server?', `You\u2019ll need to add ${label} again to control it.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void removeServer(id).catch(() => {}) },
    ]);
  };

  return (
    <View style={styles.screen}>
      <GlassBackdrop />
      <ScrollView
        style={styles.scroll}
      contentContainerStyle={[styles.content, { maxWidth: tier === 'regular' ? layout.contentMaxWidthWide : layout.contentMaxWidth, paddingTop: spacing.lg, paddingBottom: spacing.xl + insets.bottom }]}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <Grid columns={gridCols}>
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
          servers.map((s) =>
            editingId === s.id ? (
              <View key={s.id} style={styles.serverEditRow}>
                <TextInput
                  style={styles.input}
                  value={editLabel}
                  onChangeText={setEditLabel}
                  placeholder="Label"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                />
                <TextInput
                  style={styles.input}
                  value={editUrl}
                  onChangeText={setEditUrl}
                  placeholder="http://host:9191"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                {editErr ? <Text style={styles.editErr}>{editErr}</Text> : null}
                <View style={styles.buttonRow}>
                  <View style={styles.buttonFlex}>
                    <ActionButton
                      label="Save"
                      disabled={!editUrl.trim()}
                      onPress={() => {
                        updateServer(s.id, {
                          label: editLabel.trim() || s.label,
                          baseUrl: editUrl.trim(),
                        })
                          .then(() => {
                            setEditErr(null);
                            setEditingId(null);
                          })
                          .catch((e) =>
                            setEditErr(describeError(e).detail ?? describeError(e).title),
                          );
                      }}
                    />
                  </View>
                  <View style={styles.buttonFlex}>
                    <ActionButton
                      label="Cancel"
                      tone="ghost"
                      onPress={() => {
                        setEditErr(null);
                        setEditingId(null);
                      }}
                    />
                  </View>
                </View>
              </View>
            ) : (
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
                  onPress={() => void setActive(s.id).catch(() => {})}
                  accessibilityRole="button"
                >
                  <View style={{ flex: 1 }}>
                    <View style={styles.serverTitleRow}>
                      <Text style={styles.serverLabel}>{s.label || s.baseUrl}</Text>
                      {s.id === activeServerId ? <Pill label="active" tone="ok" /> : null}
                    </View>
                    <Text numberOfLines={1} style={styles.meta}>
                      {s.baseUrl} · {ORIGIN_LABEL[s.origin] ?? s.origin}
                      {s.lastOkAt ? formatSeen(s.lastOkAt) : ''}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${s.label || s.baseUrl}`}
                    hitSlop={8}
                    onPress={() => {
                      setEditingId(s.id);
                      setEditLabel(s.label);
                      setEditUrl(s.baseUrl);
                    }}
                  >
                    <Ionicons name="create-outline" size={18} color={colors.textMuted} />
                  </Pressable>
                </Pressable>
              </ReanimatedSwipeable>
            ),
          )
        )}
      </Card>


      {client ? <HubPinsCard /> : null}

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
                  void setToken(activeServerId, (tokenDraft ?? '').trim())
                    .then(() => setTokenDraft(null))
                    .catch((e) =>
                      Alert.alert('Couldn\u2019t save the token', describeError(e).title),
                    );
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
          {feedUrls.map((f) =>
            editingFeed === f.key ? (
              <View key={f.key} style={styles.feedRow}>
                <Text style={styles.feedLabel}>{f.label}</Text>
                <TextInput
                  style={styles.input}
                  value={feedDraft}
                  onChangeText={setFeedDraft}
                  placeholder={f.advertised ?? 'http://host:9191/dns.txt'}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                <View style={styles.buttonRow}>
                  <View style={styles.buttonFlex}>
                    <ActionButton
                      label="Save"
                      onPress={() => {
                        if (activeServerId) {
                          void updateServer(activeServerId, {
                            feedUrls: { [f.key]: feedDraft.trim() || undefined },
                          });
                        }
                        setEditingFeed(null);
                      }}
                    />
                  </View>
                  <View style={styles.buttonFlex}>
                    <ActionButton
                      label="Cancel"
                      tone="ghost"
                      onPress={() => setEditingFeed(null)}
                    />
                  </View>
                </View>
              </View>
            ) : (
              <View key={f.key} style={styles.feedRow}>
                <View style={styles.feedLabelRow}>
                  <Text style={styles.feedLabel}>{f.label}</Text>
                  {f.custom ? <Text style={styles.feedCustom}>custom</Text> : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${f.label} URL`}
                    hitSlop={8}
                    onPress={() => {
                      setEditingFeed(f.key);
                      setFeedDraft(f.url);
                    }}
                    style={{ marginLeft: 'auto' }}
                  >
                    <Ionicons name="create-outline" size={16} color={colors.textMuted} />
                  </Pressable>
                </View>
                <Text style={styles.feedUrl} selectable>
                  {f.url}
                </Text>
              </View>
            ),
          )}
        </Card>
      ) : null}

      <Card>
        <SectionTitle icon="book-outline" label="Docs" />
        {DOC_LINKS.map((d) => (
          <DocLink key={d.url} {...d} />
        ))}
      </Card>
      </Grid>
      <Text style={styles.footer}>Blockingmachine · by Greigh Studios LLC</Text>
      </ScrollView>
    </View>
  );
}
