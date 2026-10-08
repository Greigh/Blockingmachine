/**
 * Dashboard: /v1/status on a poll, protection toggle, compile + control actions.
 * This is the screen you open to answer "is my blocking up" and to flip it.
 */

import React, { useEffect } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError } from '../../src/api/client';
import { useClient } from '../../src/api/useClient';
import { useServerEvents } from '../../src/hooks/useEvents';
import { useServers } from '../../src/state/servers';
import { useFilter } from '../../src/state/filter';
import { ActionButton, Card, ErrorBanner, Pill, SectionTitle, Skeleton } from '../../src/components/ui';
import { GlassBackdrop } from '../../src/components/GlassBackdrop';
import { formatTimestamp, formatUptime } from '../../src/format';
import { haptics } from '../../src/haptics';
import { chrome, colors, spacing } from '../../src/theme';

// The hub stamps lastCompile with toLocaleString() (unparseable on Hermes) while
// the add-on carries lastCompileMs — prefer the epoch, fall back to the raw
// string since it's already human-readable in the hub's own locale.
function formatLastCompile(data?: { lastCompile: string | null; lastCompileMs?: number }): string {
  if (!data) return '—';
  if (data.lastCompile) return formatTimestamp(data.lastCompile);
  // Add-on sends lastCompileMs as a *duration* (compile took N ms) — only treat
  // it as a timestamp when it's plausibly epoch-millis (> ~2001).
  if (typeof data.lastCompileMs === 'number' && data.lastCompileMs > 1e12) {
    return new Date(data.lastCompileMs).toLocaleString();
  }
  return '—';
}

