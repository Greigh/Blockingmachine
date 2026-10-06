import { ApiError, BlockingmachineClient, normalizeBaseUrl } from '../api/client';
import type { StatusPayload } from '../api/types';

const jsonResponse = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const okStatus: StatusPayload = {
  status: 'online',
  service: 'Blockingmachine Hub',
  version: '1.0.0-rc.9',
  uptimeSeconds: 3600,
  rules: { total: 100, dns: 80, browser: 60, quarantinedThreats: 2 },
  lastCompile: '2026-10-05T00:00:00Z',
  protection: { enabled: true, pausedUntil: null, daemonStatus: 'running' },
};

const clientWith = (impl: jest.Mock, token?: string) =>
  new BlockingmachineClient(
    { baseUrl: 'http://192.168.1.10:9191', token },
    { fetchImpl: impl as unknown as typeof fetch },
  );

describe('normalizeBaseUrl', () => {
  it('adds http:// to bare host:port', () => {
    expect(normalizeBaseUrl('192.168.1.10:9191')).toBe('http://192.168.1.10:9191');
  });
  it('keeps an explicit https scheme and strips the path', () => {
    expect(normalizeBaseUrl('https://hub.local:9191/foo?x=1')).toBe('https://hub.local:9191');
  });
  it('rejects non-http schemes and garbage', () => {
    expect(() => normalizeBaseUrl('ftp://host')).toThrow(ApiError);
    expect(() => normalizeBaseUrl('')).toThrow(ApiError);
    expect(() => normalizeBaseUrl('   ')).toThrow(ApiError);
  });
});

describe('BlockingmachineClient', () => {
  it('requests /v1/status with no auth header when no token is set', async () => {
    const impl = jest.fn().mockResolvedValue(jsonResponse(200, okStatus));
    const client = clientWith(impl);
    const status = await client.getStatus();
    expect(status.rules.total).toBe(100);
    const [url, init] = impl.mock.calls[0];
    expect(url).toBe('http://192.168.1.10:9191/v1/status');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('attaches the bearer token when configured', async () => {
    const impl = jest.fn().mockResolvedValue(jsonResponse(200, okStatus));
    await clientWith(impl, 'secret').getStatus();
    expect(impl.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
  });

  it('maps 401 to unauthorized and 403 to forbidden', async () => {
    await expect(
      clientWith(jest.fn().mockResolvedValue(jsonResponse(401, { error: 'nope' }))).getStatus(),
    ).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
    await expect(
      clientWith(jest.fn().mockResolvedValue(jsonResponse(403, { error: 'origin' }))).getStatus(),
    ).rejects.toMatchObject({ kind: 'forbidden', status: 403 });
  });

  it('maps a refused connection to unreachable', async () => {
    const impl = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    await expect(clientWith(impl).getStatus()).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });

  it('surfaces the server error body on 5xx', async () => {
    const impl = jest
      .fn()
      .mockResolvedValue(jsonResponse(503, { error: 'DNS daemon is not running' }));
    await expect(clientWith(impl).setProtection(true)).rejects.toMatchObject({
      kind: 'server',
      status: 503,
      message: 'DNS daemon is not running',
    });
  });

  it('encodes the check domain and tolerates both hub and add-on verdict shapes', async () => {
    const impl = jest.fn().mockResolvedValue(
      jsonResponse(200, { domain: 'ads.example.com', blocked: true, matchedHost: 'example.com' }),
    );
    const res = await clientWith(impl).checkDomain('  Ads.Example.COM ');
    expect(impl.mock.calls[0][0]).toBe(
      'http://192.168.1.10:9191/v1/check?domain=ads.example.com',
    );
    expect(res.blocked).toBe(true);
    expect(res.matchedHost).toBe('example.com');
  });

  it('posts {enabled} to /v1/protection', async () => {
    const impl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { success: true, enabled: false }));
    await clientWith(impl, 'tok').setProtection(false);
    const [url, init] = impl.mock.calls[0];
    expect(url).toBe('http://192.168.1.10:9191/v1/protection');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ enabled: false });
  });

  it('reports a compile already-in-progress as data, not an error', async () => {
    const impl = jest.fn().mockResolvedValue(
      jsonResponse(200, { success: true, alreadyRunning: true }),
    );
    const res = await clientWith(impl).compile();
    expect(res.alreadyRunning).toBe(true);
  });

  it('aborts the request when the timeout elapses', async () => {
    const impl = jest.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const client = new BlockingmachineClient(
      { baseUrl: 'http://10.0.0.1:9191' },
      { timeoutMs: 25, fetchImpl: impl as unknown as typeof fetch },
    );
    await expect(client.getStatus()).rejects.toMatchObject({ kind: 'unreachable' });
  });
});
