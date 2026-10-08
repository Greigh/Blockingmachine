/**
 * Domain check: GET /v1/check?domain= — verdict card with the covering rule (hub)
 * or matched host (add-on), whichever the server answered with.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError } from '../../src/api/client';
import { useClient } from '../../src/api/useClient';
import { useFilter } from '../../src/state/filter';
import type { CheckResult } from '../../src/api/types';
import { ActionButton, Card, Pill, SectionTitle } from '../../src/components/ui';
import { GlassBackdrop } from '../../src/components/GlassBackdrop';
import { relativeTime } from '../../src/format';
import { haptics } from '../../src/haptics';
import { chrome, colors, glass, spacing } from '../../src/theme';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

interface HistoryEntry {
  domain: string;
  blocked: boolean;
  at: number;
}

export default function CheckScreen() {
  const client = useClient();
  const filter = useFilter();
  const insets = useSafeAreaInsets();
  const [domain, setDomain] = useState('');
  // Session-scoped scratchpad — deduped by domain, newest first, capped at 10.
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const trimmed = domain.trim().toLowerCase();
  const valid = DOMAIN_RE.test(trimmed) && trimmed.length <= 253;

  const check = useMutation({
    // Hub verdict when it's reachable — richer (verdict source, matched host).
    // When the hub is unreachable (or none is configured) a synced ruleset
    // answers on-device with the same evaluator the hub uses.
    mutationFn: async (d: string): Promise<CheckResult> => {
      if (client) {
        try {
          return await client.checkDomain(d);
        } catch (err) {
          if (!(err instanceof ApiError && err.kind === 'unreachable')) throw err;
          const local = await filter.evaluate(d);
          if (local) return { ...local, source: 'on-device ruleset' };
          throw err;
        }
      }
      const local = await filter.evaluate(d);
      if (local) return { ...local, source: 'on-device ruleset' };
      throw new Error('No server connected and no on-device ruleset — sync one in Settings.');
    },
    onSuccess: (res, d) => {
      haptics.success();
      const name = res.domain || d;
      setHistory((prev) =>
        [{ domain: name, blocked: res.blocked, at: Date.now() }, ...prev.filter((h) => h.domain !== name)].slice(0, 10),
      );
    },
    onError: () => haptics.error(),
  });

  const runCheck = (d: string) => {
    setDomain(d);
    check.mutate(d);
  };

  const result: CheckResult | undefined = check.data;

  return (
    <View style={styles.screen}>
      <GlassBackdrop />
      <ScrollView
        style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg, paddingBottom: spacing.xl + insets.bottom + chrome.tabBarClearance }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Check a domain</Text>
      <Text style={styles.subtitle}>
        Ask the server whether a domain is covered by the compiled rules.
      </Text>

      <Card>
        <TextInput
          style={styles.input}
          placeholder="example.com"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          value={domain}
          onChangeText={setDomain}
          onSubmitEditing={() => valid && client && runCheck(trimmed)}
          returnKeyType="search"
        />
        <ActionButton
          label={check.isPending ? 'Checking…' : 'Check'}
          onPress={() => runCheck(trimmed)}
          disabled={!valid || (!client && !filter.ready)}
          loading={check.isPending}
        />
        {!valid && trimmed.length > 0 ? (
          <Text style={styles.hint}>Enter a bare domain (no scheme, no path).</Text>
        ) : null}
      </Card>

      {result ? (
        <Card style={result.blocked ? styles.verdictBlocked : styles.verdictAllowed}>
          <View style={styles.verdictHero}>
            <View
              style={[
                styles.verdictIcon,
                result.blocked ? styles.verdictIconBlocked : styles.verdictIconAllowed,
              ]}
            >
              <Ionicons
                name={result.blocked ? 'ban-outline' : 'shield-checkmark-outline'}
                size={30}
                color={result.blocked ? colors.danger : colors.accent}
              />
            </View>
            <Text
              style={[styles.verdictText, { color: result.blocked ? colors.danger : colors.accent }]}
            >
              {result.blocked ? 'Blocked' : 'Allowed'}
            </Text>
            <Text style={styles.domain}>{result.domain}</Text>
            {result.verdict || result.source ? (
              <View style={styles.verdictRow}>
                {result.verdict ? <Pill label={result.verdict} tone="muted" /> : null}
                {result.source ? <Pill label={result.source} tone="info" /> : null}
              </View>
            ) : null}
            {result.coveringRule ? (
              <Text style={styles.detail}>Covering rule: {result.coveringRule}</Text>
            ) : null}
            {result.matchedHost ? (
              <Text style={styles.detail}>Matched host: {result.matchedHost}</Text>
            ) : null}
          </View>
        </Card>
      ) : null}

      {check.error ? (
        <Card>
          <Text style={styles.errorText}>Check failed: {check.error.message}</Text>
        </Card>
      ) : null}

      {history.length > 0 ? (
        <Card>
          <SectionTitle icon="time-outline" label="Recent checks" />
          {history.map((h) => (
            <ReanimatedSwipeable
              key={h.domain}
              friction={2}
              rightThreshold={40}
              renderRightActions={() => (
                <Pressable
                  style={styles.swipeDelete}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${h.domain}`}
                  onPress={() =>
                    setHistory((prev) => prev.filter((e) => e.domain !== h.domain))
                  }
                >
                  <Ionicons name="trash-outline" size={18} color={colors.text} />
                </Pressable>
              )}
            >
              <Pressable
                style={styles.historyRow}
                android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
                onPress={() => client && runCheck(h.domain)}
                accessibilityRole="button"
              >
                <Pill
                  label={h.blocked ? 'BLOCKED' : 'allowed'}
                  tone={h.blocked ? 'bad' : 'ok'}
                />
                <Text style={styles.historyDomain}>{h.domain}</Text>
                <Text style={styles.historyTime}>{relativeTime(h.at)}</Text>
              </Pressable>
            </ReanimatedSwipeable>
          ))}
        </Card>
      ) : null}

      {!client ? (
        <Card>
          <Text style={styles.detail}>
            {filter.ready
              ? `Checking on-device — ${filter.meta?.ruleCount.toLocaleString()} rules synced locally.`
              : 'Add a server in Settings, or sync an on-device ruleset.'}
          </Text>
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
  title: { color: colors.text, fontSize: 28, fontWeight: '800' },
  subtitle: { color: colors.textMuted, fontSize: 13, marginBottom: spacing.md, marginTop: 2 },
  input: {
    backgroundColor: glass.surface,
    borderColor: glass.border,
    borderTopColor: glass.borderTop,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
  },
  hint: { color: colors.warn, fontSize: 12, marginTop: spacing.sm },
  verdictBlocked: {
    backgroundColor: 'rgba(248,81,73,0.10)',
    borderColor: 'rgba(248,81,73,0.35)',
    borderTopColor: 'rgba(248,81,73,0.5)',
  },
  verdictAllowed: {
    backgroundColor: 'rgba(63,185,80,0.10)',
    borderColor: 'rgba(63,185,80,0.35)',
    borderTopColor: 'rgba(63,185,80,0.5)',
  },
  verdictHero: { alignItems: 'center', paddingVertical: spacing.sm },
  verdictIcon: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    height: 60,
    justifyContent: 'center',
    marginBottom: spacing.sm,
    width: 60,
  },
  verdictIconBlocked: {
    backgroundColor: 'rgba(248,81,73,0.15)',
    borderColor: 'rgba(248,81,73,0.4)',
  },
  verdictIconAllowed: {
    backgroundColor: 'rgba(63,185,80,0.15)',
    borderColor: 'rgba(63,185,80,0.4)',
  },
  verdictText: { fontSize: 24, fontWeight: '800' },
  verdictRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  domain: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '600',
    marginTop: spacing.xs,
    textAlign: 'center',
  },
  detail: { color: colors.textMuted, fontSize: 13, marginTop: spacing.xs },
  errorText: { color: colors.danger, fontSize: 13 },
  historyRow: {
    alignItems: 'center',
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
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  historyDomain: { color: colors.text, flex: 1, fontSize: 14 },
  historyTime: { color: colors.textMuted, fontSize: 12 },
});
