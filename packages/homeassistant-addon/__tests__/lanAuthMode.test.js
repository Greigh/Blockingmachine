/**
 * D-7: the add-on's installation-aware auth posture, and the D-9 admin boundary
 * around the mode switch.
 *
 * New installs mint a token and run 'required'; a data dir holding artifacts
 * from an older version is an existing install and stays 'open' — token
 * absence is never the signal. Mode changes are privileged: only the
 * management credential (`.admin_token`, minted on every install and
 * recoverable only through the add-on Log / data dir) authorizes them — never
 * the feed token, the session cookie, or a spoofable header.
 *
 * These spawn the real server the way the s6 run script does and assert the
 * observable contract end-to-end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir, chmod, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

async function startAddon(t, { seedFiles = {}, env = {} } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bm-lanauth-'));
  for (const [name, content] of Object.entries(seedFiles)) {
    if (name === '.lan-auth-dir') {
      await mkdir(join(dataDir, '.lan-auth.json'));
      continue;
    }
    await writeFile(join(dataDir, name), content, 'utf8');
  }
  const port = 46000 + Math.floor(Math.random() * 3000);
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
  // Wait until the auth state file exists (mode decided) — then probe with
  // whatever credential the posture demands.
  for (let i = 0; i < 40; i += 1) {
    if (existsSync(join(dataDir, '.lan-auth.json')) || existsSync(join(dataDir, '.feed_token'))) break;
    await delay(100);
  }
  const minted = existsSync(join(dataDir, '.feed_token'))
    ? (await readFile(join(dataDir, '.feed_token'), 'utf8')).trim()
    : (env.FEED_TOKEN || '');
  const admin = existsSync(join(dataDir, '.admin_token'))
    ? (await readFile(join(dataDir, '.admin_token'), 'utf8')).trim()
    : '';
  // Readiness = the socket answers at all. A 401 is a *good* sign on a secured
  // install — it means initLanAuth ran and the gates are up before listen.
  const probe = minted ? `/v1/status?token=${minted}` : '/v1/status';
  let up = false;
  for (let attempt = 0; attempt < 40 && !up; attempt += 1) {
    await delay(100);
    try {
      const res = await fetch(`${base}${probe}`);
      up = res.status === 200 || res.status === 401;
    } catch { /* not up yet */ }
  }
  assert.ok(up, 'the add-on server did not come up');
  return { base, dataDir, minted, admin };
}

