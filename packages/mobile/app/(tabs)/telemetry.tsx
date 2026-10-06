/**
 * Telemetry: /v1/telemetry — quarantined threats (hub), recent compiles, browser
 * telemetry aggregate. The add-on serves a thinner payload; missing sections hide.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useClient } from '../../src/api/useClient';
import { useServers } from '../../src/state/servers';
import { Card, ErrorBanner, Pill } from '../../src/components/ui';
import { colors, spacing } from '../../src/theme';

const RISK_TONES: Record<string, 'bad' | 'warn' | 'info' | 'muted'> = {
  critical: 'bad',
  high: 'bad',
  medium: 'warn',
  low: 'info',
};

export default function TelemetryScreen() {
  const client = useClient();
  const { activeServer } = useServers();
  const baseUrl = activeServer?.baseUrl ?? 'none';

  const telemetry = useQuery({
    queryKey: ['telemetry', baseUrl],
    queryFn: () => client!.getTelemetry(),
    enabled: !!client,
    refetchInterval: 30_000,
  });

  const data = telemetry.data;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
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

      {data?.threats && data.threats.length > 0 ? (
        <Card>
          <Text style={styles.sectionTitle}>Quarantined threats</Text>
          {data.threats.map((t) => (
            <View key={t.id} style={styles.threatRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.threatDomain}>{t.domain}</Text>
                <Text style={styles.meta}>
                  {t.category} · {t.source} · {Math.round(t.confidence * 100)}% ·{' '}
                  {new Date(t.timestamp).toLocaleDateString()}
                </Text>
              </View>
              <Pill
                label={t.riskLevel}
                tone={RISK_TONES[t.riskLevel] ?? 'muted'}
              />
            </View>
          ))}
        </Card>
      ) : null}

      {data?.history && data.history.length > 0 ? (
        <Card>
          <Text style={styles.sectionTitle}>Recent compiles</Text>
          {data.history.map((h, i) => (
            <View key={`${h.timestamp}-${i}`} style={styles.historyRow}>
              <Text style={styles.historyDate}>
                {new Date(h.timestamp).toLocaleString()}
              </Text>
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
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 13, marginBottom: spacing.md, marginTop: 2 },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: spacing.sm },
  threatRow: {
    alignItems: 'center',
    borderTopColor: colors.cardBorder,
    borderTopWidth: 1,
    flexDirection: 'row',
    paddingVertical: spacing.sm,
  },
  threatDomain: { color: colors.text, fontSize: 15, fontWeight: '600' },
  historyRow: {
    borderTopColor: colors.cardBorder,
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
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
});
