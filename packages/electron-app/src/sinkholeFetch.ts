import http from 'http';
import type { IncomingMessage } from 'http';
import https from 'https';
import { isPrivateOrLocalHost, shouldBypassUntrustedTls } from './sinkholeNet';

export interface SinkholeHttpResult {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface SinkholeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  allowInsecureLocalTls: boolean;
  /**
   * Resolve as soon as the status line arrives without consuming the body. For endpoints
   * whose response is a long-lived stream — Pi-hole v6's `/api/action/gravity` answers by
   * streaming the run log for the duration of the rebuild, so reading to the end would hold
   * the caller open for the whole run.
   */
  respondOnHeaders?: boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Headers that must not follow a request across an origin boundary. A sinkhole API token aimed
 * at a private resolver is exactly what a hostile redirect would otherwise collect — the same
 * rule `fetch` applies to `redirect: 'follow'` internally, applied to the hops we drive by hand.
 */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'cookie2', 'x-ftl-sid']);

/** `headers` without the entries a cross-origin redirect must not carry. */
function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

/**
 * Fetch a user-configured sinkhole URL.
 * Untrusted TLS is skipped only when the caller opted in and the current hop
 * is HTTPS on a local/private host. Public hosts always verify certificates.
 */
export async function sinkholeFetch(url: string, init: SinkholeFetchInit): Promise<SinkholeHttpResult> {
  const timeoutMs = init.timeoutMs ?? 6000;
  let current = url;
  let method = (init.method || 'GET').toUpperCase();
  let body = init.body;
  let headers = init.headers ?? {};

  for (let hop = 0; hop < 5; hop++) {
    if (init.allowInsecureLocalTls && isLocalHttpUrl(current)) {
      const response = await nodeRequest(current, {
        method,
        // Admin APIs on embedded daemons get single-use sockets: FTL (Pi-hole v6's CivetWeb)
        // is observed to write bytes after its chunk terminator, and a pooled connection
        // would feed that trailing garbage to the next request's parser.
        headers: { ...headers, Connection: 'close' },
        body,
        timeoutMs,
        rejectUnauthorized: !shouldBypassUntrustedTls(current, true),
        respondOnHeaders: init.respondOnHeaders,
      });
      if (REDIRECT_STATUSES.has(response.status) && response.location) {
        const next = new URL(response.location, current);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw Object.assign(new Error(`Redirect to unsupported protocol ${next.protocol}`), { code: 'ERR_INVALID_REDIRECT' });
        }
        if (next.origin !== new URL(current).origin) headers = stripCredentialHeaders(headers);
        current = next.toString();
        if (response.status === 301 || response.status === 302 || response.status === 303) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      return toResult(response.status, response.statusText, response.body);
    }

    const res = await fetch(current, {
      method,
      headers: { ...headers, Connection: 'close' },
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (init.respondOnHeaders) {
      res.body?.cancel().catch(() => undefined);
      return toResult(res.status, res.statusText, '');
    }
    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      if (!location) return toResult(res.status, res.statusText, await res.text());
      const next = new URL(location, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw Object.assign(new Error(`Redirect to unsupported protocol ${next.protocol}`), { code: 'ERR_INVALID_REDIRECT' });
      }
      if (next.origin !== new URL(current).origin) headers = stripCredentialHeaders(headers);
      current = next.toString();
      if (res.status === 301 || res.status === 302 || res.status === 303) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return toResult(res.status, res.statusText, await res.text());
  }

  throw Object.assign(new Error('Too many redirects'), { code: 'ERR_TOO_MANY_REDIRECTS' });
}

function isLocalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isPrivateOrLocalHost(parsed.hostname);
  } catch {
    return false;
  }
}

function toResult(status: number, statusText: string, body: string): SinkholeHttpResult {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body,
    json: async () => JSON.parse(body || 'null'),
  };
}

const MAX_SINKHOLE_PAYLOAD_SIZE = 25 * 1024 * 1024; // 25MB

function nodeRequest(
  urlStr: string,
  opts: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number; rejectUnauthorized: boolean; respondOnHeaders?: boolean },
): Promise<{ status: number; statusText: string; location?: string; body: string }> {
  const parsed = new URL(urlStr);
  const isHttps = parsed.protocol === 'https:';
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.body && opts.method !== 'GET' && opts.method !== 'HEAD' && !headers['Content-Length'] && !headers['content-length']) {
    headers['Content-Length'] = String(Buffer.byteLength(opts.body));
  }
  const hostname = parsed.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
  const path = `${parsed.pathname}${parsed.search}`;
  const common = {
    protocol: parsed.protocol,
    hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path,
    method: opts.method,
    headers,
    timeout: opts.timeoutMs,
    agent: false,
    // Lenient parsing for embedded LAN daemons: FTL's CivetWeb has been seen writing a JSON
    // body after the chunk terminator on a `Connection: close` response — strictly legal to
    // reject, but rejecting it makes a real admin endpoint unusable. Lenient mode skips the
    // trailing bytes instead of failing the whole request. Public-facing parsing stays strict
    // (this function only ever runs against private/LAN hosts by sinkholeFetch's contract).
    insecureHTTPParser: true,
  };

  return new Promise((resolve, reject) => {
    const onResponse = (res: IncomingMessage) => {
      if (opts.respondOnHeaders) {
        // Drain rather than destroy: `Connection: close` (set above) ends the socket anyway,
        // and draining lets the kernel discard the stream instead of RST-ing it mid-flight.
        res.resume();
        resolve({
          status: res.statusCode || 0,
          statusText: res.statusMessage || '',
          location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
          body: '',
        });
        return;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      res.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > MAX_SINKHOLE_PAYLOAD_SIZE) {
          res.destroy(new Error(`Sinkhole response exceeded payload limit of 25MB: >${totalBytes} bytes`));
          return;
        }
        chunks.push(buf);
      });
      res.on('end', () => {
        const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
        resolve({
          status: res.statusCode || 0,
          statusText: res.statusMessage || '',
          location,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    };
    const req = isHttps
      ? https.request(
          {
            ...common,
            rejectUnauthorized: opts.rejectUnauthorized,
            // Self-signed LAN certificates often use a different name than the IP or .local host.
            ...(opts.rejectUnauthorized ? {} : { checkServerIdentity: () => undefined }),
            servername: isIp ? undefined : hostname,
          },
          onResponse,
        )
      : http.request(common, onResponse);
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('The operation was aborted due to timeout'), { code: 'ETIMEDOUT', name: 'TimeoutError' }));
    });
    req.on('error', reject);
    if (opts.body && opts.method !== 'GET' && opts.method !== 'HEAD') req.write(opts.body);
    req.end();
  });
}
