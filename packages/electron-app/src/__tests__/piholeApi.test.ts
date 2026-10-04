/**
 * Pi-hole dual-flavor API — the contract the pane's "v5 & v6" label makes.
 *
 * The old code emitted `?auth=&action=` onto any configured URL, which on a v6 Pi-hole hits the
 * admin SPA: HTTP 200 HTML, reported as a successful gravity run that never happened. These
 * tests pin the flavor split and the v6 session lifecycle — auth, one authed call, logout —
 * with an injected fetch so the request sequence is asserted, not guessed.
 */

import { describe, expect, test } from '@jest/globals';
import { piholeApiFlavor, piholeGravityUpdate, piholeVersionProbe } from '../piholeApi';
import type { SinkholeFetchInit, SinkholeHttpResult } from '../sinkholeFetch';

const INIT = { timeoutMs: 1000, allowInsecureLocalTls: false };

function result(status: number, body: unknown, statusText = 'OK'): SinkholeHttpResult {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => text,
    json: async () => JSON.parse(text || 'null'),
  };
}

interface Call {
  url: string;
  init: SinkholeFetchInit;
}

function fakeFetch(handler: (call: Call) => SinkholeHttpResult) {
  const calls: Call[] = [];
  const impl = async (url: string, init: SinkholeFetchInit) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { calls, impl };
}

describe('piholeApiFlavor', () => {
  test('an api.php path is v5; everything else is v6', () => {
    expect(piholeApiFlavor('http://pi.hole/admin/api.php')).toBe('v5');
    expect(piholeApiFlavor('http://pi.hole/admin')).toBe('v6');
    expect(piholeApiFlavor('http://pi.hole')).toBe('v6');
    expect(piholeApiFlavor('http://localhost:8080/admin')).toBe('v6');
  });
});

describe('v5 requests', () => {
  test('appends auth and the requested params onto the configured api.php URL', async () => {
    const { calls, impl } = fakeFetch(() => result(200, { version: 5 }));
    const res = await piholeVersionProbe('http://pi.hole/admin/api.php', 'tok', impl, INIT);
    expect(res.ok).toBe(true);
    expect(res.flavor).toBe('v5');
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('auth')).toBe('tok');
    expect(url.searchParams.get('type')).toBe('version');
  });

  test('an HTML 200 is a failure, not a success — that is a v6 SPA, not the API', async () => {
    // The failure this module exists for: a v5-shaped call answered by the admin web page.
    const { impl } = fakeFetch(() => result(200, '<!DOCTYPE html><html>…admin…</html>'));
    const res = await piholeGravityUpdate('http://pi.hole/admin/api.php', 'tok', impl, INIT);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/admin web page/);
  });
});

describe('v6 requests', () => {
  const sessionOk = { session: { sid: 'sid-123', valid: true, validity: 300 } };

  test('version probe: auth → /api/info/version with X-FTL-SID → session deleted', async () => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.url.endsWith('/api/auth') && call.init.method === 'POST') return result(200, sessionOk);
      if (call.url.endsWith('/api/info/version')) return result(200, { version: { core: { local: { version: 'v6.2' } } } });
      if (call.url.endsWith('/api/auth') && call.init.method === 'DELETE') return result(204, '');
      throw new Error(`unexpected call ${call.url} ${call.init.method}`);
    });
    const res = await piholeVersionProbe('http://pi.hole/admin', 'app-password', impl, INIT);
    expect(res.ok).toBe(true);
    expect(res.flavor).toBe('v6');
    expect(calls.map((c) => `${c.init.method ?? 'GET'} ${new URL(c.url).pathname}`)).toEqual([
      'POST /api/auth',
      'GET /api/info/version',
      'DELETE /api/auth',
    ]);
    expect(calls[0].init.body).toBe(JSON.stringify({ password: 'app-password' }));
    expect(calls[1].init.headers?.['X-FTL-SID']).toBe('sid-123');
    expect(calls[2].init.headers?.['X-FTL-SID']).toBe('sid-123');
  });

  test('gravity update posts to /api/action/gravity under the session', async () => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.url.endsWith('/api/auth') && call.init.method === 'POST') return result(200, sessionOk);
      if (call.url.endsWith('/api/action/gravity')) return result(200, {});
      if (call.url.endsWith('/api/auth') && call.init.method === 'DELETE') return result(204, '');
      throw new Error(`unexpected call ${call.url}`);
    });
    const res = await piholeGravityUpdate('http://pi.hole/admin', 'pw', impl, INIT);
    expect(res.ok).toBe(true);
    expect(calls.map((c) => `${c.init.method ?? 'GET'} ${new URL(c.url).pathname}`)).toEqual([
      'POST /api/auth',
      'POST /api/action/gravity',
      'DELETE /api/auth',
    ]);
  });

  test('a rejected password is a clear error, not an HTTP 200 mystery', async () => {
    const { impl } = fakeFetch(() => result(401, { error: { message: 'bad password' } }, 'Unauthorized'));
    await expect(piholeGravityUpdate('http://pi.hole/admin', 'wrong', impl, INIT)).rejects.toThrow(/rejected the password/);
  });

  test('a missing key never opens a session', async () => {
    const { calls, impl } = fakeFetch(() => result(200, sessionOk));
    const res = await piholeVersionProbe('http://pi.hole/admin', undefined, impl, INIT);
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('the session is released even when the call fails', async () => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.url.endsWith('/api/auth') && call.init.method === 'POST') return result(200, sessionOk);
      if (call.url.endsWith('/api/action/gravity')) return result(500, {}, 'boom');
      if (call.url.endsWith('/api/auth') && call.init.method === 'DELETE') return result(204, '');
      throw new Error(`unexpected call ${call.url}`);
    });
    const res = await piholeGravityUpdate('http://pi.hole/admin', 'pw', impl, INIT);
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls[2].init.method).toBe('DELETE');
  });
});
