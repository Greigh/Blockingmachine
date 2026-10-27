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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { CertAuthority, startFilterProxy, type RunningFilterProxy } from '../index.js';

jest.setTimeout(30_000);

const V2_SIGNATURE = Buffer.from('\r\n\r\n\x00\r\nQUIT\n', 'latin1');

function buildTcp4Header(
  srcIp: number[],
  dstIp: number[],
  srcPort: number,
  dstPort: number,
): Buffer {
  const frame = Buffer.alloc(28);
  V2_SIGNATURE.copy(frame, 0);
  frame[12] = 0x21; // version 2, command PROXY
  frame[13] = 0x11; // AF_INET, STREAM
  frame.writeUInt16BE(12, 14);
  Buffer.from(srcIp).copy(frame, 16);
  Buffer.from(dstIp).copy(frame, 20);
  frame.writeUInt16BE(srcPort, 24);
  frame.writeUInt16BE(dstPort, 26);
  return frame;
}

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

describe('pin/bypass mutation routes (flags 95, 98)', () => {
  const postJson = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('POST /v1/proxy/pins/bypass marks the host bypassed and appends a chained ledger line', async () => {
    const res = await postJson('/v1/proxy/pins/bypass', {
      host: 'UserBypass.Example',
      reason: 'operator-directed',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    // The reply echoes the normalized host the store recorded.
    expect(body.host).toBe('userbypass.example');
    expect(body.bypassed).toBe(true);
    expect(body.pinned).toBe(false);
    expect(body.entry).toMatchObject({
      host: 'userbypass.example',
      action: 'bypass',
      reason: 'operator-directed',
    });
    expect(app.policy.isBypassed('userbypass.example')).toBe(true);
    expect(app.policy.isPinned('userbypass.example')).toBe(false);

    // The GET listing carries every action — the new entry surfaces there.
    const pins = (await (await fetch(`${base}/v1/proxy/pins`)).json()) as Record<
      string,
      any
    >;
    expect(
      pins.pins.some(
        (p: any) => p.host === 'userbypass.example' && p.action === 'bypass',
      ),
    ).toBe(true);

    // Persisted: the on-disk line chains to the previous physical line
    // (or carries the genesis null when it is the ledger's first line).
    const raw = await readFile(join(dir, 'store', 'policy.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((line) => line !== '');
    const records = lines.map((line) => JSON.parse(line) as Record<string, any>);
    const last = records[records.length - 1];
    expect(last.action).toBe('bypass');
    expect(last.host).toBe('userbypass.example');
    if (lines.length >= 2) {
      expect(last.prevHash).toBe(
        createHash('sha256').update(lines[lines.length - 2], 'utf8').digest('hex'),
      );
    } else {
      expect(last.prevHash).toBeNull();
    }
  });

  test('a host bypassed via the route tunnels a CONNECT without a verdict', async () => {
    const echo = tcpEchoServer();
    const echoPort = await listen(echo);
    try {
      const res = await postJson('/v1/proxy/pins/bypass', { host: 'localhost' });
      expect(res.status).toBe(200);

      // CONNECT authority 'localhost' is bypassed → 200 + blind splice: raw
      // non-TLS bytes echo straight through, where an evaluated flow would
      // have peeked for a ClientHello and closed on this junk.
      const before = app.proxy.stats();
      const { sock, status } = await connectHandshake(
        app.proxy.port,
        `localhost:${echoPort}`,
      );
      expect(status).toBe('HTTP/1.1 200 Connection Established');
      sock.write('bypassed bytes, never a ClientHello');
      const echoed = await withTimeout(collectBytes(sock, 32), 8_000, 'bypassed echo');
      expect(echoed.toString('latin1')).toBe('bypassed bytes, never a ClientHello');
      const after = app.proxy.stats();
      expect(after.flowsTunneled).toBe(before.flowsTunneled + 1);
      expect(after.flowsTerminated).toBe(before.flowsTerminated); // no forge — no verdict
      sock.destroy();
    } finally {
      // Retract so no later test inherits a bypassed loopback authority.
      app.policy.remove('localhost');
      await closeServer(echo);
    }
  });

  test('POST /v1/proxy/pins/remove retracts a learned pin — the host terminates again', async () => {
    const host = 'retract.example';
    app.policy.learnPin(host, 'pin-injection-sim');
    expect(app.policy.isPinned(host)).toBe(true);

    // While pinned the CONNECT blind-tunnels: the proxy dials
    // retract.example:443 (NXDOMAIN) and the splice dies — no forged
    // handshake is ever attempted.
    const { sock: pinnedSock, status: pinnedStatus } = await connectHandshake(
      app.proxy.port,
      `${host}:443`,
    );
    expect(pinnedStatus).toBe('HTTP/1.1 200 Connection Established');
    await withTimeout(once(pinnedSock, 'close'), 10_000, 'pinned-flow dial-fail close');

    const res = await postJson('/v1/proxy/pins/remove', { host });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.host).toBe(host);
    expect(body.pinned).toBe(false);
    expect(body.bypassed).toBe(false);
    expect(body.entry).toMatchObject({ host, action: 'remove' });
    expect(app.policy.isPinned(host)).toBe(false);

    // Unpinned, the same CONNECT terminates: a real ClientHello completes
    // against the forged leaf — a blind tunnel could never mint this cert.
    const { sock, status } = await connectHandshake(app.proxy.port, `${host}:443`);
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    const client = tls.connect({
      socket: sock,
      servername: host,
      ca: app.authority.caCertPem,
      rejectUnauthorized: true,
    });
    client.on('error', () => {});
    await withTimeout(once(client, 'secureConnect'), 10_000, 'post-remove forged handshake');
    expect(client.getPeerCertificate().subject.CN).toBe(host);
    // A completed handshake is not a pinning signal — the removal holds.
    expect(app.policy.isPinned(host)).toBe(false);
    client.destroy();
  });

  test('POST /v1/proxy/pins/remove retracts a bypass — remove covers both sets', async () => {
    app.policy.addBypass('retract-bypass.example');
    expect(app.policy.isBypassed('retract-bypass.example')).toBe(true);

    const res = await postJson('/v1/proxy/pins/remove', { host: 'retract-bypass.example' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.bypassed).toBe(false);
    expect(app.policy.isBypassed('retract-bypass.example')).toBe(false);
    expect(body.entry.action).toBe('remove');
  });

  test('the mutations reject bad hosts and bodies with 400', async () => {
    const cases: [string, unknown][] = [
      ['/v1/proxy/pins/bypass', {}], // host missing
      ['/v1/proxy/pins/remove', { host: 42 }], // non-string
      ['/v1/proxy/pins/bypass', { host: '   ' }], // normalizes to empty
      ['/v1/proxy/pins/remove', { host: `${'a'.repeat(254)}` }], // past the 253 DNS bound
      ['/v1/proxy/pins/bypass', { host: 'ok.example', reason: 7 }], // non-string reason
      ['/v1/proxy/pins/bypass', { host: 'ok.example', reason: 'x'.repeat(201) }],
    ];
    for (const [path, body] of cases) {
      const res = await postJson(path, body);
      expect(res.status).toBe(400);
      const payload = (await res.json()) as Record<string, any>;
      expect(payload.success).toBe(false);
      expect(typeof payload.error).toBe('string');
    }
    // Unparseable JSON is a 400 too — the guards pass it, the parser refuses it.
    const badJson = await fetch(`${base}/v1/proxy/pins/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'definitely not json',
    });
    expect(badJson.status).toBe(400);
    // None of the refused writes touched the ledger.
    expect(app.policy.isBypassed('ok.example')).toBe(false);
    expect(app.policy.isPinned('ok.example')).toBe(false);
  });

  test('the mutations inherit the POST guards — text/plain 415s, GET 405s', async () => {
    for (const path of ['/v1/proxy/pins/bypass', '/v1/proxy/pins/remove']) {
      const plain = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ host: 'drive-by.example' }),
      });
      expect(plain.status).toBe(415);
      const get = await fetch(`${base}${path}`);
      expect(get.status).toBe(405);
      expect(get.headers.get('allow')).toContain('POST');
    }
    expect(app.policy.isBypassed('drive-by.example')).toBe(false);
  });
});

describe('pause semantics — verdict points', () => {
  test('a paused CONNECT to a blocked host answers 200 — verdicts are off', async () => {
    // Baseline: unpaused, the rule blocks outright.
    const { sock: preSock, status: preStatus } = await connectHandshake(
      app.proxy.port,
      'one.example:443',
    );
    expect(preStatus).toBe('HTTP/1.1 403 Forbidden');
    await withTimeout(once(preSock, 'close'), 5_000, 'pre-check close');

    await toggle(false);
    try {
      const before = app.proxy.stats();
      const { sock, status } = await connectHandshake(app.proxy.port, 'one.example:443');
      expect(status).toBe('HTTP/1.1 200 Connection Established'); // verdict never ran
      const after = app.proxy.stats();
      expect(after.flowsBlocked).toBe(before.flowsBlocked);
      // The blind tunnel dials one.example:443 — NXDOMAIN closes the splice.
      await withTimeout(once(sock, 'close'), 10_000, 'upstream dial-fail close');
      sock.destroy();
    } finally {
      await toggle(true);
    }
  });

  test('a toggle landing mid-peek tunnels the CONNECT flow — no forge, no close', async () => {
    const echo = tcpEchoServer();
    const echoPort = await listen(echo);
    try {
      const { sock, status } = await connectHandshake(app.proxy.port, `localhost:${echoPort}`);
      expect(status).toBe('HTTP/1.1 200 Connection Established');
      // The ClientHello peek is now live — flip protection off inside it. A
      // paused verdict point must splice, never reach terminateFlow.
      await toggle(false);
      try {
        const before = app.proxy.stats();
        sock.write('mid-peek junk, not a ClientHello');
        const echoed = await withTimeout(collectBytes(sock, 32), 8_000, 'mid-peek echo');
        expect(echoed.toString('latin1')).toBe('mid-peek junk, not a ClientHello');
        const after = app.proxy.stats();
        expect(after.flowsTunneled).toBe(before.flowsTunneled + 1);
        expect(after.flowsTerminated).toBe(before.flowsTerminated);
        sock.destroy();
      } finally {
        await toggle(true);
      }
    } finally {
      await closeServer(echo);
    }
  });

  test('a mid-peek paused PROXY-v2 flow tunnels to the ANNOUNCED destination', async () => {
    // The upstream is a real TLS server whose cert a scratch CA signed — a
    // tunneled ClientHello completes against its leaf. A mis-dialed sni:443
    // (the old post-peek fallback even when the v2 destination was known) or
    // a terminated flow can never produce this handshake.
    const originDir = await mkdtemp(join(tmpdir(), 'bm-control-origin-ca-'));
    let upstream: tls.Server | null = null;
    try {
      const originCa = await CertAuthority.open({ storeDir: originDir });
      const leaf = originCa.forgeLeaf('v2paused.example');
      upstream = tls.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (s) => {
        s.on('data', (c: Buffer) => s.write(c));
      });
      const upstreamPort = await listen(upstream);

      const sock = net.connect({ host: '127.0.0.1', port: app.proxy.port });
      await once(sock, 'connect');
      sock.write(buildTcp4Header([10, 9, 9, 9], [127, 0, 0, 1], 51111, upstreamPort));
      // Let the frame land so the ClientHello peek is live — the pre-peek
      // paused check must already have run with protection on, forcing this
      // flow through the post-peek re-check branch.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await toggle(false);
      try {
        const client = tls.connect({
          socket: sock,
          servername: 'v2paused.example',
          ca: originCa.caCertPem,
          rejectUnauthorized: true,
        });
        client.on('error', () => {});
        await withTimeout(once(client, 'secureConnect'), 10_000, 'paused v2 handshake');
        expect(client.getPeerCertificate().subject.CN).toBe('v2paused.example');
        client.destroy();
      } finally {
        await toggle(true);
        sock.destroy();
      }
    } finally {
      if (upstream !== null) {
        await closeServer(upstream);
      }
      await rm(originDir, { recursive: true, force: true });
    }
  });
});

describe('startup failure cleanup', () => {
  test('a control-port bind failure rejects startFilterProxy AND releases the data port', async () => {
    const d = await mkdtemp(join(tmpdir(), 'bm-https-filter-bindfail-'));
    const blocker = net.createServer();
    try {
      // Occupy the control port; claim a free port for the data listener so
      // its release is probeable afterwards.
      const controlPort = await listen(blocker);
      const probe = net.createServer();
      const dataPort = await listen(probe);
      await closeServer(probe);

      await expect(
        startFilterProxy({ storeDir: join(d, 'store'), dataPort, controlPort }),
      ).rejects.toThrow();

      // The bound data listener must have been closed on the way out — a
      // connect is refused, not answered.
      const s = net.connect({ host: '127.0.0.1', port: dataPort });
      s.on('error', () => {});
      await withTimeout(once(s, 'error'), 5_000, 'released-port refusal');
      s.destroy();
    } finally {
      await closeServer(blocker);
      await rm(d, { recursive: true, force: true });
    }
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

        // app3 was booted without rulesPath — reload reports the honest 500.
        const reload = await fetch(
          `http://127.0.0.1:${app3.controlPort}/v1/proxy/reload`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
        );
        expect(reload.status).toBe(500);
        const reloadBody = (await reload.json()) as Record<string, any>;
        expect(reloadBody.success).toBe(false);
        expect(reloadBody.error).toContain('rulesPath');

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
