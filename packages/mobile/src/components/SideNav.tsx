/**
 * Wide-tier navigation — replaces the floating pill tab bar when the canvas
 * leaves the compact tier:
 *
 *   'rail'     icon-only column (medium tier — unfolded iPhone Duo, narrow
 *              splits): the same role Material's NavigationRail fills on
 *              foldables.
 *   'sidebar'  labeled rows (regular tier — full-size iPad): an iPad-native
 *              sidebar with the app wordmark.
 *
 * `dockSide` picks the edge: 'trailing' (right) on foldables — iPhone Duo's
 * system utility rail lives there in unfolded posture — and 'leading' (left)
 * on iPad, where sidebars conventionally dock.
 *
 * Foldable edge cases handled here: the Duo's cover reserves an ~84pt right
 * strip (reported via the right safe-area inset) that the rail fills instead
 * of its usual 76pt, its hardware status island overlays the top of the
 * trailing edge, so rail items dock to the bottom (the platform's Duo
 * utility-dock convention) and the sidebar's brand row clears it.
 *
 * It's a real sibling of the navigator, not a tabBar render — the navigator
 * flexes into the remaining width, so scenes never draw underneath it and no
 * per-screen insets are needed.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassView, isGlassEffectAPIAvailable } from 'expo-glass-effect';
import { useQuarantineBadge } from '../hooks/useEvents';
import { isIPad, type NavDockSide } from '../hooks/useWidthTier';
import { haptics } from '../haptics';
import { colors, glass, layout, spacing } from '../theme';

interface NavTab {
  href: '/check' | '/telemetry' | '/settings' | '/';
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}

const TABS: NavTab[] = [
  { href: '/', label: 'Dashboard', icon: 'shield-half-outline' },
  { href: '/check', label: 'Check', icon: 'search-outline' },
  { href: '/telemetry', label: 'Telemetry', icon: 'pulse-outline' },
  { href: '/settings', label: 'Settings', icon: 'settings-outline' },
];

function isActive(pathname: string, href: NavTab['href']): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function SideNav({
  variant,
  dockSide,
}: {
  variant: 'rail' | 'sidebar';
  dockSide: NavDockSide;
}) {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const quarantineBadge = useQuarantineBadge();
  const liquidGlass = isGlassEffectAPIAvailable();

  const go = (href: NavTab['href']) => {
    haptics.select();
    router.push(href);
  };

  if (variant === 'rail') {
    return (
      <View
        style={[
          styles.rail,
          dockSide === 'leading' ? styles.edgeLeading : styles.edgeTrailing,
          liquidGlass ? styles.railClear : null,
          {
            paddingTop: insets.top + spacing.md,
            paddingBottom: insets.bottom + spacing.sm,
            // A trailing-edge OS strip (Duo cover) is wider than the rail —
            // fill it so the navigator column ends exactly at its boundary.
            width: Math.max(
              layout.navRailWidth,
              dockSide === 'trailing' ? insets.right : 0,
            ),
          },
        ]}
      >
        {TABS.map((tab) => {
          const active = isActive(pathname, tab.href);
          return (
            <Pressable
              key={tab.href}
              onPress={() => go(tab.href)}
              accessibilityRole="button"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: active }}
              style={({ pressed }) => [
                styles.railItem,
                !liquidGlass && active && styles.railItemActive,
                pressed && styles.pressed,
              ]}
            >
              <View
                style={[
                  styles.railTile,
                  !liquidGlass && active && styles.railTileActiveSolid,
                ]}
              >
                {liquidGlass ? (
                  <GlassView
                    glassEffectStyle="regular"
                    style={[StyleSheet.absoluteFill, styles.railTileGlass]}
                  />
                ) : null}
                {liquidGlass && active ? (
                  <View
                    style={[StyleSheet.absoluteFill, styles.railTileActiveTint]}
                  />
                ) : null}
                <View>
                  <Ionicons
                    name={tab.icon}
                    size={22}
                    color={active ? colors.accent : colors.textMuted}
                  />
                  {tab.href === '/telemetry' &&
                  quarantineBadge !== undefined ? (
                    <View style={styles.badgeDot}>
                      <Text style={styles.badgeDotText}>{quarantineBadge}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
              <Text
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                numberOfLines={1}
                style={[styles.railLabel, active && styles.railLabelActive]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  }

  return (
    <View
      style={[
        styles.sidebar,
        dockSide === 'leading' ? styles.edgeLeading : styles.edgeTrailing,
        {
          paddingTop:
            insets.top +
            spacing.lg +
            // The Duo's hardware status island overlays the top of the
            // trailing edge without entering the reported insets — the brand
            // row starts below it.
            (dockSide === 'trailing' && !isIPad()
              ? STATUS_ISLAND_CLEARANCE
              : 0),
          paddingBottom: insets.bottom + spacing.md,
        },
        liquidGlass ? styles.glassShell : null,
      ]}
    >
      {liquidGlass ? (
        <GlassView glassEffectStyle="regular" style={StyleSheet.absoluteFill} />
      ) : null}
      <View style={styles.brandRow}>
        <Ionicons name="shield-half" size={20} color={colors.accent} />
        <Text style={styles.brandText}>Blockingmachine</Text>
      </View>
      {TABS.map((tab) => {
        const active = isActive(pathname, tab.href);
        return (
          <Pressable
            key={tab.href}
            onPress={() => go(tab.href)}
            accessibilityRole="button"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: active }}
            style={({ pressed }) => [
              styles.sideItem,
              active && styles.sideItemActive,
              pressed && styles.pressed,
            ]}
          >
            <Ionicons
              name={tab.icon}
              size={18}
              color={active ? colors.accent : colors.textMuted}
            />
            <Text style={[styles.sideLabel, active && styles.sideLabelActive]}>
              {tab.label}
            </Text>
            {tab.href === '/telemetry' && quarantineBadge !== undefined ? (
              <View style={styles.badgePill}>
                <Text style={styles.badgePillText}>{quarantineBadge}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Height the Duo's status island occupies over the trailing edge's top. */
