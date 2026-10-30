/**
 * Five-tab shell contract: ScreenHeader's gear pushes the settings route, and
 * the navigator surfaces (Tabs layout + SideNav) render from the routes
 * registry rather than a parallel destination list. The layout scans are
 * source-level because the registry's purpose — one vocabulary — is only
 * checkable where the markup lives.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as fs from 'fs';
import * as path from 'path';
import { ScreenHeader } from '../components/ScreenHeader';
import { SETTINGS_ROUTE } from '../routes';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));


const pkgRoot = path.resolve(__dirname, '..', '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(pkgRoot, rel), 'utf8');

describe('ScreenHeader', () => {
  it('renders the title and subtitle', async () => {
    await render(<ScreenHeader title="Rules" subtitle="Edit the corpus" />);
    expect(screen.getByText('Rules')).toBeTruthy();
    expect(screen.getByText('Edit the corpus')).toBeTruthy();
  });

  it('pushes the settings route from the gear', async () => {
    await render(<ScreenHeader title="Home" />);
    fireEvent.press(screen.getByLabelText('Settings'));
    expect(mockPush).toHaveBeenCalledWith(SETTINGS_ROUTE);
  });
});

describe('tabs layout registry contract', () => {
  const layout = readSrc('app/(tabs)/_layout.tsx');

  it('declares Tabs.Screens by mapping the registry, with no settings tab', () => {
    expect(layout).toContain("from '../../src/routes'");
    expect(layout).toContain('name={tab.route}');
    expect(layout).not.toContain('name="settings"');
    expect(layout).not.toContain('name="index"');
  });
});

describe('SideNav registry contract', () => {
  const sideNav = readSrc('src/components/SideNav.tsx');

  it('renders destinations from the routes registry', () => {
    expect(sideNav).toContain("from '../routes'");
  });

  it('still offers the settings destination', () => {
    expect(sideNav).toContain("'/settings'");
  });
});

describe('settings route relocation', () => {
  it('settings lives as a pushed route, not inside the tab group', () => {
    expect(fs.existsSync(path.join(pkgRoot, 'app', 'settings.tsx'))).toBe(true);
    expect(
      fs.existsSync(path.join(pkgRoot, 'app', '(tabs)', 'settings.tsx')),
    ).toBe(false);
  });
});
