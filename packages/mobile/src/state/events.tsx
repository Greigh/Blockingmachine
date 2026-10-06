/**
 * App-wide SSE subscription to the active server's /v1/events stream.
 *
 * Lives at the root (above the tab navigator) so the stream stays open while the
 * user moves between tabs — previously the subscription was owned by the
 * dashboard screen, which meant events only landed while that tab happened to be
 * mounted. Two jobs:
 *
 * 1. Fold known event names into TanStack Query invalidation so every view
 *    refreshes the moment the hub broadcasts rather than waiting for a poll.
 * 2. Surface events a user should see even from another tab (today:
 *    `quarantine_added`) as an in-app alert the dashboard renders.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeEvents } from '../api/sse';
import { useServers } from './servers';

/** Every event name the hub currently broadcasts (packages/electron-app/src/index.ts). */
const INVALIDATING_EVENTS = new Set([
  'compile_completed',
  'rules_updated',
  'remote_control',
  'quarantine_added',
]);

/** Events that produce a visible alert rather than a silent refresh. */
const ALERT_EVENTS = new Set(['quarantine_added']);

export interface ServerEventAlert {
  event: string;
  /** Decoded SSE `data:` JSON — e.g. `{count, domains}` for quarantine_added. */
  data: Record<string, unknown>;
  at: number;
}

const MAX_RECENT = 30;

interface ServerEventsState {
  connected: boolean;
  alert: ServerEventAlert | null;
  /** Rolling buffer of every hub broadcast, newest first — the activity feed. */
  recent: ServerEventAlert[];
  dismissAlert: () => void;
}

const ServerEventsContext = createContext<ServerEventsState>({
  connected: false,
  alert: null,
  recent: [],
  dismissAlert: () => {},
});

function decodeEventData(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function ServerEventsProvider({ children }: { children: React.ReactNode }) {
  const { activeServer, activeToken } = useServers();
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [alert, setAlert] = useState<ServerEventAlert | null>(null);
  const [recent, setRecent] = useState<ServerEventAlert[]>([]);
  const baseUrl = activeServer?.baseUrl ?? null;

  useEffect(() => {
    if (!baseUrl) {
      setConnected(false);
      return;
    }
    setConnected(false);
    setAlert(null);
    setRecent([]);
    const sub = subscribeEvents(
      baseUrl,
      {
        onOpen: () => setConnected(true),
        onEvent: (event) => {
          if (INVALIDATING_EVENTS.has(event.event)) {
            void queryClient.invalidateQueries({ queryKey: ['status', baseUrl] });
            void queryClient.invalidateQueries({ queryKey: ['telemetry', baseUrl] });
            void queryClient.invalidateQueries({ queryKey: ['protection', baseUrl] });
          }
          const decoded: ServerEventAlert = {
            event: event.event,
            data: decodeEventData(event.data),
            at: Date.now(),
          };
          setRecent((prev) => [decoded, ...prev].slice(0, MAX_RECENT));
          if (ALERT_EVENTS.has(event.event)) {
            setAlert(decoded);
          }
        },
        onError: () => setConnected(false),
      },
      // Token changes must reconnect — a 401 stops the loop, so the corrected
      // token only takes effect on a fresh subscription.
      { token: activeToken },
    );
    return () => sub.stop();
  }, [baseUrl, activeToken, queryClient]);

  return (
    <ServerEventsContext.Provider
      value={{ connected, alert, recent, dismissAlert: () => setAlert(null) }}
    >
      {children}
    </ServerEventsContext.Provider>
  );
}

export function useServerEventsState(): ServerEventsState {
  return useContext(ServerEventsContext);
}
