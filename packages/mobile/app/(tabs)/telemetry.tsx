/**
 * Telemetry: /v1/telemetry — quarantined threats (hub), recent compiles, browser
 * telemetry aggregate. The add-on serves a thinner payload; missing sections hide.
 */

import React, { useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClient } from '../../src/api/useClient';
import { useServerEvents, type ServerEventAlert } from '../../src/hooks/useEvents';
import { useServers } from '../../src/state/servers';
import { Card, ErrorBanner, Pill, Skeleton } from '../../src/components/ui';
import { GlassBackdrop } from '../../src/components/GlassBackdrop';
import { formatTimestamp, relativeTime } from '../../src/format';
import { chrome, colors, glass, spacing } from '../../src/theme';

const RISK_TONES: Record<string, 'bad' | 'warn' | 'info' | 'muted'> = {
  critical: 'bad',
  high: 'bad',
  medium: 'warn',
  low: 'info',
};

/** Human label for a hub broadcast in the activity feed. Unknown names pass through. */
function describeEvent(e: ServerEventAlert): string {
  if (e.event === 'connected') return 'Connected to live feed';
  if (e.event === 'compile_completed') return 'Compile finished';
  if (e.event === 'rules_updated') return 'Rules updated';
  if (e.event === 'quarantine_added') {
    const n = typeof e.data.count === 'number' ? e.data.count : null;
    return n === null
      ? 'Threats quarantined'
      : `${n} threat${n === 1 ? '' : 's'} quarantined`;
  }
  if (e.event === 'protection_changed') return 'Protection toggled';
  if (e.event === 'remote_control') {
    const action = typeof e.data.action === 'string' ? e.data.action.replace(/_/g, ' ') : 'action';
    return `Remote control: ${action}`;
  }
  return e.event;
}

