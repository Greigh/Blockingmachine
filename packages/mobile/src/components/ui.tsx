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
import { LinearGradient } from 'expo-linear-gradient';
import { haptics } from '../haptics';
import { colors, glass, spacing } from '../theme';

export function Card(props: { children: React.ReactNode; style?: object }) {
  return <View style={[styles.card, props.style]}>{props.children}</View>;
}

/** Card header — leading accent icon + bold label. `style` overrides the bottom gap. */
export function SectionTitle(props: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color?: string;
  style?: object;
}) {
  return (
    <View style={[styles.sectionTitle, props.style]}>
      <Ionicons name={props.icon} size={16} color={props.color ?? colors.accent} />
      <Text style={styles.sectionTitleText}>{props.label}</Text>
    </View>
  );
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
      {tone === 'primary' && !disabled ? (
        <LinearGradient
          colors={[colors.accent, colors.accentDim]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.buttonGradient}
        >
          {props.loading ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={styles.buttonText}>{props.label}</Text>
          )}
        </LinearGradient>
      ) : props.loading ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <Text style={styles.buttonText}>{props.label}</Text>
      )}
    </Pressable>
  );
}

export function ErrorBanner(props: { title: string; detail?: string; onRetry?: () => void }) {
  return (
    <View style={styles.errorBanner}>
      <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
      <View style={styles.errorBody}>
        <Text style={styles.errorText}>{props.title}</Text>
        {props.detail ? <Text style={styles.errorDetail}>{props.detail}</Text> : null}
      </View>
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
    backgroundColor: glass.surface,
    borderColor: glass.border,
    borderTopColor: glass.borderTop,
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  sectionTitle: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginBottom: spacing.sm,
  },
  sectionTitleText: { color: colors.text, fontSize: 16, fontWeight: '700' },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: glass.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  pill_ok: { backgroundColor: 'rgba(63,185,80,0.18)' },
  pill_warn: { backgroundColor: 'rgba(210,153,34,0.18)' },
  pill_bad: { backgroundColor: 'rgba(248,81,73,0.18)' },
  pill_info: { backgroundColor: 'rgba(88,166,255,0.18)' },
  pill_muted: { backgroundColor: 'rgba(139,148,158,0.18)' },
  pillText: { fontSize: 12, fontWeight: '600' },
  pillText_ok: { color: colors.accent },
  pillText_warn: { color: colors.warn },
  pillText_bad: { color: colors.danger },
  pillText_info: { color: colors.info },
  pillText_muted: { color: colors.textMuted },
  button: {
    alignItems: 'center',
    borderRadius: 14,
    justifyContent: 'center',
    minHeight: 44,
    overflow: 'hidden',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  button_primary: { backgroundColor: colors.accentDim },
  button_danger: {
    backgroundColor: 'rgba(248,81,73,0.14)',
    borderColor: 'rgba(248,81,73,0.35)',
    borderTopColor: 'rgba(248,81,73,0.5)',
    borderWidth: 1,
  },
  button_ghost: {
    backgroundColor: glass.surface,
    borderColor: glass.border,
    borderTopColor: glass.borderTop,
    borderWidth: 1,
  },
  buttonGradient: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    paddingHorizontal: spacing.md,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  errorBanner: {
    alignItems: 'center',
    backgroundColor: 'rgba(248,81,73,0.12)',
    borderColor: 'rgba(248,81,73,0.4)',
    borderTopColor: 'rgba(248,81,73,0.55)',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  skeleton: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 6,
  },
  errorBody: { flex: 1 },
  errorDetail: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  errorRetry: { color: colors.info, fontWeight: '600', marginLeft: spacing.md },
  errorText: { color: colors.text },
});
