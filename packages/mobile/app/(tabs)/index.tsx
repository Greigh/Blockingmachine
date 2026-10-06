/**
 * Dashboard: /v1/status on a poll, protection toggle, compile + control actions.
 * This is the screen you open to answer "is my blocking up" and to flip it.
 */

import React from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ApiError } from '../../src/api/client';
import { useClient } from '../../src/api/useClient';
import { useServerEvents } from '../../src/hooks/useEvents';
import { useServers } from '../../src/state/servers';
import { ActionButton, Card, ErrorBanner, Pill } from '../../src/components/ui';
import { colors, spacing } from '../../src/theme';

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function DashboardScreen() {
  const client = useClient();
  const { connected } = useServerEvents();
  const { activeServer } = useServers();
  const queryClient = useQueryClient();
  const baseUrl = activeServer?.baseUrl ?? 'none';

  const status = useQuery({
    queryKey: ['status', baseUrl],
    queryFn: () => client!.getStatus(),
    enabled: !!client,
    refetchInterval: 15_000,
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['status', baseUrl] }),
      queryClient.invalidateQueries({ queryKey: ['protection', baseUrl] }),
    ]);

  const protection = useMutation({
    mutationFn: (enabled: boolean) => client!.setProtection(enabled),
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

  if (!activeServer) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No server configured</Text>
        <Text style={styles.emptyText}>
          Pair with your Blockingmachine hub or Home Assistant add-on to get started.
        </Text>
        <ActionButton label="Add server" onPress={() => router.push('/add-server')} />
      </View>
    );
  }

  const data = status.data;
  const daemonStopped = data?.protection?.daemonStatus === 'stopped';
  const err = status.error as ApiError | null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
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

      {err ? (
        <ErrorBanner
          message={
            err.kind === 'unauthorized'
              ? 'Server requires a feed token — add it in Settings.'
              : `Can't reach server: ${err.message}`
          }
          onRetry={() => void status.refetch()}
        />
      ) : null}

      <Card>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>Protection</Text>
          <Switch
            value={Boolean(data?.protection?.enabled)}
            disabled={protection.isPending}
            onValueChange={(v) => protection.mutate(v)}
            trackColor={{ true: colors.accentDim }}
            thumbColor={data?.protection?.enabled ? colors.accent : colors.textMuted}
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
        {protection.error ? (
          <Text style={styles.errorLine}>
            {protection.error instanceof ApiError && protection.error.status === 503
              ? 'DNS daemon is not running — start it on the hub first.'
              : `Toggle failed: ${protection.error.message}`}
          </Text>
        ) : null}
      </Card>

      <Card>
        <Text style={styles.sectionTitle}>Rules</Text>
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
        <Text style={styles.metaLine}>
          Last compile:{' '}
          {data?.lastCompile ? new Date(data.lastCompile).toLocaleString() : 'never'}
        </Text>
        <Text style={styles.metaLine}>
          Uptime: {data ? formatUptime(data.uptimeSeconds) : '—'}
          {typeof data?.activeSseClients === 'number'
            ? ` · ${data.activeSseClients} live client${data.activeSseClients === 1 ? '' : 's'}`
            : ''}
        </Text>
      </Card>

      <Card>
        <Text style={styles.sectionTitle}>Actions</Text>
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
      </Card>

      {data?.aiRadar || data?.browserTelemetry ? (
        <Card>
          <Text style={styles.sectionTitle}>Insights</Text>
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
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: spacing.md,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  empty: {
    alignItems: 'center',
    backgroundColor: colors.bg,
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
  sectionTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  statRow: { flexDirection: 'row', marginBottom: spacing.sm },
  stat: { flex: 1 },
  statValue: { color: colors.text, fontSize: 18, fontWeight: '700' },
  statLabel: { color: colors.textMuted, fontSize: 12 },
  metaLine: { color: colors.textMuted, fontSize: 13, marginTop: spacing.xs },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  buttonFlex: { flex: 1 },
  errorLine: { color: colors.danger, fontSize: 13, marginTop: spacing.sm },
});
