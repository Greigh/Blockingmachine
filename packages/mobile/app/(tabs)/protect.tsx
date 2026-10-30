/**
 * Protect tab — this-phone filtering workspace: the on-device filter/tunnel,
 * standalone ruleset sync, per-app bypass, HTTPS capture, and the local DNS
 * service. Populated by the cards moved out of Settings (Task 3 of the mobile
 * shell redesign).
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassBackdrop } from '../../src/components/GlassBackdrop';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { hasEdgeUtilityStrip, useWidthTier } from '../../src/hooks/useWidthTier';
import { chrome, colors, layout, spacing } from '../../src/theme';

export default function ProtectScreen() {
  const insets = useSafeAreaInsets();
  const tier = useWidthTier();
  return (
    <View style={styles.screen}>
      <GlassBackdrop />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          {
            maxWidth:
              tier === 'regular' ? layout.contentMaxWidthWide : layout.contentMaxWidth,
            paddingTop: insets.top + spacing.lg,
            paddingBottom:
              spacing.xl +
              insets.bottom +
              (tier === 'compact' && !hasEdgeUtilityStrip(insets.right)
                ? chrome.tabBarClearance
                : 0),
          },
        ]}
      >
        <ScreenHeader
          title="Protect"
          subtitle="Filtering that runs on this phone."
        />
        <Text style={styles.meta}>Nothing here yet.</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, alignSelf: 'center', width: '100%' },
  meta: { color: colors.textMuted, fontSize: 13 },
});
