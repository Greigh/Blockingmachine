import type { ThemeType } from './types/';

export interface AccentColorOption {
  id: string;
  name: string;
  primary: string;
  hover: string;
  glow: string;
}

export const ACCENT_PALETTE: AccentColorOption[] = [
  { id: 'blue', name: 'Cupertino Blue', primary: '#007aff', hover: '#0062cc', glow: 'rgba(0, 122, 255, 0.3)' },
  { id: 'indigo', name: 'Electric Indigo', primary: '#6366f1', hover: '#4f46e5', glow: 'rgba(99, 102, 241, 0.3)' },
  { id: 'emerald', name: 'Nordic Emerald', primary: '#10b981', hover: '#059669', glow: 'rgba(16, 185, 129, 0.3)' },
  { id: 'violet', name: 'Deep Violet', primary: '#8b5cf6', hover: '#7c3aed', glow: 'rgba(139, 92, 246, 0.3)' },
  { id: 'cyan', name: 'Cyber Cyan', primary: '#06b6d4', hover: '#0891b2', glow: 'rgba(6, 182, 212, 0.3)' },
  { id: 'amber', name: 'Solar Amber', primary: '#f59e0b', hover: '#d97706', glow: 'rgba(245, 158, 11, 0.3)' },
  { id: 'rose', name: 'Vibrant Rose', primary: '#f43f5e', hover: '#e11d48', glow: 'rgba(244, 63, 94, 0.3)' },
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
};

export const applyAccentColor = (colorId: string) => {
  if (typeof document === 'undefined') return;
  const selected =
    ACCENT_PALETTE.find((c) => c.id === colorId) || ACCENT_PALETTE[0];
  const root = document.documentElement;
  root.style.setProperty('--primary-color', selected.primary);
  root.style.setProperty('--primary-color-hover', selected.hover);
  root.style.setProperty('--sidebar-active-text', selected.primary);
  root.style.setProperty('--badge-primary-text', selected.primary);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('bm-accent-color', selected.id);
    }
  } catch {}
};
