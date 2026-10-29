/**
 * `app/(tabs)/telemetry.tsx` — regression: with no hub server configured the
 * screen showed the "Add a server" empty state AND a "Cannot read property
 * 'getTelemetry' of null" error card. Cause: `queryFn` dereferenced `client!`,
 * and React Query's `refetch()` ignores `enabled: !!client` — pull-to-refresh
 * and the banner's retry both ran the fetcher on a null client. The query now
 * resolves null instead and onRefresh early-returns.
 */

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ServerProvider, type KeyValueStore, type SecretStore } from '../state/servers';
import TelemetryScreen from '../../app/(tabs)/telemetry';

jest.mock('expo-router', () => ({
  usePathname: () => '/telemetry',
}));

jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return {
    ...actual,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../hooks/useEvents', () => ({
  useServerEvents: () => ({ alert: null, recent: [], dismissAlert: jest.fn() }),
}));

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

describe('TelemetryScreen without a configured hub', () => {
  it('shows the empty state and pull-to-refresh does not error on a null client', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await render(
      <QueryClientProvider client={queryClient}>
        <ServerProvider kv={memoryKv()} secrets={memorySecrets()}>
          <TelemetryScreen />
        </ServerProvider>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('Add a server in Settings first.')).toBeTruthy(),
    );

    // observer.refetch() is the exact call pull-to-refresh and the banner's
    // retry make — it runs queryFn even while `enabled` is false (the bug's
    // path). Assert on the settled result, not a DOM poll — an error state
    // re-renders later than a no-error assertion can observe, so a negative
    // DOM check alone races green.
    const query = queryClient.getQueryCache().find({ queryKey: ['telemetry', 'none'] });
    expect(query?.observers.length).toBeGreaterThan(0);
    let result: { status: string; error: unknown } | undefined;
    await act(async () => {
      result = await query!.observers[0].refetch();
    });
    expect(result?.status).toBe('success');
    expect(result?.error).toBeNull();
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect(screen.getByText('Add a server in Settings first.')).toBeTruthy();
  });
});
