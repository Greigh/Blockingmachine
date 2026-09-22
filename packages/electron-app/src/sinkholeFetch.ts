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
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

  for (let hop = 0; hop < 5; hop++) {
    if (init.allowInsecureLocalTls && isLocalHttpUrl(current)) {
      const response = await nodeRequest(current, {
        method,
        headers: init.headers,
        body,
        timeoutMs,
        rejectUnauthorized: !shouldBypassUntrustedTls(current, true),
      });
      if (REDIRECT_STATUSES.has(response.status) && response.location) {
        const next = new URL(response.location, current);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw Object.assign(new Error(`Redirect to unsupported protocol ${next.protocol}`), { code: 'ERR_INVALID_REDIRECT' });
        }
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
      headers: init.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      if (!location) return toResult(res.status, res.statusText, await res.text());
      const next = new URL(location, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw Object.assign(new Error(`Redirect to unsupported protocol ${next.protocol}`), { code: 'ERR_INVALID_REDIRECT' });
      }
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

function nodeRequest(
  urlStr: string,
  opts: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number; rejectUnauthorized: boolean },
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
  };

  return new Promise((resolve, reject) => {
    const onResponse = (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
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
