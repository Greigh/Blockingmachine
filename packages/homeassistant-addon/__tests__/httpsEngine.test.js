/**
 * The add-on's HTTPS-filter engine — the same `startFilterProxy` the desktop
 * hub runs, bundled into `engine.mjs` so the image stays dependency-free.
 *
 * What this file proves: the engine actually comes up inside the add-on
 * process (not just "the import parses"), the data port serves the three
 * read-only enrollment surfaces a phone needs to join the hub (`/ca.pem`,
 * `/v1/proxy/ca.mobileconfig`, `/proxy.pac`), a configured token is enforced
 * on CONNECT, and a feed compile hot-reloads the engine's rule file. A
 * regression in any of these would leave the add-on advertising a proxy that
 * either isn't listening or can't be enrolled against.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, request } from 'node:http';
import { connect as netConnect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const TOKEN = 'test-feed-token-9e2d41';
const DATA_TOKEN = 'test-data-token-77aa';
// Fixed but obscure port window so parallel `node --test` files never collide;
// the control listener is loopback-only inside the process but still needs a
// real port to bind.
const DATA_PORT = 46300 + Math.floor(Math.random() * 500);
const CONTROL_PORT = 47300 + Math.floor(Math.random() * 500);

function httpJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method || 'GET', headers: opts.headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Raw CONNECT probe — returns the status code on the first response line. */
function connectProbe(port, target, headers = {}, dialHost = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, dialHost, () => {
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const m = /^HTTP\/\d\.\d (\d{3})/.exec(buf);
      if (m) {
        sock.destroy();
        resolve(parseInt(m[1], 10));
      }
    });
    sock.on('error', reject);
    setTimeout(() => {
      sock.destroy();
      reject(new Error('CONNECT probe timed out'));
    }, 5000).unref();
  });
}

async function startServer(t, extraEnv = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bm-https-'));
  await writeFile(join(dataDir, 'dns.txt'), '||doubleclick.net^\n', 'utf8');
  await writeFile(join(dataDir, 'browser.txt'), 'example.com##.ad\n', 'utf8');

  const feedPort = 48800 + Math.floor(Math.random() * 500);
  const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn('node', [serverPath], {
    env: {
      ...process.env,
      FEED_PORT: String(feedPort),
      DATA_DIR: dataDir,
      FEED_TOKEN: TOKEN,
      AUTO_COMPILE: 'disabled',
      HTTPS_FILTER: 'true',
      HTTPS_DATA_PORT: String(DATA_PORT),
      HTTPS_CONTROL_PORT: String(CONTROL_PORT),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  });

  // The engine's CA is generated on first boot (RSA-2048 keygen is the slow
  // part) — poll the data port rather than sleeping a fixed window.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await httpJson(`http://127.0.0.1:${DATA_PORT}/ca.pem`);
      if (res.status === 200) return { child, dataDir, feedPort };
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('data port did not answer /ca.pem within 30s');
    await delay(250);
  }
}

