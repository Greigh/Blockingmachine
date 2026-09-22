import { describe, expect, test } from '@jest/globals';
import {
  ADGUARD_ON_HA_API_MESSAGE,
  HA_ON_DIRECT_MESSAGE,
  classifyDirectStatus,
  classifyHaApiResponse,
  haApiConnectionResult,
  type ProbeResponse,
} from '../sinkholeIdentity';

const nginx404: ProbeResponse = { ok: false, status: 404, statusText: 'Not Found', body: '404 page not found\n' };
const haApi: ProbeResponse = { ok: true, status: 200, body: '{"message":"API running."}' };
const adguardStatus: ProbeResponse = {
  ok: true,
  status: 200,
  body: JSON.stringify({
    version: 'v0.107.79',
    protection_enabled: true,
    running: true,
    dns_port: 53,
    http_port: 80,
  }),
};

describe('Home Assistant and AdGuard identity', () => {
  test('HA API mode with an AdGuard host and a plain /api/ 404 suggests Direct mode', async () => {
    const calls: string[] = [];
    const identity = await classifyHaApiResponse(
      nginx404,
      'https://homeassistant.local:8124/api/',
      async (url) => {
        calls.push(url);
        if (url.endsWith('/control/status')) return adguardStatus;
        return nginx404;
      },
    );
    expect(identity.kind).toBe('adguard');
    if (identity.kind === 'adguard') {
      expect(identity.message).toBe(ADGUARD_ON_HA_API_MESSAGE);
      expect(identity.message).toContain('Direct AdGuard');
      expect(identity.message).toContain('8123');
      expect(identity.message).not.toContain('adguard.refresh');
      expect(identity.details).toBe('adguard_on_ha_api');
    }
    expect(calls[0]).toBe('https://homeassistant.local:8124/control/status');
    const shown = haApiConnectionResult(identity, 40, 'https://homeassistant.local:8124', 404);
    expect(shown.success).toBe(false);
    expect(shown.message).toBe(ADGUARD_ON_HA_API_MESSAGE);
  });

  test('Direct mode warns when /api/ reports Home Assistant and AdGuard status is absent', async () => {
    const identity = await classifyDirectStatus(
      nginx404,
      'http://homeassistant.local:8123/control/status',
      async (url) => {
        expect(url).toBe('http://homeassistant.local:8123/api/');
        return haApi;
      },
    );
    expect(identity.kind).toBe('home-assistant');
    if (identity.kind === 'home-assistant') {
      expect(identity.message).toBe(HA_ON_DIRECT_MESSAGE);
      expect(identity.details).toBe('ha_on_direct');
    }
  });

  test('a real Home Assistant /api/ success stays the Home Assistant success path', async () => {
    const calls: string[] = [];
    const identity = await classifyHaApiResponse(haApi, 'http://homeassistant.local:8123/api/', async (url) => {
      calls.push(url);
      throw new Error(`unexpected probe ${url}`);
    });
    expect(identity.kind).toBe('home-assistant');
    expect(calls).toEqual([]);
    const shown = haApiConnectionResult(identity, 18, 'http://homeassistant.local:8123', 200);
    expect(shown).toEqual({
      success: true,
      statusCode: 200,
      message: 'Connected to Home Assistant API (18ms, ready for adguard.refresh)',
    });
  });

  test('a real AdGuard /control/status success does not probe Home Assistant', async () => {
    const identity = await classifyDirectStatus(
      adguardStatus,
      'https://homeassistant.local:8124/control/status',
      async () => {
        throw new Error('should not probe');
      },
    );
    expect(identity.kind).toBe('adguard');
  });

  test('AdGuard UI HTML is enough when /control/status is not JSON', async () => {
    const identity = await classifyHaApiResponse(
      nginx404,
      'https://adguard.local:8443/api/',
      async (url) => {
        if (url.endsWith('/control/status')) return nginx404;
        if (url.endsWith('/')) {
          return { ok: true, status: 200, body: '<!doctype html><html><title>AdGuard Home</title></html>' };
        }
        return nginx404;
      },
    );
    expect(identity.kind).toBe('adguard');
  });
});
