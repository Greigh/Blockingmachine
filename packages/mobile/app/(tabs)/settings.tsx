/**
 * Settings: saved server list (add/select/remove), token editor for the active
 * server, and the feed URLs the server advertises. mDNS-derived servers show the
 * service name so a household with both a hub and an add-on stays legible.
 */

import React, { useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useClient } from '../../src/api/useClient';
import { useServers } from '../../src/state/servers';
import { ActionButton, Card, Pill } from '../../src/components/ui';
import { relativeTime } from '../../src/format';
import { colors, spacing } from '../../src/theme';

const ORIGIN_LABEL: Record<string, string> = {
  manual: 'manual',
  qr: 'paired via QR',
  mdns: 'discovered',
};

function formatSeen(iso: string): string {
  const rel = relativeTime(iso);
  return rel ? ` · seen ${rel}` : '';
}

export default function SettingsScreen() {
  const { servers, activeServerId, activeToken, setActive, removeServer, setToken } =
    useServers();
  const client = useClient();
  const [tokenDraft, setTokenDraft] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ['status', servers.find((s) => s.id === activeServerId)?.baseUrl ?? 'none'],
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>

      <Card>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>Servers</Text>
          <TouchableOpacity
            onPress={() => router.push('/add-server')}
            accessibilityRole="button"
          >
            <Text style={styles.link}>Add</Text>
          </TouchableOpacity>
        </View>
        {servers.length === 0 ? (
          <Text style={styles.meta}>No servers yet — add one to get started.</Text>
        ) : (
          servers.map((s) => (
            <View key={s.id} style={styles.serverRow}>
              <TouchableOpacity
                style={{ flex: 1 }}
                onPress={() => void setActive(s.id)}
                accessibilityRole="button"
              >
                <View style={styles.serverTitleRow}>
                  <Text style={styles.serverLabel}>{s.label || s.baseUrl}</Text>
                  {s.id === activeServerId ? <Pill label="active" tone="ok" /> : null}
                </View>
                <Text style={styles.meta}>
                  {s.baseUrl} · {ORIGIN_LABEL[s.origin] ?? s.origin}
                  {s.lastOkAt ? formatSeen(s.lastOkAt) : ''}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => confirmRemove(s.id, s.label || s.baseUrl)}
                accessibilityRole="button"
                hitSlop={8}
              >
                <Ionicons name="trash-outline" size={18} color={colors.danger} />
              </TouchableOpacity>
            </View>
          ))
        )}
      </Card>

      {activeServerId ? (
        <Card>
          <Text style={styles.sectionTitle}>Feed token</Text>
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
          <Text style={styles.sectionTitle}>Feed URLs</Text>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  title: { color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: spacing.md },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  rowBetween: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  link: { color: colors.info, fontSize: 15, fontWeight: '600' },
  serverRow: {
    alignItems: 'center',
    borderTopColor: colors.cardBorder,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  serverTitleRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  serverLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.cardBorder,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.text,
    fontSize: 15,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  buttonFlex: { flex: 1 },
  feedRow: { borderTopColor: colors.cardBorder, borderTopWidth: 1, paddingVertical: spacing.sm },
  feedLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  feedUrl: { color: colors.info, fontSize: 12, marginTop: 2 },
});
