/**
 * Route registry: the single vocabulary for the five-tab shell — order,
 * labels, icons, and router paths consumed by the Tabs layout and SideNav.
 */

import { TABS, SETTINGS_ROUTE, tabIcon, type TabId } from '../routes';

describe('TABS registry', () => {
  it('holds the five tabs in shell order', () => {
    expect(TABS.map((t) => t.id)).toEqual([
      'home',
      'protect',
      'check',
      'rules',
      'telemetry',
    ]);
  });

  it('labels tabs for the bar', () => {
    expect(TABS.map((t) => t.label)).toEqual([
      'Home',
      'Protect',
      'Check',
      'Rules',
      'Telemetry',
    ]);
  });

  it('maps every tab to an expo-router screen name', () => {
    const routes = TABS.map((t) => t.route);
    expect(routes).toEqual(['index', 'protect', 'check', 'rules', 'telemetry']);
  });

  it('maps every tab to a URL path — index is the root', () => {
    expect(TABS.map((t) => t.href)).toEqual([
      '/',
      '/protect',
      '/check',
      '/rules',
      '/telemetry',
    ]);
  });

  it('gives every tab an Ionicons glyph name', () => {
    for (const tab of TABS) {
      expect(typeof tab.icon).toBe('string');
      expect(tab.icon.length).toBeGreaterThan(0);
    }
  });
});

describe('SETTINGS_ROUTE', () => {
  it('is the pushed settings sheet, outside the tab group', () => {
    expect(SETTINGS_ROUTE).toBe('/settings');
  });
});

describe('tabIcon', () => {
  it('returns the icon for a known tab and falls back for unknown', () => {
    const home = TABS.find((t) => t.id === 'home')!;
    expect(tabIcon('home')).toBe(home.icon);
    expect(tabIcon('nope' as TabId)).toBeUndefined();
  });
});
