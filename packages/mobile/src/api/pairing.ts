/**
 * QR pairing payload decode/validation. The desktop app renders a QR containing
 * JSON: {"v":1,"url":"http://<lanip>:9191","token":"<feedToken>"}. The token key is
 * present only when the hub has one configured — an absent token is a valid payload
 * describing an open LAN server, not a broken QR.
 */

import { normalizeBaseUrl } from './client';

export interface PairingPayload {
  url: string;
  /** Alternate LAN URLs for the same hub — emitted when the desktop host is
   *  multi-homed (VPN, Docker bridges) and the first interface may be wrong. */
  urls?: string[];
  token?: string;
  /** Flag 129 — the hub's HTTPS-filter CA, so pairing alone can install it. */
  httpsCaPem?: string;
  /** The hub-rendered SHA-256 fingerprint of `httpsCaPem` (`AA:BB:…`). */
  httpsCaSha256?: string;
  /** Flag 127 — the data-port token the splice listener demands, when set. */
  httpsToken?: string;
  /** The data-port override when the hub moved it off :9294. */
  httpsPort?: number;
}

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingError';
  }
}

/**
 * Decode a scanned QR string into a validated payload. Throws PairingError on
 * anything that isn't a Blockingmachine pairing code, so a random QR (a URL, a
 * Wi-Fi code) fails loud rather than saving a garbage server entry.
 */
export function decodePairingPayload(raw: string): PairingPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PairingError('That QR code isn\u2019t a Blockingmachine pairing code.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PairingError('That QR code isn\u2019t a Blockingmachine pairing code.');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) {
    throw new PairingError('This pairing code is from a different app version — update the desktop app and scan again.');
  }
  if (typeof obj.url !== 'string' || !obj.url.trim()) {
    throw new PairingError('This pairing code is incomplete — re-generate it in the desktop app.');
  }
  let url: string;
  try {
    url = normalizeBaseUrl(obj.url);
  } catch {
    throw new PairingError('This pairing code has a bad address — re-generate it in the desktop app.');
  }
  // Bad alternates are dropped rather than failing the whole scan — `url` alone
  // still pins a working payload, matching what older desktop builds emit.
  const urls = Array.isArray(obj.urls)
    ? obj.urls
        .map((u) => {
          try {
            return typeof u === 'string' ? normalizeBaseUrl(u) : null;
          } catch {
            return null;
          }
        })
        .filter((u): u is string => !!u)
    : undefined;
  const token =
    typeof obj.token === 'string' && obj.token.trim() ? obj.token.trim() : undefined;
  const optStr = (k: string): string | undefined =>
    typeof obj[k] === 'string' && obj[k].trim() ? (obj[k] as string).trim() : undefined;
  const httpsCaPem = optStr('httpsCaPem');
  const httpsCaSha256 = optStr('httpsCaSha256');
  const httpsToken = optStr('httpsToken');
  const httpsPort =
    typeof obj.httpsPort === 'number' &&
    Number.isInteger(obj.httpsPort) &&
    obj.httpsPort > 0 &&
    obj.httpsPort <= 65535
      ? obj.httpsPort
      : undefined;
  return { url, urls, token, httpsCaPem, httpsCaSha256, httpsToken, httpsPort };
}

/** Serialise — used by the desktop side's tests to pin the contract both ways. */
export function encodePairingPayload(payload: PairingPayload): string {
  return JSON.stringify({
    v: 1,
    url: payload.url,
    ...(payload.urls?.length ? { urls: payload.urls } : {}),
    ...(payload.token ? { token: payload.token } : {}),
    ...(payload.httpsCaPem ? { httpsCaPem: payload.httpsCaPem } : {}),
    ...(payload.httpsCaSha256 ? { httpsCaSha256: payload.httpsCaSha256 } : {}),
    ...(payload.httpsToken ? { httpsToken: payload.httpsToken } : {}),
    ...(payload.httpsPort ? { httpsPort: payload.httpsPort } : {}),
  });
}