const authModePost = (base, { mode, headers = {} } = {}) =>
  fetch(`${base}/v1/auth-mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ mode }),
  });

test('a new install boots secured: token minted, everything gated, unlock+cookie flow works', async (t) => {
  const { base, dataDir, minted, admin } = await startAddon(t);

  // Mode + credential persisted for the next boot.
  const state = JSON.parse(await readFile(join(dataDir, '.lan-auth.json'), 'utf8'));
  assert.equal(state.mode, 'required');
  assert.match(minted, /^[A-Za-z0-9_-]{32}$/);
  // The management credential exists too — on EVERY install, 0600.
  assert.match(admin, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await stat(join(dataDir, '.admin_token'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dataDir, '.feed_token'))).mode & 0o777, 0o600);

  // Everything is gated — status, feeds, and the dashboard path alike.
  for (const path of ['/v1/status', '/dns.txt', '/v1/protection']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 401, `${path} must require the token on a new install`);
  }

  // A browser hitting the dashboard gets the unlock page, not bare JSON.
  const dash = await fetch(`${base}/`, { headers: { Accept: 'text/html' } });
  assert.equal(dash.status, 401);
  assert.match(await dash.text(), /Unlock|feed token/i);

  // Typing the token into the unlock form lands on /?token=… — authorized, and
  // a session cookie comes back so the query param can go away.
  const unlocked = await fetch(`${base}/?token=${minted}`, { headers: { Accept: 'text/html' } });
  assert.equal(unlocked.status, 200);
  const setCookie = unlocked.headers.get('set-cookie') || '';
  assert.match(setCookie, /bm_token=/);
  assert.match(setCookie, /HttpOnly/i);

  // The cookie alone authenticates subsequent requests — the ingress session.
  const viaCookie = await fetch(`${base}/v1/status`, {
    headers: { Cookie: `bm_token=${minted}` },
  });
  assert.equal(viaCookie.status, 200);

  // The credentialed status deliberately discloses the feed token (the
  // dashboard's copy buttons); bearer and basic-auth shapes work for feed
  // clients. The admin credential is NEVER disclosed.
  const status = await viaCookie.json();
  assert.equal(status.feedServer.authMode, 'required');
  assert.equal(status.feedServer.feedToken, minted);
  assert.equal(status.feedServer.adminConfigured, true);
  assert.equal(status.feedServer.adminAuthorized, false);
  assert.ok(!JSON.stringify(status).includes(admin), 'status must never carry the admin credential');
  const bearer = await fetch(`${base}/v1/status`, { headers: { Authorization: `Bearer ${minted}` } });
  assert.equal(bearer.status, 200);
});

test('an existing install stays open: artifacts in DATA_DIR mean compatibility, not a forced token', async (t) => {
  const { base, dataDir, admin } = await startAddon(t, {
    seedFiles: { 'dns.txt': '||doubleclick.net^\n', 'browser.txt': 'example.com##.ad\n' },
  });

  // The upgrade path: state recorded 'open' so behaviour matches what ran before.
  const state = JSON.parse(await readFile(join(dataDir, '.lan-auth.json'), 'utf8'));
  assert.equal(state.mode, 'open');
  assert.equal(state.version, 2);
  assert.equal(existsSync(join(dataDir, '.feed_token')), false, 'no token is minted onto a legacy install');
  assert.match(admin, /^[A-Za-z0-9_-]{32}$/, 'the admin credential IS minted on legacy installs');

  for (const path of ['/v1/status', '/dns.txt', '/v1/protection']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} must stay open for existing subscribers`);
  }
  // Open-mode status must NOT disclose a stored token to an unauthenticated caller.
  const status = await (await fetch(`${base}/v1/status`)).json();
  assert.equal(status.feedServer.authMode, 'open');
  assert.equal(status.feedServer.feedToken, '');
});

// ─── D-9: the admin boundary on /v1/auth-mode ─────────────────────────────────

test('an unauthenticated LAN client cannot flip open→required — no state changes', async (t) => {
  const { base, dataDir } = await startAddon(t, { seedFiles: { 'dns.txt': '||x^\n' } });

  const res = await authModePost(base, { mode: 'required' });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /admin/i);
  assert.ok(!JSON.stringify(body).match(/[A-Za-z0-9_-]{32}/), 'no credential in the refusal');

  // Zero state change — file, mode, and gate all untouched.
  const state = JSON.parse(await readFile(join(dataDir, '.lan-auth.json'), 'utf8'));
  assert.equal(state.mode, 'open');
  assert.equal(existsSync(join(dataDir, '.feed_token')), false, 'no token was minted by the refusal');
  assert.equal((await fetch(`${base}/v1/status`)).status, 200);
});

test('an unauthenticated LAN client cannot flip required→open', async (t) => {
  const { base, minted } = await startAddon(t);
  // Bare request: refused at the outer data-plane gate (401) before it can even
  // reach the admin check — no state change either way.
  const res = await authModePost(base, { mode: 'open' });
  assert.equal(res.status, 401);
  assert.equal((await fetch(`${base}/v1/status`)).status, 401, 'required stays required');
  // Even armed with the feed token, an ordinary client is still not admin:
  // the bearer passes the data-plane gate then hits the admin check — 403.
  const withFeed = await authModePost(base, {
    mode: 'open',
    headers: { Authorization: `Bearer ${minted}` },
  });
  assert.equal(withFeed.status, 403);
  const status = await fetch(`${base}/v1/status?token=${minted}`);
  assert.equal(status.status, 200);
});

