import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupFunction } from 'node:net';

// dns.lookup is patched on the CJS module exports object: node's own HTTP
// connect path resolves through that same binding, so the test sees whatever
// the socket would actually dial — pre-fix the default agent path and post-fix
// the guarded-lookup path alike.
const require = createRequire(import.meta.url);
const dns = require('node:dns') as { lookup: LookupFunction } & Record<string, unknown>;
const realLookup = dns.lookup;

const { fetchWithConditionalCache } = await import('../fetch.js');

let server: http.Server;
let port = 0;
let hitCount = 0;

type Answer = { address: string; family: number };

function servePrivateResolver(map: Record<string, Answer[]>) {
  dns.lookup = ((hostname: string, options: any, callback: any) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const entries = map[hostname];
    if (!entries || entries.length === 0) {
      process.nextTick(() => callback(new Error(`ENOTFOUND ${hostname}`), ''));
      return;
    }
    if (options?.all) {
      process.nextTick(() => callback(null, entries));
    } else {
      process.nextTick(() => callback(null, entries[0].address, entries[0].family));
    }
  }) as LookupFunction;
}

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hitCount += 1;
    res.end('||secret-internal-service.example^');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  hitCount = 0;
});

afterAll(async () => {
  dns.lookup = realLookup;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  jest.restoreAllMocks();
});

describe('DNS rebinding: resolve-time guard on outbound fetches', () => {
  it('blocks a public-looking hostname that resolves to a private address', async () => {
    // Reproduction: 'rebind.public.example' passes the lexical hostname check —
    // it is a perfectly public-looking name — but its DNS answer is loopback.
    // Before the resolver-pinned agent this connected straight to the private
    // service and returned its body (SSRF). Now the socket is refused at
    // lookup time and the server is never touched.
    servePrivateResolver({
      'rebind.public.example': [{ address: '127.0.0.1', family: 4 }],
    });
    const result = await fetchWithConditionalCache(
      `http://rebind.public.example:${port}/list`,
    );
    expect(result.status).toBe(403);
    expect(result.content).toBeNull();
    expect(hitCount).toBe(0);
  });

  it('blocks when any single DNS answer is private (no safe address survives)', async () => {
    servePrivateResolver({
      'only-private.example': [
        { address: '169.254.169.254', family: 4 }, // cloud metadata
        { address: '::1', family: 6 },
      ],
    });
    const result = await fetchWithConditionalCache(
      `http://only-private.example:${port}/metadata`,
    );
    expect(result.status).toBe(403);
    expect(hitCount).toBe(0);
  });

  it('honours allowPrivateNetworks — LAN feed URLs keep working', async () => {
    servePrivateResolver({
      'router.home.internal': [{ address: '127.0.0.1', family: 4 }],
    });
    // The hostname also fails the lexical check (.internal), so opt-out must be
    // explicit — exactly like the documented LAN-feed escape hatch.
    const result = await fetchWithConditionalCache(
      `http://router.home.internal:${port}/feed.txt`,
      { allowPrivateNetworks: true },
    );
    expect(result.status).toBe(200);
    expect(result.content).toContain('||secret-internal-service.example^');
    expect(hitCount).toBe(1);
  });

  it('attempts the connection for a public resolution — the guard does not fire', async () => {
    // Public answer: the lookup guard must let it through; the socket then
    // fails at TCP level (nothing listens), which is a different failure class
    // than the policy block — proving the guard did not intercept it.
    servePrivateResolver({
      'genuinely-public.example': [{ address: '8.8.8.8', family: 4 }],
    });
    const result = await fetchWithConditionalCache(
      `http://genuinely-public.example:${port}/list`,
    );
    // Retries on a refused connect are transient-retryable, so the final shape
    // is a failed fetch — importantly NOT the 403 policy block.
    expect(result.status).not.toBe(403);
    expect(result.content).toBeNull();
  }, 20000);
});
