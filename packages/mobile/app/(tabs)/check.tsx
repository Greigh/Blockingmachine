/**
 * Domain check: GET /v1/check?domain= — verdict card with the covering rule (hub)
 * or matched host (add-on), whichever the server answered with.
 */

import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { useClient } from '../../src/api/useClient';
import type { CheckResult } from '../../src/api/types';
import { ActionButton, Card, Pill } from '../../src/components/ui';
import { colors, spacing } from '../../src/theme';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export default function CheckScreen() {
  const client = useClient();
  const [domain, setDomain] = useState('');
  const trimmed = domain.trim().toLowerCase();
  const valid = DOMAIN_RE.test(trimmed) && trimmed.length <= 253;

  const check = useMutation({
    mutationFn: (d: string) => client!.checkDomain(d),
  });

  const result: CheckResult | undefined = check.data;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
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
          onSubmitEditing={() => valid && client && check.mutate(trimmed)}
          returnKeyType="search"
        />
        <ActionButton
          label={check.isPending ? 'Checking…' : 'Check'}
          onPress={() => check.mutate(trimmed)}
          disabled={!valid || !client}
          loading={check.isPending}
        />
        {!valid && trimmed.length > 0 ? (
          <Text style={styles.hint}>Enter a bare domain (no scheme, no path).</Text>
        ) : null}
      </Card>

      {result ? (
        <Card>
          <View style={styles.verdictRow}>
            <Pill
              label={result.blocked ? 'BLOCKED' : 'NOT BLOCKED'}
              tone={result.blocked ? 'bad' : 'ok'}
            />
            {result.verdict ? <Pill label={result.verdict} tone="muted" /> : null}
          </View>
          <Text style={styles.domain}>{result.domain}</Text>
          {result.coveringRule ? (
            <Text style={styles.detail}>Covering rule: {result.coveringRule}</Text>
          ) : null}
          {result.matchedHost ? (
            <Text style={styles.detail}>Matched host: {result.matchedHost}</Text>
          ) : null}
          {result.source ? (
            <Text style={styles.detail}>Feed: {result.source}</Text>
          ) : null}
        </Card>
      ) : null}

      {check.error ? (
        <Card>
          <Text style={styles.errorText}>Check failed: {check.error.message}</Text>
        </Card>
      ) : null}

      {!client ? (
        <Card>
          <Text style={styles.detail}>Add a server in Settings first.</Text>
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
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.cardBorder,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
  },
  hint: { color: colors.warn, fontSize: 12, marginTop: spacing.sm },
  verdictRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  domain: { color: colors.text, fontSize: 17, fontWeight: '600', marginBottom: spacing.xs },
  detail: { color: colors.textMuted, fontSize: 13, marginTop: spacing.xs },
  errorText: { color: colors.danger, fontSize: 13 },
});
