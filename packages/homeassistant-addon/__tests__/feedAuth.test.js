/**
 * Feed-token gating: when `feed_token` is configured, every endpoint the add-on serves requires
 * it — the feeds, the REST API, the mutation endpoints and the dashboard.
 *
 * The whole surface is gated rather than just the feed paths because the dashboard embeds rule
 * previews and the feed URLs — a page that stayed open would leak what the feeds are protecting,
 * and the token inside the copied URLs. And `/v1/protection` pauses blocking for the network:
 * leaving it open on an untrusted network is worse than leaking the list.
 *
 * Three credential shapes are accepted because the consumers differ in what they can send:
 * `?token=` for subscription URLs, `Bearer` for scripts, and `Basic` — which is also what a client
 * produces for a `http://user:token@host/` userinfo URL.
 *
 * The check that matters most is the negative one: `X-Hass-Source`/`X-Ingress-Path` headers mark
 * traffic that came through Home Assistant's ingress proxy, but a direct client can set them by
 * hand, so they must not bypass the token.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const TOKEN = 'test-feed-token-4f8c2a';

const ALL_PATHS = [
  '/',
  '/dns.txt',
  '/browser.txt',
  '/unbound.conf',
  '/shadowrocket.conf',
  '/privoxy.action',
  '/db.blockingmachine.rpz',
  '/v1/status',
  '/v1/rules',
  '/v1/events',
  '/v1/check?domain=doubleclick.net',
];

test('a configured feed token gates every endpoint, by every accepted credential shape', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bm-feed-auth-'));
  await writeFile(join(dataDir, 'dns.txt'), '||doubleclick.net^\n', 'utf8');
  await writeFile(join(dataDir, 'browser.txt'), 'example.com##.ad\n', 'utf8');

  const port = 44000 + Math.floor(Math.random() * 5000);
  const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      FEED_PORT: String(port),
      FEED_TOKEN: TOKEN,
      AUTO_COMPILE: 'disabled',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let attempt = 0; attempt < 40 && !up; attempt += 1) {
    await delay(100);
    try {
      const probe = await fetch(`${base}/dns.txt?token=${TOKEN}`);
      up = probe.ok;
    } catch { /* not up yet */ }
  }
  assert.ok(up, 'the add-on server did not come up');

  // 1. Nothing is open without the credential — feeds, API and dashboard alike.
  for (const path of ALL_PATHS) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 401, `${path} must refuse without the token`);
    assert.equal(res.headers.get('www-authenticate'), 'Basic realm="Blockingmachine feeds", charset="UTF-8"',
      `${path} should offer a Basic challenge so fetchers and browsers can answer it`);
    const body = await res.text();
    assert.ok(!body.includes('doubleclick.net'), `${path} must not leak feed content in a 401`);
    assert.ok(!body.includes(TOKEN), `${path} must not leak the token in a 401`);
  }

  // A forged ingress provenance is not a credential: the headers only mark how a request arrived
  // through HA's proxy, and anything on the port can set them.
  const forged = await fetch(`${base}/dns.txt`, {
    headers: { 'X-Hass-Source': 'core.ingress', 'X-Ingress-Path': '/api/hassio_ingress/test' },
  });
  assert.equal(forged.status, 401, 'ingress headers alone must not satisfy the token check');

  // A mutation endpoint is the dangerous thing to leave open, so it gets its own pin.
  const mutate = await fetch(`${base}/v1/protection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(mutate.status, 401, 'the protection toggle must be gated too');

  // 2. Query param — the shape a subscription URL can carry.
  for (const path of ['/dns.txt', '/unbound.conf', '/shadowrocket.conf', '/privoxy.action', '/db.blockingmachine.rpz']) {
    const res = await fetch(`${base}${path}?token=${TOKEN}`);
    assert.equal(res.status, 200, `${path}?token=… must be served`);
  }

  // 3. Bearer — the shape a script sends.
  const bearer = await fetch(`${base}/dns.txt`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(bearer.status, 200);
  assert.ok((await bearer.text()).includes('doubleclick.net'));

  // 4. Basic — the shape a userinfo URL (`http://user:token@host/…`) arrives as.
  const basic = await fetch(`${base}/dns.txt`, {
    headers: { Authorization: `Basic ${Buffer.from(`user:${TOKEN}`).toString('base64')}` },
  });
  assert.equal(basic.status, 200, 'user:token basic auth must be accepted');
  const bareBasic = await fetch(`${base}/dns.txt`, {
    headers: { Authorization: `Basic ${Buffer.from(TOKEN).toString('base64')}` },
  });
  assert.equal(bareBasic.status, 200, 'a bare-token basic credential must be accepted');

  // 5. Wrong credentials get the same refusal as none — no partial answers.
  for (const attempt of [
    fetch(`${base}/dns.txt?token=wrong`),
    fetch(`${base}/dns.txt`, { headers: { Authorization: 'Bearer wrong' } }),
    fetch(`${base}/dns.txt`, { headers: { Authorization: `Basic ${Buffer.from('user:wrong').toString('base64')}` } }),
    fetch(`${base}/dns.txt`, { headers: { Authorization: `Basic ${Buffer.from('not base64 at all !!!').toString('base64')}` } }),
  ]) {
    assert.equal((await attempt).status, 401);
  }

  // 6. The CORS preflight stays open — a 401 on OPTIONS would make the failure unreadable.
  const preflight = await fetch(`${base}/dns.txt`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204, 'OPTIONS is the handshake, not content');

  // 7. The dashboard and status answer for a token holder, and the URLs they print carry it.
  const dash = await fetch(`${base}/?token=${TOKEN}`);
  assert.equal(dash.status, 200);
  const dashHtml = await dash.text();
  assert.ok(dashHtml.includes(`?token=${TOKEN}`), 'copied feed URLs must work as pasted');
  assert.ok(dashHtml.includes('token required'), 'the dashboard should state the auth mode');

  const status = await (await fetch(`${base}/v1/status?token=${TOKEN}`)).json();
  assert.equal(status.feedServer.requiresAuth, true);
  assert.ok(status.feedServer.dnsFeedUrl.includes(`?token=${TOKEN}`));
  assert.deepEqual(status.browserTelemetry, { trackersBlocked: 0, elementsHidden: 0, threatsDetected: 0 });
});

test('v1/check resolves a domain the way the DNS consumers would', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bm-check-'));
  await writeFile(
    join(dataDir, 'dns.txt'),
    // The allow is a child of the blocked parent on purpose — longest match wins.
    '||doubleclick.net^\n@@||excepted.doubleclick.net^\n',
    'utf8',
  );

  const port = 44000 + Math.floor(Math.random() * 5000);
  const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      FEED_PORT: String(port),
      AUTO_COMPILE: 'disabled',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let attempt = 0; attempt < 40 && !up; attempt += 1) {
    await delay(100);
    try {
      up = (await fetch(`${base}/v1/status`)).ok;
    } catch { /* not up yet */ }
  }
  assert.ok(up, 'the add-on server did not come up');

  const blocked = await (await fetch(`${base}/v1/check?domain=ads.doubleclick.net`)).json();
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.matchedHost, 'doubleclick.net');

  const allowed = await (await fetch(`${base}/v1/check?domain=excepted.doubleclick.net`)).json();
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.matchedHost, 'excepted.doubleclick.net');

  const unknown = await (await fetch(`${base}/v1/check?domain=example.org`)).json();
  assert.equal(unknown.blocked, false);
  assert.equal(unknown.matchedHost, null);

  const invalid = await fetch(`${base}/v1/check?domain=not_a_domain`);
  assert.equal(invalid.status, 400);
});
