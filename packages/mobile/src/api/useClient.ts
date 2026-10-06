/**
 * Builds a BlockingmachineClient for the currently active server, memoized on
 * (baseUrl, token). Returns null when nothing is configured — screens branch on
 * that to show the empty state rather than a spinner forever.
 */

import { useMemo } from 'react';
import { BlockingmachineClient } from './client';
import { useServers } from '../state/servers';

export function useClient(): BlockingmachineClient | null {
  const { activeServer, activeToken } = useServers();
  return useMemo(
    () =>
      activeServer
        ? new BlockingmachineClient({
            baseUrl: activeServer.baseUrl,
            token: activeToken || undefined,
          })
        : null,
    [activeServer, activeToken],
  );
}
