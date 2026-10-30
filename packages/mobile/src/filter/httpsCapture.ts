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
import * as SecureStore from 'expo-secure-store';
import { Buffer } from 'buffer';
import { UserError } from '../errors';
import { sha256 } from './sha256';

/** The hub engine's PROXY-v2 data listener — fixed convention (P3/P4). */
export const HUB_DATA_PORT = 9294;
/** The hub engine's /v1/proxy/* control listener (loopback-only on the hub). */
export const HUB_CONTROL_PORT = 9293;

const HUB_HOST_KEY = 'bm.httpsCapture.hubHost';
const HUB_PORT_KEY = 'bm.httpsCapture.hubPort';
const hubTokenKey = (host: string) => `bm.httpsCapture.hubToken.${host}`;
const CA_FINGERPRINT_KEY = 'bm.httpsCapture.caFingerprint';
const PAIRED_CA_PEM_KEY = 'bm.httpsCapture.pairedCaPem';
const PAIRED_CA_SHA256_KEY = 'bm.httpsCapture.pairedCaSha256';

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

/**
 * `http://<hub>:<port><path>` for the data listener (:9294 by default — the
 * PROXY-v2 splice port doubles as the read-only `/v1/proxy/ca.pem` host for
 * flag 129, since the control port never leaves the hub's loopback). `port`
 * lets the card honour the port the QR advertised.
 */
export function hubDataUrl(host: string, path: string, port: number = HUB_DATA_PORT): string {
  const h = host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${port}${path}`;
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
 * The hub's data-port override — unset means the :9294 convention. Pairing
 * writes this when the QR names a port, so every later call honours it.
 */
export async function loadHubPort(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(HUB_PORT_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

export async function saveHubPort(port: number | null): Promise<void> {
  try {
    if (port) await AsyncStorage.setItem(HUB_PORT_KEY, String(port));
    else await AsyncStorage.removeItem(HUB_PORT_KEY);
  } catch {
    // Same posture as the host — convenience persistence.
  }
}

/**
 * The flag-127 data-port token — the hub's splice listener requires it from
 * non-loopback peers when configured; it rides the QR as `httpsToken` and
 * goes into the PROXY-v2 auth TLV on every captured connection. It's a
 * credential, so it lives in SecureStore like the feed token — and keyed by
 * hub host so a retargeted capture can never send one hub's token to another
 * machine.
 */
export async function loadHubToken(host: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(hubTokenKey(host));
  } catch {
    return null;
  }
}

export async function saveHubToken(host: string, token: string | null): Promise<void> {
  try {
    if (token) await SecureStore.setItemAsync(hubTokenKey(host), token);
    else await SecureStore.deleteItemAsync(hubTokenKey(host));
  } catch {
    // Convenience persistence — a lost token just means re-pairing.
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
  /** SHA-256 over the certificate DER, `AA:BB:…` uppercase — always set. */
  sha256Fingerprint: string;
  notAfter?: string;
}

/**
 * The PEM body from `/v1/proxy/ca.pem`, DER bytes, or null when the string
 * doesn't parse as a single PEM certificate block.
 */
export function pemToDer(certPem: string): Uint8Array | null {
  const m = /-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\r\n]+?)\s*-----END CERTIFICATE-----/.exec(
    certPem,
  );
  if (!m) return null;
  try {
    return new Uint8Array(Buffer.from(m[1].replace(/\s+/g, ''), 'base64'));
  } catch {
    return null;
  }
}

/**
 * `AA:BB:…` uppercase-colon SHA-256 of the certificate DER — the same
 * rendering the hub card shows (Node's `X509Certificate.fingerprint256`),
 * so the phone and the desktop display the same string for the same CA.
 */
export function fingerprintOfPem(certPem: string): string | null {
  const der = pemToDer(certPem);
  if (!der || der.length === 0) return null;
  return [...sha256(der)]
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

/**
 * GET `http://<hub>:<port>/v1/proxy/ca.pem` — the flag-129 read-only CA
 * surface on the data listener. The port defaults to :9294 and honours the
 * value the QR advertised (paired hubs may have moved it). The fingerprint
 * is computed locally from the PEM body — the LAN answer carries no trust
 * of its own, so the hash the user confirms is one this device derived.
 */
export async function fetchHubCa(
  host: string,
  fetchImpl: typeof fetch = fetch,
  port: number = HUB_DATA_PORT,
): Promise<HubCa> {
  let res: Response;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 20_000);
  try {
    res = await fetchImpl(hubDataUrl(host, '/v1/proxy/ca.pem', port), { signal: timeout.signal });
  } catch {
    throw new UserError(
      'The hub didn\u2019t answer on its data port — is HTTPS filtering running there, and is this phone on the same network?',
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new UserError(`The hub couldn\u2019t send its CA (error ${res.status}) — is HTTPS filtering running there?`);
  }
  const certPem = await res.text();
  if (typeof certPem !== 'string' || !certPem.includes('BEGIN CERTIFICATE')) {
    throw new UserError('The hub answered without a certificate — is HTTPS filtering running there?');
  }
  const sha256Fingerprint = fingerprintOfPem(certPem);
  if (!sha256Fingerprint) {
    throw new UserError('The hub sent a malformed CA certificate — refusing to install it.');
  }
  return { certPem, sha256Fingerprint };
}

/**
 * The CA the QR carried (flag 129): persisted so pairing alone can offer an
 * install without any LAN fetch. `loadPairedCa` re-verifies the stored PEM
 * against the stored fingerprint — a tampered store answers null rather
 * than a mismatched pair.
 */
export interface PairedCa {
  certPem: string;
  sha256Fingerprint: string;
}

export async function savePairedCa(ca: PairedCa | null): Promise<void> {
  try {
    if (ca) {
      await AsyncStorage.setItem(PAIRED_CA_PEM_KEY, ca.certPem);
      await AsyncStorage.setItem(PAIRED_CA_SHA256_KEY, ca.sha256Fingerprint);
    } else {
      await AsyncStorage.removeItem(PAIRED_CA_PEM_KEY);
      await AsyncStorage.removeItem(PAIRED_CA_SHA256_KEY);
    }
  } catch {
    // Convenience persistence — a lost paired CA just means re-fetch/re-pair.
  }
}

export async function loadPairedCa(): Promise<PairedCa | null> {
  try {
    const [certPem, declared] = await Promise.all([
      AsyncStorage.getItem(PAIRED_CA_PEM_KEY),
      AsyncStorage.getItem(PAIRED_CA_SHA256_KEY),
    ]);
    if (!certPem || !declared) return null;
    const actual = fingerprintOfPem(certPem);
    const norm = (v: string) => v.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (!actual || norm(actual) !== norm(declared)) return null;
    return { certPem, sha256Fingerprint: declared.trim().toUpperCase() };
  } catch {
    return null;
  }
}
