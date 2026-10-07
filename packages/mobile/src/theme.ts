/**
 * Dark palette matching the desktop app's hub aesthetic — shield-green accents
 * over a deep aurora backdrop. `glass` holds the translucent surface tokens:
 * fills read through the backdrop's glow orbs, `borderTop` is the hairline
 * highlight that makes a surface read as glass rather than flat translucency.
 */
export const colors = {
  bg: '#070a14',
  card: '#161b22',
  cardBorder: '#21262d',
  text: '#e6edf3',
  textMuted: '#8b949e',
  accent: '#3fb950',
  accentDim: '#238636',
  warn: '#d29922',
  danger: '#f85149',
  info: '#58a6ff',
  // Aurora backdrop glows (indigo / violet / teal) — rendered as blurred orbs.
  glowIndigo: '#6366f1',
  glowViolet: '#a855f7',
  glowTeal: '#22d3ee',
} as const;

export const glass = {
  /** Card/sheet fill — reads through the backdrop orbs. */
  surface: 'rgba(255,255,255,0.06)',
  surfaceStrong: 'rgba(255,255,255,0.10)',
  /** All-edge hairline. */
  border: 'rgba(255,255,255,0.10)',
  /** Top-edge highlight — the glass tell. */
  borderTop: 'rgba(255,255,255,0.18)',
  /** Chrome (tab bar, header) — heavier tint since it floats over content. */
  chromeSurface: 'rgba(13,17,23,0.55)',
  chromeBorder: 'rgba(255,255,255,0.14)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const chrome = {
  /** Floating glass tab bar metrics — screens add `clearance` to bottom padding. */
  tabBarHeight: 64,
  tabBarClearance: 96,
} as const;
