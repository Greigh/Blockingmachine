/**
 * mDNS discovery for `_blockingmachine._tcp` advertisers on the LAN.
 *
 * `react-native-zeroconf` is a native module — unavailable inside Expo Go and inside
 * jest — so it is required lazily and any resolution failure degrades discovery to
 * "unavailable" rather than crashing the settings screen. The rest of the app
 * (manual entry, QR pairing) never touches it.
 */

export interface DiscoveredServer {
  /** mDNS instance name, e.g. "Blockingmachine Hub on macbook". */
  name: string;
  host: string;
  port: number;
  /** All advertised addresses (v4 + v6 as the resolver reports them). */
  addresses: string[];
  /** Parsed TXT record: api, version, token=required|open. */
  txt: {
    api?: string;
    version?: string;
    token?: 'required' | 'open' | string;
  };
}

export interface DiscoverySession {
  stop: () => void;
}

export interface DiscoveryHandlers {
  onFound: (server: DiscoveredServer) => void;
  onRemove?: (name: string) => void;
  onError?: (error: Error) => void;
}

const SERVICE_TYPE = 'blockingmachine';
const SERVICE_PROTOCOL = 'tcp';
const SERVICE_DOMAIN = 'local.';

interface ZeroconfService {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
  fullName?: string;
}

interface ZeroconfModule {
  scan: (type?: string, protocol?: string, domain?: string) => void;
  stop: () => void;
  on: (event: string, cb: (...args: any[]) => void) => void;
  removeListener?: (event: string, cb: (...args: any[]) => void) => void;
}

function loadZeroconf(): ZeroconfModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-zeroconf');
    return (mod?.default ?? mod) as ZeroconfModule;
  } catch {
    return null;
  }
}

export function isDiscoveryAvailable(): boolean {
  return loadZeroconf() !== null;
}

function toDiscovered(svc: ZeroconfService): DiscoveredServer | null {
  const addresses = (svc.addresses ?? []).filter((a) => typeof a === 'string' && a.length > 0);
  const host = svc.host ?? addresses[0];
  if (!host || typeof svc.port !== 'number' || svc.port <= 0) return null;
  const txt = (svc.txt ?? {}) as DiscoveredServer['txt'];
  return {
    name: svc.name ?? svc.fullName ?? host,
    host,
    port: svc.port,
    addresses,
    txt: { api: txt.api, version: txt.version, token: txt.token },
  };
}

/**
 * Browse for Blockingmachine advertisers until stopped. Emits one `onFound` per
 * resolved service; the dedupe set is the caller's concern (the server list keys
 * on host:port anyway).
 */
export function browseServers(handlers: DiscoveryHandlers): DiscoverySession {
  const zeroconf = loadZeroconf();
  if (!zeroconf) {
    handlers.onError?.(new Error('mDNS discovery requires the dev-client build (not Expo Go)'));
    return { stop: () => {} };
  }

  const resolved = (svc: ZeroconfService) => {
    const server = toDiscovered(svc);
    if (server) handlers.onFound(server);
  };
  const removed = (svc: ZeroconfService) => {
    const name = svc?.name ?? svc?.fullName;
    if (name) handlers.onRemove?.(name);
  };
  const onError = (err: unknown) => {
    handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
  };

  zeroconf.on('resolved', resolved);
  zeroconf.on('remove', removed);
  zeroconf.on('error', onError);
  try {
    zeroconf.scan(SERVICE_TYPE, SERVICE_PROTOCOL, SERVICE_DOMAIN);
  } catch (err) {
    onError(err);
  }

  return {
    stop: () => {
      try {
        zeroconf.stop();
      } catch {
        // already stopped — nothing to undo
      }
      zeroconf.removeListener?.('resolved', resolved);
      zeroconf.removeListener?.('remove', removed);
      zeroconf.removeListener?.('error', onError);
    },
  };
}
