import React, { type ComponentRef } from 'react';
import { Tabs, useFocusEffect } from 'expo-router';
import { PlatformPressable } from 'expo-router/react-navigation';
import { Ionicons } from '@expo/vector-icons';
import { BlurView, BlurTargetView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable } from 'expo-glass-effect';
import { Platform, StyleSheet, View, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SideNav } from '../../src/components/SideNav';
import { useWidthTier, navDockSide, hasEdgeUtilityStrip } from '../../src/hooks/useWidthTier';
import { useQuarantineBadge } from '../../src/hooks/useEvents';
import { chrome, colors, glass, layout, spacing } from '../../src/theme';
import { TABS } from '../../src/routes';

const icon =
  (name: keyof typeof Ionicons.glyphMap) =>
  ({ color, size }: { color: ColorValue; size: number }) =>
    <Ionicons name={name} color={color as string} size={size} />;

/**
 * The Android blur channel — deliberately NOT a wrapper around the navigator.
 *
 * BlurView's `dimezisBlurView` samples whatever its `blurTarget` paints, so the
 * BlurView can never sit inside its own target: the sampler would be inside
 * the sampled tree, which produces a RenderNode self-reference — Android's
 * RenderThread recurses in `RenderNode::prepareTreeImpl` until the stack
 * blows (SIGSEGV at launch). A single target wrapping <Tabs> always contains
 * the bar, because the BottomTabBar renders inside the navigator.
 *
 * The escape: the navigator's scenes and its BottomTabBar are siblings, so the
 * target wraps each SCREEN via `screenLayout` — the bar is never inside any
 * screen's target. The focused screen owns the slot (publish/clear below).
 * `blurTargetListeners` exists because mutating a ref's `.current` doesn't
 * re-render anything, and BlurView only re-reads the target on an update.
 */
const tabBarBlurTarget: { current: ComponentRef<typeof View> | null } = { current: null };
const blurTargetListeners = new Set<() => void>();
const notifyBlurTarget = () => blurTargetListeners.forEach((f) => f());

/** Per-screen blur source — focus-bound so the bar samples the visible screen. */
function ScreenBlurTarget({ children }: { children: React.ReactNode }) {
  const target = React.useRef<ComponentRef<typeof View> | null>(null);
  useFocusEffect(
    React.useCallback(() => {
      if (Platform.OS !== 'android') return undefined;
      tabBarBlurTarget.current = target.current;
      notifyBlurTarget();
      return () => {
        if (tabBarBlurTarget.current === target.current) {
          tabBarBlurTarget.current = null;
          notifyBlurTarget();
        }
      };
    }, []),
  );
  if (Platform.OS !== 'android') return <>{children}</>;
  return (
    <BlurTargetView ref={target} style={styles.navTarget}>
      {children}
    </BlurTargetView>
  );
}

const screenBlurLayout = ({ children }: { children?: React.ReactNode }) => (
  <ScreenBlurTarget>{children}</ScreenBlurTarget>
);

