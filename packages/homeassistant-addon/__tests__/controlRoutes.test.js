/**
 * Remote-control route parity with the desktop hub.
 *
 * `/v1/control/cosmetics` and `/v1/control/reload` exist so an extension subscribed to
 * the add-on's `/v1/events` stream can be driven exactly as if the desktop hub had sent
 * the command — same paths, same `remote_control` event name, same action payloads.
 * A missing route would not just leave the button dead: it would make an install whose
 * hub *is* the add-on look broken next to an install whose hub is the desktop app.
 *
 * The assertions that matter: the SSE frame is the extension's wire format
 * (`event: remote_control` + JSON `data:`), POST is the only mutating verb, and the
 * routes sit behind the same token gate as everything else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const TOKEN = 'test-feed-token-9e2d41';

async function startServer(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bm-control-'));
  await writeFile(join(dataDir, 'dns.txt'), '||doubleclick.net^\n', 'utf8');
  await writeFile(join(dataDir, 'browser.txt'), 'example.com##.ad\n', 'utf8');

  const port = 45000 + Math.floor(Math.random() * 5000);
  const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn('node', [serverPath], {
    env: {
      ...process.env,
      FEED_PORT: String(port),
      DATA_DIR: dataDir,
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
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/v1/status?token=${TOKEN}`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await delay(100);
  }
  return { base, child };
}

async function post(base, path, body, token = TOKEN) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });
}

/** Collects SSE frames from /v1/events until `match` appears or the deadline passes. */
function nextSseEvent(base, match, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = get(`${base}/v1/events?token=${TOKEN}`, (res) => {
      let buf = '';
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`timed out waiting for SSE event matching ${match}`));
      }, timeoutMs);
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes(match)) {
          clearTimeout(timer);
          req.destroy();
          resolve(buf);
        }
      });
      res.on('error', () => { /* destroyed early — the timer already reported */ });
    });
    req.on('error', reject);
  });
}

test('POST /v1/control/cosmetics broadcasts the extension wire event', async (t) => {
  const { base } = await startServer(t);
  const frame = nextSseEvent(base, 'remote_control');
  await delay(150); // let the SSE client subscribe before the broadcast fires
  const res = await post(base, '/v1/control/cosmetics', { enabled: false });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.action, 'toggle_cosmetics');
  assert.equal(json.enabled, false);

  const sse = await frame;
  assert.match(sse, /event: remote_control\n/);
  assert.match(sse, /data: \{"action":"toggle_cosmetics","enabled":false\}/);
});

test('POST /v1/control/reload broadcasts reload_rules', async (t) => {
  const { base } = await startServer(t);
  const frame = nextSseEvent(base, 'remote_control');
  await delay(150);
  const res = await post(base, '/v1/control/reload', {});
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.action, 'reload_rules');

  const sse = await frame;
  assert.match(sse, /data: \{"action":"reload_rules"\}/);
});

test('GET cosmetics returns the hub-parity status stub; reload refuses GET', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/v1/control/cosmetics`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);

  const bad = await fetch(`${base}/v1/control/reload`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(bad.status, 405);
});

test('control routes sit behind the token gate like every other endpoint', async (t) => {
  const { base } = await startServer(t);
  const res = await post(base, '/v1/control/reload', {}, '');
  assert.notEqual(res.status, 200);
});
