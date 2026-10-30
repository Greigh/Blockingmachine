/**
 * The five-section route registry — the shell's single source of truth.
 *
 * Before this file the shell was a flat `currentView` string: ten sidebar buttons, nine
 * `navigate-view` names the main process sends (tray menu, application menu), and a ⌘-map in
 * `App.tsx`, each spelling the same names by hand. The registry makes sections, sub-screen
 * tabs, sidebar order, shortcut hints, and the legacy-name translation one piece of data —
 * Sidebar renders it, App consumes it, and a nav rename or a new tab is one edit here.
 *
 * The list itself is inert: no `window.electron`, no state, no side effects on import —
 * the same contract `deploy/deployTargets` keeps. Icons are `createElement` output so the
 * registry file can stay `.ts`; the SVG paths are the ones Sidebar used, moved not redrawn.
 */

import { createElement, type ReactNode } from 'react';

export type SectionId = 'home' | 'rules' | 'discover' | 'distribute' | 'settings';

/** Where the shell is: a section, and the sub-screen tab inside it (null = section default). */
export interface AppRoute {
  section: SectionId;
  tab: string | null;
}

export interface TabSpec {
  id: string;
  label: string;
}

export interface SectionSpec {
  id: SectionId;
  label: string;
  /** Inline icon, sized for the sidebar row. */
  icon: ReactNode;
  /** The shortcut hint rendered on the sidebar row ('⌘1' … '⌘,'). */
  shortcut: string;
  /** Sub-screens, in tab order. Empty for sections that are a single screen. */
  tabs: readonly TabSpec[];
}

/** Shared frame for every section icon — paths only differ per section. */
function sectionIcon(children: ReactNode): ReactNode {
  return createElement(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: 16,
      height: 16,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round' as const,
      strokeLinejoin: 'round' as const,
      'aria-hidden': true,
    },
    children,
  );
}

const path = (key: string, d: string) => createElement('path', { key, d });

const SECTION_LIST: readonly SectionSpec[] = [
  {
    id: 'home',
    label: 'Home',
    icon: sectionIcon(
      path('bolt', 'M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z'),
    ),
    shortcut: '⌘1',
    tabs: [],
  },
  {
    id: 'rules',
    label: 'Rules',
    icon: sectionIcon(
      path('list', 'M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z'),
    ),
    shortcut: '⌘2',
    tabs: [
      { id: 'feeds', label: 'Feeds' },
      { id: 'modules', label: 'Modules' },
      { id: 'custom', label: 'Custom' },
      { id: 'output', label: 'Output' },
    ],
  },
  {
    id: 'discover',
    label: 'Discover',
    icon: sectionIcon([
      createElement('circle', { key: 'c1', cx: 12, cy: 12, r: 9 }),
      path('arc', 'M12 3a9 9 0 019 9'),
      createElement('circle', { key: 'c2', cx: 12, cy: 12, r: 3 }),
      path('needle', 'M12 12l4-4'),
    ]),
    shortcut: '⌘3',
    tabs: [
      { id: 'radar', label: 'Radar' },
      { id: 'engine', label: 'AI engine' },
      { id: 'inspect', label: 'Inspect' },
    ],
  },
  {
    id: 'distribute',
    label: 'Distribute',
    icon: sectionIcon([
      createElement('rect', { key: 'r1', x: 2, y: 3, width: 20, height: 6, rx: 2 }),
      createElement('rect', { key: 'r2', x: 2, y: 15, width: 20, height: 6, rx: 2 }),
      path('bars', 'M6 6h.01M6 18h.01M12 9v6M8 12h8'),
    ]),
    shortcut: '⌘4',
    tabs: [
      { id: 'browser-extension', label: 'Browser ext' },
      { id: 'adguard-home', label: 'AdGuard Home' },
      { id: 'pihole', label: 'Pi-hole' },
      { id: 'home-assistant', label: 'Home Assistant' },
      { id: 'system-daemon', label: 'System daemon' },
      { id: 'adguard-desktop', label: 'AdGuard desktop' },
      { id: 'hosts', label: 'Hosts file' },
      { id: 'dnsmasq', label: 'Routers & DNS' },
      { id: 'unbound', label: 'Unbound' },
      { id: 'shadowrocket', label: 'Shadowrocket' },
      { id: 'privoxy', label: 'Privoxy' },
      { id: 'bind', label: 'BIND' },
      { id: 'network', label: 'LAN feed & pairing' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: sectionIcon([
      path('gear', 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z'),
      createElement('path', { key: 'center', d: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z' }),
    ]),
    shortcut: '⌘,',
    tabs: [],
  },
];

/** The sections, in sidebar order. */
export const SECTIONS: readonly SectionSpec[] = SECTION_LIST;

/** Where a fresh launch lands — the protection deck. Frozen: shared, never mutate. */
export const DEFAULT_ROUTE: AppRoute = Object.freeze({ section: 'home', tab: null });

const BY_ID = new Map<SectionId, SectionSpec>(SECTION_LIST.map((s) => [s.id, s]));

export function isSectionId(v: unknown): v is SectionId {
  return typeof v === 'string' && (BY_ID as Map<string, SectionSpec>).has(v);
}

/** The spec for a declared section. */
export function sectionById(id: SectionId): SectionSpec {
  const spec = BY_ID.get(id);
  if (!spec) throw new Error(`unknown section id: ${id}`);
  return spec;
}

/**
 * What `navigate-view` payloads mean in the new shell.
 *
 * The main process still sends the flat view names it always sent — the tray, the
 * application menu, and onboarding completions are unchanged on that side. This map is the
 * translation the renderer applies at the boundary: every name the wire can carry resolves
 * to a route; anything else is `null`, and the caller falls back to DEFAULT_ROUTE.
 */
const LEGACY_VIEW_ROUTES: Readonly<Record<string, AppRoute>> = Object.freeze({
  process: { section: 'home', tab: null },
  sources: { section: 'rules', tab: 'feeds' },
  modules: { section: 'rules', tab: 'modules' },
  custom: { section: 'rules', tab: 'custom' },
  browser: { section: 'rules', tab: 'output' },
  inspector: { section: 'discover', tab: 'inspect' },
  'ai-radar': { section: 'discover', tab: 'radar' },
  bulkImport: { section: 'rules', tab: 'feeds' },
  deploy: { section: 'distribute', tab: null },
  settings: { section: 'settings', tab: null },
});

/** The route a legacy view name resolves to, or null for anything not on the wire. */
export function routeForViewName(name: string): AppRoute | null {
  return LEGACY_VIEW_ROUTES[name] ?? null;
}
