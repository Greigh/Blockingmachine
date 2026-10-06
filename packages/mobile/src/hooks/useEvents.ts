/**
 * Live-update hook: reads the app-wide /v1/events subscription owned by
 * ServerEventsProvider (mounted above the tab navigator, so the stream survives
 * tab switches). `connected` reflects the transport for the live/offline pill;
 * `alert` carries events worth surfacing across tabs (quarantine_added today).
 */

export {
  useServerEventsState as useServerEvents,
  type ServerEventAlert,
} from '../state/events';
