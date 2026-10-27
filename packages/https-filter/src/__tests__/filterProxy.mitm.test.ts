/**
 * MITM termination tests (design spec §5.3, plan Task 5).
 *
 * End-to-end proof of the forge → terminate → verified-upstream chain: a
 * client CONNECTs through the data listener, negotiates TLS against a leaf
 * forged for its SNI, and its plaintext HTTP request is evaluated per-request
 * and relayed to the real origin over a fully chain-verified upstream TLS
 * connection (`rejectUnauthorized: true` — fail closed, no bypass anywhere).
 *
 * Also covers the plain-HTTP absolute-form forward path (Review Focus #3),
 * per-request evaluation on one keep-alive connection (Review Focus #4), and
 * pin learning on client handshake-abort (the certificate-pinning signal).
 */

import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import tls from 'node:tls';
import { createRequestEvaluator } from '@blockingmachine/core';
import { CertAuthority } from '../ca/certAuthority.js';
import { PolicyStore } from '../policy/policyStore.js';
import { startProxy, type RunningProxy } from '../proxy/filterProxy.js';
import { relayRequest } from '../proxy/httpRelay.js';
import type { RelayResponse } from '../proxy/terminate.js';

jest.setTimeout(30_000);

function listen(
  server: http.Server | https.Server | http2.Http2SecureServer | net.Server,
): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function closeServer(
  server: http.Server | https.Server | http2.Http2SecureServer | net.Server,
): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Read until the HTTP header terminator or close — CONNECT replies and 403s. */
function readHttpHead(sock: net.Socket | tls.TLSSocket): Promise<string> {
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

interface WireResponse {
  status: number;
  head: string;
  body: string;
}

/**
 * Write one h1 request on `sock` and read status/head/body back. Relies on the
 * relayed response carrying Content-Length — `res.end(str)` sets it upstream
 * and the relay forwards it byte-identically.
 */
function httpRequestOver(
  sock: tls.TLSSocket,
  opts: { method?: string; path: string; host: string },
): Promise<WireResponse> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) {
        return;
      }
      const head = buf.subarray(0, idx).toString('latin1');
      const lenMatch = /content-length:\s*(\d+)/i.exec(head);
      const bodyLen = lenMatch === null ? 0 : Number(lenMatch[1]);
      if (buf.length < idx + 4 + bodyLen) {
        return;
      }
      sock.off('data', onData);
      resolve({
        status: Number(head.split(' ')[1]),
        head,
        body: buf.subarray(idx + 4, idx + 4 + bodyLen).toString('utf8'),
      });
    };
    sock.on('data', onData);
    sock.write(
      `${opts.method ?? 'GET'} ${opts.path} HTTP/1.1\r\nHost: ${opts.host}\r\n\r\n`,
    );
  });
}

let dir: string;
let authority: CertAuthority; // the proxy's MITM CA — trusted by the test client
let originCa: CertAuthority; // a *separate* CA signing the local origins' certs
let rogueCa: CertAuthority; // a third CA the proxy must NOT trust upstream
let policy: PolicyStore;
let proxy: RunningProxy;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bm-https-filter-mitm-'));
  authority = await CertAuthority.open({ storeDir: join(dir, 'proxy-ca') });
  originCa = await CertAuthority.open({ storeDir: join(dir, 'origin-ca') });
  rogueCa = await CertAuthority.open({ storeDir: join(dir, 'rogue-ca') });
  policy = await PolicyStore.open(join(dir, 'policy.jsonl'));
  proxy = await startProxy({
    bindHost: '127.0.0.1',
    dataPort: 0,
    authority,
    evaluator: createRequestEvaluator(['||blocked.example^', '||b.example^']),
    policy,
    // The test's "platform trust store": the real upstream chain verify runs
    // against tls.rootCertificates + this CA — still rejectUnauthorized:true,
    // still fail-closed; a rogue CA is not injected anywhere.
    upstreamCaCerts: [originCa.caCertPem],
    // Loopback upstream dials complete in ms; 2s keeps the blackhole-dial
    // test well under its 5s assertion without slowing the suite.
    upstreamConnectTimeoutMs: 2_000,
  });
});

afterAll(async () => {
  await proxy.close();
  await rm(dir, { recursive: true, force: true });
});

