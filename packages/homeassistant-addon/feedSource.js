/**
 * Feed source pull — the add-on's bridge from the desktop hub.
 *
 * The add-on serves feeds from files in its data directory, and nothing else in the
 * system writes them. This module closes that gap by pulling `dns.txt` and
 * `browser.txt` from the desktop app's own feed server (`http://<mac>:9191`), so
 * "Compile Rules Now" and the auto-compile schedule both mean "sync, then recount".
 *
 * Pulling rather than being pushed to is deliberate: the desktop is a laptop that
 * sleeps and roams, while the add-on is a long-lived service. A pull scheduled here
 * keeps working no matter when the desktop happens to be awake.
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';

/** Filenames the add-on serves, in pull order. */
export const FEED_FILES = ['dns.txt', 'browser.txt'];

/**
 * A body that parses to no rules is not a feed — a proxy login page, an HTML error,
 * or an empty file would all silently wipe the published list if written verbatim.
 */
export function bodyLooksLikeFeed(body) {
  return body
    .split('\n')
    .some((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('!') && !t.startsWith('#') && !t.startsWith('<');
    });
}

/** Feeds are MB-scale; anything past this is a hostile body, not a blocklist. */
const MAX_FEED_BYTES = 32 * 1024 * 1024;

/**
 * Whether a cleartext URL's host is provably on the local network — loopback,
 * RFC1918/ULA/link-local literals, or a name that cannot resolve off-LAN
 * (`localhost`, single-label names, `.local`/`.lan`/`.internal`/`.localhost`/
 * `.home.arpa` suffixes). The feed token is a LAN-scoped secret: it may travel
 * over TLS or to these hosts, never cleartext to a public address.
 *
 * Mirrors `isLocalNetworkHost` in `packages/core/src/utils/urlSafety.ts` — this
 * package's Docker context cannot reach the workspace, so the copy stays; keep
 * the host lists and ranges in step with the canonical version.
 */
function isLocalFeedHost(url) {
  try {
    const parsed = new URL(url);
    const raw = parsed.hostname.toLowerCase();
    const host = raw.startsWith('[') ? raw.slice(1, -1) : raw;
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.lan') ||
      host.endsWith('.internal') ||
      host.endsWith('.home.arpa')
    ) {
      return true;
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split('.').map(Number);
      return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    if (host.includes(':')) {
      if (host === '::1') return true;
      if (/^fe[89ab]/.test(host) || /^f[cd]/.test(host)) return true;
      const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
      if (dotted) return isLocalFeedHost(`http://${dotted[1]}/`);
      const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
      if (hexMapped) {
        const hi = parseInt(hexMapped[1], 16);
        const lo = parseInt(hexMapped[2], 16);
        return isLocalFeedHost(`http://${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}/`);
      }
      return false;
    }
    return !host.includes('.');
  } catch {
    return false;
  }
}

/** The token attaches only where the wire protects it: TLS, or a local host. */
export function credentialAllowed(url) {
  return url.startsWith('https:') || isLocalFeedHost(url);
}

/**
 * Reads a feed response with a hard byte ceiling. The LAN pull is plaintext by
 * design, so the channel is MITM-able — the bound is what stands between a
 * poisoned response and container memory. The stream is preferred so the cap
 * trips mid-flight; test doubles that only expose `text()` get the same cap
 * after the body lands.
 */
async function readFeedBody(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let total = 0;
    let body = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          throw new Error(`feed body exceeded ${maxBytes} bytes — refusing to buffer more`);
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      return body;
    } finally {
      reader.cancel().catch(() => {});
    }
  }
  const body = await res.text();
  if (Buffer.byteLength(body) > maxBytes) {
    throw new Error(`feed body exceeded ${maxBytes} bytes — refusing to keep it`);
  }
  return body;
}

/**
 * Fetches one feed file and writes it under dataDir.
 * @returns {Promise<{ file: string, bytes: number }>}
 */
async function pullOne({ sourceUrl, token, dataDir, fileName, fetchImpl, timeoutMs }) {
  const url = `${sourceUrl.replace(/\/+$/, '')}/${fileName}`;
  // The request still goes without the credential — an open feed has no token
  // to withhold, and a gated source answers the 401 that names the problem.
  const headers = token && credentialAllowed(url) ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${fileName}: ${url} answered HTTP ${res.status}`);
  }
  const body = await readFeedBody(res, MAX_FEED_BYTES);
  if (!bodyLooksLikeFeed(body)) {
    throw new Error(`${fileName}: ${url} returned no usable rules — refusing to overwrite the published feed`);
  }
  await fs.writeFile(join(dataDir, fileName), body, 'utf8');
  return { file: fileName, bytes: Buffer.byteLength(body) };
}

/**
 * Pulls both feeds from the configured source. Individual failures are collected
 * per file so one bad feed does not veto the other, and an existing on-disk copy
 * is always kept rather than truncated.
 *
 * @param {{ sourceUrl: string, token?: string, dataDir: string,
 *          fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<{ pulled: string[], errors: string[] }>}
 */
export async function pullFeeds({ sourceUrl, token, dataDir, fetchImpl = fetch, timeoutMs = 15000 }) {
  const pulled = [];
  const errors = [];
  for (const fileName of FEED_FILES) {
    try {
      const result = await pullOne({ sourceUrl, token, dataDir, fileName, fetchImpl, timeoutMs });
      pulled.push(result.file);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { pulled, errors };
}
