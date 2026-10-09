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
  /** Advertised hostname (e.g. `daniels-macbook-pro-3.local.`) — display only. */
  host: string;
  /**
   * The address to actually fetch. Android's HTTP stack cannot resolve `.local`
   * names (mDNS is only reachable via NsdManager, which `fetch` never touches),
   * so dialing `host` dies with UnknownHostException on Android — use this.
   */
  connectHost: string;
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

let zeroconfInstance: ZeroconfModule | null | undefined;

function loadZeroconf(): ZeroconfModule | null {
  if (zeroconfInstance !== undefined) return zeroconfInstance;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-zeroconf');
    // v0.17+ exports the Zeroconf *class* as default — older releases exported a
    // singleton. The constructor throws when the native module isn't linked, so
    // instantiating here doubles as the availability check. Cached: each instance
    // registers DeviceEventEmitter listeners, so repeated construction leaks them.
    const Klass = (mod?.default ?? mod) as new () => ZeroconfModule;
    zeroconfInstance = new Klass();
  } catch {
    zeroconfInstance = null;
  }
  return zeroconfInstance;
}

export function isDiscoveryAvailable(): boolean {
  return loadZeroconf() !== null;
}

/**
 * Pick the address to dial for a discovered service. IPv4 first (always valid
 * in a URL), then a bracketed IPv6 literal, then the raw hostname — last is the
 * only choice on iOS when resolution returned no addresses, since `.local` does
 * resolve there.
 */
export function pickConnectHost(host: string, addresses: string[]): string {
  const ipv4 = addresses.find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
  if (ipv4) return ipv4;
  const ipv6 = addresses.find((a) => a.includes(':'));
  return ipv6 ? `[${ipv6}]` : host;
}

function toDiscovered(svc: ZeroconfService): DiscoveredServer | null {
  const addresses = (svc.addresses ?? []).filter((a) => typeof a === 'string' && a.length > 0);
  const host = svc.host ?? addresses[0];
  if (!host || typeof svc.port !== 'number' || svc.port <= 0) return null;
  // TXT arrives either as a record or as [key, value] pairs depending on the
  // resolver path — normalize to a record before reading token/version.
  const rawTxt = svc.txt;
  const txt: Record<string, unknown> = Array.isArray(rawTxt)
    ? Object.fromEntries(rawTxt as [string, unknown][])
    : ((rawTxt ?? {}) as Record<string, unknown>);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    name: svc.name ?? svc.fullName ?? host,
    host,
    connectHost: pickConnectHost(host, addresses),
    port: svc.port,
    addresses,
    txt: { api: str(txt.api), version: str(txt.version), token: str(txt.token) },
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
    handlers.onError?.(new Error('Network discovery needs the dev-client build — use manual entry or QR instead.'));
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
