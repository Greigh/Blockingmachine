/** Small shared UI primitives — card, status pill, action button, error banner. */

import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors, spacing } from '../theme';

export function Card(props: { children: React.ReactNode; style?: object }) {
  return <View style={[styles.card, props.style]}>{props.children}</View>;
}

export function Pill(props: { label: string; tone?: 'ok' | 'warn' | 'bad' | 'info' | 'muted' }) {
  const tone = props.tone ?? 'muted';
  return (
    <View style={[styles.pill, styles[`pill_${tone}` as const]]}>
      <Text style={[styles.pillText, styles[`pillText_${tone}` as const]]}>
        {props.label}
      </Text>
    </View>
  );
}

export function ActionButton(props: {
  label: string;
  onPress: () => void;
  tone?: 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
}) {
  const tone = props.tone ?? 'primary';
  const disabled = props.disabled || props.loading;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={disabled}
      onPress={props.onPress}
      style={[
        styles.button,
        styles[`button_${tone}` as const],
        disabled && styles.buttonDisabled,
      ]}
    >
      {props.loading ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <Text style={styles.buttonText}>{props.label}</Text>
      )}
    </TouchableOpacity>
  );
}

export function ErrorBanner(props: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.errorBanner}>
      <Text style={styles.errorText}>{props.message}</Text>
      {props.onRetry ? (
        <TouchableOpacity onPress={props.onRetry} accessibilityRole="button">
          <Text style={styles.errorRetry}>Retry</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  pill_ok: { backgroundColor: 'rgba(63,185,80,0.15)' },
  pill_warn: { backgroundColor: 'rgba(210,153,34,0.15)' },
  pill_bad: { backgroundColor: 'rgba(248,81,73,0.15)' },
  pill_info: { backgroundColor: 'rgba(88,166,255,0.15)' },
  pill_muted: { backgroundColor: 'rgba(139,148,158,0.15)' },
  pillText: { fontSize: 12, fontWeight: '600' },
  pillText_ok: { color: colors.accent },
  pillText_warn: { color: colors.warn },
  pillText_bad: { color: colors.danger },
  pillText_info: { color: colors.info },
  pillText_muted: { color: colors.textMuted },
  button: {
    alignItems: 'center',
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  button_primary: { backgroundColor: colors.accentDim },
  button_danger: { backgroundColor: 'rgba(248,81,73,0.2)' },
  button_ghost: {
    backgroundColor: 'transparent',
    borderColor: colors.cardBorder,
    borderWidth: 1,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  errorBanner: {
    alignItems: 'center',
    backgroundColor: 'rgba(248,81,73,0.12)',
    borderColor: colors.danger,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  errorRetry: { color: colors.info, fontWeight: '600', marginLeft: spacing.md },
  errorText: { color: colors.text, flex: 1 },
});
