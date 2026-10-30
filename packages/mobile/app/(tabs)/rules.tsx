/**
 * Rules tab — the corpus workspace: hub filter sources, custom rules, and
 * standalone feed management. Populated by the cards moved out of Settings
 * (Task 4 of the mobile shell redesign).
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassBackdrop } from '../../src/components/GlassBackdrop';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { hasEdgeUtilityStrip, useWidthTier } from '../../src/hooks/useWidthTier';
import { chrome, colors, layout, spacing } from '../../src/theme';

export default function RulesScreen() {
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
          title="Rules"
          subtitle="The filter corpus — sources, feeds, and custom rules."
        />
        <Text style={styles.meta}>Nothing here yet.</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  scroll: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, alignSelf: 'center', width: '100%' },
  meta: { color: colors.textMuted, fontSize: 13 },
});
