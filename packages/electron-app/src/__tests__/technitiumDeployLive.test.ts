/**
 * Live rehearsal for the Deploy Hub's Technitium subscription claim, against a real
 * Technitium DNS Server in docker.
 *
 * The dnsmasq pane tells the reader "Technitium and pfBlockerNG subscribe to this address
 * on their own schedules". On a running Technitium that claim decomposes into observable
 * behaviour this suite verifies end to end:
 *
 *   subscribe → POST /api/settings/set?blockListUrls=<feed url>
 *               (the feed is served by an HTTP server inside this test, emitting a
 *               hosts-format file produced by the project's own formatter)
 *   pull      → POST /api/settings/forceUpdateBlockLists
 *               (the scheduled pull is 24h by default; the API can force one now)
 *   verify    → /api/settings/get shows the URL subscribed
 *   block     → a query to Technitium's own DNS answers NXDOMAIN for a listed name
 *               (its configured blockingType) while a clean name resolves — the list
 *               is doing the work, not just stored as configuration.
 *
 * The container reaches this host through the docker/lima host address, discovered the
 * same way the container resolves it (`getent hosts host.docker.internal`).
 *
 * Gated on the `technitium/dns-server` image being present locally: it never pulls —
 * CI and contributors without it skip, and the pane's copy stays honest either way.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateFilterList, parseFilterList } from '@blockingmachine/core';

const IMAGE = 'technitium/dns-server:latest';
const NAME = 'bm-technitium-test';
const WEB_PORT = 15381;
const API = `http://localhost:${WEB_PORT}/api`;

function haveDockerImage(): boolean {
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (docker.status !== 0) return false;
  return spawnSync('docker', 'image inspect technitium/dns-server:latest'.split(' '), {
    encoding: 'utf8',
  }).status === 0;
}

const haveImage = haveDockerImage();
let token = '';

async function api(path: string): Promise<{ status: string; response: Record<string, unknown> }> {
  const res = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}token=${token}`);
  return res.json() as Promise<{ status: string; response: Record<string, unknown> }>;
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API}/user/login?user=admin&pass=admin`);
      const body = (await res.json()) as { status?: string; token?: string };
      if (body.status === 'ok' && body.token) {
        token = body.token;
        return;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('technitium never came up');
}

/** The address the container reaches this host on — resolved the container's own way. */
function hostAddress(): string {
  const out = execFileSync(
    'docker',
    ['exec', NAME, 'sh', '-c', 'getent hosts host.docker.internal || nslookup host.docker.internal'],
    { encoding: 'utf8' },
  );
  const ip = /(\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1];
  if (!ip) throw new Error(`cannot resolve host.docker.internal in container:\n${out}`);
  return ip;
}

(haveImage ? describe : describe.skip)('the technitium subscription claim, rehearsed on a live dns server', () => {
  let feedPort = 0;
  let feed: ReturnType<typeof createServer> | null = null;

  beforeAll(async () => {
    spawnSync('docker', ['rm', '-f', NAME], { encoding: 'utf8' });
    const run = spawnSync(
      'docker',
      ['run', '-d', '--name', NAME, '-p', `${WEB_PORT}:5380`, '-p', '15371:53/udp', IMAGE],
      { encoding: 'utf8' },
    );
    if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
    await waitReady();

    // The feed the pane points at — emitted by the project's own formatter, not hand-written.
    const rules = parseFilterList('||ads.example.com^\n||tracker.example.org^', 'live');
    const filterText = generateFilterList(rules, { name: 'live' } as never, 'hosts');
    feed = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(filterText);
    });
    await new Promise<void>((resolve) => feed!.listen(0, '0.0.0.0', resolve));
    feedPort = (feed!.address() as AddressInfo).port;
  }, 120_000);

  afterAll(() => {
    feed?.close();
    spawnSync('docker', ['rm', '-f', NAME], { encoding: 'utf8' });
  });

  test('a subscribed block-list URL is pulled, and the listed name answers NXDOMAIN', async () => {
    const feedUrl = `http://${hostAddress()}:${feedPort}/filter.txt`;

    const set = await api(`/settings/set?blockListUrls=${encodeURIComponent(feedUrl)}`);
    expect(set.status).toBe('ok');

    const force = await api('/settings/forceUpdateBlockLists');
    expect(force.status).toBe('ok');
    // The pull is a server-side job; the zone is ready when a query answers.
    await new Promise((r) => setTimeout(r, 3000));

    const get = await api('/settings/get');
    const urls = (get.response.blockListUrls as string[] | null) ?? [];
    expect(urls).toContain(feedUrl);
    expect(get.response.blockingType).toBe('NxDomain');

    const deadline = Date.now() + 30_000;
    let blocked = '';
    while (Date.now() < deadline) {
      blocked = execFileSync(
        'docker',
        ['exec', NAME, 'sh', '-c', 'nslookup ads.example.com 127.0.0.1 2>&1 || true'],
        { encoding: 'utf8' },
      );
      if (/NXDOMAIN|can't find/i.test(blocked)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(blocked).toMatch(/NXDOMAIN|can't find/i);

    const clean = execFileSync(
      'docker',
      ['exec', NAME, 'sh', '-c', 'nslookup example.com 127.0.0.1 2>&1 || true'],
      { encoding: 'utf8' },
    );
    expect(clean).not.toMatch(/can't find/i);
    expect(clean).toMatch(/Address:/);
  }, 60_000);
});