/** CONNECT to `target` through the data listener, then TLS up over the tunnel. */
async function connectThenTls(
  target: string,
  servername: string,
  alpn: string[],
): Promise<{ client: tls.TLSSocket; status: string }> {
  const raw = net.connect({ host: '127.0.0.1', port: proxy.port });
  await once(raw, 'connect');
  raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const head = await withTimeout(readHttpHead(raw), 5_000, 'CONNECT response');
  const status = head.split('\r\n')[0];
  const client = tls.connect({
    socket: raw,
    servername,
    ca: authority.caCertPem, // the device-trusted MITM CA
    ALPNProtocols: alpn,
  });
  await withTimeout(once(client, 'secureConnect'), 10_000, 'terminated handshake');
  return { client, status };
}

/** h1-only HTTPS origin whose cert `originCa` signed for `sni`. */
async function httpsOrigin(sni: string): Promise<{ server: https.Server; port: number }> {
  const leaf = originCa.forgeLeaf(sni);
  // https.createServer configures no ALPN → upstream tls.connect negotiates
  // nothing → the relay takes the h1 path end-to-end.
  const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
    const body = `origin ${req.method} ${req.url} host=${req.headers.host}`;
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) });
    res.end(body);
  });
  const port = await listen(server);
  return { server, port };
}

/** Poll `cond` until true or the deadline passes — for async proxy state. */
async function waitFor(cond: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor condition never held');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Capture the first bytes a real `tls.connect` writes — a genuine
 * ClientHello — by pointing it at a throwaway net.Server. Used to replay a
 * valid hello then close, simulating a client gone before the handshake ends.
 */
function captureClientHello(servername: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let client: tls.TLSSocket | undefined;
    const cap = net.createServer((sock) => {
      sock.once('data', (chunk: Buffer) => {
        client?.destroy();
        sock.destroy();
        cap.close();
        resolve(chunk);
      });
    });
    cap.once('error', reject);
    cap.listen(0, '127.0.0.1', () => {
      const port = (cap.address() as net.AddressInfo).port;
      client = tls.connect({
        port,
        host: '127.0.0.1',
        servername,
        rejectUnauthorized: false,
      });
      client.on('error', () => {});
      setTimeout(() => {
        client?.destroy();
        cap.close();
        reject(new Error('no ClientHello captured'));
      }, 5_000).unref();
    });
  });
}

/**
 * A `RelayResponse` that records instead of writing — drives `relayRequest`
 * directly so construct-time throws (control-char paths, malformed
 * authorities) are unit-tested without a full terminated flow.
 */
function fakeResponse(): {
  res: RelayResponse;
  statuses: number[];
  isDestroyed: () => boolean;
} {
  const statuses: number[] = [];
  let destroyed = false;
  let headersSent = false;
  return {
    statuses,
    isDestroyed: () => destroyed,
    res: {
      protocol: 'h1',
      get headersSent() {
        return headersSent;
      },
      respond(status) {
        statuses.push(status);
        headersSent = true;
      },
      begin(status) {
        statuses.push(status);
        headersSent = true;
        return new Writable({
          write(_chunk, _enc, cb) {
            cb();
          },
        });
      },
      destroy() {
        destroyed = true;
      },
      onClose() {},
    },
  };
}

/** A fresh CONNECT + TLS + GET through the proxy — the engine-survival probe. */
async function probeEngineAlive(tag: string): Promise<void> {
  const { server, port } = await httpsOrigin(`alive-${tag}.example`);
  try {
    const { client } = await connectThenTls(
      `localhost:${port}`,
      `alive-${tag}.example`,
      ['http/1.1'],
    );
    const res = await withTimeout(
      httpRequestOver(client, { path: '/', host: `alive-${tag}.example` }),
      10_000,
      'post-incident GET',
    );
    expect(res.status).toBe(200);
    client.destroy();
  } finally {
    await closeServer(server);
  }
}

