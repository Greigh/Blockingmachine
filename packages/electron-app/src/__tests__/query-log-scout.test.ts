import { describe, expect, test } from '@jest/globals';
import {
  emptyUnblockedNotice,
  fetchAdguardQueryLog,
  parseAdguardQueryLog,
  resolveAdguardScoutBase,
  separateAdguardUrls,
} from '../queryLogScout';

const adguardLog = JSON.stringify({
  data: [
    { question: { name: 'ads.example.net' }, client: '10.0.0.8', filter_id: 0 },
    { question: { name: 'blocked.example.net' }, client: '10.0.0.8', filter_id: 12 },
    { question: { name: 'news.example.net' }, client: '10.0.0.9' },
  ],
});

describe('AdGuard query log scout', () => {
  test('does not turn a Home Assistant URL into an empty successful scout', async () => {
    const calls: string[] = [];
    const loaded = await fetchAdguardQueryLog({
      config: {
        adguardMode: 'ha-api',
        adguardHomeUrl: 'http://homeassistant.local:8123/api',
      },
      limit: 60,
      request: async (url) => {
        calls.push(url);
        return { ok: false, status: 404, body: '404 page not found\n' };
      },
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.message).toMatch(/AdGuard Direct URL/i);
      expect(loaded.message).toContain('https://homeassistant.local:8124');
      expect(loaded.details).toBe('ha_url_for_scout');
    }
    expect(calls).toEqual([]);
    expect(loaded).not.toHaveProperty('totalQueriesAnalyzed');
    expect(loaded).not.toMatchObject({ flaggedCount: 0, cleanCount: 0 });
  });

  test('a failed query log response is an error, not a zero-result scan', async () => {
    const loaded = await fetchAdguardQueryLog({
      config: {
        adguardMode: 'direct',
        adguardDirectUrl: 'https://homeassistant.local:8124',
      },
      limit: 60,
      request: async (url) => {
        if (url.includes('/control/querylog')) {
          return { ok: false, status: 404, statusText: 'Not Found', body: '404 page not found\n' };
        }
        if (url.endsWith('/api/')) {
          return { ok: true, status: 200, body: '{"message":"API running."}' };
        }
        return { ok: false, status: 404, body: '404 page not found\n' };
      },
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.message).toMatch(/AdGuard Direct URL/i);
      expect(loaded.message).not.toMatch(/all benign|totalQueriesAnalyzed/i);
    }
    expect('queries' in loaded && loaded.ok).toBe(false);
  });

  test('reads unblocked AdGuard queries and skips blocked ones', async () => {
    const loaded = await fetchAdguardQueryLog({
      config: { adguardMode: 'ha-api', adguardDirectUrl: 'https://homeassistant.local:8124' },
      limit: 60,
      request: async (url) => {
        expect(url).toBe('https://homeassistant.local:8124/control/querylog?limit=60');
        return { ok: true, status: 200, body: adguardLog };
      },
    });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.rawCount).toBe(3);
      expect(loaded.queries.map((query) => query.domain)).toEqual(['ads.example.net', 'news.example.net']);
      expect(loaded.unblockedCount).toBe(2);
    }
  });

  test('a successful log with only blocked queries explains the empty set', () => {
    const parsed = parseAdguardQueryLog(JSON.stringify({
      data: [{ question: { name: 'blocked.example.net' }, filter_id: 4 }],
    }));
    expect(parsed.rawCount).toBe(1);
    expect(parsed.unblockedCount).toBe(0);
    expect(emptyUnblockedNotice(60)).toMatch(/No unblocked queries in the last 60/);
    const target = resolveAdguardScoutBase({
      adguardMode: 'direct',
      adguardHomeUrl: 'http://127.0.0.1:3000',
    });
    expect(target.ok).toBe(true);
  });

  test('transport failures are not swallowed as an empty log', async () => {
    const loaded = await fetchAdguardQueryLog({
      config: { adguardMode: 'direct', adguardDirectUrl: 'https://adguard.local:3000' },
      limit: 50,
      request: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.message).toContain('ECONNREFUSED');
      expect(loaded.message).toContain('not treated as an empty log');
    }
  });

  test('switching to Home Assistant mode keeps a real AdGuard URL for the scout', () => {
    const separated = separateAdguardUrls(
      { adguardMode: 'direct', adguardHomeUrl: 'https://homeassistant.local:8124', adguardDirectUrl: '' },
      { adguardMode: 'ha-api', adguardHomeUrl: 'http://homeassistant.local:8123/api' },
    );
    expect(separated.adguardDirectUrl).toBe('https://homeassistant.local:8124');

    const alreadyHa = separateAdguardUrls(
      { adguardMode: 'ha-api', adguardHomeUrl: 'http://homeassistant.local:8123/api', adguardDirectUrl: '' },
      { adguardHomeUrl: 'http://homeassistant.local:8123/api' },
    );
    expect(alreadyHa.adguardDirectUrl || '').toBe('');

    const savedEmpty = separateAdguardUrls(
      { adguardMode: 'direct', adguardHomeUrl: 'https://homeassistant.local:8124', adguardDirectUrl: '' },
      { adguardMode: 'ha-api', adguardHomeUrl: 'http://homeassistant.local:8123/api', adguardDirectUrl: '' },
    );
    expect(savedEmpty.adguardDirectUrl).toBe('https://homeassistant.local:8124');

    const webhook = separateAdguardUrls(
      { adguardMode: 'direct', adguardHomeUrl: 'https://homeassistant.local:8124', adguardDirectUrl: '' },
      { adguardMode: 'webhook', adguardDirectUrl: '' },
    );
    expect(webhook.adguardDirectUrl).toBe('https://homeassistant.local:8124');

    const cleared = separateAdguardUrls(
      { adguardMode: 'ha-api', adguardHomeUrl: 'http://homeassistant.local:8123/api', adguardDirectUrl: 'https://homeassistant.local:8124' },
      { adguardDirectUrl: '' },
    );
    expect(cleared.adguardDirectUrl || '').toBe('');
  });
});
