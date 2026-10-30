/**
 * Task 3 relocation audit — the this-phone filtering cards moved out of the
 * Settings scroll into the Protect tab. Source-level pins because the cards
 * exercise native modules that jest cannot host; the scan is the contract
 * that nothing was stranded or duplicated.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as fs from 'fs';
import * as path from 'path';
import { ServerProvider, type KeyValueStore, type SecretStore } from '../state/servers';
import { FilterProvider } from '../state/filter';
import ProtectScreen from '../../app/(tabs)/protect';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return {
    ...actual,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../components/GlassBackdrop', () => ({
  GlassBackdrop: () => null,
}));

const memoryKv = (): KeyValueStore => ({
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
});

const memorySecrets = (): SecretStore => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
});

const pkgRoot = path.resolve(__dirname, '..', '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(pkgRoot, rel), 'utf8');

const protectSrc = readSrc('app/(tabs)/protect.tsx');
const settingsSrc = readSrc('app/settings.tsx');
const layoutSrc = readSrc('app/(tabs)/_layout.tsx');

const MOVED_CARDS = [
  'LocalFilterCard',
  'HttpsCaptureCard',
  'IosTunnelCard',
  'IosHubFilterCard',
  'LocalDnsCard',
  'PerAppBypassCard',
  'StandaloneFilterCard',
];

describe('Protect tab relocation', () => {
  it('defines every moved this-phone card', () => {
    for (const card of MOVED_CARDS) {
      expect(protectSrc).toContain(`function ${card}(`);
    }
  });

  it('mounts the cards under the platform gates they had in Settings', () => {
    expect(protectSrc).toContain('isLocalVpnSupported() ? <LocalFilterCard');
    expect(protectSrc).toContain('isLocalVpnSupported() ? <HttpsCaptureCard');
    expect(protectSrc).toContain('isLocalVpnSupported() ? <PerAppBypassCard');
    expect(protectSrc).toContain('isIosTunnelSupported() ? <IosTunnelCard');
    expect(protectSrc).toContain("Platform.OS === 'ios' ? <IosHubFilterCard");
    expect(protectSrc).toContain('<LocalDnsCard');
    expect(protectSrc).toContain('<StandaloneFilterCard');
  });

  it('settings keeps none of the moved identifiers', () => {
    for (const card of MOVED_CARDS) {
      expect(settingsSrc).not.toContain(card);
    }
  });

  it('both screens share the one StyleSheet', () => {
    expect(protectSrc).toContain('screenStyles');
    expect(settingsSrc).toContain('screenStyles');
    expect(protectSrc).not.toContain('StyleSheet.create');
    expect(settingsSrc).not.toContain('StyleSheet.create');
  });

  it('the protect tab is wired into the tab layout', () => {
    expect(layoutSrc).toContain('tab.route');
    const routes = readSrc('src/routes.ts');
    expect(routes).toContain("'protect'");
  });

  it('mounts with no hub configured — platform-gated cards stay hidden on jest', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await render(
      <QueryClientProvider client={queryClient}>
        <ServerProvider kv={memoryKv()} secrets={memorySecrets()}>
          <FilterProvider>
            <ProtectScreen />
          </FilterProvider>
        </ServerProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Protect')).toBeTruthy();
    expect(screen.getByText(/rules feed comes from a hub/)).toBeTruthy();
  });
});