/** Frosted fill for the floating tab bar — clipped to the bar's rounded shape. */
function TabBarGlass() {
  if (isGlassEffectAPIAvailable()) {
    // Real Liquid Glass material — the system draws refraction + specular.
    return (
      <>
        <GlassView glassEffectStyle="regular" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, styles.barTintGlass]} />
        <View style={[StyleSheet.absoluteFill, styles.barBorder]} />
      </>
    );
  }
  return (
    <>
      <BlurView
        intensity={60}
        tint="dark"
        blurMethod="dimezisBlurView"
        // A SNAPSHOT object, not the live ref — BlurView.componentDidUpdate only
        // re-resolves the target when `prevProps.blurTarget?.current` differs
        // from the new one. Passing the stable ref makes that compare the
        // object to itself → always equal → the populated target is never
        // picked up after mount (this bar mounts *inside* the target's
        // subtree, i.e. before the target ref attaches). A fresh {current}
        // literal snapshots the value per render so the change is visible.
        blurTarget={{ current: tabBarBlurTarget.current }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, styles.barTint]} />
      <View style={[StyleSheet.absoluteFill, styles.barBorder]} />
    </>
  );
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const tier = useWidthTier();
  // New quarantines badge the Telemetry tab until the dashboard banner (or the
  // badge's implicit "I saw it") dismisses them — cross-tab signal, not just a
  // banner that only exists while Dashboard happens to be mounted.
  const quarantineBadge = useQuarantineBadge();
  const dockSide = navDockSide();
  // Re-render whenever a screen publishes/clears its blur target so the bar's
  // BlurView gets a fresh `blurTarget` prop snapshot (see tabBarBlurTarget).
  const [, bumpBlurTarget] = React.useState(0);
  React.useEffect(() => {
    const notify = () => bumpBlurTarget((n) => n + 1);
    blurTargetListeners.add(notify);
    return () => {
      blurTargetListeners.delete(notify);
    };
  }, []);
  // The Duo's cover reports a right-edge utility strip; the rail docks inside
  // it at compact too, so the pill (which the strip would clip) never mounts.
  const edgeStrip = hasEdgeUtilityStrip(insets.right);
  const sideNav =
    tier === 'regular' ? (
      <SideNav variant="sidebar" dockSide={dockSide} />
    ) : tier === 'medium' || edgeStrip ? (
      <SideNav variant="rail" dockSide={dockSide} />
    ) : null;
  return (
    <View style={styles.row}>
      {dockSide === 'leading' ? sideNav : null}
      <View style={styles.nav}>
        <Tabs
          // Per-screen blur targets — see ScreenBlurTarget. On Android each
          // screen is the sampler's source; on iOS this is a passthrough.
          screenLayout={screenBlurLayout}
          // Compact keeps the floating pill (explicit undefined → the
          // navigator's own BottomTabBar with the styling below) — except on
          // foldable edge strips, where the rail replaces it. Off compact, the
          // sibling SideNav owns navigation and the bar renders nothing.
          tabBar={tier === 'compact' && !edgeStrip ? undefined : () => null}
          screenOptions={{
        // No nav header — each screen carries its own large title so the aurora
        // backdrop runs uninterrupted to the status bar.
        headerShown: false,
        tabBarBackground: TabBarGlass,
        tabBarStyle: {
          position: 'absolute',
          // The pill only exists on the compact tier — alignSelf centers an
          // absolute child on the cross axis in Yoga, and the margins are the
          // minimum inset on phones.
          alignSelf: 'center',
          maxWidth: layout.tabBarMaxWidth,
          marginHorizontal: spacing.lg,
          // The pill floats above the home indicator via margin — so the bar
          // must not *also* reserve the inset as padding inside its own height
          // (react-navigation adds insets.bottom as paddingBottom, which would
          // squeeze the items into a 30pt top lane).
          marginBottom: insets.bottom + spacing.sm,
          paddingBottom: 0,
          height: chrome.tabBarHeight,
          backgroundColor: 'transparent',
          borderTopWidth: 0,
          borderRadius: 28,
          overflow: 'hidden',
          elevation: 0,
        },
        // The stock item button top-anchors its icon+label column
        // (tabVerticalUiKit justifyContent:'flex-start') — invisible on the
        // 49pt stock bar that content fills, but the 64pt pill leaves a dead
        // band below the labels. Same PlatformPressable, content recentered.
        tabBarButton: (props) => (
          <PlatformPressable {...props} style={[props.style, styles.itemButton]} />
        ),
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        sceneStyle: { backgroundColor: 'transparent' },
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.id}
          name={tab.route}
          options={{
            title: tab.label,
            tabBarIcon: icon(tab.icon),
            // The quarantine badge is bound to the telemetry tab by registry id.
            ...(tab.id === 'telemetry'
              ? {
                  tabBarBadge: quarantineBadge,
                  tabBarBadgeStyle: { backgroundColor: colors.warn, color: colors.bg },
                }
              : null),
          }}
        />
      ))}
        </Tabs>
      </View>
      {dockSide === 'trailing' ? sideNav : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  nav: { flex: 1 },
  navTarget: { flex: 1 },
  itemButton: { justifyContent: 'center' },
  barTint: { backgroundColor: glass.chromeSurface },
  // Liquid Glass already carries depth — keep only a whisper of brand tint.
  barTintGlass: { backgroundColor: 'rgba(63,185,80,0.05)' },
  barBorder: {
    borderRadius: 28,
    borderWidth: 1,
    borderColor: glass.chromeBorder,
  },
});