export default function DashboardScreen() {
  const client = useClient();
  const insets = useSafeAreaInsets();
  const { connected, alert, dismissAlert } = useServerEvents();
  const { activeServer, markOk } = useServers();
  const filter = useFilter();
  const queryClient = useQueryClient();
  const baseUrl = activeServer?.baseUrl ?? 'none';

  const status = useQuery({
    queryKey: ['status', baseUrl],
    queryFn: () => client!.getStatus(),
    enabled: !!client,
    refetchInterval: 15_000,
  });

  // Successful polls are the "last seen" heartbeat shown beside each server in
  // Settings — markOk itself throttles the storage write.
  useEffect(() => {
    if (status.isSuccess && activeServer) void markOk(activeServer.id);
  }, [status.isSuccess, status.dataUpdatedAt, activeServer, markOk]);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['status', baseUrl] }),
      queryClient.invalidateQueries({ queryKey: ['protection', baseUrl] }),
    ]);

  const protection = useMutation({
    mutationFn: (enabled: boolean) => client!.setProtection(enabled),
    onSuccess: () => haptics.success(),
    onError: () => haptics.error(),
    onSettled: invalidate,
  });

  const compile = useMutation({
    mutationFn: () => client!.compile(),
    onSettled: invalidate,
  });

  const cosmetics = useMutation({
    mutationFn: (enabled: boolean) => client!.setCosmetics(enabled),
  });

  const reload = useMutation({
    mutationFn: () => client!.reloadBrowsers(),
  });

  const daemon = useMutation({
    mutationFn: (action: 'start' | 'stop') => client!.controlDaemon(action),
    onSuccess: () => haptics.success(),
    onError: () => haptics.error(),
    onSettled: invalidate,
  });

  // Mutation results describe the server they ran against — drop them when the
  // active server changes or one hub's "Compiled" banner leaks onto another's.
  useEffect(() => {
    protection.reset();
    compile.reset();
    cosmetics.reset();
    reload.reset();
    daemon.reset();
  }, [baseUrl]);

  if (!activeServer) {
    return (
      <View style={[styles.empty, { paddingTop: insets.top }]}>
        <GlassBackdrop />
        <Text style={styles.emptyTitle}>
          {filter.ready ? 'Standalone mode' : 'No server configured'}
        </Text>
        <Text style={styles.emptyText}>
          {filter.ready && filter.meta
            ? `${filter.meta.ruleCount.toLocaleString()} rules on this device — domain checks work without a hub. Pair with a hub for live telemetry and remote control.`
            : 'Pair with your Blockingmachine hub or Home Assistant add-on to get started.'}
        </Text>
        {filter.ready ? (
          <Pill label="on-device rules active" tone="ok" />
        ) : null}
        <ActionButton label="Add server" onPress={() => router.push('/add-server')} />
      </View>
    );
  }

  const data = status.data;
  const daemonStopped = data?.protection?.daemonStatus === 'stopped';
  // The HA add-on shares the /v1 surface but not the hub's control endpoints —
  // daemon control, cosmetics and browser reload are hub-only. When the server
  // identifies as the add-on, those buttons hide rather than silently 404.
  const isAddon = /add-?on/i.test(data?.service ?? '');
  const err = status.error as ApiError | null;

  const quarantineCount =
    alert?.event === 'quarantine_added' && typeof alert.data.count === 'number'
      ? alert.data.count
      : null;

  return (
    <View style={styles.screen}>
      <GlassBackdrop />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg, paddingBottom: spacing.xl + insets.bottom + chrome.tabBarClearance }]}
      refreshControl={
        <RefreshControl
          refreshing={status.isRefetching}
          onRefresh={() => void status.refetch()}
          tintColor={colors.textMuted}
        />
      }
    >
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{data?.service ?? 'Blockingmachine'}</Text>
          <Text style={styles.subtitle}>
            {activeServer.label || activeServer.baseUrl}
            {data?.version ? ` · v${data.version}` : ''}
          </Text>
        </View>
        <Pill
          label={connected ? 'live' : 'polling'}
          tone={connected ? 'ok' : 'muted'}
        />
      </View>

      {alert?.event === 'quarantine_added' ? (
        <Pressable
          style={({ pressed }) => [styles.alertBanner, pressed && { opacity: 0.85 }]}
          // Navigate without dismissing — the alert still drives the tab badge
          // and the "new" pills on the telemetry rows. It clears via ✕, or when
          // the user leaves the telemetry tab (viewed = acknowledged).
          onPress={() => router.push('/(tabs)/telemetry')}
        >
          <Text style={styles.alertText}>
            {quarantineCount
              ? `${quarantineCount} new threat${quarantineCount === 1 ? '' : 's'} quarantined`
              : 'New threats quarantined'}
            {' — review'}
          </Text>
          <Pressable
            onPress={dismissAlert}
            hitSlop={8}
            accessibilityLabel="Dismiss"
            accessibilityRole="button"
          >
            <Text style={styles.alertDismiss}>✕</Text>
          </Pressable>
        </Pressable>
      ) : null}

      {err ? (
        <ErrorBanner
          message={
            err.kind === 'unauthorized'
              ? 'Server requires a feed token — add it in Settings.'
              : err.kind === 'unreachable'
                ? `Can't reach server — check the hub's feed server is on (Settings → Pair Mobile App). ${err.message}`
                : `Can't reach server: ${err.message}`
          }
          onRetry={() => void status.refetch()}
        />
      ) : null}

      {status.isLoading && !data ? (
        <>
          <Card>
            <Skeleton width="42%" height={20} />
            <Skeleton height={16} style={{ marginTop: spacing.sm }} />
            <Skeleton height={16} width="70%" style={{ marginTop: spacing.sm }} />
          </Card>
          <Card>
            <Skeleton width="30%" height={20} />
            <View style={[styles.statRow, { marginTop: spacing.sm }]}>
              {[0, 1, 2, 3].map((i) => (
                <View key={i} style={styles.stat}>
                  <Skeleton width="75%" height={20} />
                  <Skeleton width="55%" height={12} style={{ marginTop: spacing.xs }} />
                </View>
              ))}
            </View>
          </Card>
        </>
      ) : (
        <>
      <Card>
        <View style={styles.rowBetween}>
          <SectionTitle icon="shield-checkmark-outline" label="Protection" />
          <Switch
            value={Boolean(data?.protection?.enabled)}
            disabled={protection.isPending || daemonStopped}
            onValueChange={(v) => {
              haptics.select();
              protection.mutate(v);
            }}
            trackColor={{ false: 'rgba(255,255,255,0.15)', true: colors.accentDim }}
            thumbColor={data?.protection?.enabled ? colors.accent : colors.textMuted}
            ios_backgroundColor={'rgba(255,255,255,0.15)'}
          />
        </View>
        <View style={styles.pillRow}>
          {daemonStopped ? (
            <Pill label="daemon stopped" tone="bad" />
          ) : (
            <Pill
              label={data?.protection?.enabled ? 'active' : 'paused'}
              tone={data?.protection?.enabled ? 'ok' : 'warn'}
            />
          )}
          {data?.protection?.daemonStatus ? (
            <Pill label={`daemon: ${data.protection.daemonStatus}`} tone="muted" />
          ) : null}
        </View>
        {daemonStopped ? (
          <View style={styles.buttonRow}>
            <View style={styles.buttonFlex}>
              <ActionButton
                label={daemon.isPending ? 'Starting…' : 'Start DNS daemon'}
                onPress={() => daemon.mutate('start')}
                loading={daemon.isPending}
                disabled={!client}
              />
            </View>
          </View>
        ) : null}
        {daemon.error ? (
          <Text style={styles.errorLine}>
            Daemon {daemon.variables === 'stop' ? 'stop' : 'start'} failed:{' '}
            {daemon.error.message}
          </Text>
        ) : null}
        {protection.error ? (
          <Text style={styles.errorLine}>
            {protection.error instanceof ApiError && protection.error.status === 503
              ? 'DNS daemon is not running — start it on the hub first.'
              : `Toggle failed: ${protection.error.message}`}
          </Text>
        ) : null}
      </Card>

      <Card>
        <SectionTitle icon="layers-outline" label="Rules" />
        <View style={styles.statRow}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{data?.rules?.total?.toLocaleString() ?? '—'}</Text>
            <Text style={styles.statLabel}>total</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{data?.rules?.dns?.toLocaleString() ?? '—'}</Text>
            <Text style={styles.statLabel}>dns</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{data?.rules?.browser?.toLocaleString() ?? '—'}</Text>
            <Text style={styles.statLabel}>browser</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.warn }]}>
              {data?.rules?.quarantinedThreats?.toLocaleString() ?? '—'}
            </Text>
            <Text style={styles.statLabel}>quarantined</Text>
          </View>
        </View>
        <Text style={styles.metaLine}>Last compile: {formatLastCompile(data)}</Text>
        <Text style={styles.metaLine}>
          Uptime: {data ? formatUptime(data.uptimeSeconds) : '—'}
          {typeof data?.activeSseClients === 'number'
            ? ` · ${data.activeSseClients} live client${data.activeSseClients === 1 ? '' : 's'}`
            : ''}
        </Text>
      </Card>
        </>
      )}

      <Card>
        <SectionTitle icon="flash-outline" label="Actions" />
        <View style={styles.buttonRow}>
          <View style={styles.buttonFlex}>
            <ActionButton
              label={compile.isPending ? 'Compiling…' : 'Compile now'}
              onPress={() => compile.mutate()}
              loading={compile.isPending}
              disabled={!client}
            />
          </View>
        </View>
        {!isAddon ? (
          <View style={styles.buttonRow}>
            <View style={styles.buttonFlex}>
              <ActionButton
                label="Reload browsers"
                tone="ghost"
                onPress={() => reload.mutate()}
                loading={reload.isPending}
              />
            </View>
            <View style={styles.buttonFlex}>
              <ActionButton
                label="Cosmetics off"
                tone="ghost"
                onPress={() => cosmetics.mutate(false)}
                loading={cosmetics.isPending}
              />
            </View>
          </View>
        ) : null}
        {compile.data ? (
          <Text style={styles.metaLine}>
            {compile.data.alreadyRunning
              ? 'Compile already in progress on the hub.'
              : compile.data.message ?? 'Compile triggered.'}
          </Text>
        ) : null}
        {reload.data?.success ? (
          <Text style={styles.metaLine}>Reload broadcast sent to browsers.</Text>
        ) : null}
        {reload.error ? (
          <Text style={styles.errorLine}>Browser reload failed: {reload.error.message}</Text>
        ) : null}
        {cosmetics.error ? (
          <Text style={styles.errorLine}>Cosmetics toggle failed: {cosmetics.error.message}</Text>
        ) : null}
        {compile.error ? (
          <Text style={styles.errorLine}>Compile failed: {compile.error.message}</Text>
        ) : null}
      </Card>

      {data?.aiRadar || data?.browserTelemetry ? (
        <Card>
          <SectionTitle icon="sparkles-outline" label="Insights" />
          {data.aiRadar ? (
            <View style={styles.pillRow}>
              <Pill
                label={`AI radar ${data.aiRadar.enabled ? 'on' : 'off'}`}
                tone={data.aiRadar.enabled ? 'info' : 'muted'}
              />
              {data.aiRadar.sessionActive ? <Pill label="live scan" tone="ok" /> : null}
            </View>
          ) : null}
          {data.browserTelemetry ? (
            <Text style={styles.metaLine}>
              Browsers: {data.browserTelemetry.trackersBlocked.toLocaleString()} trackers ·{' '}
              {data.browserTelemetry.elementsHidden.toLocaleString()} elements hidden ·{' '}
              {data.browserTelemetry.threatsDetected.toLocaleString()} threats
            </Text>
          ) : null}
        </Card>
      ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  scroll: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: spacing.md,
  },
  title: { color: colors.text, fontSize: 28, fontWeight: '800' },
  subtitle: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  empty: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  emptyText: { color: colors.textMuted, fontSize: 14, textAlign: 'center' },
  rowBetween: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  statRow: { flexDirection: 'row', marginBottom: spacing.sm },
  stat: { flex: 1 },
  statValue: {
    color: colors.text,
    fontSize: 22,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  statLabel: { color: colors.textMuted, fontSize: 12 },
  metaLine: { color: colors.textMuted, fontSize: 13, marginTop: spacing.xs },
  alertBanner: {
    alignItems: 'center',
    backgroundColor: 'rgba(210,153,34,0.14)',
    borderColor: 'rgba(210,153,34,0.45)',
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  alertText: { color: colors.warn, flex: 1, fontSize: 14, fontWeight: '600' },
  alertDismiss: { color: colors.textMuted, fontSize: 14, paddingLeft: spacing.sm },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  buttonFlex: { flex: 1 },
  errorLine: { color: colors.danger, fontSize: 13, marginTop: spacing.sm },
});
