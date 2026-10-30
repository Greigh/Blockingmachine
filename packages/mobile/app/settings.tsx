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
  Switch,
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
import { useFilter } from '../src/state/filter';
import {
  readFeeds,
  saveFeeds,
  type FilterFeed,
} from '../src/filter/feeds';
import type { HubFilterSource } from '../src/api/types';
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
  const pins = useQuery({
    queryKey: ['proxy-pins'],
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

/**
 * On-device filter feeds — the standalone path: blocklist URLs the phone
 * fetches and compiles itself, unioned with any hub ruleset into
 * `ruleset_native.txt`. Hub-less iPhones get real filtering this way; hub
 * users can still layer personal lists on top. A dead feed degrades to a
 * meta error, never to an empty ruleset.
 */
function FilterFeedsCard() {
  const filter = useFilter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const feeds = useQuery({ queryKey: ['filter-feeds'], queryFn: readFeeds });

  const mutate = async (next: FilterFeed[]) => {
    await saveFeeds(next);
    void feeds.refetch();
  };

  const addFeed = () => {
    const name = newName.trim() || 'Custom feed';
    const url = newUrl.trim();
    if (!url) return;
    if (!url.startsWith('https://')) {
      setErr({ title: 'Feed URLs must be https://', detail: 'Plaintext feeds can be rewritten on the wire.' });
      return;
    }
    setErr(null);
    void mutate([...(feeds.data ?? []), { name, url, enabled: true }]);
    setNewName('');
    setNewUrl('');
  };

  const refresh = () => {
    setBusy(true);
    setErr(null);
    filter
      .refreshLocal()
      .catch((e) => setErr(describeError(e)))
      .finally(() => setBusy(false));
  };

  const meta = filter.localMeta;
  return (
    <Card>
      <View style={styles.rowBetween}>
        <SectionTitle icon="list-outline" label="Filter feeds" style={{ marginBottom: 0 }} />
        {meta ? <Pill label={`${meta.ruleCount.toLocaleString()} rules`} tone="ok" /> : null}
      </View>
      <Text style={styles.meta}>
        Blocklists the phone fetches and filters with on its own — no hub needed. Rules union with any synced hub set, and a feed that fails never takes the rest with it.
      </Text>
      {(feeds.data ?? []).map((f, i) => (
        <View key={f.url} style={styles.rowBetween}>
          <View style={{ flex: 1, marginRight: 8 }}>
            <Text style={styles.meta} numberOfLines={1}>{f.name}</Text>
            <Text style={styles.feedUrl} numberOfLines={1}>{f.url}</Text>
          </View>
          <Switch
            value={f.enabled}
            onValueChange={(v) => void mutate((feeds.data ?? []).map((x, j) => (j === i ? { ...x, enabled: v } : x)))}
            thumbColor={f.enabled ? colors.accent : colors.textMuted}
          />
          <ActionButton
            label="Remove"
            tone="ghost"
            onPress={() => void mutate((feeds.data ?? []).filter((_, j) => j !== i))}
          />
        </View>
      ))}
      <TextInput
        style={styles.input}
        placeholder="Feed name (optional)"
        placeholderTextColor={colors.textMuted}
        value={newName}
        onChangeText={setNewName}
      />
      <TextInput
        style={styles.input}
        placeholder="https://example.com/blocklist.txt"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={newUrl}
        onChangeText={setNewUrl}
      />
      <View style={styles.buttonRow}>
        <View style={styles.buttonFlex}>
          <ActionButton label="Add feed" onPress={addFeed} disabled={!newUrl.trim()} />
        </View>
        <View style={styles.buttonFlex}>
          <ActionButton
            label={busy ? 'Fetching…' : 'Fetch feeds now'}
            tone="primary"
            loading={busy || filter.syncing}
            onPress={refresh}
          />
        </View>
      </View>
      {meta ? (
        <Text style={styles.meta}>
          {`Last fetch ${new Date(meta.syncedAt).toLocaleString()} — ${meta.feedCount} feed${meta.feedCount === 1 ? '' : 's'}`}
        </Text>
      ) : null}
      {meta?.errors.map((e) => (
        <Text key={e.name} style={styles.syncErrorDetail}>{`${e.name}: ${e.error}`}</Text>
      ))}
      {err ? (
        <>
          <Text style={styles.syncError}>{err.title}</Text>
          {err.detail ? <Text style={styles.syncErrorDetail}>{err.detail}</Text> : null}
        </>
      ) : null}
    </Card>
  );
}

/**
 * Hub-side filter editing — the blocklist subscriptions and hand-written
 * custom rules the hub compiles from. Changes save to the hub, then a
 * recompile makes them live — the same effect as editing on the desktop.
 * Only renders when a hub is paired (the add-on reports 404 and the card
 * degrades honestly).
 */
function HubSourcesCard() {
  const client = useClient();
  const [draft, setDraft] = useState<HubFilterSource[] | null>(null);
  const [customDraft, setCustomDraft] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<FriendlyError | null>(null);
  const sources = useQuery({
    queryKey: ['hub-sources'],
    queryFn: () => client!.getSources(),
    enabled: !!client,
  });
  const custom = useQuery({
    queryKey: ['hub-custom-rules'],
    queryFn: () => client!.getCustomRules(),
    enabled: !!client,
  });

  const list = draft ?? sources.data?.sources ?? null;
  const customText = customDraft ?? custom.data?.customRules ?? '';

  const saveAndCompile = () => {
    if (!client || !list) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    void client
      .saveSources(list)
      .then((r) => {
        if (r.success === false) throw new Error(r.error ?? 'The hub refused the source list');
        return client.saveCustomRules(customText);
      })
      .then((r) => {
        if (r.success === false) throw new Error(r.error ?? 'The hub refused the custom rules');
        return client.compile();
      })
      .then(() => {
        setResult('Saved — the hub is recompiling now.');
        setDraft(null);
        setCustomDraft(null);
        void sources.refetch();
        void custom.refetch();
      })
      .catch((e) => setErr(describeError(e)))
      .finally(() => setBusy(false));
  };

  const addSource = () => {
    const url = newUrl.trim();
    if (!url || !list) return;
    setDraft([...list, { name: newName.trim() || 'Custom list', url, enabled: true }]);
    setNewName('');
    setNewUrl('');
  };

  if (!client) return null;
  return (
    <Card>
      <View style={styles.rowBetween}>
        <SectionTitle icon="cloud-download-outline" label="Hub filter sources" style={{ marginBottom: 0 }} />
        {list ? <Pill label={`${list.length} lists`} tone="muted" /> : null}
      </View>
      <Text style={styles.meta}>
        The blocklists this hub compiles into every device\u2019s rules. Toggle or add a list, then save — the hub recompiles and the next sync picks it up.
      </Text>
      {sources.error ? (
        <Text style={styles.syncErrorDetail}>
          {describeError(sources.error).title} — this server may not support source editing
        </Text>
      ) : null}
      {(list ?? []).map((s, i) => (
        <View key={`${s.name}-${i}`} style={styles.rowBetween}>
          <View style={{ flex: 1, marginRight: 8 }}>
            <Text style={styles.meta} numberOfLines={1}>{s.name}</Text>
            <Text style={styles.feedUrl} numberOfLines={1}>{s.url}</Text>
          </View>
          <Switch
            value={s.enabled}
            onValueChange={(v) => setDraft((list ?? []).map((x, j) => (j === i ? { ...x, enabled: v } : x)))}
            thumbColor={s.enabled ? colors.accent : colors.textMuted}
          />
          <ActionButton
            label="Remove"
            tone="ghost"
            onPress={() => setDraft((list ?? []).filter((_, j) => j !== i))}
          />
        </View>
      ))}
      <TextInput
        style={styles.input}
        placeholder="List name (optional)"
        placeholderTextColor={colors.textMuted}
        value={newName}
        onChangeText={setNewName}
      />
      <TextInput
        style={styles.input}
        placeholder="https://example.com/blocklist.txt"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={newUrl}
        onChangeText={setNewUrl}
      />
      <View style={styles.buttonRow}>
        <View style={styles.buttonFlex}>
          <ActionButton label="Add list" onPress={addSource} disabled={!newUrl.trim()} />
        </View>
      </View>
      <SectionTitle icon="create-outline" label="Custom rules" />
      <TextInput
        style={[styles.input, { minHeight: 80 }]}
        placeholder={'||bad-domain.example^\n@@||allowed.example^'}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        value={customText}
        onChangeText={setCustomDraft}
      />
      <View style={styles.buttonRow}>
        <View style={styles.buttonFlex}>
          <ActionButton
            label={busy ? 'Saving…' : 'Save & recompile'}
            tone="primary"
            loading={busy}
            onPress={saveAndCompile}
          />
        </View>
      </View>
      {result ? <Text style={styles.meta}>{result}</Text> : null}
      {err ? (
        <>
          <Text style={styles.syncError}>{err.title}</Text>
          {err.detail ? <Text style={styles.syncErrorDetail}>{err.detail}</Text> : null}
        </>
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

  const status = useQuery({
    queryKey: ['status', activeServer?.baseUrl ?? 'none'],
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
      { text: 'Remove', style: 'destructive', onPress: () => void removeServer(id) },
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
                <View style={styles.buttonRow}>
                  <View style={styles.buttonFlex}>
                    <ActionButton
                      label="Save"
                      disabled={!editUrl.trim()}
                      onPress={() => {
                        void updateServer(s.id, {
                          label: editLabel.trim() || s.label,
                          baseUrl: editUrl.trim(),
                        });
                        setEditingId(null);
                      }}
                    />
                  </View>
                  <View style={styles.buttonFlex}>
                    <ActionButton
                      label="Cancel"
                      tone="ghost"
                      onPress={() => setEditingId(null)}
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
                  onPress={() => void setActive(s.id)}
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


      <FilterFeedsCard />
      {client ? <HubSourcesCard /> : null}
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