test('forged Origin, Referer, Host and ingress headers do not grant admin', async (t) => {
  const { base, dataDir } = await startAddon(t, { seedFiles: { 'dns.txt': '||x^\n' } });
  const forged = {
    Origin: 'https://homeassistant.local:8123',
    Referer: 'https://homeassistant.local:8123/api/hassio_ingress/abc/',
    'X-Ingress-Path': '/api/hassio_ingress/abc',
    'X-Hass-Source': 'core.ingress',
    'X-Forwarded-For': '172.30.32.2',
    Host: 'homeassistant.local:8123',
  };
  const res = await authModePost(base, { mode: 'required', headers: forged });
  assert.equal(res.status, 403);
  const state = JSON.parse(await readFile(join(dataDir, '.lan-auth.json'), 'utf8'));
  assert.equal(state.mode, 'open');
});

test('the admin credential authorizes flips via X-Admin-Token AND Bearer — in both modes', async (t) => {
  const { base, dataDir, admin } = await startAddon(t, { seedFiles: { 'dns.txt': '||x^\n' } });

  // open → required with the management credential.
  const flip = await authModePost(base, {
    mode: 'required',
    headers: { 'X-Admin-Token': admin },
  });
  assert.equal(flip.status, 200);
  const result = await flip.json();
  assert.equal(result.success, true);
  assert.equal(result.tokenMinted, true);
  // Only admins reach this response — echoing the feed token is safe and is
  // what the caller needs to re-pair its clients.
  const token = (await readFile(join(dataDir, '.feed_token'), 'utf8')).trim();
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(result.token, token);

  // Enforced immediately + durable.
  assert.equal((await fetch(`${base}/v1/status`)).status, 401);
  assert.equal((await fetch(`${base}/v1/status?token=${token}`)).status, 200);
  const state = JSON.parse(await readFile(join(dataDir, '.lan-auth.json'), 'utf8'));
  assert.equal(state.mode, 'required');

  // required → open via Bearer-carried admin credential, WITHOUT also carrying
  // the feed token — admin authority alone satisfies the request gate here.
  const back = await authModePost(base, {
    mode: 'open',
    headers: { Authorization: `Bearer ${admin}` },
  });
  assert.equal((await back.json()).success, true);
  assert.equal((await fetch(`${base}/v1/status`)).status, 200);
});

test('concurrent unauthorized flips can never exploit a transition window', async (t) => {
  const { base, dataDir } = await startAddon(t, { seedFiles: { 'dns.txt': '||x^\n' } });
  const bursts = await Promise.all(Array.from({ length: 8 }, () =>
    authModePost(base, { mode: 'required' }),
  ));
  assert.ok(bursts.every((r) => r.status === 403));
  const state = JSON.parse(await readFile(join(dataDir, '.lan-auth.json'), 'utf8'));
  assert.equal(state.mode, 'open');
});