const STATUS_ISLAND_CLEARANCE = 64;

const styles = StyleSheet.create({
  rail: {
    alignItems: 'center',
    backgroundColor: glass.chromeSurface,
    gap: spacing.sm,
    // Bottom-docked — the Duo dock convention — which also keeps the stack
    // clear of the hardware status island overlaying the top corner.
    justifyContent: 'flex-end',
    width: layout.navRailWidth,
  },
  railItem: {
    alignItems: 'center',
    borderRadius: 14,
    gap: 3,
    paddingHorizontal: 4,
    paddingVertical: spacing.sm,
    width: 64,
  },
  railItemActive: { backgroundColor: 'rgba(63,185,80,0.14)' },
  // Each item is a discrete liquid-glass tile floating on the edge strip —
  // the platform's utility-rail convention (same shape as the status island
  // above it), rather than one continuous glass column.
  railClear: { backgroundColor: 'transparent' },
  railTile: {
    alignItems: 'center',
    borderRadius: 15,
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  railTileGlass: { borderRadius: 15 },
  railTileActiveTint: {
    backgroundColor: 'rgba(63,185,80,0.20)',
    borderRadius: 15,
  },
  railTileActiveSolid: { backgroundColor: 'rgba(63,185,80,0.14)' },
  railLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '600' },
  railLabelActive: { color: colors.accent },
  badgeDot: {
    alignItems: 'center',
    backgroundColor: colors.warn,
    borderRadius: 999,
    height: 16,
    justifyContent: 'center',
    minWidth: 16,
    paddingHorizontal: 4,
    position: 'absolute',
    right: -8,
    top: -6,
  },
  badgeDotText: { color: colors.bg, fontSize: 9, fontWeight: '700' },
  // The real glass material replaces the fake tint — its own edge + refraction
  // carry the surface, so the chrome fill turns off underneath it.
  glassShell: { backgroundColor: 'transparent' },
  sidebar: {
    backgroundColor: glass.chromeSurface,
    gap: 2,
    paddingHorizontal: spacing.sm,
    width: layout.navSidebarWidth,
  },
  edgeLeading: { borderRightColor: glass.chromeBorder, borderRightWidth: 1 },
  edgeTrailing: { borderLeftColor: glass.chromeBorder, borderLeftWidth: 1 },
  brandRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.sm,
  },
  brandText: { color: colors.text, fontSize: 16, fontWeight: '800' },
  sideItem: {
    alignItems: 'center',
    borderRadius: 12,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm + 2,
  },
  sideItemActive: { backgroundColor: 'rgba(63,185,80,0.14)' },
  sideLabel: { color: colors.textMuted, flex: 1, fontSize: 14, fontWeight: '600' },
  sideLabelActive: { color: colors.accent },
  badgePill: {
    alignItems: 'center',
    backgroundColor: colors.warn,
    borderRadius: 999,
    justifyContent: 'center',
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  badgePillText: { color: colors.bg, fontSize: 10, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
