/**
 * Control API browser-boundary posture.
 *
 * The daemon's control server binds loopback, so the realistic adversary is a
 * web page in a browser on the same machine — not a LAN host. The audit found
 * the origin allowlist trusted `*.local` (a name any device can claim over
 * mDNS — a page served from a rogue `printer.local` could pause DNS
 * protection or inject arbitrary blocks into the resolver), `/v1/stats`
 * answered unguarded (recentQueries is a full DNS query log — browsing
 * history), the preflight advertised POST, and mutations parsed JSON under
 * any content type.
 *
 * These tests run the real `startDaemon` on ephemeral ports and pin the
 * fixed contract: claimable-name origins refused, telemetry reads gated,
 * simple-request POSTs 415'd, and the hub's daemonManager shapes (no-Origin +
 * application/json) still working.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import type { AddressInfo } from 'node:net';
import { startDaemon } from '../index.js';
import type { DaemonConfig } from '../types.js';

const config: DaemonConfig = {
  bindHost: '127.0.0.1',
  dnsPort: 0,
  controlPort: 0,
  upstreamDoHUrl: 'https://dns.quad9.net/dns-query',
  sinkholeIpv4: '0.0.0.0',
  sinkholeIpv6: '::',
  feedUrl: 'http://127.0.0.1:9/dns.txt', // dead on purpose — baseline rules load
};

let base: string;
let controlServer: import('node:http').Server;
let dnsServer: Awaited<ReturnType<typeof startDaemon>>['dnsServer'];

beforeAll(async () => {
  const started = await startDaemon(config);
  controlServer = started.controlServer;
  dnsServer = started.dnsServer;
  if (!controlServer.listening) {
    await new Promise<void>((resolve) => controlServer.once('listening', resolve));
  }
  const { port } = controlServer.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  controlServer.close();
  await dnsServer.stop();
});

describe('control API browser-boundary posture', () => {
  test('the preflight does not offer POST', async () => {
    const res = await fetch(`${base}/v1/toggle`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    const methods = (res.headers.get('access-control-allow-methods') || '').toLowerCase();
    expect(methods).toContain('get');
    expect(methods).not.toContain('post');
  });

  test('a claimable .local origin cannot toggle protection or inject quarantine', async () => {
    for (const path of ['/v1/toggle', '/v1/quarantine']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://rogue-printer.local',
        },
        body: JSON.stringify(path === '/v1/toggle' ? { enabled: false } : { domains: ['example.com'] }),
      });
      expect(res.status).toBe(403);
    }
    expect(dnsServer.isProtectionEnabled()).toBe(true);
  });

  test('the DNS query log is not readable by a .local page', async () => {
    const res = await fetch(`${base}/v1/stats`, {
      headers: { Origin: 'http://smart-tv.local' },
    });
    expect(res.status).toBe(403);
    // But the daemonManager probe — a native client with no Origin — still works.
    const probe = await fetch(`${base}/v1/status`);
    expect(probe.status).toBe(200);
  });

  test('a simple-request POST shape is refused by the content-type wall', async () => {
    const res = await fetch(`${base}/v1/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(415);
    expect(dnsServer.isProtectionEnabled()).toBe(true);
  });

  test('the daemonManager shapes still work — no-Origin JSON POSTs pass', async () => {
    const toggle = await fetch(`${base}/v1/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggle.status).toBe(200);
    expect(dnsServer.isProtectionEnabled()).toBe(false);
    await fetch(`${base}/v1/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(dnsServer.isProtectionEnabled()).toBe(true);

    const quarantine = await fetch(`${base}/v1/quarantine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains: ['injected-test.example.com'] }),
    });
    expect(quarantine.status).toBe(200);
    const q = await quarantine.json();
    expect(q.injected).toBe(1);
  });
});
