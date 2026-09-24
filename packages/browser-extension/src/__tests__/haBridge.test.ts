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
});
