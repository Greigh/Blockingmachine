import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useServerEvents } from '../../src/hooks/useEvents';
import { chrome, colors, glass, spacing } from '../../src/theme';

const icon =
  (name: keyof typeof Ionicons.glyphMap) =>
  ({ color, size }: { color: ColorValue; size: number }) =>
    <Ionicons name={name} color={color as string} size={size} />;

/** Frosted fill for the floating tab bar — clipped to the bar's rounded shape. */
function TabBarGlass() {
  return (
    <>
      <BlurView
        intensity={60}
        tint="dark"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, styles.barTint]} />
      <View style={[StyleSheet.absoluteFill, styles.barBorder]} />
    </>
  );
}

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
        // No nav header — each screen carries its own large title so the aurora
        // backdrop runs uninterrupted to the status bar.
        headerShown: false,
        tabBarBackground: TabBarGlass,
        tabBarStyle: {
          position: 'absolute',
          marginHorizontal: spacing.lg,
          marginBottom: spacing.sm,
          height: chrome.tabBarHeight,
          backgroundColor: 'transparent',
          borderTopWidth: 0,
          borderRadius: 28,
          overflow: 'hidden',
          elevation: 0,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        sceneStyle: { backgroundColor: 'transparent' },
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

const styles = StyleSheet.create({
  barTint: { backgroundColor: glass.chromeSurface },
  barBorder: {
    borderRadius: 28,
    borderWidth: 1,
    borderColor: glass.chromeBorder,
  },
});
