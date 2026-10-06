/**
 * QR pairing payload decode/validation. The desktop app renders a QR containing
 * JSON: {"v":1,"url":"http://<lanip>:9191","token":"<feedToken>"}. The token key is
 * present only when the hub has one configured — an absent token is a valid payload
 * describing an open LAN server, not a broken QR.
 */

import { normalizeBaseUrl } from './client';

export interface PairingPayload {
  url: string;
  token?: string;
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
    throw new PairingError('Not a Blockingmachine pairing code (not JSON)');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PairingError('Not a Blockingmachine pairing code (not an object)');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) {
    throw new PairingError(`Unsupported pairing payload version: ${String(obj.v)}`);
  }
  if (typeof obj.url !== 'string' || !obj.url.trim()) {
    throw new PairingError('Pairing payload is missing a server URL');
  }
  const url = normalizeBaseUrl(obj.url); // throws ApiError on a bad address
  const token =
    typeof obj.token === 'string' && obj.token.trim() ? obj.token.trim() : undefined;
  return { url, token };
}

/** Serialise — used by the desktop side's tests to pin the contract both ways. */
export function encodePairingPayload(payload: PairingPayload): string {
  return JSON.stringify({ v: 1, url: payload.url, ...(payload.token ? { token: payload.token } : {}) });
}
