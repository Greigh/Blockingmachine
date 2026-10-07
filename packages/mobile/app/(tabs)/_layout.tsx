import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { ColorValue } from 'react-native';
import { useServerEvents } from '../../src/hooks/useEvents';
import { colors } from '../../src/theme';

const icon =
  (name: keyof typeof Ionicons.glyphMap) =>
  ({ color, size }: { color: ColorValue; size: number }) =>
    <Ionicons name={name} color={color as string} size={size} />;

export default function TabsLayout() {
  const { alert } = useServerEvents();
  // New quarantines badge the Telemetry tab until the dashboard banner (or the
  // badge's implicit "I saw it") dismisses them — cross-tab signal, not just a
  // banner that only exists while Dashboard happens to be mounted.
  const quarantineBadge =
    alert?.event === 'quarantine_added' && typeof alert.data.count === 'number'
      ? alert.data.count
      : alert?.event === 'quarantine_added'
        ? '!'
        : undefined;
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.card },
        headerTintColor: colors.text,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.cardBorder },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Dashboard', tabBarIcon: icon('shield-half-outline') }}
      />
      <Tabs.Screen
        name="check"
        options={{ title: 'Check', tabBarIcon: icon('search-outline') }}
      />
      <Tabs.Screen
        name="telemetry"
        options={{
          title: 'Telemetry',
          tabBarIcon: icon('pulse-outline'),
          tabBarBadge: quarantineBadge,
          tabBarBadgeStyle: { backgroundColor: colors.warn, color: colors.bg },
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: 'Settings', tabBarIcon: icon('settings-outline') }}
      />
    </Tabs>
  );
}