describe('TLS termination', () => {
  test('flagship: CONNECT + client TLS trusting the CA → GET / returns the real origin response', async () => {
    const { server, port } = await httpsOrigin('app.example');
    try {
      const before = proxy.stats();
      const { client, status } = await connectThenTls(`localhost:${port}`, 'app.example', [
        'http/1.1',
      ]);
      expect(status).toBe('HTTP/1.1 200 Connection Established');

      // The leaf the client verified is forged for its SNI by our CA.
      expect(client.getPeerCertificate().subject.CN).toBe('app.example');

      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'app.example' }),
        10_000,
        'proxied GET /',
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe('origin GET / host=app.example');

      const after = proxy.stats();
      expect(after.flowsTerminated).toBe(before.flowsTerminated + 1);
      expect(after.flowsTunneled).toBe(before.flowsTunneled);

      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('h2 downstream request relays over an h1 upstream', async () => {
    const { server, port } = await httpsOrigin('h2down.example');
    try {
      const { client } = await connectThenTls(`localhost:${port}`, 'h2down.example', ['h2']);
      expect(client.alpnProtocol).toBe('h2');

      const session = http2.connect('https://h2down.example', {
        createConnection: () => client,
      });
      const req = session.request({
        ':method': 'GET',
        ':path': '/h2path',
        ':scheme': 'https',
        ':authority': 'h2down.example',
      });
      const done = new Promise<WireResponse>((resolve) => {
        let head = '';
        let body = '';
        req.on('response', (headers) => {
          head = JSON.stringify(headers);
        });
        req.on('data', (d: Buffer) => {
          body += d.toString();
        });
        req.on('end', () => resolve({ status: 0, head, body }));
      });
      req.end();
      const res = await withTimeout(done, 10_000, 'h2 downstream response');
      expect(res.head).toContain('200');
      expect(res.body).toBe('origin GET /h2path host=h2down.example');
      session.close();
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('h1 downstream request relays over an h2 upstream (ALPN h2 negotiated)', async () => {
    const leaf = originCa.forgeLeaf('h2up.example');
    const origin = http2.createSecureServer({
      key: leaf.keyPem,
      cert: leaf.certPem,
      allowHTTP1: true,
      ALPNProtocols: ['h2', 'http/1.1'],
    });
    origin.on('request', (req, res) => {
      const body = `h2origin ${req.method} ${req.url} proto=${req.httpVersion}`;
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) });
      res.end(body);
    });
    const port = await listen(origin);
    try {
      const { client } = await connectThenTls(`localhost:${port}`, 'h2up.example', ['http/1.1']);
      const res = await withTimeout(
        httpRequestOver(client, { path: '/via-h2-up', host: 'h2up.example' }),
        10_000,
        'proxied GET',
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe('h2origin GET /via-h2-up proto=2.0');
      client.destroy();
    } finally {
      await closeServer(origin);
    }
  });

  test('keep-alive: one terminated connection evaluates EVERY request — allowed a.example then blocked b.example', async () => {
    const { server, port } = await httpsOrigin('multi.example');
    try {
      const { client } = await connectThenTls(`localhost:${port}`, 'multi.example', ['http/1.1']);

      const first = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'a.example' }),
        10_000,
        'first request',
      );
      expect(first.status).toBe(200);
      expect(first.body).toBe('origin GET / host=a.example');

      // Same connection, different Host — per-request verdict, not per-connection.
      const second = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'b.example' }),
        10_000,
        'second request',
      );
      expect(second.status).toBe(403);
      expect(second.head.toLowerCase()).toContain('x-blockingmachine-rule: ||b.example^');
      expect(second.head.toLowerCase()).toContain('content-length: 0');

      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('upstream verification is fail-closed: an origin cert from an untrusted CA yields 502, never pass-through', async () => {
    const leaf = rogueCa.forgeLeaf('rogue.example');
    const origin = http2.createSecureServer({ key: leaf.keyPem, cert: leaf.certPem });
    origin.on('request', (_req, res) => {
      res.writeHead(200);
      res.end('must never reach the client');
    });
    const port = await listen(origin);
    try {
      const { client } = await connectThenTls(`localhost:${port}`, 'rogue.example', ['http/1.1']);
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'rogue.example' }),
        10_000,
        'failing relay',
      );
      expect(res.status).toBe(502);
      client.destroy();
    } finally {
      await closeServer(origin);
    }
  });

  test('client aborting the forged handshake learns a pin → isPinned true, pinsLearned++', async () => {
    const before = proxy.stats();
    const raw = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(raw, 'connect');
    raw.write('CONNECT pinned.example:443 HTTP/1.1\r\nHost: pinned.example:443\r\n\r\n');
    const head = await withTimeout(readHttpHead(raw), 5_000, 'CONNECT response');
    expect(head).toContain('200');

    const client = tls.connect({
      socket: raw,
      servername: 'pinned.example',
      rejectUnauthorized: true, // does NOT trust our CA — the pinning signal
    });
    client.on('error', () => {}); // self-signed-cert alert expected client-side

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (policy.isPinned('pinned.example')) {
            clearInterval(poll);
            resolve();
          }
        }, 50);
        setTimeout(() => {
          clearInterval(poll);
          reject(new Error('pin was not learned'));
        }, 8_000).unref();
      }),
      10_000,
      'pin learning',
    );
    expect(proxy.stats().pinsLearned).toBe(before.pinsLearned + 1);
    client.destroy();
  });
});

