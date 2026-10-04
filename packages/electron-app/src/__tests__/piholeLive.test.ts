/**
 * Live rehearsal for the Pi-hole deploy path, against a real Pi-hole v6 in docker.
 *
 * The pane's presets point at `/admin` and its key field says "v5 & v6" — but the old code
 * emitted the v5 `?auth=&action=` shape against whatever URL it got. This suite proves the
 * failure and the fix on the daemon itself:
 *
 *   old shape on v6:  GET /admin?auth=x&type=version   → 308 → 200 HTML — a false "connected"
 *   api.php on v6:    GET /admin/api.php?…             → 400 "The API is hosted at pi.hole/api"
 *   v6 path:          auth → /api/info/version → gravity → DELETE auth  — gravity really runs
 *
 * Gated on the `pihole/pihole` image being present locally: it never pulls (a 161MB fetch has
 * no place in a unit run), so CI and contributors without the image skip — the unit suite in
 * `piholeApi.test.ts` carries the contract meanwhile. The container is always removed.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { piholeGravityUpdate, piholeVersionProbe } from '../piholeApi';
import { sinkholeFetch } from '../sinkholeFetch';
import type { SinkholeFetchInit } from '../sinkholeFetch';

const IMAGE = 'pihole/pihole:2025.11.1';
const NAME = 'bm-pihole-test';
const PORT = 18083;
const PASSWORD = 'bm-live-password';
const BASE = `http://localhost:${PORT}/admin`;

function haveDockerImage(): boolean {
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (docker.status !== 0) return false;
  const img = spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' });
  return img.status === 0;
}

const haveImage = haveDockerImage();
const INIT: SinkholeFetchInit = { timeoutMs: 8000, allowInsecureLocalTls: true };

/**
 * The docker desktop/colima port proxy on macOS occasionally misdelivers a closed stream's
 * tail onto the next connection — a transient transport fault, not a Pi-hole answer. A live
 * suite retries those; a semantic mismatch (bad status, wrong body) fails the first time.
 */
async function resilient<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if ((err as { statusCode?: number }).statusCode) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw last;
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await sinkholeFetch(`http://localhost:${PORT}/api/info/version`, INIT);
      // 401 unauthenticated is the ready signal — FTL is answering the API.
      if (res.status === 401 || res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('pi-hole container never came up');
}

(haveImage ? describe : describe.skip)('the pi-hole sync path, rehearsed on a live pi-hole v6', () => {
  beforeAll(async () => {
    spawnSync('docker', ['rm', '-f', NAME], { encoding: 'utf8' });
    const run = spawnSync(
      'docker',
      [
        'run', '-d', '--name', NAME,
        '-p', `${PORT}:80`,
        '-e', `FTLCONF_webserver_api_password=${PASSWORD}`,
        IMAGE,
      ],
      { encoding: 'utf8' },
    );
    if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
    await waitReady();
  }, 120_000);

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', NAME], { encoding: 'utf8' });
  });

  test('the retired v5-shaped URL is a false positive on v6', async () => {
    // What the old code did — auth+type params on the /admin URL a preset produces. FTL
    // redirects /admin to the SPA and answers 200 HTML: the old path reported "Connected".
    const res = await sinkholeFetch(`${BASE}?auth=x&type=version`, INIT);
    expect(res.status).toBe(200);
    expect((await res.text()).trimStart()).toMatch(/^</);
    // …and the api.php variant gets an explicit refusal naming the v6 API root.
    const legacy = await sinkholeFetch(`${BASE}/api.php?auth=x&action=updategravity`, INIT);
    expect(legacy.status).toBe(400);
    expect(await legacy.text()).toContain('/api');
  });

  test('piholeVersionProbe opens a real session and reads the version', async () => {
    const res = await resilient(async () => {
      const r = await piholeVersionProbe(BASE, PASSWORD, sinkholeFetch, INIT);
      if (!r.ok) throw new Error(`probe status ${r.status}: ${r.detail ?? ''}`);
      return r;
    });
    expect(res.ok).toBe(true);
    expect(res.flavor).toBe('v6');
  }, 30_000);

  test('piholeGravityUpdate triggers a gravity run the daemon records', async () => {
    const res = await resilient(() => piholeGravityUpdate(BASE, PASSWORD, sinkholeFetch, INIT));
    expect(res.ok).toBe(true);
    // The daemon's own log says gravity ran — the difference between a trigger and a fetch.
    // FTL writes the line when the rebuild finishes, so poll the container log.
    const deadline = Date.now() + 60_000;
    let logs = '';
    while (Date.now() < deadline) {
      logs = execFileSync('docker', ['logs', NAME], { encoding: 'utf8' });
      if (/Gravity database has been updated|gravity.*(start|began)/i.test(logs)) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(logs).toMatch(/Gravity database has been updated|gravity.*(start|began)/i);
  }, 90_000);

  test('a wrong password fails honestly instead of reading as connected', async () => {
    await expect(
      piholeVersionProbe(BASE, 'definitely-wrong', sinkholeFetch, INIT),
    ).rejects.toThrow(/rejected the password/);
  });
});
