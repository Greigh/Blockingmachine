/**
 * Rules tab — the corpus workspace: the standalone feeds merged into the
 * on-device ruleset and the hub's filter sources + custom rules. These cards
 * moved out of the old Settings scroll unchanged; only their home changed.
 */

import React, { useState } from 'react';
import {
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFilter } from '../../src/state/filter';
import {
  readFeeds,
  saveFeeds,
  type FilterFeed,
} from '../../src/filter/feeds';
import type { HubFilterSource } from '../../src/api/types';
import { styles } from '../../src/components/screenStyles';
import { ActionButton, Card, Grid, Pill, SectionTitle } from '../../src/components/ui';
import { describeError, type FriendlyError } from '../../src/errors';
import { GlassBackdrop } from '../../src/components/GlassBackdrop';
import { gridColumnsFor, hasEdgeUtilityStrip, useWidthTier } from '../../src/hooks/useWidthTier';
import { chrome, colors, layout, spacing } from '../../src/theme';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { useClient } from '../../src/api/useClient';

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

export default function RulesScreen() {
  const insets = useSafeAreaInsets();
  const tier = useWidthTier();
  const gridCols = gridColumnsFor(tier);
  const client = useClient();
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
          title="Rules"
          subtitle="The filter corpus — sources, feeds, and custom rules."
        />
        <Grid columns={gridCols}>
          <FilterFeedsCard />
          {client ? <HubSourcesCard /> : null}
        </Grid>
      </ScrollView>
    </View>
  );
}