describe('plain-HTTP absolute-form forwarding', () => {
  test('GET http://h/x straight at the data port forwards to the origin and returns its response', async () => {
    const origin = http.createServer((req, res) => {
      res.end(`plain ${req.method} ${req.url}`);
    });
    const port = await listen(origin);
    try {
      const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
      await once(sock, 'connect');
      sock.write(
        `GET http://localhost:${port}/x?q=1 HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
      );
      const raw = await withTimeout(
        new Promise<Buffer>((resolve) => {
          const chunks: Buffer[] = [];
          sock.on('data', (c: Buffer) => chunks.push(c));
          sock.once('close', () => resolve(Buffer.concat(chunks)));
        }),
        10_000,
        'plain forward response',
      );
      const text = raw.toString('latin1');
      expect(text).toContain('HTTP/1.1 200');
      expect(text).toContain(`/x?q=1`);
      sock.destroy();
    } finally {
      await closeServer(origin);
    }
  });

  test('GET http://blocked.example/x is evaluated and answered 403 with the covering rule', async () => {
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(sock, 'connect');
    sock.write('GET http://blocked.example/x HTTP/1.1\r\nHost: blocked.example\r\n\r\n');
    const head = await withTimeout(readHttpHead(sock), 5_000, 'blocked response');
    expect(head).toContain('HTTP/1.1 403 Forbidden');
    expect(head).toContain('X-Blockingmachine-Rule: ||blocked.example^');
    sock.destroy();
  });

  test('origin-form GET / with a Host header forwards over port 80-style addressing', async () => {
    const origin = http.createServer((req, res) => {
      res.end(`plain ${req.method} ${req.url}`);
    });
    const port = await listen(origin);
    try {
      const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
      await once(sock, 'connect');
      sock.write(
        `GET /y HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
      );
      const raw = await withTimeout(
        new Promise<Buffer>((resolve) => {
          const chunks: Buffer[] = [];
          sock.on('data', (c: Buffer) => chunks.push(c));
          sock.once('close', () => resolve(Buffer.concat(chunks)));
        }),
        10_000,
        'origin-form response',
      );
      expect(raw.toString('latin1')).toContain('plain GET /y');
      sock.destroy();
    } finally {
      await closeServer(origin);
    }
  });

  test('absolute-form target disagreeing with Host → both authorities evaluated, then 400', async () => {
    // Both names individually allow — forwarding the pair would smuggle the
    // Host header's unjudged authority to a shared edge.
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(sock, 'connect');
    sock.write(
      'GET http://allowed-one.example/x HTTP/1.1\r\nHost: allowed-two.example\r\n\r\n',
    );
    const head = await withTimeout(readHttpHead(sock), 5_000, 'mismatch response');
    expect(head).toContain('HTTP/1.1 400 Bad Request');
    sock.destroy();
  });

  test('absolute-form target allowed but the Host header is blocked → 403', async () => {
    // Evaluate-both-and-require-agreement: the Host side is judged too —
    // a blocked Host must not ride inside an allowed request line.
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(sock, 'connect');
    sock.write(
      'GET http://allowed-one.example/x HTTP/1.1\r\nHost: blocked.example\r\n\r\n',
    );
    const head = await withTimeout(readHttpHead(sock), 5_000, 'blocked host response');
    expect(head).toContain('HTTP/1.1 403 Forbidden');
    sock.destroy();
  });
});

