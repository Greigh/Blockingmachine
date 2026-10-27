/**
 * Control API tests — the `/v1/proxy/*` surface on the loopback control port
 * (design spec §5.7, plan Task 7).
 *
 * The guard posture mirrors the system daemon's controlApi.test.ts: the
 * adversary is a web page on the same machine, so the origin allowlist, the
 * POST-only-JSON wall, and a preflight that never offers POST are all pinned
 * here on the proxy's own port. Beyond the guards, these tests drive the real
 * wiring end-to-end — `startFilterProxy` on a temp storeDir — asserting the
 * toggle's pause semantics on an actual CONNECT flow (paused ⇒ blind tunnel,
 * never a forge attempt), reload picking up a rewritten rules file, the CA
 * fingerprint's openssl-equivalent derivation, and the degraded-policy path
 * still yielding a running proxy.
 */

import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { once } from 'node:events';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { startFilterProxy, type RunningFilterProxy } from '../index.js';

jest.setTimeout(30_000);

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function tcpEchoServer(): net.Server {
  return net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
  });
}

/** Read until the HTTP header terminator or the socket closes — for CONNECT replies. */
function readHttpHead(sock: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.includes('\r\n\r\n')) {
        sock.off('data', onData);
        resolve(buf.toString('latin1'));
      }
    };
    sock.on('data', onData);
    sock.once('close', () => {
      sock.off('data', onData);
      resolve(buf.toString('latin1'));
    });
  });
}

/** Accumulate until at least `n` bytes arrive (or the socket ends). */
function collectBytes(sock: net.Socket, n: number): Promise<Buffer> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const done = () => {
      sock.off('data', onData);
      resolve(buf);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= n) done();
    };
    sock.on('data', onData);
    sock.once('close', done);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One CONNECT handshake through the data listener → response status line. */
async function connectHandshake(
  dataPort: number,
  target: string,
): Promise<{ sock: net.Socket; status: string }> {
  const sock = net.connect({ host: '127.0.0.1', port: dataPort });
  await once(sock, 'connect');
  sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const head = await withTimeout(readHttpHead(sock), 5_000, 'CONNECT response');
  return { sock, status: head.split('\r\n')[0] };
}

let dir: string;
let rulesPath: string;
let app: RunningFilterProxy;
let base: string;

