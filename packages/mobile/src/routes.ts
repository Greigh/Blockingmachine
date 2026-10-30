/**
 * Route registry — the single vocabulary for the five-tab shell. The Tabs
 * layout and SideNav both render from this list, so order/labels/icons can
 * never drift between the compact pill and the wide-tier rail/sidebar.
 *
 * Settings is deliberately not a tab: it is a pushed route reached via the
 * header gear on every tab screen (`SETTINGS_ROUTE`).
 */

import type { Ionicons } from '@expo/vector-icons';

export type TabId = 'home' | 'protect' | 'check' | 'rules' | 'telemetry';

export interface TabSpec {
  /** Stable identity — used for tests and any future deep-link mapping. */
  id: TabId;
  /** Bar/rail/sidebar label. */
  label: string;
  /** Ionicons glyph name. */
  icon: keyof typeof Ionicons.glyphMap;
  /** expo-router screen name inside `app/(tabs)/`. */
  route: 'index' | 'protect' | 'check' | 'rules' | 'telemetry';
  /** URL path for navigation (SideNav/gear) — note 'index' → '/', not '/index'. */
  href: '/' | '/protect' | '/check' | '/rules' | '/telemetry';
}

export const TABS: readonly TabSpec[] = [
  { id: 'home', label: 'Home', icon: 'shield-half-outline', route: 'index', href: '/' },
  { id: 'protect', label: 'Protect', icon: 'phone-portrait-outline', route: 'protect', href: '/protect' },
  { id: 'check', label: 'Check', icon: 'search-outline', route: 'check', href: '/check' },
  { id: 'rules', label: 'Rules', icon: 'list-outline', route: 'rules', href: '/rules' },
  { id: 'telemetry', label: 'Telemetry', icon: 'pulse-outline', route: 'telemetry', href: '/telemetry' },
] as const;

/** Pushed settings sheet — a stack route, not a tab. */
export const SETTINGS_ROUTE = '/settings' as const;
