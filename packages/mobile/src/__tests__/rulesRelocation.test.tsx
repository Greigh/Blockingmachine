/**
 * Task 4 relocation audit — the corpus cards (standalone filter feeds, hub
 * filter sources + custom rules) moved from Settings into the Rules tab,
 * leaving Settings a five-surface connection/preferences sheet. Source scans
 * pin where each identifier lives; the mount test covers the screen shell.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as fs from 'fs';
import * as path from 'path';
import { ServerProvider, type KeyValueStore, type SecretStore } from '../state/servers';
import { FilterProvider } from '../state/filter';
import RulesScreen from '../../app/(tabs)/rules';

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

const rulesSrc = readSrc('app/(tabs)/rules.tsx');
const settingsSrc = readSrc('app/settings.tsx');

const MOVED = ['FilterFeedsCard', 'HubSourcesCard'];

describe('Rules tab relocation', () => {
  it('defines both corpus cards — custom rules ride inside HubSourcesCard', () => {
    for (const card of MOVED) {
      expect(rulesSrc).toContain(`function ${card}(`);
    }
    expect(rulesSrc).toContain('label="Custom rules"');
    expect(rulesSrc).toContain('label="Hub filter sources"');
    expect(rulesSrc).toContain('label="Filter feeds"');
  });

  it('mounts them in the screen', () => {
    expect(rulesSrc).toContain('<FilterFeedsCard');
    expect(rulesSrc).toContain('client ? <HubSourcesCard');
  });

  it('settings keeps none of the moved identifiers', () => {
    for (const card of MOVED) {
      expect(settingsSrc).not.toContain(card);
    }
    expect(settingsSrc).not.toContain('label="Custom rules"');
    expect(settingsSrc).not.toContain('label="Filter feeds"');
  });
});

describe('Settings slimmed to connection and preferences', () => {
  it('retains exactly the five surviving surfaces', () => {
    for (const label of [
      'label="Servers"',
      'label="Feed token"',
      'label="Feed URLs"',
      'label="Hub HTTPS pins"',
      'label="Docs"',
    ]) {
      expect(settingsSrc).toContain(label);
    }
    // No feature cards left behind.
    for (const gone of [
      'On-device filter',
      'HTTPS capture',
      'Local DNS service',
      'Standalone filter',
      'Per-app bypass',
      'Web filtering via hub',
    ]) {
      expect(settingsSrc).not.toContain(gone);
    }
  });
});

describe('RulesScreen mount', () => {
  it('renders with no hub configured', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await render(
      <QueryClientProvider client={queryClient}>
        <ServerProvider kv={memoryKv()} secrets={memorySecrets()}>
          <FilterProvider>
            <RulesScreen />
          </FilterProvider>
        </ServerProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Rules')).toBeTruthy();
  });
});
