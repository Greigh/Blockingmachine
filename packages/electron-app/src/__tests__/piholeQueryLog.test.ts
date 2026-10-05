/**
 * Functional pins for `fetchPiholeQueryLog` — the v5/v6 split the three AI-radar call
 * sites previously skipped by always emitting the v5 `?auth=` shape. On a v6 Pi-hole that
 * call hits the admin SPA, gets HTML, and scans nothing — the radar reported a clean log
 * that was never actually read.
 */

import { describe, expect, test } from '@jest/globals';
import { fetchPiholeQueryLog } from '../piholeApi';
import type { PiholeFetch } from '../piholeApi';
import type { SinkholeHttpResult } from '../sinkholeFetch';

function result(status: number, body: unknown): SinkholeHttpResult {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

const INIT = { timeoutMs: 1000, allowInsecureLocalTls: false };

describe('fetchPiholeQueryLog — v5', () => {
  const v5Url = 'http://pi.hole/admin/api.php';

  test('queries api.php with getAllQueries + auth and keeps only permitted answers', async () => {
    const seen: string[] = [];
    const fetchImpl: PiholeFetch = async (url) => {
      seen.push(url);
      return result(200, {
        data: [
          ['1700000000', 'IPv4', 'forwarded.example.com', '10.0.0.2', '2', ''],
          ['1700000001', 'IPv4', 'cached.example.com', '10.0.0.2', '3', ''],
          ['1700000002', 'IPv4', 'gravity-blocked.example.com', '10.0.0.2', '1', ''],
          ['1700000003', 'IPv4', 'denylist-blocked.example.com', '10.0.0.2', '4', ''],
        ],
      });
    };
    const out = await fetchPiholeQueryLog(v5Url, 'v5token', 50, fetchImpl, INIT);
    expect(out.ok).toBe(true);
    expect(out.flavor).toBe('v5');
    expect(seen[0]).toContain('getAllQueries=50');
    expect(seen[0]).toContain('auth=v5token');
    expect(out.queries.map((q) => q.domain)).toEqual(['forwarded.example.com', 'cached.example.com']);
    expect(out.queries[0].client).toBe('10.0.0.2');
    expect(out.queries[0].timestamp).toBe(new Date(1700000000 * 1000).toISOString());
  });

  test('an HTML answer where JSON was asked for is a v6 endpoint tell, not an empty log', async () => {
    const fetchImpl: PiholeFetch = async () => result(200, '<!doctype html><title>Pi-hole</title>');
    const out = await fetchPiholeQueryLog(v5Url, 'k', 50, fetchImpl, INIT);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('admin web page');
    expect(out.queries).toEqual([]);
  });

  test('HTTP failure surfaces as !ok rather than an empty query set', async () => {
    const fetchImpl: PiholeFetch = async () => result(500, 'error');
    const out = await fetchPiholeQueryLog(v5Url, 'k', 50, fetchImpl, INIT);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(500);
  });
});

describe('fetchPiholeQueryLog — v6', () => {
  const v6Url = 'http://pi.hole/admin';

  test('opens a session, reads /api/queries with X-FTL-SID, always logs out', async () => {
    const calls: Array<{ url: string; method?: string; sid?: string }> = [];
    const fetchImpl: PiholeFetch = async (url, init) => {
      calls.push({ url, method: init.method, sid: init.headers?.['X-FTL-SID'] });
      if (url.endsWith('/api/auth') && init.method === 'POST') {
        return result(200, { session: { valid: true, sid: 'sid-123' } });
      }
      if (url.includes('/api/queries')) {
        return result(200, {
          queries: [
            { domain: 'forwarded.example.com', status: 'FORWARDED', client: { ip: '10.0.0.9' }, time: 1700000000 },
            { domain: 'cached.example.com', status: 'CACHE', client: { ip: '10.0.0.9' }, time: 1700000001 },
            { domain: 'gravity.example.com', status: 'GRAVITY', client: { ip: '10.0.0.9' }, time: 1700000002 },
          ],
        });
      }
      return result(200, {}); // DELETE /api/auth
    };
    const out = await fetchPiholeQueryLog(v6Url, 'v6-password', 25, fetchImpl, INIT);
    expect(out.ok).toBe(true);
    expect(out.flavor).toBe('v6');
    expect(out.queries.map((q) => q.domain)).toEqual(['forwarded.example.com', 'cached.example.com']);
    expect(out.queries[0].client).toBe('10.0.0.9');
    // auth → queries(+sid) → DELETE auth(+sid): the session is opened, used and retired.
    expect(calls.map((c) => c.url)).toEqual([
      'http://pi.hole/api/auth',
      'http://pi.hole/api/queries?length=25',
      'http://pi.hole/api/auth',
    ]);
    expect(calls[1].sid).toBe('sid-123');
    expect(calls[2].method).toBe('DELETE');
    expect(calls[2].sid).toBe('sid-123');
  });

  test('retires the session even when the query read fails', async () => {
    const calls: string[] = [];
    const fetchImpl: PiholeFetch = async (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (init.method === 'POST') return result(200, { session: { valid: true, sid: 's' } });
      if (url.includes('/api/queries')) return result(500, 'upstream exploded');
      return result(200, {});
    };
    const out = await fetchPiholeQueryLog(v6Url, 'p', 10, fetchImpl, INIT);
    expect(out.ok).toBe(false);
    expect(calls[2]).toBe('DELETE http://pi.hole/api/auth');
  });

  test('an empty credential fails honestly instead of POSTing a blank password', async () => {
    const fetchImpl: PiholeFetch = async () => result(200, {});
    const out = await fetchPiholeQueryLog(v6Url, undefined, 10, fetchImpl, INIT);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain('password');
    expect(out.queries).toEqual([]);
  });
});
