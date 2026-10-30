/**
 * Shared large-title header for the five tab screens — title + optional
 * subtitle on the left, a settings gear on the trailing edge. The gear pushes
 * `SETTINGS_ROUTE` (settings is a stack route, not a tab). Screens render it
 * as the first element of their scroll content, preserving the
 * aurora-to-status-bar look (the stack header stays off on tabs).
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { colors, spacing } from '../theme';
import { SETTINGS_ROUTE } from '../routes';
import { haptics } from '../haptics';

export function ScreenHeader({
  title,
  subtitle,
  trailing,
}: {
  title: string;
  subtitle?: string;
  /** Optional accessory rendered between the text and the gear (e.g. a Pill). */
  trailing?: React.ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={() => {
          haptics.tap();
          router.push(SETTINGS_ROUTE);
        }}
        style={styles.gear}
        hitSlop={8}
      >
        <Ionicons name="settings-outline" size={24} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  text: { flex: 1 },
  title: { color: colors.text, fontSize: 28, fontWeight: '800' },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  gear: { padding: spacing.xs, marginTop: 4 },
  trailing: { marginTop: 6, marginRight: spacing.xs },
});
