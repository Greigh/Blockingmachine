/**
 * Live rehearsal for the AdGuard Home deploy path, against a real AGH in docker.
 *
 * The app's direct mode ends at `POST /control/filtering/refresh` with `{whitelist: false}` —
 * the call that asks a configured AGH to re-fetch its subscribed lists. This suite runs the
 * whole chain the recipe describes on the daemon itself:
 *
 *   subscribe  → POST /control/filtering/add_url   (AGH fetches the URL at subscribe time —
 *                                                  an unresolvable name is refused on the spot)
 *   refresh    → POST /control/filtering/refresh   (the app's exact request shape)
 *   verify     → /control/filtering/status         (the filter's rule count is non-zero)
 *   block      → a query to AGH's DNS              (a listed name answers 0.0.0.0; a clean name
 *                                                  resolves — the filter file is doing the work)
 *
 * The feed is an HTTP server inside this test serving a filter emitted by the project's own
 * formatter. The container reaches the host at the lima/docker host address, discovered the
 * same way the container resolves it — AGH's fetcher uses its own upstream DNS, not the
 * container resolver, so an `*.internal` name that `wget` resolves still fails add_url (a
 * real deployment constraint this suite keeps visible).
 *
 * Gated on the `adguard/adguardhome` image being present locally: it never pulls — CI and
 * contributors without it skip, and the pane's copy stays honest either way.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateFilterList, parseFilterList } from '@blockingmachine/core';

const IMAGE = 'adguard/adguardhome:v0.107.71';
const NAME = 'bm-agh-test';
const WEB_PORT = 13010;
const USER = 'bm';
const PASSWORD = 'bmtest123';
const API = `http://localhost:${WEB_PORT}`;
const AUTH = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

function haveDockerImage(): boolean {
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (docker.status !== 0) return false;
  return spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' }).status === 0;
}

const haveImage = haveDockerImage();

async function api(path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: AUTH,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API}/control/install/get_addresses`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('adguard home never came up');
}

/** The address the container reaches this host on — resolved the container's own way. */
function hostAddress(): string {
  const out = execFileSync(
    'docker',
    ['exec', NAME, 'nslookup', 'host.docker.internal'],
    { encoding: 'utf8' },
  );
  const ip = /Address:\s+(\d+\.\d+\.\d+\.\d+)\s*$/m.exec(out.trim())?.[1];
  if (!ip) throw new Error(`cannot resolve host.docker.internal in container:\n${out}`);
  return ip;
}

(haveImage ? describe : describe.skip)('the adguard home deploy path, rehearsed on a live agh', () => {
  let feedPort = 0;
  let feed: ReturnType<typeof createServer> | null = null;

  beforeAll(async () => {
    spawnSync('docker', ['rm', '-f', NAME], { encoding: 'utf8' });
    const run = spawnSync(
      'docker',
      ['run', '-d', '--name', NAME, '-p', `${WEB_PORT}:3000`, '-p', '15363:53/udp', IMAGE],
      { encoding: 'utf8' },
    );
    if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
    await waitReady();

    // First-boot configuration through the same API the install wizard drives.
    const conf = await fetch(`${API}/control/install/configure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        web: { ip: '0.0.0.0', port: 3000 },
        dns: { ip: '0.0.0.0', port: 53 },
        username: USER,
        password: PASSWORD,
        language: 'en',
      }),
    });
    if (!conf.ok) throw new Error(`install/configure failed: ${conf.status}`);
    await new Promise((r) => setTimeout(r, 3000));

    // The filter the hub would serve — emitted by the project's own formatter, not hand-written.
    const rules = parseFilterList('||ads.example.com^\n||tracker.example.org^', 'live');
    const filterText = generateFilterList(rules, { name: 'live' } as never, 'adguard');
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

  test('an unresolvable filter URL is refused at subscribe time', async () => {
    // The recipe's validateFilterURL claim, live: AGH resolves+fetches when asked to subscribe,
    // so a name its own DNS cannot see is rejected immediately — it cannot fail silently later.
    const res = await api('/control/filtering/add_url', {
      name: 'unresolvable',
      url: 'http://does-not-resolve.invalid/list.txt',
      whitelist: false,
    });
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/fetch|resolve|address/i);
  });

  test('the app\'s refresh call lands the subscribed filter — and the filter blocks', async () => {
    const feedUrl = `http://${hostAddress()}:${feedPort}/filter.txt`;
    const add = await api('/control/filtering/add_url', {
      name: 'bm-live',
      url: feedUrl,
      whitelist: false,
    });
    expect(add.status).toBe(200);
    expect(add.text).toMatch(/OK/i);

    // The exact request the hub sends: POST /control/filtering/refresh {whitelist:false}.
    const refresh = await api('/control/filtering/refresh', { whitelist: false });
    expect(refresh.status).toBe(200);

    const status = await api('/control/filtering/status');
    const filters = (JSON.parse(status.text).filters ?? []) as {
      name: string;
      rules_count: number;
      enabled: boolean;
    }[];
    const ours = filters.find((f) => f.name === 'bm-live');
    expect(ours?.enabled).toBe(true);
    expect(ours?.rules_count).toBeGreaterThan(0);

    // And the filter actually answers: a listed name nulls through AGH's own DNS,
    // a clean name resolves — the subscription is doing real work, not stored text.
    const blocked = execFileSync(
      'docker',
      ['exec', NAME, 'nslookup', 'ads.example.com', '127.0.0.1'],
      { encoding: 'utf8' },
    );
    expect(blocked).toMatch(/0\.0\.0\.0/);
    const clean = execFileSync(
      'docker',
      ['exec', NAME, 'nslookup', 'example.com', '127.0.0.1'],
      { encoding: 'utf8' },
    );
    expect(clean).not.toMatch(/Address:\s+0\.0\.0\.0/);
  }, 60_000);
});
