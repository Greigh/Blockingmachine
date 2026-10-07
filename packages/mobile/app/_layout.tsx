/**
 * Root layout: providers around the whole app — TanStack Query for server state,
 * ServerProvider for the saved-hub registry — then the Stack holding the tab
 * navigator plus the add-server modal.
 */

import React, { useMemo } from 'react';
import { DarkTheme, ThemeProvider } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { ServerProvider } from '../src/state/servers';
import { ServerEventsProvider } from '../src/state/events';
import { FilterProvider } from '../src/state/filter';
import { colors } from '../src/theme';

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.card,
    primary: colors.accent,
    text: colors.text,
    border: colors.cardBorder,
  },
};

export default function RootLayout() {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            retry: 1,
          },
        },
      }),
    [],
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ServerProvider kv={AsyncStorage} secrets={SecureStore}>
          <FilterProvider>
        <ServerEventsProvider>
          <ThemeProvider value={navTheme}>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.card },
              headerTintColor: colors.text,
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen
              name="add-server"
              options={{ title: 'Add Server', presentation: 'modal' }}
            />
          </Stack>
          </ThemeProvider>
        </ServerEventsProvider>
          </FilterProvider>
        </ServerProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
