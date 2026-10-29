/**
 * Live-update hook: reads the app-wide /v1/events subscription owned by
 * ServerEventsProvider (mounted above the tab navigator, so the stream survives
 * tab switches). `connected` reflects the transport for the live/offline pill;
 * `alert` carries events worth surfacing across tabs (quarantine_added today).
 */

import { useServerEventsState } from '../state/events';

export {
  useServerEventsState as useServerEvents,
  type ServerEventAlert,
} from '../state/events';

/**
 * The quarantine count every nav surface badges with — the floating pill's
 * tabBarBadge on compact, the rail/sidebar badge on the wide tiers. A numeric
 * count stays a count; a count-less broadcast degrades to '!'.
 */
export function useQuarantineBadge(): number | '!' | undefined {
  const { alert } = useServerEventsState();
  return alert?.event === 'quarantine_added'
    ? typeof alert.data.count === 'number'
      ? alert.data.count
      : '!'
    : undefined;
}
