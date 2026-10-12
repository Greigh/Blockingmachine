/**
 * Browser drive-by posture on a tokenless install.
 *
 * The add-on's auth model is "a configured feed_token gates the whole surface,
 * or the LAN is trusted". Before this hardening, a tokenless install had a
 * second, quieter hole: the CORS preflight advertised POST, and the mutation
 * endpoints parsed JSON regardless of Content-Type — so an arbitrary web page
 * could fire `POST /v1/protection` with a text/plain body (a "simple request",
 * no preflight needed) and pause blocking for the network.
 *
 * Two walls close that without an origin allowlist — which cannot exist here
 * because the dashboard's own calls arrive through Home Assistant ingress
 * bearing the HA instance's arbitrary origin:
 *   1. The preflight no longer offers POST, so a cross-origin request that
 *      would carry `Content-Type: application/json` is refused by the browser.
 *   2. Every POST endpoint requires `Content-Type: application/json`, so the
 *      simple-request shapes (text/plain, form) that skip preflights are
 *      refused by the server itself.
 *
 * Legitimate callers are unaffected: the dashboard's fetches are same-origin
 * (they never consult CORS), and the extension, mobile app, and any JSON
 * client already declare the content type.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function startAddon(t, env = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bm-driveby-'));
  await writeFile(join(dataDir, 'dns.txt'), '||doubleclick.net^\n', 'utf8');
  await writeFile(join(dataDir, 'browser.txt'), 'example.com##.ad\n', 'utf8');

  const port = 45000 + Math.floor(Math.random() * 5000);
  const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      FEED_PORT: String(port),
      AUTO_COMPILE: 'disabled',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  // In token mode every path 401s, so the readiness probe has to carry it.
  const probe = env.FEED_TOKEN ? `/v1/status?token=${env.FEED_TOKEN}` : '/v1/status';
  let up = false;
  for (let attempt = 0; attempt < 40 && !up; attempt += 1) {
    await delay(100);
    try {
      up = (await fetch(`${base}${probe}`)).ok;
    } catch { /* not up yet */ }
  }
  assert.ok(up, 'the add-on server did not come up');
  return base;
}

test('a tokenless install refuses the simple-request drive-by shapes', async (t) => {
  const base = await startAddon(t);

  // 1. The preflight must not offer POST — otherwise a cross-origin page could
  //    legitimately send the JSON content type the mutation endpoints consume.
  const preflight = await fetch(`${base}/v1/protection`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  const methods = (preflight.headers.get('access-control-allow-methods') || '').toLowerCase();
  assert.ok(methods.includes('get'), 'GET stays advertised for feed fetches');
  assert.ok(!methods.includes('post'), `preflight must not offer POST — got: ${methods}`);

  // 2. The classic simple-request drive-by: JSON payload under a preflight-free
  //    content type. Before the check this parsed and toggled protection.
  const driveBy = await fetch(`${base}/v1/protection`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(driveBy.status, 415, 'text/plain must not reach the JSON parser');

  const state = await (await fetch(`${base}/v1/protection`)).json();
  assert.equal(state.enabled, true, 'protection must be untouched by the refused POST');

  // 3. A form-shaped drive-by (the other simple-request type) gets the same wall.
  const formDriveBy = await fetch(`${base}/v1/telemetry/browser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'x=1',
  });
  assert.equal(formDriveBy.status, 415);

  // 4. A bare POST with no content type at all — fetch(url, {method:'POST'}) —
  //    is a simple request too, and previously triggered a full recompile.
  const barePost = await fetch(`${base}/v1/compile`, { method: 'POST' });
  assert.equal(barePost.status, 415, 'a bodyless POST must not trigger a compile');

  // 5. Real JSON clients are unaffected — the contract they already speak.
  const jsonPost = await fetch(`${base}/v1/protection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(jsonPost.status, 200, 'the declared JSON shape still toggles');
  const toggled = await (await fetch(`${base}/v1/protection`)).json();
  assert.equal(toggled.enabled, false);

  // And telemetry intake still aggregates for the extension.
  const telemetry = await fetch(`${base}/v1/telemetry/browser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackersBlocked: 3 }),
  });
  assert.equal(telemetry.status, 200);
});

test('with a token configured, authentication still precedes the content check', async (t) => {
  const TOKEN = 'driveby-token-9c1e';
  const base = await startAddon(t, { FEED_TOKEN: TOKEN });

  const unauth = await fetch(`${base}/v1/protection`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(unauth.status, 401, 'the token gate stays outermost');

  const authed = await fetch(`${base}/v1/protection?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(authed.status, 200, 'a token-holding JSON client is unaffected');
});
