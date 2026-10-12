/**
 * Bonjour/mDNS advertisement for the LAN feed server.
 *
 * Publishing `_blockingmachine._tcp` while the feed server listens lets the mobile
 * app (and anything else on the LAN) find the hub without typing an address. The
 * TXT record carries `api=v1`, the app version, and `token=required|open` so a
 * client knows whether to prompt for a feed token before it ever probes a mutation.
 *
 * `bonjour-service` is a multicast responder on the main process — a failure to
 * publish (no multicast route, sandboxed network, second instance racing the
 * service name) is logged and swallowed: advertising is best-effort chrome around
 * the feed, never a reason the feed server itself should fail to start.
 *
 * A module of its own for the same reason `feedAuth` is: `index.ts` cannot be
 * imported in a test, and "what goes in the TXT record" deserves a pinned answer.
 */

import { hostname as osHostname } from 'os';

export interface AdvertiseHandle {
  stop: () => void;
}

export const MDNS_SERVICE_TYPE = 'blockingmachine';
export const MDNS_PROTOCOL = 'tcp';

/**
 * The hostname the advert's A/AAAA records claim on the wire.
 *
 * bonjour-service defaults `host` to `os.hostname()` — the machine's own
 * LocalHostName — and unconditionally publishes A/AAAA records for it. That is a
 * second responder claiming `Daniels-MacBook-Pro.local`: macOS re-verifies its
 * hostname on wake/join, sees the advert answer for the name, declares a
 * collision and renames the machine (`…-2.local`, then `-3`…). The advert must
 * claim a dedicated name instead: `…-bm.local` still resolves to this machine's
 * addresses for the SRV target, stays unique per machine, and never fights the
 * system's own record.
 */
export function mdnsServiceHost(hostname: string = osHostname()): string {
  const stripped = hostname.replace(/\.local\.?$/i, '').split('.')[0];
  const safe = stripped.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 55);
  return `${safe || 'hub'}-bm.local`;
}

export interface AdvertiseOptions {
  /** Port the feed server listens on. */
  port: number;
  /** App version for the TXT record. */
  version: string;
  /** Whether feedToken is configured — maps to `token=required|open`. */
  tokenRequired: boolean;
  /** Instance name override (tests). */
  name?: string;
  /** Hostname for the advert's A/AAAA records — defaults to `mdnsServiceHost()`
   * (never the machine's LocalHostName, which it must not claim). */
  host?: string;
}

/** TXT record contents — exported so tests pin the wire contract. */
export function advertiseTxt(opts: Pick<AdvertiseOptions, 'version' | 'tokenRequired'>): Record<string, string> {
  return {
    api: 'v1',
    version: opts.version,
    token: opts.tokenRequired ? 'required' : 'open',
  };
}

interface BonjourLike {
  publish: (opts: {
    name: string;
    type: string;
    protocol: string;
    port: number;
    host?: string;
    txt: Record<string, string>;
  }) => { stop: () => void };
  destroy: () => void;
}

function loadBonjour(): (() => BonjourLike) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('bonjour-service');
    const Bonjour = mod?.default ?? mod?.Bonjour ?? mod;
    if (typeof Bonjour !== 'function') return null;
    return () => new Bonjour() as BonjourLike;
  } catch {
    return null;
  }
}

/**
 * Publish the service. Returns a handle whose `stop` unpublishes; returns a no-op
 * handle when bonjour-service isn't loadable so callers never branch on failure.
 */
export function advertiseFeedServer(opts: AdvertiseOptions): AdvertiseHandle {
  const create = loadBonjour();
  if (!create) {
    console.warn('[mDNS] bonjour-service unavailable — feed server not advertised');
    return { stop: () => {} };
  }
  try {
    const bonjour = create();
    const service = bonjour.publish({
      name: opts.name ?? 'Blockingmachine Hub',
      type: MDNS_SERVICE_TYPE,
      protocol: MDNS_PROTOCOL,
      port: opts.port,
      host: opts.host ?? mdnsServiceHost(),
      txt: advertiseTxt(opts),
    });
    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          service.stop();
        } catch {
          // multicast teardown races are unremarkable
        }
        try {
          bonjour.destroy();
        } catch {
          // same
        }
      },
    };
  } catch (err: any) {
    console.warn('[mDNS] Advertisement failed:', err?.message || err);
    return { stop: () => {} };
  }
}
