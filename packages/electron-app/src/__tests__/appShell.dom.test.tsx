/**
 * The App shell after the five-section rewire: sidebar renders SECTIONS in
 * registry order, the ⌘ map is section-level, and legacy deep links land on
 * the right route through routeForViewName. Section views are module-mocked;
 * Sidebar and Header are real — they are the shell under test.
 */

import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const captured: Record<string, Record<string, unknown> | undefined> = {};

jest.unstable_mockModule('../views/HomeView', () => ({
  HomeView: (props: Record<string, unknown>) => {
    captured.home = props;
    return 'HOME-VIEW';
  },
}));
jest.unstable_mockModule('../views/RulesView', () => ({
  RulesView: (props: Record<string, unknown>) => {
    captured.rules = props;
    return 'RULES-VIEW';
  },
}));
jest.unstable_mockModule('../views/DiscoverView', () => ({
  DiscoverView: (props: Record<string, unknown>) => {
    captured.discover = props;
    return 'DISCOVER-VIEW';
  },
}));
jest.unstable_mockModule('../views/DistributeView', () => ({
  DistributeView: (props: Record<string, unknown>) => {
    captured.distribute = props;
    return 'DISTRIBUTE-VIEW';
  },
}));
jest.unstable_mockModule('../Settings', () => ({
  default: () => 'SETTINGS-VIEW',
}));
jest.unstable_mockModule('../components/BrandLogo', () => ({
  BrandLogo: () => null,
}));
jest.unstable_mockModule('../views/OnboardingModal', () => ({
  OnboardingModal: () => null,
  PRESET_BUNDLES: [],
}));
jest.unstable_mockModule('../views/PresetsModal', () => ({
  PRESET_BUNDLES: [],
  PresetsModal: () => null,
}));
// Side-effect CSS import — jest has no transform for it.
jest.unstable_mockModule('../index.css', () => ({}));

const { default: App } = await import('../App');

afterEach(() => {
  cleanup();
  for (const key of Object.keys(captured)) delete captured[key];
});

const ipcHandlers: Record<string, (payload?: unknown) => void> = {};

function bridge(overrides: Record<string, unknown> = {}) {
  // Without the flag the shell mounts with the onboarding modal open — the
  // layout renders aria-hidden and the section keymap refuses keys.
  localStorage.setItem('bm-onboarding-completed', 'true');
  const subscribe = (channel: string) => (cb: (payload?: unknown) => void) => {
    ipcHandlers[channel] = cb;
    return () => {
      delete ipcHandlers[channel];
    };
  };
  (window as unknown as { electron: unknown }).electron = {
    getTheme: jest.fn(async () => 'system'),
    setTheme: jest.fn(async () => ({})),
    getSources: jest.fn(async () => [
      { name: 'EasyList', url: 'https://a', enabled: true },
      { name: 'EasyPrivacy', url: 'https://b', enabled: false },
    ]),
    getSavePath: jest.fn(async () => '/tmp/out'),
    getLiveRadarSession: jest.fn(async () => null),
    onLiveRadarSessionUpdate: jest.fn(() => () => {}),
    onOpenSettings: subscribe('open-settings'),
    onTriggerCompile: subscribe('trigger-compile'),
    onNavigateView: subscribe('navigate-view'),
    onLaunchOnboarding: subscribe('launch-onboarding'),
    onUpdateAvailable: subscribe('update-available'),
    rendererReady: jest.fn(),
    notifyResize: jest.fn(),
    openExternal: jest.fn(async () => ({})),
    getAppVersion: jest.fn(async () => '9.9.9'),
    showItemInFolder: jest.fn(async () => ({})),
    saveSources: jest.fn(async () => ({ success: true })),
    setExportFormat: jest.fn(async () => ({})),
    ...overrides,
  };
}

async function renderApp() {
  await act(async () => {
    render(<App />);
  });
}

describe('App shell', () => {
  it('renders the five sections in registry order', async () => {
    bridge();
    await renderApp();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const items = within(nav).getAllByRole('button');
    // The label span's first child is the section name; badge/LIVE/shortcut
    // are sibling elements and cannot leak in.
    expect(
      items.map((b) => b.querySelector('.sidebar-label')?.firstChild?.textContent?.trim()),
    ).toEqual(['Home', 'Rules', 'Discover', 'Distribute', 'Settings']);
    expect(items.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Home',
      'Rules',
      'Discover',
      'Distribute',
      'Settings',
    ]);
  });

  it('lands on Home and marks the item current', async () => {
    bridge();
    await renderApp();
    expect(screen.getByText('HOME-VIEW')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('button', { name: /Home/ }).getAttribute('aria-current')).toBe('page');
  });

  it.each([
    ['1', 'HOME-VIEW'],
    ['2', 'RULES-VIEW'],
    ['3', 'DISCOVER-VIEW'],
    ['4', 'DISTRIBUTE-VIEW'],
    [',', 'SETTINGS-VIEW'],
  ])('⌘%s selects the section view %s', async (key, marker) => {
    bridge();
    await renderApp();
    fireEvent.keyDown(window, { key, metaKey: true });
    expect(screen.getByText(marker)).toBeTruthy();
  });

  it('legacy navigate-view names land on the right route', async () => {
    bridge();
    await renderApp();
    act(() => ipcHandlers['navigate-view']('deploy'));
    expect(screen.getByText('DISTRIBUTE-VIEW')).toBeTruthy();
    act(() => ipcHandlers['navigate-view']('inspector'));
    expect(screen.getByText('DISCOVER-VIEW')).toBeTruthy();
    expect(captured.discover?.initialTab).toBe('inspect');
  });

  it('the bulkImport deep link lands on Rules › feeds carrying bulk mode', async () => {
    bridge();
    await renderApp();
    act(() => ipcHandlers['navigate-view']('bulkImport'));
    expect(screen.getByText('RULES-VIEW')).toBeTruthy();
    expect(captured.rules?.initialTab).toBe('feeds');
    expect(captured.rules?.feedsInitialTab).toBe('bulk');
  });

  it('trigger-compile returns to Home with a fresh nonce', async () => {
    bridge();
    await renderApp();
    const before = captured.home?.compileNonce as number;
    act(() => ipcHandlers['navigate-view']('settings'));
    expect(screen.getByText('SETTINGS-VIEW')).toBeTruthy();
    act(() => ipcHandlers['trigger-compile']());
    expect(screen.getByText('HOME-VIEW')).toBeTruthy();
    expect(captured.home?.compileNonce as number).toBeGreaterThan(before);
  });

  it('open-settings lands on the Settings section', async () => {
    bridge();
    await renderApp();
    act(() => ipcHandlers['open-settings']());
    expect(screen.getByText('SETTINGS-VIEW')).toBeTruthy();
  });

  it('the sources badge rides on the Rules item', async () => {
    bridge();
    await renderApp();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('button', { name: /Rules/ }).textContent).toContain('1/2');
  });
});
