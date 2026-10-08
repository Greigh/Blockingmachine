import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { HaBridge, DEFAULT_HA_CONFIG } from '../background/haBridge.js';
import { STORAGE_KEY_HA_CONFIG, STORAGE_KEY_COSMETICS_ENABLED } from '../shared/constants.js';

describe('HaBridge', () => {
  let mockStorage: Record<string, any>;
  let originalFetch: any;

  beforeEach(() => {
    mockStorage = {};
    originalFetch = globalThis.fetch;

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: (jest.fn() as any).mockImplementation((keys: string | string[]) => {
            const result: Record<string, any> = {};
            const keyList = Array.isArray(keys) ? keys : [keys];
            for (const k of keyList) {
              if (k in mockStorage) result[k] = mockStorage[k];
            }
            return Promise.resolve(result);
          }),
          set: (jest.fn() as any).mockImplementation((items: Record<string, any>) => {
            Object.assign(mockStorage, items);
            return Promise.resolve();
          }),
        },
      },
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('loads default config when storage is empty', async () => {
    const bridge = new HaBridge();
    const config = await bridge.loadConfig();

    expect(config.enabled).toBe(false);
    expect(config.url).toBe(DEFAULT_HA_CONFIG.url);
    expect(config.cosmeticsEnabled).toBe(true);
  });

  test('saves and retrieves updated configuration', async () => {
    const bridge = new HaBridge();
    await bridge.saveConfig({
      enabled: true,
      url: 'http://192.168.1.100:8123',
      token: 'secret_token_123',
      cosmeticsEnabled: false,
    });

    const config = bridge.getConfig();
    expect(config.enabled).toBe(true);
    expect(config.url).toBe('http://192.168.1.100:8123');
    expect(config.token).toBe('secret_token_123');
    expect(config.cosmeticsEnabled).toBe(false);

    expect(mockStorage[STORAGE_KEY_HA_CONFIG]).toEqual(expect.objectContaining({
      enabled: true,
      url: 'http://192.168.1.100:8123',
    }));
    expect(mockStorage[STORAGE_KEY_COSMETICS_ENABLED]).toBe(false);
  });

  test('reports telemetry via POST endpoint', async () => {
    const mockFetch = (jest.fn() as any).mockResolvedValue({
      ok: true,
      status: 200,
    });
    globalThis.fetch = mockFetch;

    const bridge = new HaBridge();
    const result = await bridge.reportTelemetry({
      trackersBlocked: 42,
      elementsHidden: 8,
      threatsDetected: 1,
      trackers: [{ domain: 'adservice.google.com', count: 12 }],
    });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/telemetry/browser'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  test('reportTelemetry sends the feed token to /v1/* and the HA token to Home Assistant', async () => {
    const calls: { url: string; auth?: string }[] = [];
    globalThis.fetch = (jest.fn() as any).mockImplementation(async (url: string, init: any) => {
      calls.push({ url, auth: init?.headers?.Authorization });
      // Fail until the HA webhook so every endpoint's credential is captured.
      return url.includes('/api/webhook/') ? { ok: true, status: 200 } : { ok: false, status: 500 };
    });

    const bridge = new HaBridge();
    await bridge.saveConfig({
      enabled: true,
      url: 'https://abc123xyz.ui.nabu.casa',
      token: 'ha-long-lived-token',
      feedUrl: 'http://192.168.1.10:9191/browser.txt',
      feedToken: 'hub-feed-token',
    });

    const sent = await bridge.reportTelemetry({ trackersBlocked: 1, elementsHidden: 0, threatsDetected: 0 });
    expect(sent).toBe(true);
    expect(calls).toEqual([
      { url: 'http://192.168.1.10:9191/v1/telemetry/browser', auth: 'Bearer hub-feed-token' },
      { url: 'http://127.0.0.1:9191/v1/telemetry/browser', auth: 'Bearer hub-feed-token' },
      { url: 'https://abc123xyz.ui.nabu.casa/api/webhook/blockingmachine_browser_telemetry', auth: 'Bearer ha-long-lived-token' },
    ]);
  });

  test('testConnection reports success when /api/ answers ok', async () => {
    globalThis.fetch = (jest.fn() as any).mockResolvedValue({ ok: true, status: 200 });
    const bridge = new HaBridge();
    const result = await bridge.testConnection('http://homeassistant.local:8123', 'tok');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Connected successfully');
  });

  test('testConnection names the missing token on a 401 rather than claiming no connection', async () => {
    globalThis.fetch = (jest.fn() as any).mockImplementation(async (url: string) =>
      url.endsWith('/api/') ? { ok: false, status: 401 } : { ok: false, status: 404 }
    );
    const bridge = new HaBridge();
    const result = await bridge.testConnection('https://abc123xyz.ui.nabu.casa');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
    expect(result.message).toContain('Long-Lived Access Token');
  });

  test('testConnection reports the HTTP status when the server answered without auth failure', async () => {
    globalThis.fetch = (jest.fn() as any).mockResolvedValue({ ok: false, status: 404 });
    const bridge = new HaBridge();
    const result = await bridge.testConnection('http://192.168.1.20:9999');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('HTTP 404');
    expect(result.message).not.toContain('Could not connect');
  });

  test('testConnection only says "could not connect" when every probe throws', async () => {
    globalThis.fetch = (jest.fn() as any).mockRejectedValue(new TypeError('fetch failed'));
    const bridge = new HaBridge();
    const result = await bridge.testConnection('http://192.0.2.1:8123');
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Could not connect to specified address.');
  });
});
