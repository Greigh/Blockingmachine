/**
 * Settings is now preferences-only: exactly five cards (Appearance, Export
 * format, Save location, Startup, About) and no index nav — the feature
 * blocks that used to live here moved into the sections that own them.
 */

import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, render } from '@testing-library/react';

jest.unstable_mockModule('../components/BrandLogo', () => ({
  BrandLogo: () => null,
}));

const { default: Settings } = await import('../Settings');

function bridge(overrides: Record<string, unknown> = {}) {
  (window as unknown as { electron: unknown }).electron = {
    getTheme: jest.fn(async () => 'system'),
    getExportFormat: jest.fn(async () => 'adblock'),
    getSavePath: jest.fn(async () => '/tmp/out'),
    getLaunchAtLogin: jest.fn(async () => false),
    getFeedServerAutoStart: jest.fn(async () => false),
    getAppVersion: jest.fn(async () => '9.9.9'),
    checkForUpdates: jest.fn(async () => ({ status: 'latest' })),
    selectSavePath: jest.fn(async () => null),
    openExternal: jest.fn(async () => ({})),
    setTheme: jest.fn(async () => ({})),
    setExportFormat: jest.fn(async () => ({})),
    setLaunchAtLogin: jest.fn(async () => ({})),
    setFeedServerAutoStart: jest.fn(async () => ({})),
    showItemInFolder: jest.fn(async () => ({})),
    ...overrides,
  };
}

afterEach(cleanup);

describe('slim Settings', () => {
  it('renders exactly the five preference cards', () => {
    bridge();
    const { container } = render(
      <Settings currentTheme="system" onThemeChange={() => {}} />,
    );
    const cards = container.querySelectorAll('.setting-card');
    expect(cards).toHaveLength(5);
    expect([...cards].map((c) => c.id)).toEqual([
      'settings-appearance',
      'settings-export',
      'settings-location',
      'settings-startup',
      'about-community',
    ]);
  });

  it('has no index nav — five cards do not need one', () => {
    bridge();
    const { container } = render(
      <Settings currentTheme="system" onThemeChange={() => {}} />,
    );
    expect(container.querySelector('.settings-index')).toBeNull();
  });

  it('keeps the tour replay under About', () => {
    bridge();
    const onLaunch = jest.fn();
    const { container, getByRole } = render(
      <Settings
        currentTheme="system"
        onThemeChange={() => {}}
        onLaunchOnboarding={onLaunch}
      />,
    );
    const about = container.querySelector('#about-community');
    expect(about?.textContent).toContain('Replay welcome tour');
    getByRole('button', { name: 'Replay welcome tour' }).click();
    expect(onLaunch).toHaveBeenCalled();
  });
});