export default function TelemetryScreen() {
  const client = useClient();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const { activeServer } = useServers();
  const { alert, recent, dismissAlert } = useServerEvents();
  const baseUrl = activeServer?.baseUrl ?? 'none';

  // Leaving the tab acknowledges the quarantine alert — clears the tab badge
  // and stops the "new" pills. The banner's ✕ is the other dismissal path.
  const focused = useIsFocused();
  const wasFocused = useRef(false);
  useEffect(() => {
    if (wasFocused.current && !focused && alert?.event === 'quarantine_added') {
      dismissAlert();
    }
    wasFocused.current = focused;
  }, [focused, alert, dismissAlert]);

  // Domains carried by the latest quarantine_added broadcast get a "new" pill
  // until the alert is dismissed — the screen the dashboard banner routes to.
  const newDomains = new Set(
    alert?.event === 'quarantine_added' && Array.isArray(alert.data.domains)
      ? alert.data.domains.filter((d): d is string => typeof d === 'string')
      : [],
  );

  const telemetry = useQuery({
    queryKey: ['telemetry', baseUrl],
    queryFn: () => client!.getTelemetry(),
    enabled: !!client,
    refetchInterval: 30_000,
  });

  const data = telemetry.data;

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await telemetry.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <View style={styles.screen}>
      <GlassBackdrop />
      <ScrollView
        style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingBottom: spacing.xl + insets.bottom + chrome.tabBarClearance }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          tintColor={colors.textMuted}
          colors={[colors.accent]}
          progressBackgroundColor={'rgba(255,255,255,0.12)'}
        />
      }
    >
      <Text style={styles.title}>Telemetry</Text>
      <Text style={styles.subtitle}>
        Threat quarantine, compile history, and browser-reported counters.
      </Text>

      {telemetry.error ? (
        <ErrorBanner
          message={`Can't load telemetry: ${telemetry.error.message}`}
          onRetry={() => void telemetry.refetch()}
        />
      ) : null}

      {!client ? (
        <Card>
          <Text style={styles.meta}>Add a server in Settings first.</Text>
        </Card>
      ) : null}

      {telemetry.isLoading && !data ? (
        <>
          <Card>
            <Skeleton width="52%" height={20} />
            {[0, 1, 2].map((i) => (
              <View key={i} style={styles.threatRow}>
                <View style={{ flex: 1 }}>
                  <Skeleton width="60%" height={16} />
                  <Skeleton width="80%" height={12} style={{ marginTop: spacing.xs }} />
                </View>
                <Skeleton width={52} height={24} />
              </View>
            ))}
          </Card>
          <Card>
            <Skeleton width="44%" height={20} />
            {[0, 1].map((i) => (
              <View key={i} style={styles.historyRow}>
                <Skeleton width="50%" height={14} />
                <Skeleton width="70%" height={12} style={{ marginTop: spacing.xs }} />
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {recent.length > 0 ? (
        <Card>
          <Text style={styles.sectionTitle}>Activity</Text>
          {recent.slice(0, 15).map((e, i) => (
            <View key={`${e.at}-${i}`} style={styles.historyRow}>
              <Text style={styles.historyDate}>{describeEvent(e)}</Text>
              <Text style={styles.meta}>{relativeTime(e.at)}</Text>
            </View>
          ))}
        </Card>
      ) : null}

      {data?.threats && data.threats.length > 0 ? (
        <Card>
          <Text style={styles.sectionTitle}>Quarantined threats</Text>
          {data.threats.map((t) => (
            <View key={t.id} style={styles.threatRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.threatDomain}>{t.domain}</Text>
                <Text style={styles.meta}>
                  {t.category} · {t.source} · {Math.round(t.confidence * 100)}% ·{' '}
                  {formatTimestamp(t.timestamp)}
                </Text>
              </View>
              <View style={styles.threatPills}>
                {newDomains.has(t.domain) ? <Pill label="new" tone="info" /> : null}
                <Pill
                  label={t.riskLevel}
                  tone={RISK_TONES[t.riskLevel] ?? 'muted'}
                />
              </View>
            </View>
          ))}
        </Card>
      ) : null}

      {data?.history && data.history.length > 0 ? (
        <Card>
          <Text style={styles.sectionTitle}>Recent compiles</Text>
          {data.history.map((h, i) => (
            <View key={`${h.timestamp}-${i}`} style={styles.historyRow}>
              <Text style={styles.historyDate}>{formatTimestamp(h.timestamp)}</Text>
              <Text style={styles.meta}>
                {h.uniqueRuleCount.toLocaleString()} unique ·{' '}
                {h.duplicatesRemoved.toLocaleString()} dupes
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      {data?.browser ? (
        <Card>
          <Text style={styles.sectionTitle}>Browser telemetry</Text>
          <Text style={styles.meta}>
            {data.browser.trackersBlocked.toLocaleString()} trackers blocked ·{' '}
            {data.browser.elementsHidden.toLocaleString()} elements hidden ·{' '}
            {data.browser.threatsDetected.toLocaleString()} threats detected
          </Text>
          {data.browser.recentTrackers && data.browser.recentTrackers.length > 0 ? (
            <View style={{ marginTop: spacing.sm }}>
              {data.browser.recentTrackers.slice(0, 10).map((t) => (
                <View key={t.domain} style={styles.trackerRow}>
                  <Text style={styles.trackerDomain}>{t.domain}</Text>
                  <Text style={styles.meta}>×{t.count}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </Card>
      ) : null}

      {data && !data.threats?.length && !data.history?.length && !data.browser ? (
        <Card>
          <Text style={styles.meta}>No telemetry reported yet.</Text>
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
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 13, marginBottom: spacing.md, marginTop: 2 },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: spacing.sm },
  threatRow: {
    alignItems: 'center',
    borderTopColor: glass.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    paddingVertical: spacing.sm,
  },
  threatDomain: { color: colors.text, fontSize: 15, fontWeight: '600' },
  threatPills: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  historyRow: {
    borderTopColor: glass.border,
    borderTopWidth: 1,
    paddingVertical: spacing.sm,
  },
  historyDate: { color: colors.text, fontSize: 14 },
  trackerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  trackerDomain: { color: colors.textMuted, fontSize: 13 },
  meta: {
    color: colors.textMuted,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    marginTop: 2,
  },
});
