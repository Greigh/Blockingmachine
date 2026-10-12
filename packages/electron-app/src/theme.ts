import type { ThemeType } from './types/';

export interface AccentColorOption {
  id: string;
  name: string;
  primary: string;
  hover: string;
  glow: string;
  /** Darker shades applied in light mode so accent text and accent buttons meet AA. */
  primaryLight: string;
  hoverLight: string;
}

export const ACCENT_PALETTE: AccentColorOption[] = [
  { id: 'blue', name: 'Cupertino Blue', primary: '#007aff', hover: '#0062cc', glow: 'rgba(0, 122, 255, 0.3)', primaryLight: '#0055d4', hoverLight: '#0048b8' },
  { id: 'indigo', name: 'Electric Indigo', primary: '#6366f1', hover: '#4f46e5', glow: 'rgba(99, 102, 241, 0.3)', primaryLight: '#4f46e5', hoverLight: '#4338ca' },
  { id: 'emerald', name: 'Nordic Emerald', primary: '#10b981', hover: '#059669', glow: 'rgba(16, 185, 129, 0.3)', primaryLight: '#047857', hoverLight: '#065f46' },
  { id: 'violet', name: 'Deep Violet', primary: '#8b5cf6', hover: '#7c3aed', glow: 'rgba(139, 92, 246, 0.3)', primaryLight: '#7c3aed', hoverLight: '#6d28d9' },
  { id: 'cyan', name: 'Cyber Cyan', primary: '#06b6d4', hover: '#0891b2', glow: 'rgba(6, 182, 212, 0.3)', primaryLight: '#0e7490', hoverLight: '#155e75' },
  { id: 'amber', name: 'Solar Amber', primary: '#f59e0b', hover: '#d97706', glow: 'rgba(245, 158, 11, 0.3)', primaryLight: '#b45309', hoverLight: '#92400e' },
  { id: 'rose', name: 'Vibrant Rose', primary: '#f43f5e', hover: '#e11d48', glow: 'rgba(244, 63, 94, 0.3)', primaryLight: '#be123c', hoverLight: '#9f1239' },
];

export const applyTheme = (theme: ThemeType) => {
  if (typeof document === 'undefined') return;
  const body = document.body;
  body.classList.remove('light-theme', 'dark-theme');

  if (theme === 'light') {
    body.classList.add('light-theme');
  } else if (theme === 'dark') {
    body.classList.add('dark-theme');
  } else {
    // System theme
    if (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
      body.classList.add('dark-theme');
    } else {
      body.classList.add('light-theme');
    }
  }

  // The accent's light/dark shade depends on the resolved theme class — refresh
  // it whenever the theme changes so a late theme load cannot strand the wrong
  // contrast variant.
  try {
    const savedAccent =
      typeof localStorage !== 'undefined' ? localStorage.getItem('bm-accent-color') || 'blue' : 'blue';
    applyAccentColor(savedAccent);
  } catch {}
};

export const applyAccentColor = (colorId: string) => {
  if (typeof document === 'undefined') return;
  const selected =
    ACCENT_PALETTE.find((c) => c.id === colorId) || ACCENT_PALETTE[0];
  const root = document.documentElement;
  const light = !document.body.classList.contains('dark-theme');
  const primary = light ? selected.primaryLight : selected.primary;
  const hover = light ? selected.hoverLight : selected.hover;
  root.style.setProperty('--primary-color', primary);
  root.style.setProperty('--primary-color-hover', hover);
  root.style.setProperty('--sidebar-active-text', primary);
  // Badge text sits on a *darker* effective tint (active row over the sidebar
  // surface) than the badge token assumes — use the hover shade in light mode.
  root.style.setProperty('--badge-primary-text', light ? selected.hoverLight : selected.primary);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('bm-accent-color', selected.id);
    }
  } catch {}
};
