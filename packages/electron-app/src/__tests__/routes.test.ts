/**
 * The five-section route registry.
 *
 * The shell used to be a flat `currentView` string with ten top-level names and keyboard
 * shortcuts hard-coded against them. The registry makes the five sections, their sub-screen
 * tabs, the sidebar order, and the legacy IPC view-name translation one piece of data — so a
 * nav rename or a new tab is one edit, and `navigate-view` payloads from the main process
 * (tray, menus, onboarding) resolve to a route without the handler knowing the new names.
 */

import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_ROUTE,
  SECTIONS,
  isSectionId,
  routeForViewName,
  sectionById,
} from '../routes';

describe('SECTIONS registry', () => {
  it('declares exactly the five sections in sidebar order', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([
      'home',
      'rules',
      'discover',
      'distribute',
      'settings',
    ]);
  });

  it('gives every section a label, an icon, and a shortcut hint', () => {
    for (const section of SECTIONS) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.icon).toBeTruthy();
      expect(section.shortcut.length).toBeGreaterThan(0);
    }
  });

  it('keeps tab ids unique within each section', () => {
    for (const section of SECTIONS) {
      const ids = section.tabs.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('declares the pinned tab ids per section', () => {
    expect(sectionById('rules').tabs.map((t) => t.id)).toEqual([
      'feeds',
      'modules',
      'custom',
      'output',
    ]);
    expect(sectionById('discover').tabs.map((t) => t.id)).toEqual([
      'radar',
      'engine',
      'inspect',
    ]);
    expect(sectionById('distribute').tabs.map((t) => t.id)).toEqual([
      'browser-extension',
      'adguard-home',
      'pihole',
      'home-assistant',
      'system-daemon',
      'adguard-desktop',
      'hosts',
      'dnsmasq',
      'unbound',
      'shadowrocket',
      'privoxy',
      'bind',
      'network',
    ]);
    expect(sectionById('home').tabs).toHaveLength(0);
    expect(sectionById('settings').tabs).toHaveLength(0);
  });
});

describe('routeForViewName', () => {
  it.each([
    ['process', { section: 'home', tab: null }],
    ['sources', { section: 'rules', tab: 'feeds' }],
    ['modules', { section: 'rules', tab: 'modules' }],
    ['custom', { section: 'rules', tab: 'custom' }],
    ['browser', { section: 'rules', tab: 'output' }],
    ['inspector', { section: 'discover', tab: 'inspect' }],
    ['ai-radar', { section: 'discover', tab: 'radar' }],
    ['bulkImport', { section: 'rules', tab: 'feeds' }],
    ['deploy', { section: 'distribute', tab: null }],
    ['settings', { section: 'settings', tab: null }],
  ] as const)('maps legacy view name %s', (name, expected) => {
    expect(routeForViewName(name)).toEqual(expected);
  });

  it.each(['nonsense', '', 'PROCESS', 'deploy2', ' home'])(
    'returns null for unknown name %j',
    (name) => {
      expect(routeForViewName(name)).toBeNull();
    },
  );
});

describe('route primitives', () => {
  it('isSectionId accepts the five ids and rejects everything else', () => {
    for (const id of ['home', 'rules', 'discover', 'distribute', 'settings']) {
      expect(isSectionId(id)).toBe(true);
    }
    expect(isSectionId('process')).toBe(false);
    expect(isSectionId(null)).toBe(false);
    expect(isSectionId(42)).toBe(false);
  });

  it('DEFAULT_ROUTE is the home section', () => {
    expect(DEFAULT_ROUTE).toEqual({ section: 'home', tab: null });
  });

  it('sectionById returns the spec for every declared section', () => {
    for (const section of SECTIONS) {
      expect(sectionById(section.id)).toBe(section);
    }
  });
});
