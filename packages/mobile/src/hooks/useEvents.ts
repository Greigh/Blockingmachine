/**
 * Live-update hook: subscribes to the active server's /v1/events stream and folds
 * known event names into TanStack Query invalidation, so the dashboard, telemetry
 * and protection views refresh the moment the hub broadcasts rather than waiting
 * for the next poll. A dropped stream retries with backoff inside subscribeEvents;
 * `connected` reflects the transport so the UI can show a live/offline hint.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeEvents } from '../api/sse';
import { useServers } from '../state/servers';

const INVALIDATING_EVENTS = new Set([
  'compile_completed',
  'rules_updated',
  'remote_control',
  'protection_changed',
  'quarantine_added',
]);

export function useServerEvents(): { connected: boolean } {
  const { activeServer, activeToken } = useServers();
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const baseUrl = activeServer?.baseUrl ?? null;
  const tokenRef = useRef(activeToken);
  tokenRef.current = activeToken;

  useEffect(() => {
    if (!baseUrl) return;
    setConnected(false);
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
        },
        onError: () => setConnected(false),
      },
      { token: tokenRef.current },
    );
    return () => sub.stop();
  }, [baseUrl, queryClient]);

  return { connected };
}
