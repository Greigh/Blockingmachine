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

const { fetchWithConditionalCache, publicOnlyAgent } = await import('../fetch.js');

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

  it('passes a public resolution through the lookup — the guard does not fire', async () => {
    // Asserted at the lookup boundary rather than by a live socket: a public
    // answer survives the filter and the socket is left to fail (or succeed) on
    // its own terms. A live dial is how this used to be proven, but the address
    // it reached was real — transport outcomes depended on the network instead
    // of the policy, and the contract worth pinning is the callback shape:
    // `all: true` callers (Node's autoSelectFamily) must receive the vetted
    // array, single-result callers the first survivor.
    servePrivateResolver({
      'genuinely-public.example': [{ address: '8.8.8.8', family: 4 }],
    });
    const agent = publicOnlyAgent(
      new URL(`http://genuinely-public.example:${port}`),
    );
    const lookup = (agent as http.Agent & { options: http.AgentOptions }).options
      .lookup as unknown as (
      host: string,
      opts: Record<string, unknown>,
      cb: (err: Error | null, addr: unknown, fam?: number) => void,
    ) => void;

    const all = await new Promise<unknown>((resolve) =>
      lookup('genuinely-public.example', { all: true }, (err, addr) =>
        resolve(err ? null : addr),
      ),
    );
    expect(all).toEqual([{ address: '8.8.8.8', family: 4 }]);

    const single = await new Promise<unknown>((resolve) =>
      lookup('genuinely-public.example', {}, (err, addr, fam) =>
        resolve(err ? null : [addr, fam]),
      ),
    );
    expect(single).toEqual(['8.8.8.8', 4]);
    expect(hitCount).toBe(0);
  });

  it('pins the ai-crawl-url page fetch — a rebinding hostname never reaches the socket', async () => {
    // crawlAndScanUrl takes a renderer-supplied URL: same SSRF shape as a filter
    // source. The crawler used to fetch with the global dispatcher, so a public
    // name answering loopback connected straight through. It now goes through
    // node-fetch + the pinned agent — the private answer is refused at lookup.
    const { AiDetectorService } = await import('../ai/AiDetectorService.js');
    servePrivateResolver({
      'rebind.crawler.example': [{ address: '127.0.0.1', family: 4 }],
    });
    const service = new AiDetectorService({ provider: 'mini-ai' });
    const result = await service.crawlAndScanUrl(`http://rebind.crawler.example:${port}/page`);
    expect(result.extractedHosts).toEqual([]);
    expect(hitCount).toBe(0);
  });

  it('still refuses a literal private crawl target at the lexical layer', async () => {
    const { AiDetectorService } = await import('../ai/AiDetectorService.js');
    const service = new AiDetectorService({ provider: 'mini-ai' });
    await expect(service.crawlAndScanUrl(`http://192.168.4.9:${port}/page`))
      .rejects.toThrow('SSRF Guard');
    expect(hitCount).toBe(0);
  });
});
