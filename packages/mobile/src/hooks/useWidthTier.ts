/**
 * Width tiers for the adaptive shell.
 *
 * Three canvases, three layouts — driven off the live window so rotation,
 * Split View, Stage Manager and a fold state change all re-tier instantly:
 *
 *   compact  (< 680)   phones, folded Duo, iPad one-third Split View —
 *                      single column; floating pill on phones, while foldables
 *                      with an OS edge strip dock the rail inside it instead.
 *   medium  (680–1023) unfolded iPhone Duo, iPad half-split, iPad mini —
 *                      icon rail, two-column card grid.
 *   regular (>= 1024)  full-size iPad — labeled sidebar, two-column grid
 *                      on the wider cap.
 *
 * Where the side nav docks is a device-family call, not a width one: iPads get
 * it on the leading (left) edge — the Mail/Notes/Files convention — while
 * foldables get the trailing (right) edge, matching iPhone Duo's system
 * utility rail in unfolded posture.
 */
import { Platform, useWindowDimensions } from 'react-native';

export type WidthTier = 'compact' | 'medium' | 'regular';

/** 'leading' = left edge (iPad sidebar convention); 'trailing' = right edge (Duo rail convention). */
export type NavDockSide = 'leading' | 'trailing';

/** Pure breakpoint map — the hook is a useWindowDimensions wrapper around it. */
export function widthTierFor(width: number): WidthTier {
  if (width >= 1024) return 'regular';
  if (width >= 680) return 'medium';
  return 'compact';
}

export function useWidthTier(): WidthTier {
  return widthTierFor(useWindowDimensions().width);
}

/** `Platform.isPad` only exists on the iOS half of the platform union. */
export function isIPad(): boolean {
  return (
    Platform.OS === 'ios' &&
    Boolean((Platform as { isPad?: boolean }).isPad)
  );
}

/** Side-nav dock edge: iPad keeps the conventional leading sidebar; the Duo and other foldables take the trailing rail. */
export function navDockSide(): NavDockSide {
  return isIPad() ? 'leading' : 'trailing';
}

/**
 * True when the OS reserves a utility strip on the trailing edge — iPhone
 * Duo's cover reports ~84pt of right inset for its hardware status/utility
 * zone. The rail belongs inside it at every tier there (no pill); anything
 * content draws under the strip is clipped, so the nav column owns it.
 */
export function hasEdgeUtilityStrip(rightInset: number): boolean {
  return !isIPad() && rightInset > 0;
}

/** Columns for the card grid at this tier — the Duo rail tier gets two. */
export function gridColumnsFor(tier: WidthTier): 1 | 2 {
  return tier === 'compact' ? 1 : 2;
}