describe('hardened failure handling', () => {
  test('clean close after a completed handshake (no request) learns NO pin', async () => {
    const before = proxy.stats();
    const { client, status } = await connectThenTls(
      'localhost:1',
      'speculative.example',
      ['http/1.1'],
    );
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    // The speculative/preconnect shape: handshake completes, no request ever
    // arrives, socket closes — abandonment, not cert distrust. `end()` sends
    // the client Finished + close_notify, so the server-side handshake has
    // verifiably completed before the close lands.
    client.end();
    await withTimeout(once(client, 'close'), 5_000, 'graceful close');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(policy.isPinned('speculative.example')).toBe(false);
    expect(proxy.stats().pinsLearned).toBe(before.pinsLearned);
  });

  test('socket close before the handshake completes learns a pin', async () => {
    const hello = await captureClientHello('earlyabort.example');
    const before = proxy.stats();
    const raw = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(raw, 'connect');
    raw.write('CONNECT earlyabort.example:443 HTTP/1.1\r\nHost: x\r\n\r\n');
    await withTimeout(readHttpHead(raw), 5_000, 'CONNECT response');
    // A genuine ClientHello then gone — the forged handshake can never
    // complete, so the flow dies before secureConnection: the pin signal.
    raw.write(hello);
    raw.end();
    await waitFor(() => policy.isPinned('earlyabort.example'));
    expect(proxy.stats().pinsLearned).toBe(before.pinsLearned + 1);
    raw.destroy();
  });

  test('wire SNI with a trailing dot terminates on the normalized leaf and closing learns no pin', async () => {
    const before = proxy.stats();
    const raw = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(raw, 'connect');
    raw.write('CONNECT localhost:1 HTTP/1.1\r\nHost: localhost:1\r\n\r\n');
    const head = await withTimeout(readHttpHead(raw), 5_000, 'CONNECT response');
    expect(head).toContain('200');
    const client = tls.connect({
      socket: raw,
      servername: 'trail.example.', // FQDN form — must not break forge/compare
      rejectUnauthorized: false, // leaf-SAN-vs-dotted-name isn't under test here
    });
    client.on('error', () => {});
    await withTimeout(once(client, 'secureConnect'), 10_000, 'trailing-dot handshake');
    expect(client.getPeerCertificate().subject.CN).toBe('trail.example');
    // Graceful close after a completed handshake — no pin (same rule as the
    // speculative-socket test).
    client.end();
    await withTimeout(once(client, 'close'), 5_000, 'trailing-dot close');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(policy.isPinned('trail.example')).toBe(false);
    expect(proxy.stats().pinsLearned).toBe(before.pinsLearned);
  });

  test('a hostile upstream answering a bare 101 on an h2 flow → 502, engine survives', async () => {
    const leaf = originCa.forgeLeaf('weird.example');
    const origin = https.createServer(
      { key: leaf.keyPem, cert: leaf.certPem },
      (_req, res) => {
        // 101 to a non-Upgrade request — the h2 compat writeHead throws
        // ERR_HTTP2_STATUS_101; without the guard this crashed the engine.
        res.writeHead(101, { 'x-weird': 'y' });
        res.end('x');
      },
    );
    const port = await listen(origin);
    try {
      const { client } = await connectThenTls(`localhost:${port}`, 'weird.example', ['h2']);
      const session = http2.connect('https://weird.example', {
        createConnection: () => client,
      });
      const req = session.request({
        ':method': 'GET',
        ':path': '/',
        ':scheme': 'https',
        ':authority': 'weird.example',
      });
      const outcome = new Promise<number | null>((resolve) => {
        req.on('response', (headers) => resolve(Number(headers[':status'])));
        req.on('close', () => resolve(null));
        req.on('error', () => resolve(null));
      });
      req.end();
      const status = await withTimeout(outcome, 10_000, '101-response outcome');
      expect(status === 502 || status === null).toBe(true);
      session.close();
      client.destroy();

      await probeEngineAlive('101'); // a subsequent flow still works
    } finally {
      await closeServer(origin);
    }
  });

  test('a control-character :path reaching http.request → 502, engine survives', async () => {
    const { server, port } = await httpsOrigin('ctl.example');
    try {
      const probe = fakeResponse();
      relayRequest(
        {
          method: 'GET',
          url: '/bad\x01path', // ERR_UNESCAPED_CHARACTERS at construct time
          host: 'ctl.example',
          headers: {},
          body: Readable.from([]),
          protocol: 'h1',
        },
        probe.res,
        { host: '127.0.0.1', port, servername: 'ctl.example' },
        { upstreamCaCerts: [originCa.caCertPem] },
      );
      await waitFor(() => probe.statuses.length > 0 || probe.isDestroyed());
      expect(probe.statuses[0] === 502 || probe.isDestroyed()).toBe(true);
      await probeEngineAlive('ctlpath');
    } finally {
      await closeServer(server);
    }
  });

  test('a malformed upstream authority reaching http2.connect → 502, engine survives', async () => {
    const leaf = originCa.forgeLeaf('h2badauth.example');
    const origin = http2.createSecureServer({
      key: leaf.keyPem,
      cert: leaf.certPem,
      allowHTTP1: true,
      ALPNProtocols: ['h2', 'http/1.1'],
    });
    origin.on('request', (_req, res) => {
      res.writeHead(200, { 'content-length': '1' });
      res.end('x');
    });
    const port = await listen(origin);
    try {
      const probe = fakeResponse();
      relayRequest(
        {
          method: 'GET',
          url: '/',
          host: 'bad host!', // ERR_INVALID_URL inside http2.connect
          headers: {},
          body: Readable.from([]),
          protocol: 'h1',
        },
        probe.res,
        { host: '127.0.0.1', port, servername: 'h2badauth.example' },
        { upstreamCaCerts: [originCa.caCertPem] },
      );
      await waitFor(() => probe.statuses.length > 0 || probe.isDestroyed());
      expect(probe.statuses[0] === 502 || probe.isDestroyed()).toBe(true);
      await probeEngineAlive('badauth');
    } finally {
      await closeServer(origin);
    }
  });

  test('a blackholed upstream dial answers 502 inside the connect deadline', async () => {
    // Accepts the TCP connection and says nothing — the TLS handshake never
    // completes, so the connect deadline must turn it into a 502. Held
    // sockets are destroyed in teardown so server.close() can settle.
    const held = new Set<net.Socket>();
    const blackhole = net.createServer((sock) => {
      held.add(sock);
      sock.on('error', () => {});
      sock.once('close', () => held.delete(sock));
    });
    const port = await listen(blackhole);
    try {
      const { client } = await connectThenTls(`localhost:${port}`, 'blackhole.example', [
        'http/1.1',
      ]);
      const start = Date.now();
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'blackhole.example' }),
        10_000,
        'blackhole response',
      );
      expect(res.status).toBe(502);
      expect(Date.now() - start).toBeLessThan(5_000);
      client.destroy();
    } finally {
      for (const sock of held) {
        sock.destroy();
      }
      await closeServer(blackhole);
    }
  });

  test('relayed responses strip alt-svc and Connection-listed headers', async () => {
    const leaf = originCa.forgeLeaf('headers.example');
    // A hand-rolled TLS origin so the response carries exactly what a hostile
    // origin would send — a Node http.Server would normalize `connection`.
    const origin = tls.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (sock) => {
      sock.once('data', () => {
        sock.end(
          'HTTP/1.1 200 OK\r\n' +
            'content-length: 2\r\n' +
            'alt-svc: h3=":443"\r\n' +
            'connection: x-smuggle\r\n' +
            'x-smuggle: 1\r\n' +
            '\r\nok',
        );
      });
    });
    const port = await listen(origin);
    try {
      const { client } = await connectThenTls(`localhost:${port}`, 'headers.example', [
        'http/1.1',
      ]);
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'headers.example' }),
        10_000,
        'header-strip response',
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe('ok');
      expect(res.head.toLowerCase()).not.toContain('alt-svc');
      expect(res.head.toLowerCase()).not.toContain('x-smuggle');
      client.destroy();
    } finally {
      await closeServer(origin);
    }
  });
});
