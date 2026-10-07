/**
 * Aurora glass backdrop — mounted once behind the navigator in the root layout.
 * Every translucent surface (cards, tab bar, header) reads through this layer:
 * an ink→indigo gradient with concentric-alpha glow orbs (faked radial falloff —
 * cheaper and more predictable than a full-screen BlurView), then a dark veil to
 * pull the result back toward the palette. Screens must keep transparent
 * backgrounds for it to stay visible.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme';

/** Soft glow orb — concentric circles fading outward stand in for a radial gradient. */
function GlowOrb(props: { color: string; style?: object }) {
  return (
    <View style={[styles.orb, props.style]} pointerEvents="none">
      {[
        { size: 1.0, alpha: 0.12 },
        { size: 0.78, alpha: 0.18 },
        { size: 0.55, alpha: 0.26 },
        { size: 0.34, alpha: 0.36 },
        { size: 0.18, alpha: 0.5 },
      ].map((ring) => (
        <View
          key={ring.size}
          style={[
            styles.orbRing,
            {
              width: ORB * ring.size,
              height: ORB * ring.size,
              borderRadius: (ORB * ring.size) / 2,
              backgroundColor: props.color,
              opacity: ring.alpha,
            },
          ]}
        />
      ))}
    </View>
  );
}

export function GlassBackdrop() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={[colors.bg, '#0b0f26', '#0a1420']}
        locations={[0, 0.5, 1]}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.8, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Cores stay on-screen — the brightest rings must land in view. */}
      <GlowOrb color={colors.glowIndigo} style={{ top: -90, left: -60 }} />
      <GlowOrb color={colors.glowViolet} style={{ top: '30%', right: -50 }} />
      <GlowOrb color={colors.glowTeal} style={{ bottom: -70, left: -20 }} />
      <LinearGradient
        colors={['rgba(7,10,20,0.05)', 'rgba(7,10,20,0.38)']}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const ORB = 460;

const styles = StyleSheet.create({
  orb: {
    alignItems: 'center',
    height: ORB,
    justifyContent: 'center',
    position: 'absolute',
    width: ORB,
  },
  orbRing: { position: 'absolute' },
});