const toggle = (enabled: boolean) =>
  fetch(`${base}/v1/proxy/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bm-https-filter-control-'));
  rulesPath = join(dir, 'rules.txt');
  await writeFile(rulesPath, '||one.example^\n');
  app = await startFilterProxy({
    storeDir: join(dir, 'store'),
    rulesPath,
    dataPort: 0,
    controlPort: 0,
  });
  base = `http://127.0.0.1:${app.controlPort}`;
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('control API guards (daemon-parity)', () => {
  test('the preflight does not offer POST', async () => {
    const res = await fetch(`${base}/v1/proxy/toggle`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    const methods = (res.headers.get('access-control-allow-methods') || '').toLowerCase();
    expect(methods).toContain('get');
    expect(methods).not.toContain('post');
  });

  test('a foreign browser origin is refused 403 on reads and mutations', async () => {
    const read = await fetch(`${base}/v1/proxy/status`, {
      headers: { Origin: 'http://rogue-printer.local' },
    });
    expect(read.status).toBe(403);
    const write = await fetch(`${base}/v1/proxy/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(write.status).toBe(403);
    expect(app.proxy.isPaused()).toBe(false);
  });

  test('a POST without application/json is refused 415', async () => {
    const res = await fetch(`${base}/v1/proxy/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(415);
    expect(app.proxy.isPaused()).toBe(false);
  });

  test('an unknown path answers 404; a known path under a wrong method answers 405', async () => {
    const unknown = await fetch(`${base}/v1/nope`);
    expect(unknown.status).toBe(404);

    const getOnPostRoute = await fetch(`${base}/v1/proxy/toggle`);
    expect(getOnPostRoute.status).toBe(405);
    expect(getOnPostRoute.headers.get('allow')).toContain('POST');

    const postOnGetRoute = await fetch(`${base}/v1/proxy/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(postOnGetRoute.status).toBe(405);
  });
});

describe('control API routes', () => {
  test('GET /v1/proxy/status reports the running shape', async () => {
    const res = await fetch(`${base}/v1/proxy/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe('running');
    expect(body.protectionEnabled).toBe(true);
    expect(body.paused).toBe(false);
    expect(body.dataPort).toBe(app.proxy.port);
    expect(body.controlPort).toBe(app.controlPort);
    expect(body.rulesLoaded).toBe(app.proxy.stats().rulesSize);
    expect(body.policyDegraded).toBe(false);
    expect(body.corruptLineCount).toBe(0);
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.stats.flowsTotal).toBe(app.proxy.stats().flowsTotal);
  });

  test('POST /v1/proxy/toggle pauses → CONNECT blind-tunnels; resume re-terminates', async () => {
    const echo = tcpEchoServer();
    const echoPort = await listen(echo);
    try {
      // Pause: a named CONNECT answers 200 and blind-splices — raw non-TLS
      // bytes echo straight through, where an unpaused flow would have peeked
      // for a ClientHello and closed. No forge attempt, no upstream verify.
      const res = await toggle(false);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.protectionEnabled).toBe(false);
      const status = (await (await fetch(`${base}/v1/proxy/status`)).json()) as Record<
        string,
        any
      >;
      expect(status.paused).toBe(true);
      expect(status.status).toBe('paused');

      const before = app.proxy.stats();
      const { sock, status: connectStatus } = await connectHandshake(
        app.proxy.port,
        `localhost:${echoPort}`,
      );
      expect(connectStatus).toBe('HTTP/1.1 200 Connection Established');
      sock.write('plain bytes, never a ClientHello');
      const echoed = await withTimeout(collectBytes(sock, 32), 8_000, 'paused echo');
      expect(echoed.toString('latin1')).toBe('plain bytes, never a ClientHello');
      const after = app.proxy.stats();
      expect(after.flowsTunneled).toBe(before.flowsTunneled + 1);
      expect(after.flowsTerminated).toBe(before.flowsTerminated); // no leaf-forge attempt
      sock.destroy();

      // Resume: the same CONNECT shape terminates TLS against the forged leaf.
      await toggle(true);
      expect(app.proxy.isPaused()).toBe(false);
      const { sock: sock2, status: status2 } = await connectHandshake(
        app.proxy.port,
        `localhost:${echoPort}`,
      );
      expect(status2).toBe('HTTP/1.1 200 Connection Established');
      const before2 = app.proxy.stats();
      const client = tls.connect({
        socket: sock2,
        servername: 'resumed.example',
        ca: app.authority.caCertPem,
        rejectUnauthorized: true,
      });
      await withTimeout(once(client, 'secureConnect'), 10_000, 'resumed handshake');
      expect(client.getPeerCertificate().subject.CN).toBe('resumed.example');
      expect(app.proxy.stats().flowsTerminated).toBe(before2.flowsTerminated + 1);
      client.destroy();
    } finally {
      await closeServer(echo);
    }
  });

  test('POST /v1/proxy/reload re-reads rulesPath — stats.rulesSize changes, new blocks enforce', async () => {
    const before = (await (await fetch(`${base}/v1/proxy/stats`)).json()) as Record<
      string,
      any
    >;
    expect(before.rulesSize).toBe(1);
    expect(before.corruptLineCount).toBe(0);

    // A CONNECT to a host the current ruleset doesn't know still tunnels/terminates.
    const { sock: preSock, status: preStatus } = await connectHandshake(
      app.proxy.port,
      'fresh-block.example:443',
    );
    expect(preStatus).toBe('HTTP/1.1 200 Connection Established');
    preSock.destroy();

    await writeFile(
      rulesPath,
      '||one.example^\n||two.example^\n||fresh-block.example^\n',
    );
    const res = await fetch(`${base}/v1/proxy/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.rulesLoaded).toBe(3);

    const stats = (await (await fetch(`${base}/v1/proxy/stats`)).json()) as Record<
      string,
      any
    >;
    expect(stats.rulesSize).toBe(3);
    expect(stats.rulesSize).not.toBe(before.rulesSize);

    const { sock, status: connectStatus, } = await connectHandshake(
      app.proxy.port,
      'fresh-block.example:443',
    );
    expect(connectStatus).toBe('HTTP/1.1 403 Forbidden');
    sock.destroy();
  });

  test('GET /v1/proxy/ca returns PEM + openssl-equivalent sha256 fingerprint + notAfter', async () => {
    const res = await fetch(`${base}/v1/proxy/ca`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.certPem).toBe(app.authority.caCertPem);

    // `openssl x509 -fingerprint -sha256` is sha256 over the DER, colon-paired
    // uppercase hex — derive it from the PEM independently and compare.
    const der = Buffer.from(
      body.certPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''),
      'base64',
    );
    const expected = createHash('sha256')
      .update(der)
      .digest('hex')
      .toUpperCase()
      .match(/../g)!
      .join(':');
    expect(body.sha256Fingerprint).toBe(expected);
    expect(body.sha256Fingerprint).toBe(new X509Certificate(body.certPem).fingerprint256);
    expect(body.notAfter).toBe(new X509Certificate(body.certPem).validTo);
  });

  test('POST /v1/proxy/ca/rotate mints a new CA identity', async () => {
    const before = (await (await fetch(`${base}/v1/proxy/ca`)).json()) as Record<
      string,
      any
    >;
    const res = await fetch(`${base}/v1/proxy/ca/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.certPem).not.toBe(before.certPem);
    expect(body.sha256Fingerprint).not.toBe(before.sha256Fingerprint);
  });

  test('GET /v1/proxy/pins lists the ledger and its corrupt-line count', async () => {
    const res = await fetch(`${base}/v1/proxy/pins`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(Array.isArray(body.pins)).toBe(true);
    expect(body.corruptLineCount).toBe(0);
  });
});

describe('policy store edge cases', () => {
  test('corrupt JSONL lines surface in stats and pins without failing startup', async () => {
    const d = await mkdtemp(join(tmpdir(), 'bm-https-filter-corrupt-'));
    try {
      const storeDir = join(d, 'store');
      await mkdir(storeDir, { recursive: true });
      const genesis = JSON.stringify({
        ts: 1,
        host: 'seeded.example',
        action: 'pin',
        reason: 'seed',
        prevHash: null,
      });
      await writeFile(join(storeDir, 'policy.jsonl'), `${genesis}\nNOT-JSON\n`);

      const app2 = await startFilterProxy({
        storeDir,
        rulesPath: join(d, 'rules.txt'), // absent → empty ruleset
        dataPort: 0,
        controlPort: 0,
      });
      try {
        const pins = (await (
          await fetch(`http://127.0.0.1:${app2.controlPort}/v1/proxy/pins`)
        ).json()) as Record<string, any>;
        expect(pins.corruptLineCount).toBe(1);
        expect(pins.pins).toEqual([
          { ts: 1, host: 'seeded.example', action: 'pin', reason: 'seed' },
        ]);
        const stats = (await (
          await fetch(`http://127.0.0.1:${app2.controlPort}/v1/proxy/stats`)
        ).json()) as Record<string, any>;
        expect(stats.corruptLineCount).toBe(1);
        expect(stats.rulesSize).toBe(0);
        const status = (await (
          await fetch(`http://127.0.0.1:${app2.controlPort}/v1/proxy/status`)
        ).json()) as Record<string, any>;
        expect(status.corruptLineCount).toBe(1);
      } finally {
        await app2.close();
      }
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test('a PolicyStore.open failure degrades to an in-memory store — proxy still runs', async () => {
    const d = await mkdtemp(join(tmpdir(), 'bm-https-filter-degraded-'));
    try {
      const storeDir = join(d, 'store');
      // policy.jsonl as a DIRECTORY: open's readFile throws EISDIR — the
      // degraded fallback keeps pin learning/toggles working in memory.
      await mkdir(join(storeDir, 'policy.jsonl'), { recursive: true });
      const app3 = await startFilterProxy({ storeDir, dataPort: 0, controlPort: 0 });
      try {
        expect(app3.policyDegraded).toBe(true);
        const status = (await (
          await fetch(`http://127.0.0.1:${app3.controlPort}/v1/proxy/status`)
        ).json()) as Record<string, any>;
        expect(status.status).toBe('running');
        expect(status.policyDegraded).toBe(true);

        // The ephemeral store is fully functional — it just never persists.
        app3.policy.learnPin('learned.example', 'handshake-abort');
        expect(app3.policy.isPinned('learned.example')).toBe(true);
        app3.policy.addBypass('bypass.example');
        expect(app3.policy.isBypassed('bypass.example')).toBe(true);
        expect(app3.policy.corruptLineCount).toBe(0);

        // Data path is live: a CONNECT to a literal IP still tunnels.
        const echo = tcpEchoServer();
        const echoPort = await listen(echo);
        try {
          const { sock, status: connectStatus } = await connectHandshake(
            app3.proxy.port,
            `127.0.0.1:${echoPort}`,
          );
          expect(connectStatus).toBe('HTTP/1.1 200 Connection Established');
          sock.write('alive');
          expect((await collectBytes(sock, 5)).toString('latin1')).toBe('alive');
          sock.destroy();
        } finally {
          await closeServer(echo);
        }
      } finally {
        await app3.close();
      }
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