test('engine starts inside the add-on and status reports it', async (t) => {
  const { feedPort } = await startServer(t);
  const status = await httpJson(`http://127.0.0.1:${feedPort}/v1/status?token=${TOKEN}`);
  assert.equal(status.status, 200);
  const body = JSON.parse(status.body.toString('utf8'));
  assert.equal(body.httpsFilter.enabled, true);
  assert.equal(body.httpsFilter.running, true);
  assert.equal(body.httpsFilter.dataPort, DATA_PORT);
  // No token configured in this spawn — the open-LAN posture is reported, not hidden.
  assert.equal(body.httpsFilter.authRequired, false);
  assert.match(body.httpsFilter.caSha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test('enrollment surfaces: ca.pem, ca.mobileconfig, proxy.pac', async (t) => {
  await startServer(t);

  const pem = await httpJson(`http://127.0.0.1:${DATA_PORT}/ca.pem`);
  assert.equal(pem.status, 200);
  assert.match(pem.body.toString('utf8'), /-----BEGIN CERTIFICATE-----/);

  const mc = await httpJson(`http://127.0.0.1:${DATA_PORT}/v1/proxy/ca.mobileconfig`);
  assert.equal(mc.status, 200);
  // Safari needs the profile MIME type to offer "Profile Downloaded".
  assert.match(String(mc.headers['content-type']), /application\/x-apple-aspen-config/);
  const profile = mc.body.toString('utf8');
  // com.apple.security.root is the Apple root-CA payload type; the cert rides
  // as base64 DER inside <data>, not PEM text.
  assert.match(profile, /<string>com\.apple\.security\.root<\/string>/);
  assert.match(profile, /<key>PayloadContent<\/key>\s*<data>/);

  const pac = await httpJson(`http://127.0.0.1:${DATA_PORT}/proxy.pac`);
  assert.equal(pac.status, 200);
  assert.match(pac.body.toString('utf8'), /PROXY .*; DIRECT/);
});

test('data-port token is enforced on CONNECT when configured', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bm-https-auth-'));
  await writeFile(join(dataDir, 'dns.txt'), '||doubleclick.net^\n', 'utf8');
  await writeFile(join(dataDir, 'browser.txt'), '', 'utf8');
  const feedPort = 48800 + Math.floor(Math.random() * 500);
  const authDataPort = 46800 + Math.floor(Math.random() * 400);
  const authControlPort = 47800 + Math.floor(Math.random() * 400);
  const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn('node', [serverPath], {
    env: {
      ...process.env,
      FEED_PORT: String(feedPort),
      DATA_DIR: dataDir,
      FEED_TOKEN: TOKEN,
      AUTO_COMPILE: 'disabled',
      HTTPS_FILTER: 'true',
      HTTPS_DATA_PORT: String(authDataPort),
      HTTPS_CONTROL_PORT: String(authControlPort),
      HTTPS_DATA_TOKEN: DATA_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await httpJson(`http://127.0.0.1:${authDataPort}/ca.pem`);
      if (res.status === 200) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('auth data port did not answer within 30s');
    await delay(250);
  }

  // Flag-127 posture: loopback peers are exempt from the token gate — the
  // engine treats them as the machine's own tools. A LAN-shaped peer (dialing
  // the box's own interface address sources the flow from that address, so
  // remoteAddress is non-loopback) must authenticate before any flow.
  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (lanIp) {
    assert.equal(await connectProbe(authDataPort, 'example.org:443', {}, lanIp), 407);
    assert.equal(
      await connectProbe(authDataPort, 'doubleclick.net:443', { 'Proxy-Authorization': `Bearer ${DATA_TOKEN}` }, lanIp),
      403,
    );
  } else {
    // No LAN interface (odd CI) — at minimum prove the gate accepted config.
    t.diagnostic('no non-loopback IPv4 — skipping the peer-side auth probe');
  }
  // The loopback-exempt path still evaluates rules (403 = blocked, not dialed).
  assert.equal(await connectProbe(authDataPort, 'doubleclick.net:443'), 403);

  const status = await httpJson(`http://127.0.0.1:${feedPort}/v1/status?token=${TOKEN}`);
  const body = JSON.parse(status.body.toString('utf8'));
  assert.equal(body.httpsFilter.authRequired, true);
});

test('a feed compile hot-reloads the engine rules', async (t) => {
  const { feedPort, dataDir } = await startServer(t);

  // Rewrite the compiled feed — the add-on's compile re-emits engine-rules.txt
  // and POSTs /v1/proxy/reload on the loopback control listener.
  await writeFile(join(dataDir, 'dns.txt'), '||example-blocked.test^\n', 'utf8');
  const compile = await httpJson(`http://127.0.0.1:${feedPort}/v1/compile?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(compile.status, 200);

  // Reload is fire-and-forget inside runCompile — give the engine a beat, then
  // a CONNECT to the newly-listed host must be denied (403), where before the
  // rewrite it would have attempted a real dial.
  await delay(500);
  assert.equal(await connectProbe(DATA_PORT, 'example-blocked.test:443'), 403);
});
