/** Small shared UI primitives — card, status pill, action button, error banner, skeleton. */

import React, { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { haptics } from '../haptics';
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
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      android_ripple={{ color: 'rgba(255,255,255,0.12)' }}
      onPress={() => {
        haptics.tap();
        props.onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        styles[`button_${tone}` as const],
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      {props.loading ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <Text style={styles.buttonText}>{props.label}</Text>
      )}
    </Pressable>
  );
}

export function ErrorBanner(props: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.errorBanner}>
      <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
      <Text style={styles.errorText}>{props.message}</Text>
      {props.onRetry ? (
        <Pressable onPress={props.onRetry} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.errorRetry}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Pulsing placeholder block for loading states — sized to the content it replaces. */
export function Skeleton(props: {
  width?: DimensionValue;
  height?: number;
  style?: object;
}) {
  const opacity = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.35, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View
      style={[
        styles.skeleton,
        { height: props.height ?? 14, width: props.width ?? '100%' },
        props.style,
        { opacity },
      ]}
    />
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
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  errorBanner: {
    alignItems: 'center',
    backgroundColor: 'rgba(248,81,73,0.12)',
    borderColor: colors.danger,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  skeleton: {
    backgroundColor: colors.cardBorder,
    borderRadius: 6,
  },
  errorRetry: { color: colors.info, fontWeight: '600', marginLeft: spacing.md },
  errorText: { color: colors.text, flex: 1 },
});