test('the admin credential is never accepted via a URL query parameter', async (t) => {
  const { base, dataDir, admin } = await startAddon(t, { seedFiles: { 'dns.txt': '||x^\n' } });
  const res = await fetch(`${base}/v1/auth-mode?admin_token=${admin}&token=${admin}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'required' }),
  });
  assert.equal(res.status, 403, 'admin creds stay out of URLs');
  const state = JSON.parse(await readFile(join(dataDir, '.lan-auth.json'), 'utf8'));
  assert.equal(state.mode, 'open');
});

test('an existing install migrates to required via the admin credential — and persists', async (t) => {
  const { base, dataDir, admin } = await startAddon(t, { seedFiles: { 'dns.txt': '||x^\n' } });
  const flip = await authModePost(base, { mode: 'required', headers: { 'X-Admin-Token': admin } });
  assert.equal((await flip.json()).success, true);
  const token = (await readFile(join(dataDir, '.feed_token'), 'utf8')).trim();
  const state = JSON.parse(await readFile(join(dataDir, '.lan-auth.json'), 'utf8'));
  assert.equal(state.mode, 'required');
  assert.equal((await fetch(`${base}/v1/status`)).status, 401);
  assert.equal((await fetch(`${base}/v1/status?token=${token}`)).status, 200);
  const status = await (await fetch(`${base}/v1/status?token=${token}`)).json();
  assert.equal(status.feedServer.feedToken, token);
});

// ─── Detection / crash-recovery edges ─────────────────────────────────────────

test('a corrupt state file fails closed to required, never silently open', async (t) => {
  const { base } = await startAddon(t, {
    seedFiles: {
      '.lan-auth.json': '{not json',
      'dns.txt': '||x^\n',
    },
  });
  assert.equal((await fetch(`${base}/v1/status`)).status, 401);
});

test('a state file that is not a file at all fails closed to required', async (t) => {
  const { base } = await startAddon(t, {
    seedFiles: { '.lan-auth-dir': '', 'dns.txt': '||x^\n' },
  });
  assert.equal((await fetch(`${base}/v1/status`)).status, 401);
});

test('required mode with a missing credential re-mints and stays required (backup-restore heal)', async (t) => {
  const { base, dataDir } = await startAddon(t, {
    seedFiles: {
      '.lan-auth.json': JSON.stringify({ version: 2, mode: 'required' }),
      'dns.txt': '||x^\n',
    },
  });
  // A restored .lan-auth.json without its .feed_token: fail-closed heal mints.
  const token = (await readFile(join(dataDir, '.feed_token'), 'utf8')).trim();
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await fetch(`${base}/v1/status`)).status, 401);
  assert.equal((await fetch(`${base}/v1/status?token=${token}`)).status, 200);
});

test('an unreadable state file fails closed to required', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bm-lanauth-'));
  await writeFile(join(dataDir, '.lan-auth.json'), JSON.stringify({ mode: 'open' }));
  await writeFile(join(dataDir, 'dns.txt'), '||x^\n');
  await chmod(join(dataDir, '.lan-auth.json'), 0o000);
  const port = 46000 + Math.floor(Math.random() * 3000);
  const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DATA_DIR: dataDir, FEED_PORT: String(port), AUTO_COMPILE: 'disabled' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await chmod(join(dataDir, '.lan-auth.json'), 0o600).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let status = 0;
  for (let i = 0; i < 40; i += 1) {
    await delay(100);
    try {
      const res = await fetch(`${base}/v1/status`);
      status = res.status;
      break;
    } catch { /* not up */ }
  }
  assert.equal(status, 401, 'an unreadable mode record must not silently open the surface');
});

test('a user-configured feed_token option always means required', async (t) => {
  const TOKEN = 'user-managed-token-42';
  const { base, minted } = await startAddon(t, { env: { FEED_TOKEN: TOKEN } });
  assert.equal(minted, TOKEN);
  assert.equal((await fetch(`${base}/v1/status`)).status, 401);
  assert.equal((await fetch(`${base}/v1/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
});

test('an open-mode surface never discloses a stored token to an unauthenticated caller', async (t) => {
  const seeded = 'open-mode-seeded-token-9f4c1e';
  const { base } = await startAddon(t, {
    seedFiles: {
      '.lan-auth.json': JSON.stringify({ mode: 'open' }),
      '.feed_token': seeded + '\n',
      'dns.txt': '||x^\n',
    },
  });

  // The dashboard and status payloads are served unauthenticated in open mode —
  // they must not carry the credential a later 'required' flip would enforce.
  const html = await (await fetch(`${base}/`)).text();
  assert.ok(!html.includes(seeded), 'dashboard feed URLs must not embed the stored token');
  const status = await (await fetch(`${base}/v1/status`)).json();
  assert.equal(status.feedServer.feedToken, '');
  assert.ok(!JSON.stringify(status.feedServer).includes(seeded), 'status feed URLs leak the stored token');

  // …but the stored token is still honoured when a client sends it — and that
  // caller, having proved the credential, may see it echoed.
  const authed = await (await fetch(`${base}/v1/status?token=${seeded}`)).json();
  assert.equal(authed.feedServer.feedToken, seeded);
});
