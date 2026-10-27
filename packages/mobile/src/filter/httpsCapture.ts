/**
 * Hub HTTPS-capture surface (Android, P4): the local-VPN service splices TCP
 * :80/:443 onto a `protect()`ed socket to the hub's PROXY-v2 listener — the
 * engine then owns verdicts (SNI-level for every app; MITM content filtering
 * once the hub CA is installed on this device).
 *
 * This file is the pure-logic seam: IP-literal validation, the hub's persisted
 * address + last-confirmed CA fingerprint (AsyncStorage — same store family
 * the server list uses), the CA fetch, and URL building. The card keeps the
 * consent + KeyChain plumbing.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserError } from '../errors';

/** The hub engine's PROXY-v2 data listener — fixed convention (P3/P4). */
export const HUB_DATA_PORT = 9294;
/** The hub engine's /v1/proxy/* control listener. */
export const HUB_CONTROL_PORT = 9293;

const HUB_HOST_KEY = 'bm.httpsCapture.hubHost';
const CA_FINGERPRINT_KEY = 'bm.httpsCapture.caFingerprint';

/* ------------------------------------------------------------------ */
/* Hub address                                                         */
/* ------------------------------------------------------------------ */

/** Dotted-quad IPv4, each octet 0–255, no leading-zero octets. */
export function isValidIpv4(input: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(input);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255 && String(Number(o)) === o);
}

/**
 * IPv6 literal: 8 colon-separated hextets with at most one `::` compression
 * (which must stand for at least one group) and an optional embedded-IPv4
 * tail counting as the last two groups. No zone ids — a LAN hub address
 * doesn't need one.
 */
export function isValidIpv6(input: string): boolean {
  let s = input;
  if (!s || s.length > 45 || !s.includes(':')) return false;

  // Embedded IPv4 tail (e.g. ::ffff:192.0.2.1) — validate it, then treat it
  // as two ordinary hextets for the group count below.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isValidIpv4(tail)) return false;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return false;
  const groups = (h: string) => (h === '' ? [] : h.split(':'));
  const hextet = (g: string) => /^[0-9a-fA-F]{1,4}$/.test(g);
  for (const g of [...groups(halves[0]), ...(halves.length === 2 ? groups(halves[1]) : [])]) {
    if (!hextet(g)) return false;
  }
  if (halves.length === 1) return groups(halves[0]).length === 8;
  return groups(halves[0]).length + groups(halves[1]).length < 8;
}

/** The hub field accepts a numeric literal only — a DNS name can't be trusted to resolve the same way inside the tun. */
export function isValidIpLiteral(input: string): boolean {
  return isValidIpv4(input) || isValidIpv6(input);
}

/** `http://<hub>:9293<path>` — v6 literals need brackets around the host. */
export function hubControlUrl(host: string, path: string): string {
  const h = host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${HUB_CONTROL_PORT}${path}`;
}

/** Pull the host part out of a `scheme://host[:port]/…` URL, stripping v6 brackets. */
export function hostFromUrl(baseUrl: string): string | null {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(\[[0-9a-fA-F:]+\]|[^/:?#]+)/.exec(baseUrl.trim());
  return m ? m[1].replace(/^\[|\]$/g, '') : null;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

export async function loadHubHost(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(HUB_HOST_KEY);
  } catch {
    return null;
  }
}

export async function saveHubHost(host: string | null): Promise<void> {
  try {
    if (host) await AsyncStorage.setItem(HUB_HOST_KEY, host);
    else await AsyncStorage.removeItem(HUB_HOST_KEY);
  } catch {
    // Persistence is convenience, not correctness — a lost draft just re-asks.
  }
}

/**
 * The last CA fingerprint the user explicitly confirmed (at the install
 * prompt). Read on each fetch so a changed fingerprint shows as drift — the
 * CA arrives over cleartext LAN HTTP, so the confirm prompt is the only
 * authenticity check the flow has.
 */
export async function loadCaFingerprint(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(CA_FINGERPRINT_KEY);
  } catch {
    return null;
  }
}

export async function saveCaFingerprint(fingerprint: string | null): Promise<void> {
  try {
    if (fingerprint) await AsyncStorage.setItem(CA_FINGERPRINT_KEY, fingerprint);
    else await AsyncStorage.removeItem(CA_FINGERPRINT_KEY);
  } catch {
    // Same posture as the hub host — a lost record just re-warns next fetch.
  }
}

/* ------------------------------------------------------------------ */
/* Hub CA                                                              */
/* ------------------------------------------------------------------ */

export interface HubCa {
  certPem: string;
  sha256Fingerprint?: string;
  notAfter?: string;
}

/**
 * GET `http://<hub>:9293/v1/proxy/ca` — the engine's CA identity block
 * (`{certPem, sha256Fingerprint, notAfter, …}`). The control port stays on
 * the hub's loopback by design, so this only answers where that loopback is
 * reachable — a dev emulator's 10.0.2.2 today (flag 129).
 */
export async function fetchHubCa(
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubCa> {
  let res: Response;
  try {
    res = await fetchImpl(hubControlUrl(host, '/v1/proxy/ca'));
  } catch {
    throw new UserError(
      'The hub didn\u2019t answer — its control port stays on the hub\u2019s loopback by design, so CA install works on a dev emulator today (10.0.2.2). On a physical device, install the CA manually — export it on the hub (cert export). Tracked as flag 129.',
    );
  }
  if (!res.ok) {
    throw new UserError(`The hub couldn\u2019t send its CA (error ${res.status}) — is HTTPS filtering running there?`);
  }
  const body = (await res.json()) as {
    certPem?: unknown;
    sha256Fingerprint?: unknown;
    notAfter?: unknown;
  };
  if (typeof body.certPem !== 'string' || !body.certPem.includes('BEGIN CERTIFICATE')) {
    throw new UserError('The hub answered without a certificate — is HTTPS filtering running there?');
  }
  return {
    certPem: body.certPem,
    sha256Fingerprint: typeof body.sha256Fingerprint === 'string' ? body.sha256Fingerprint : undefined,
    notAfter: typeof body.notAfter === 'string' ? body.notAfter : undefined,
  };
}
