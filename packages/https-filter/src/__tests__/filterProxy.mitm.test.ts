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
import { brotliCompressSync, brotliDecompressSync, deflateSync, gunzipSync, gzipSync, inflateSync } from 'node:zlib';
import {
  createCosmeticIndex,
  createRequestEvaluator,
  type CosmeticIndex,
  type CosmeticPayload,
} from '@blockingmachine/core';
import { CertAuthority } from '../ca/certAuthority.js';
import { MAX_HTML_BUFFER, type ResponseEvent } from '../pipeline/response.js';
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
  opts: { method?: string; path: string; host: string; headers?: Record<string, string> },
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
    const extra = Object.entries(opts.headers ?? {})
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
    sock.write(
      `${opts.method ?? 'GET'} ${opts.path} HTTP/1.1\r\nHost: ${opts.host}\r\n${extra}\r\n`,
    );
  });
}

/**
 * Write a raw request and collect everything until the socket closes —
 * for responses that carry no content-length (304s, HEAD answers, chunked
 * flushes) where `httpRequestOver`'s length-bound reader cannot end. The
 * request should ask for `Connection: close` so the downstream lets it.
 */
function rawHttpOver(sock: tls.TLSSocket, request: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    sock.on('data', (chunk: Buffer) => chunks.push(chunk));
    sock.once('close', () => resolve(Buffer.concat(chunks)));
    sock.write(request);
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
  authority = await CertAuthority.open({ storeDir: join(dir, 'proxy-ca'), keyWrapBackend: null });
  originCa = await CertAuthority.open({ storeDir: join(dir, 'origin-ca'), keyWrapBackend: null });
  rogueCa = await CertAuthority.open({ storeDir: join(dir, 'rogue-ca'), keyWrapBackend: null });
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
  proxyPort: number = proxy.port,
): Promise<{ client: tls.TLSSocket; status: string }> {
  const raw = net.connect({ host: '127.0.0.1', port: proxyPort });
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
 * authorities) are unit-tested without a full terminated flow. `bodyBytes`
 * returns everything written through `begin`'s stream — the buffered-flush
 * assertions need the bytes, not just the status line.
 */
function fakeResponse(): {
  res: RelayResponse;
  statuses: number[];
  bodyBytes: () => Buffer;
  isDestroyed: () => boolean;
} {
  const statuses: number[] = [];
  const chunks: Buffer[] = [];
  let destroyed = false;
  let headersSent = false;
  return {
    statuses,
    bodyBytes: () => Buffer.concat(chunks),
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
          write(chunk, _enc, cb) {
            chunks.push(chunk as Buffer);
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

  test('per-request blocks keep their own counter — two blocks on one flow: requestsBlocked+2, flowsBlocked unchanged', async () => {
    // flowsBlocked is flow-scoped; a keep-alive connection can stack
    // arbitrary per-request blocks, which would otherwise push the counter
    // (and blockRatePercent = flowsBlocked/flowsTotal) past its unit.
    const { server, port } = await httpsOrigin('counter.example');
    try {
      const { client } = await connectThenTls(`localhost:${port}`, 'counter.example', [
        'http/1.1',
      ]);
      const before = proxy.stats();
      const first = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'b.example' }),
        10_000,
        'first blocked request',
      );
      expect(first.status).toBe(403);
      // Same keep-alive connection — the 403 leaves it open for a second.
      const second = await withTimeout(
        httpRequestOver(client, { path: '/two', host: 'b.example' }),
        10_000,
        'second blocked request',
      );
      expect(second.status).toBe(403);
      const after = proxy.stats();
      expect(after.requestsBlocked).toBe(before.requestsBlocked + 2);
      expect(after.flowsBlocked).toBe(before.flowsBlocked);
      // The flow itself was counted at CONNECT-terminate time, before `before`.
      expect(after.flowsTerminated).toBe(before.flowsTerminated);
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

  test('absolute-form target allowed but the Host header is blocked → 403 + the Host rule surfaces', async () => {
    // Evaluate-both-and-require-agreement: the Host side is judged too —
    // a blocked Host must not ride inside an allowed request line. The 403
    // emits the Host side's covering rule: the request-target side allowed,
    // so `rule` falls back to the rule that actually decided the block.
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(sock, 'connect');
    sock.write(
      'GET http://allowed-one.example/x HTTP/1.1\r\nHost: blocked.example\r\n\r\n',
    );
    const head = await withTimeout(readHttpHead(sock), 5_000, 'blocked host response');
    expect(head).toContain('HTTP/1.1 403 Forbidden');
    expect(head).toContain('X-Blockingmachine-Rule: ||blocked.example^');
    sock.destroy();
  });

  test('a bypassed authority tunnels on a DIRECT plain-HTTP request — no verdict runs', async () => {
    // The dispatch-path bypass gate: `GET http://h/x` aimed straight at the
    // data port used to be judged even when `h` sat in the bypass set —
    // every other entry path tunnels it. A dedicated proxy pins the rule:
    // the `127.0.0.1` host rule would block the request, the bypass flips it
    // to a blind splice, and removing the bypass restores the 403. (An IP
    // host keeps the origin dialable; a single-label rule like `localhost`
    // never reaches the evaluator at all.)
    const bypassPolicy = PolicyStore.ephemeral();
    const bypassProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator(['127.0.0.1']),
      policy: bypassPolicy,
    });
    const origin = http.createServer((req, res) => {
      res.end(`bypassed ${req.method} ${req.url}`);
    });
    const originPort = await listen(origin);
    try {
      bypassPolicy.addBypass('127.0.0.1');
      const sock = net.connect({ host: '127.0.0.1', port: bypassProxy.port });
      await once(sock, 'connect');
      sock.write(
        `GET http://127.0.0.1:${originPort}/x HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`,
      );
      const echoed = await withTimeout(
        new Promise<Buffer>((resolve) => {
          const chunks: Buffer[] = [];
          sock.on('data', (c: Buffer) => chunks.push(c));
          sock.once('close', () => resolve(Buffer.concat(chunks)));
        }),
        10_000,
        'bypassed plain response',
      );
      // The splice forwarded verbatim — the origin's own 200, not a 403,
      // and the request line it echoes is the absolute-form one, unspliced.
      expect(echoed.toString('latin1')).toContain('HTTP/1.1 200');
      expect(echoed.toString('latin1')).toContain('bypassed GET http://127.0.0.1:');

      // Sanity: with the bypass retracted, the same rule blocks on the
      // direct path — the bypass gate is what carried the flow above.
      bypassPolicy.remove('127.0.0.1');
      const sock2 = net.connect({ host: '127.0.0.1', port: bypassProxy.port });
      await once(sock2, 'connect');
      sock2.write(
        `GET http://127.0.0.1:${originPort}/x HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`,
      );
      const head2 = await withTimeout(readHttpHead(sock2), 5_000, 'unbypassed response');
      expect(head2).toContain('HTTP/1.1 403 Forbidden');
      sock2.destroy();
      sock.destroy();
    } finally {
      await closeServer(origin);
      await bypassProxy.close();
    }
  });

  test('a plain-HTTP request aimed at the data port itself → 400, no self-tunnel chain', async () => {
    // `Host: 127.0.0.1:<dataPort>` used to blind-tunnel back into this very
    // listener — each spliced flow re-dispatches and spawns the next until
    // fds run out (web-reachable: fetch('http://127.0.0.1:<port>/') is a
    // simple cross-origin request). All three target spellings refuse.
    for (const wire of [
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\n\r\n`,
      `GET http://127.0.0.1:${proxy.port}/x HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\n\r\n`,
      `GET / HTTP/1.1\r\nHost: localhost:${proxy.port}\r\n\r\n`,
      // M1: shorthand spellings getaddrinfo resolves to the same loopback
      // — the self-target guard must judge the canonical address.
      `GET / HTTP/1.1\r\nHost: 127.1:${proxy.port}\r\n\r\n`,
      `GET / HTTP/1.1\r\nHost: 0x7f000001:${proxy.port}\r\n\r\n`,
      `GET / HTTP/1.1\r\nHost: 0177.0.0.1:${proxy.port}\r\n\r\n`,
    ]) {
      const before = proxy.stats();
      const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
      await once(sock, 'connect');
      sock.write(wire);
      const head = await withTimeout(readHttpHead(sock), 5_000, 'self-target response');
      expect(head).toContain('HTTP/1.1 400 Bad Request');
      // A spliced self-connection would show up as a second counted flow —
      // exactly one new flow means nothing dialed back into the listener.
      expect(proxy.stats().flowsTotal).toBe(before.flowsTotal + 1);
      expect(proxy.stats().flowsTunneled).toBe(before.flowsTunneled);
      sock.destroy();
    }
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

  test('a ClientHello arriving past the peek timeout can never forge a second name — disagreeing wire SNI fails the handshake', async () => {
    // The ungated-forge regression: SNICallback used to mint/serve a leaf
    // for ANY valid wire SNI with no verdict behind it — CONNECT an allowed
    // host, drip the ClientHello past the peek bound (the peek resolves
    // sni:null and the flow terminates under the CONNECT name), and the late
    // hello's blocked SNI got forged sight-unseen. The gate now serves only
    // the gated name's context; a disagreeing name fails the handshake. A
    // dedicated proxy with a short peek keeps the drip fast, and an
    // ephemeral policy store keeps the pin assertions self-contained.
    const dripPolicy = PolicyStore.ephemeral();
    const dripProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator(['||blocked.example^']),
      policy: dripPolicy,
      peekTimeoutMs: 400,
    });
    try {
      // A real ClientHello for blocked.example, delivered in two writes: a
      // 3-byte record-header stub the peek cannot settle on, then — after
      // the timeout resolves the flow under the CONNECT name — the rest,
      // reassembling into the genuine hello on the wire.
      const hello = await captureClientHello('blocked.example');
      // The forge path itself under observation — a regression would mint a
      // 'blocked.example' leaf for a name no verdict ever saw.
      const forgeSpy = jest.spyOn(authority, 'forgeLeaf');
      const before = dripProxy.stats();
      const raw = net.connect({ host: '127.0.0.1', port: dripProxy.port });
      await once(raw, 'connect');
      raw.write('CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n');
      const head = await withTimeout(readHttpHead(raw), 5_000, 'CONNECT response');
      expect(head).toContain('200');
      raw.write(hello.subarray(0, 3));
      // Outlast the peek bound — the flow terminates under 'allowed.example'.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      raw.write(hello.subarray(3));
      const tail = await withTimeout(
        new Promise<Buffer>((resolve) => {
          const chunks: Buffer[] = [];
          raw.on('data', (c: Buffer) => chunks.push(c));
          raw.once('close', () => resolve(Buffer.concat(chunks)));
        }),
        10_000,
        'late-SNI close',
      );
      // A forged leaf answers with handshake records (0x16 ServerHello…);
      // the refusal dies with at most a TLS alert (0x15) before close.
      if (tail.length > 0) {
        expect(tail[0]).toBe(0x15);
      }
      // 'blocked.example' was never minted — only the gated CONNECT name.
      const forged = forgeSpy.mock.calls.map((call) => call[0]);
      expect(forged).toContain('allowed.example');
      expect(forged).not.toContain('blocked.example');
      forgeSpy.mockRestore();
      const after = dripProxy.stats();
      // The flow was admitted to termination under the CONNECT name (the
      // refusal happens inside its handshake) — and nothing spliced.
      expect(after.flowsTerminated).toBe(before.flowsTerminated + 1);
      expect(after.flowsTunneled).toBe(before.flowsTunneled);
      // A server-side SNI refusal is not client distrust of the leaf — no
      // pin may be learned on either name (P0 has no unlearn route).
      expect(dripPolicy.isPinned('allowed.example')).toBe(false);
      expect(dripPolicy.isPinned('blocked.example')).toBe(false);
      expect(after.pinsLearned).toBe(before.pinsLearned);
      raw.destroy();
    } finally {
      await dripProxy.close();
    }
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

describe('pin suppression on engine-initiated teardown', () => {
  test('close() while a flow is parked in the forge wait learns NO pin', async () => {
    // A socket dying before `secureConnection` is the pinning signal only
    // when the CLIENT chose to die on the forged leaf. `close()` destroying
    // a socket still awaiting its queued leaf reads identically on the wire
    // — and must not mint a persistent false pin on the way down. The forge
    // is held pending by a spy (forgeConcurrency: 1): the parked `await
    // forger.forge` is exactly the state a flow queued behind another mint
    // sits in.
    const heldPolicy = PolicyStore.ephemeral();
    const heldProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator([]),
      policy: heldPolicy,
      forgeConcurrency: 1,
    });
    const realForgeLeaf = authority.forgeLeaf.bind(authority);
    const parked = new Promise<never>(() => {});
    const forgeSpy = jest
      .spyOn(authority, 'forgeLeaf')
      .mockImplementation((sni: string) =>
        sni === 'forgeheld.example'
          ? (parked as unknown as ReturnType<typeof realForgeLeaf>)
          : realForgeLeaf(sni),
      );
    try {
      const hello = await captureClientHello('forgeheld.example');
      const raw = net.connect({ host: '127.0.0.1', port: heldProxy.port });
      await once(raw, 'connect');
      raw.write(
        'CONNECT forgeheld.example:443 HTTP/1.1\r\nHost: forgeheld.example:443\r\n\r\n',
      );
      const head = await withTimeout(readHttpHead(raw), 5_000, 'CONNECT response');
      expect(head).toContain('200');
      raw.write(hello);
      // Wait until the flow is verifiably suspended at `await forger.forge`,
      // then tear the engine down underneath it.
      await waitFor(() =>
        forgeSpy.mock.calls.some((call) => call[0] === 'forgeheld.example'),
      );
      await heldProxy.close();
      // The destroy fired 'close' before secureConnection — the pinning
      // shape — but the death was the engine's, not leaf distrust.
      expect(heldPolicy.isPinned('forgeheld.example')).toBe(false);
      expect(heldProxy.stats().pinsLearned).toBe(0);
      raw.destroy();
    } finally {
      forgeSpy.mockRestore();
    }
  });

  test('a forge rejection learns NO pin — the teardown destroy is not client distrust', async () => {
    // terminateToHttp failing before the handshake (a forgeLeaf throw,
    // above all) lands in terminateFlow's catch, which destroys the
    // socket — a death before `secureConnection` the client did not choose.
    // Without suppression the destroy fires the same pinning signal a
    // distrusting client does, and a persistent false pin lands on the
    // ledger.
    const rejectPolicy = PolicyStore.ephemeral();
    const rejectProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator([]),
      policy: rejectPolicy,
    });
    const realForgeLeaf = authority.forgeLeaf.bind(authority);
    const forgeSpy = jest
      .spyOn(authority, 'forgeLeaf')
      .mockImplementation((sni: string) => {
        if (sni === 'forgereject.example') {
          throw new Error('injected forge failure');
        }
        return realForgeLeaf(sni);
      });
    try {
      const hello = await captureClientHello('forgereject.example');
      const raw = net.connect({ host: '127.0.0.1', port: rejectProxy.port });
      await once(raw, 'connect');
      raw.write(
        'CONNECT forgereject.example:443 HTTP/1.1\r\nHost: forgereject.example:443\r\n\r\n',
      );
      const head = await withTimeout(readHttpHead(raw), 5_000, 'CONNECT response');
      expect(head).toContain('200');
      raw.write(hello);
      // The rejection destroys the flow — then give any would-be pin
      // landing off that close its chance to exist.
      await withTimeout(once(raw, 'close'), 5_000, 'rejected flow close');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(rejectPolicy.isPinned('forgereject.example')).toBe(false);
      expect(rejectProxy.stats().pinsLearned).toBe(0);
      raw.destroy();
    } finally {
      forgeSpy.mockRestore();
      await rejectProxy.close();
    }
  });
});

describe('leaf-forge admission (flag 94)', () => {
  test('a distinct-SNI burst pays at most one forge per name through the queue', async () => {
    const forgeSpy = jest.spyOn(authority, 'forgeLeaf');
    try {
      const names = ['burst-a.example', 'burst-b.example', 'burst-c.example'];
      const clients = await Promise.all(
        names.map((sni) => connectThenTls('localhost:1', sni, ['http/1.1'])),
      );
      const forged = forgeSpy.mock.calls
        .map((call) => call[0])
        .filter((n) => names.includes(n));
      for (const sni of names) {
        expect(forged.filter((n) => n === sni).length).toBe(1);
      }
      for (const { client } of clients) {
        client.destroy();
      }
    } finally {
      forgeSpy.mockRestore();
    }
  });
});

describe('upstream response deadline (flag 99)', () => {
  test('a TLS upstream that handshakes then goes silent → 502 inside the bound (h1)', async () => {
    const leaf = originCa.forgeLeaf('silent.example');
    const held = new Set<tls.TLSSocket>();
    const silent = tls.createServer(
      { key: leaf.keyPem, cert: leaf.certPem },
      (sock) => {
        held.add(sock);
        // Handshake completes — the request is swallowed, never answered.
        sock.on('data', () => {});
        sock.on('error', () => {});
        sock.once('close', () => held.delete(sock));
      },
    );
    const port = await listen(silent);
    try {
      const probe = fakeResponse();
      const start = Date.now();
      relayRequest(
        {
          method: 'GET',
          url: '/',
          host: 'silent.example',
          headers: {},
          body: Readable.from([]),
          protocol: 'h1',
        },
        probe.res,
        { host: '127.0.0.1', port, servername: 'silent.example' },
        { upstreamCaCerts: [originCa.caCertPem], responseTimeoutMs: 400 },
      );
      await waitFor(() => probe.statuses.length > 0 || probe.isDestroyed(), 6_000);
      expect(probe.statuses[0]).toBe(502);
      const elapsed = Date.now() - start;
      // The deadline fired the failure — not a dial error (instant) and not
      // a parked request (seconds-long).
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(5_000);
      await probeEngineAlive('silent');
    } finally {
      for (const sock of held) {
        sock.destroy();
      }
      await closeServer(silent);
    }
  });

  test('an h2 upstream stream left unanswered → 502 inside the bound', async () => {
    const leaf = originCa.forgeLeaf('h2silent.example');
    const held = new Set<http2.ServerHttp2Stream>();
    const origin = http2.createSecureServer({
      key: leaf.keyPem,
      cert: leaf.certPem,
      ALPNProtocols: ['h2'],
    });
    origin.on('request', (req, res) => {
      held.add(req.stream);
      req.stream.on('error', () => {});
      req.stream.once('close', () => held.delete(req.stream));
      void res; // the stream is accepted — and never answered
    });
    origin.on('sessionError', () => {});
    const port = await listen(origin);
    try {
      const probe = fakeResponse();
      const start = Date.now();
      relayRequest(
        {
          method: 'GET',
          url: '/',
          host: 'h2silent.example',
          headers: {},
          body: Readable.from([]),
          protocol: 'h1',
        },
        probe.res,
        { host: '127.0.0.1', port, servername: 'h2silent.example' },
        { upstreamCaCerts: [originCa.caCertPem], responseTimeoutMs: 400 },
      );
      await waitFor(() => probe.statuses.length > 0 || probe.isDestroyed(), 6_000);
      expect(probe.statuses[0]).toBe(502);
      expect(Date.now() - start).toBeLessThan(5_000);
    } finally {
      for (const stream of held) {
        stream.destroy();
      }
      await closeServer(origin);
    }
  });

  test('end-to-end: a terminated request to a silent upstream answers the client 502 inside the bound', async () => {
    const silentProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator([]),
      policy,
      upstreamCaCerts: [originCa.caCertPem],
      upstreamConnectTimeoutMs: 2_000,
      upstreamResponseTimeoutMs: 300,
    });
    const leaf = originCa.forgeLeaf('silente2e.example');
    const held = new Set<tls.TLSSocket>();
    const silent = tls.createServer(
      { key: leaf.keyPem, cert: leaf.certPem },
      (sock) => {
        held.add(sock);
        sock.on('data', () => {});
        sock.on('error', () => {});
        sock.once('close', () => held.delete(sock));
      },
    );
    const port = await listen(silent);
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'silente2e.example',
        ['http/1.1'],
        silentProxy.port,
      );
      const start = Date.now();
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'silente2e.example' }),
        10_000,
        'silent upstream response',
      );
      expect(res.status).toBe(502);
      expect(Date.now() - start).toBeLessThan(5_000);
      client.destroy();
    } finally {
      for (const sock of held) {
        sock.destroy();
      }
      await closeServer(silent);
      await silentProxy.close();
    }
  });

  test('a slow-but-answering upstream clears the bound at first byte — a body streaming past it arrives whole', async () => {
    // Tight response bound on a dedicated proxy; the origin answers headers
    // immediately, then drips the body tail PAST the bound — the deadline is
    // first-byte only, so the whole body still lands.
    const dripProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator([]),
      policy,
      upstreamCaCerts: [originCa.caCertPem],
      upstreamConnectTimeoutMs: 2_000,
      upstreamResponseTimeoutMs: 300,
    });
    const leaf = originCa.forgeLeaf('drip.example');
    const origin = https.createServer(
      { key: leaf.keyPem, cert: leaf.certPem },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10' });
        res.write('chunk-');
        setTimeout(() => res.end('one!'), 450); // body tail lands past the bound
      },
    );
    const port = await listen(origin);
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'drip.example',
        ['http/1.1'],
        dripProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'drip.example' }),
        10_000,
        'dripping response',
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe('chunk-one!');
      client.destroy();
    } finally {
      await closeServer(origin);
      await dripProxy.close();
    }
  });

  test('a client upload slower than the bound still completes — the deadline arms at request finish, not dispatch', async () => {
    // Arming at dispatch charged the CLIENT's body time to the upstream's
    // window: a >300ms legit upload 502'd mid-pipe. Armed on the outbound
    // request's 'finish' instead, the bound only measures the upstream's
    // silence after a fully-sent request.
    const slowProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator([]),
      policy,
      upstreamCaCerts: [originCa.caCertPem],
      upstreamConnectTimeoutMs: 2_000,
      upstreamResponseTimeoutMs: 300,
    });
    const leaf = originCa.forgeLeaf('slowup.example');
    const origin = https.createServer(
      { key: leaf.keyPem, cert: leaf.certPem },
      (req, res) => {
        req.resume();
        req.on('end', () => {
          const body = `done ${req.method} ${req.url}`;
          res.writeHead(200, {
            'content-type': 'text/plain',
            'content-length': String(body.length),
          });
          res.end(body);
        });
      },
    );
    const port = await listen(origin);
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'slowup.example',
        ['http/1.1'],
        slowProxy.port,
      );
      const response = new Promise<{ status: number; head: string; body: string }>(
        (resolve) => {
          let buf = Buffer.alloc(0);
          client.on('data', (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            const idx = buf.indexOf('\r\n\r\n');
            if (idx < 0) return;
            const head = buf.subarray(0, idx).toString('latin1');
            const lenMatch = /content-length:\s*(\d+)/i.exec(head);
            const bodyLen = lenMatch === null ? 0 : Number(lenMatch[1]);
            if (buf.length < idx + 4 + bodyLen) return;
            resolve({
              status: Number(head.split(' ')[1]),
              head,
              body: buf.subarray(idx + 4, idx + 4 + bodyLen).toString('utf8'),
            });
          });
        },
      );
      client.write(
        'POST /upload HTTP/1.1\r\nHost: slowup.example\r\nContent-Length: 12\r\n\r\n',
      );
      client.write('012345');
      // Drip the rest past the 300ms bound — charged to the client under
      // dispatch arming, still in the clear under finish-armed.
      await new Promise((resolve) => setTimeout(resolve, 450));
      client.write('ABCDEF');
      const res = await withTimeout(response, 10_000, 'slow-upload response');
      expect(res.status).toBe(200);
      expect(res.body).toBe('done POST /upload');
      client.destroy();
    } finally {
      await closeServer(origin);
      await slowProxy.close();
    }
  });
});

describe('contentType inference (flag 96)', () => {
  test('sec-fetch-dest: image fires an $image rule; the same request undeclared relays to the origin', async () => {
    const ctProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator(['||img-scope.example^$image']),
      policy,
      upstreamCaCerts: [originCa.caCertPem],
      upstreamConnectTimeoutMs: 2_000,
    });
    const { server, port } = await httpsOrigin('img-scope.example');
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'img-scope.example',
        ['http/1.1'],
        ctProxy.port,
      );
      // The declared resource type feeds the $image modifier — 403, no dial.
      const blocked = await withTimeout(
        httpRequestOver(client, {
          path: '/pic.png',
          host: 'img-scope.example',
          headers: { 'sec-fetch-dest': 'image' },
        }),
        10_000,
        'image-scoped request',
      );
      expect(blocked.status).toBe(403);
      expect(blocked.head.toLowerCase()).toContain(
        'x-blockingmachine-rule: ||img-scope.example^$image',
      );
      // Undeclared: the rule cannot fire — conservative under-match, so the
      // same request relays through to the origin.
      const allowed = await withTimeout(
        httpRequestOver(client, { path: '/pic.png', host: 'img-scope.example' }),
        10_000,
        'undeclared request',
      );
      expect(allowed.status).toBe(200);
      expect(allowed.body).toContain('origin GET /pic.png');
      client.destroy();
    } finally {
      await closeServer(server);
      await ctProxy.close();
    }
  });

  test('a typed @@ exception cannot arm off a client-declared type — the untyped block still wins', async () => {
    // `sec-fetch-dest` is client bytes. `||tracker.example/tracker.png`
    // blocks the request on its own; `@@||tracker.example/tracker.png$image`
    // would except it *if* the declared type were the only evaluation — a
    // fabricated `dest: image` then relaxes a block the client could never
    // lift. The conservative shape runs BOTH: a block on either leg wins, so
    // the declared type may only ever tighten a verdict. (Path-scoped rules,
    // because a host-wide `||tracker.example^` would drop the flow at the
    // SNI verdict — the per-request evaluator never sees it.)
    const armProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator([
        '||tracker.example/tracker.png',
        '@@||tracker.example/tracker.png$image',
      ]),
      policy,
      upstreamCaCerts: [originCa.caCertPem],
      upstreamConnectTimeoutMs: 2_000,
    });
    const { server, port } = await httpsOrigin('tracker.example');
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'tracker.example',
        ['http/1.1'],
        armProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, {
          path: '/tracker.png',
          host: 'tracker.example',
          headers: { 'sec-fetch-dest': 'image' },
        }),
        10_000,
        'armed-exception request',
      );
      expect(res.status).toBe(403);
      // The untyped leg's rule is the one that actually blocked — the typed
      // leg's exception never surfaced to the client.
      expect(res.head.toLowerCase()).toContain(
        'x-blockingmachine-rule: ||tracker.example/tracker.png',
      );
      client.destroy();
    } finally {
      await closeServer(server);
      await armProxy.close();
    }
  });

  test('the tighten direction stays intact — untyped-allowed + $image block + dest:image → 403', async () => {
    // The same double evaluation must not lose the ADD direction: the typed
    // leg's own block still wins over the untyped leg's allow.
    const addProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator(['||img-add.example^$image']),
      policy,
      upstreamCaCerts: [originCa.caCertPem],
      upstreamConnectTimeoutMs: 2_000,
    });
    const { server, port } = await httpsOrigin('img-add.example');
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'img-add.example',
        ['http/1.1'],
        addProxy.port,
      );
      const blocked = await withTimeout(
        httpRequestOver(client, {
          path: '/p.png',
          host: 'img-add.example',
          headers: { 'sec-fetch-dest': 'image' },
        }),
        10_000,
        'typed-add request',
      );
      expect(blocked.status).toBe(403);
      const allowed = await withTimeout(
        httpRequestOver(client, { path: '/p.png', host: 'img-add.example' }),
        10_000,
        'undeclared request',
      );
      expect(allowed.status).toBe(200);
      client.destroy();
    } finally {
      await closeServer(server);
      await addProxy.close();
    }
  });
});

describe('thirdParty inference — sec-fetch-site (flag 96)', () => {
  // `||site-tp.example/p` is inert at CONNECT time — the SNI verdict runs
  // with no request context, so a `$third-party` gate can never fire there.
  // Terminated per-request evaluation sees the client-volunteered header:
  // cross-site → third-party; same-site/same-origin/none → first-party
  // (same-site shares the registrable domain — ABP's eTLD+1 reading),
  // absent/garbage → undefined (no guessing).
  const tpRules = [
    '||site-tp.example/p$third-party',
    '||site-fp.example/q$~third-party',
    '||site-arm.example/r',
    '@@||site-arm.example/r$~third-party',
    // Covers the blind-splice test's localhost origin — a rule that WOULD
    // fire under a real cross-site signal, proving the splice never reads it.
    '||localhost/p$third-party',
  ];

  async function tpProxy(): Promise<RunningProxy> {
    return startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator(tpRules),
      policy,
      upstreamCaCerts: [originCa.caCertPem],
      upstreamConnectTimeoutMs: 2_000,
    });
  }

  test('sec-fetch-site: cross-site fires a $third-party rule; same-site stays first-party (h1 MITM)', async () => {
    const p = await tpProxy();
    const { server, port } = await httpsOrigin('site-tp.example');
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'site-tp.example',
        ['http/1.1'],
        p.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, {
          path: '/p',
          host: 'site-tp.example',
          headers: { 'sec-fetch-site': 'cross-site' },
        }),
        10_000,
        'cross-site request',
      );
      expect(res.status).toBe(403);
      expect(res.head.toLowerCase()).toContain(
        'x-blockingmachine-rule: ||site-tp.example/p$third-party',
      );
      // first-party and undeclared contexts leave the rule unfired —
      // same-site included: `a.foo.com` → `b.foo.com` shares the
      // registrable domain, so ABP's `$third-party` does not cover it.
      for (const headers of [
        { 'sec-fetch-site': 'same-site' },
        { 'sec-fetch-site': 'same-origin' },
        { 'sec-fetch-site': 'none' },
        { 'sec-fetch-site': 'totally-bogus' },
        {},
      ] as Record<string, string>[]) {
        const res = await withTimeout(
          httpRequestOver(client, { path: '/p', host: 'site-tp.example', headers }),
          10_000,
          'non-third-party request',
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('origin GET /p');
      }
      client.destroy();
    } finally {
      await closeServer(server);
      await p.close();
    }
  });

  test('h2 parity: sec-fetch-site rides the compat headers into the same verdict', async () => {
    const p = await tpProxy();
    const { server, port } = await httpsOrigin('site-tp.example');
    try {
      const { client } = await connectThenTls(`localhost:${port}`, 'site-tp.example', ['h2'], p.port);
      const session = http2.connect('https://site-tp.example', { createConnection: () => client });
      try {
        const blocked = new Promise<number>((resolve) => {
          const req = session.request({
            ':method': 'GET',
            ':path': '/p',
            ':scheme': 'https',
            ':authority': 'site-tp.example',
            'sec-fetch-site': 'cross-site',
          });
          req.on('response', (headers) => resolve(Number(headers[':status'])));
          req.resume();
          req.end();
        });
        expect(await withTimeout(blocked, 10_000, 'h2 third-party verdict')).toBe(403);
        const allowed = new Promise<number>((resolve) => {
          const req = session.request({
            ':method': 'GET',
            ':path': '/p',
            ':scheme': 'https',
            ':authority': 'site-tp.example',
            'sec-fetch-site': 'same-origin',
          });
          req.on('response', (headers) => resolve(Number(headers[':status'])));
          req.resume();
          req.end();
        });
        expect(await withTimeout(allowed, 10_000, 'h2 first-party verdict')).toBe(200);
      } finally {
        session.close();
      }
      client.destroy();
    } finally {
      await closeServer(server);
      await p.close();
    }
  });

  test('$~third-party blocks first-party contexts and frees cross-site ones', async () => {
    const p = await tpProxy();
    const { server, port } = await httpsOrigin('site-fp.example');
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'site-fp.example',
        ['http/1.1'],
        p.port,
      );
      // same-origin AND same-site are both first-party — same-site shares
      // the registrable domain, which is the boundary `$~third-party` reads.
      for (const site of ['same-origin', 'same-site']) {
        const blocked = await withTimeout(
          httpRequestOver(client, {
            path: '/q',
            host: 'site-fp.example',
            headers: { 'sec-fetch-site': site },
          }),
          10_000,
          `${site} first-party request`,
        );
        expect(blocked.status).toBe(403);
      }
      const freed = await withTimeout(
        httpRequestOver(client, {
          path: '/q',
          host: 'site-fp.example',
          headers: { 'sec-fetch-site': 'cross-site' },
        }),
        10_000,
        'cross-site request',
      );
      expect(freed.status).toBe(200);
      client.destroy();
    } finally {
      await closeServer(server);
      await p.close();
    }
  });

  test('a fabricated same-origin cannot arm a $~third-party exception — the untyped block wins', async () => {
    // `sec-fetch-site` is client bytes like `sec-fetch-dest`: the declared
    // signal may only ever TIGHTEN. `||site-arm.example/r` blocks untyped;
    // `@@||site-arm.example/r$~third-party` would except it under a
    // first-party reading — a fabricated `same-origin` then relaxing a
    // block the client could never lift. The second, untyped pass keeps
    // the block.
    const p = await tpProxy();
    const { server, port } = await httpsOrigin('site-arm.example');
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'site-arm.example',
        ['http/1.1'],
        p.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, {
          path: '/r',
          host: 'site-arm.example',
          headers: { 'sec-fetch-site': 'same-origin' },
        }),
        10_000,
        'armed-exception request',
      );
      expect(res.status).toBe(403);
      expect(res.head.toLowerCase()).toContain('x-blockingmachine-rule: ||site-arm.example/r');
      client.destroy();
    } finally {
      await closeServer(server);
      await p.close();
    }
  });

  test('the plain-HTTP blind splice never reads sec-fetch-site — $third-party stays inert', async () => {
    // Non-terminated paths carry request headers only as opaque bytes: the
    // splice verdict evaluates URL+method, so a `$third-party` rule can
    // never fire there — `thirdParty` stays honestly undefined where the
    // proxy cannot see the signal.
    const p = await tpProxy();
    const origin = http.createServer((_req, res) => {
      res.end('plain splice');
    });
    const port = await listen(origin);
    try {
      const sock = net.connect({ host: '127.0.0.1', port: p.port });
      await once(sock, 'connect');
      sock.write(
        `GET http://localhost:${port}/p HTTP/1.1\r\nHost: localhost:${port}\r\nSec-Fetch-Site: cross-site\r\nConnection: close\r\n\r\n`,
      );
      const raw = await withTimeout(
        new Promise<Buffer>((resolve) => {
          const chunks: Buffer[] = [];
          sock.on('data', (c: Buffer) => chunks.push(c));
          sock.once('close', () => resolve(Buffer.concat(chunks)));
        }),
        10_000,
        'plain-splice response',
      );
      expect(raw.toString('latin1')).toContain('HTTP/1.1 200');
      expect(raw.toString('latin1')).toContain('plain splice');
      sock.destroy();
    } finally {
      await closeServer(origin);
      await p.close();
    }
  });
});

describe('response pipeline (P2 Task 3)', () => {
  // A dedicated engine carrying BOTH faces of one rule file — the request
  // evaluator and the cosmetic index — exactly as startFilterProxy wires it.
  const rules = [
    'cosmetic.example##.ad-slot',
    "cosmetic.example#%#//scriptlet('set-constant', 'bm_flag', 'true')",
    'cosmetich2.example##.ad-h2',
    'cosmetich2.example##+js(set-constant, h2_flag, 1)',
    '||ctblock.example^$image',
    "||csp.example^$csp=script-src 'none'",
    'cspcos.example##.csp-ad',
    "||cspcos.example^$csp=frame-src 'none'",
    'unknowncos.example##+js(totally-fake-name)',
  ];
  let responsePolicy: PolicyStore;
  let responseProxy: RunningProxy;

  beforeAll(async () => {
    responsePolicy = PolicyStore.ephemeral();
    responseProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator(rules),
      cosmeticIndex: createCosmeticIndex(rules),
      policy: responsePolicy,
      upstreamCaCerts: [originCa.caCertPem],
      upstreamConnectTimeoutMs: 2_000,
    });
  });

  afterAll(async () => {
    await responseProxy.close();
  });

  /** h1 HTTPS origin serving `body` with the given headers — records the request head. */
  async function htmlOrigin(
    sni: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ server: https.Server; port: number; lastRequest: () => http.IncomingMessage | null }> {
    const leaf = originCa.forgeLeaf(sni);
    let seen: http.IncomingMessage | null = null;
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
      seen = req;
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
        ...headers,
      });
      res.end(body);
    });
    const port = await listen(server);
    return { server, port, lastRequest: () => seen };
  }

  test('h1: injectable host gets the <style> + <script> blocks and a widened CSP', async () => {
    const page =
      '<html><head><title>t</title></head><body><div class="ad-slot">x</div></body></html>';
    const { server, port } = await htmlOrigin('cosmetic.example', page, {
      'content-security-policy': "script-src 'self'; style-src 'self'",
    });
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cosmetic.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'cosmetic.example' }),
        10_000,
        'injected GET',
      );
      expect(res.status).toBe(200);
      // Element-hiding style block with its selector folded into one rule.
      expect(res.body).toContain('<style id="bm-c">.ad-slot{display:none!important}</style>');
      expect(res.body.indexOf('<style id="bm-c">')).toBeLessThan(res.body.indexOf('</head>'));
      // The scriptlet runtime + the invocation, inside the head.
      expect(res.body).toContain('__bm_sc');
      expect(res.body).toContain('set-constant');
      expect(res.body).toContain('bm_flag');
      // The upstream CSP was widened (never narrowed) for the inline markup.
      expect(res.head.toLowerCase()).toContain('content-security-policy:');
      expect(res.head.toLowerCase()).toContain("'unsafe-inline'");
      // The injected body is honestly length-stamped.
      expect(res.head.toLowerCase()).toContain(`content-length: ${Buffer.byteLength(res.body)}`);
      const after = responseProxy.stats();
      expect(after.htmlInjected).toBe(before.htmlInjected + 1);
      expect(after.scriptletsInvoked).toBe(before.scriptletsInvoked + 1);
      expect(after.cspRewrites).toBe(before.cspRewrites + 1);
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('h2 upstream parity: an ALPN-h2 origin gets the same injection', async () => {
    const leaf = originCa.forgeLeaf('cosmetich2.example');
    const origin = http2.createSecureServer({
      key: leaf.keyPem,
      cert: leaf.certPem,
      allowHTTP1: true,
      ALPNProtocols: ['h2', 'http/1.1'],
    });
    origin.on('request', (_req, res) => {
      const page = '<html><head></head><body><p class="ad-h2">x</p></body></html>';
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(page.length) });
      res.end(page);
    });
    const port = await listen(origin);
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cosmetich2.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'cosmetich2.example' }),
        10_000,
        'h2-upstream injected GET',
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('<style id="bm-c">.ad-h2{display:none!important}</style>');
      expect(res.body).toContain('h2_flag');
      expect(responseProxy.stats().htmlInjected).toBe(before.htmlInjected + 1);
      client.destroy();
    } finally {
      await closeServer(origin);
    }
  });

  test("client's decodable accept-encoding reaches the upstream on an injectable host (flag 108)", async () => {
    const { server, port, lastRequest } = await htmlOrigin(
      'cosmetic.example',
      '<html><head></head><body>enc</body></html>',
    );
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cosmetic.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, {
          path: '/',
          host: 'cosmetic.example',
          headers: { 'accept-encoding': 'gzip, deflate, br, zstd', accept: 'text/html' },
        }),
        10_000,
        'encoding-offer GET',
      );
      expect(res.status).toBe(200);
      // The offer is intersected with the codecs the pipeline can decode —
      // gzip/deflate/br ride through, the undecodable zstd is dropped; no
      // more forced identity.
      expect(lastRequest()?.headers['accept-encoding']).toBe('gzip, deflate, br');
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('response-CT re-verdict: untyped request + image/png response → 403 + counter + ledger', async () => {
    const leaf = originCa.forgeLeaf('ctblock.example');
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      const body = 'PNGDATA';
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(body.length) });
      res.end(body);
    });
    const port = await listen(server);
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'ctblock.example',
        ['http/1.1'],
        responseProxy.port,
      );
      // No sec-fetch-dest and a neutral Accept — the request-side verdict is
      // untyped, so `||ctblock.example^$image` cannot fire until the response
      // names its real type.
      const res = await withTimeout(
        httpRequestOver(client, {
          path: '/p.png',
          host: 'ctblock.example',
          headers: { accept: '*/*' },
        }),
        10_000,
        'ct-reverdict GET',
      );
      expect(res.status).toBe(403);
      expect(res.head.toLowerCase()).toContain('x-blockingmachine-rule: ||ctblock.example^$image');
      expect(responseProxy.stats().responsesBlocked).toBe(before.responsesBlocked + 1);
      await waitFor(() =>
        responsePolicy
          .list()
          .some(
            (e) =>
              e.action === 'proxy_event' &&
              e.host === 'ctblock.example' &&
              (e.reason ?? '').startsWith('response-block'),
          ),
      );
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('over-cap html flushes byte-identical — never a partial injection', async () => {
    const filler = 'x'.repeat(MAX_HTML_BUFFER + 1024);
    const bigBody = `<html><body>${filler}</body></html>`;
    const { server, port } = await htmlOrigin('cosmetic.example', bigBody);
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cosmetic.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'cosmetic.example' }),
        15_000,
        'over-cap GET',
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe(bigBody);
      expect(res.body).not.toContain('bm-c');
      expect(responseProxy.stats().injectionsSkipped).toBe(before.injectionsSkipped + 1);
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('$csp rule: the response gains the merged header even without injection', async () => {
    const leaf = originCa.forgeLeaf('csp.example');
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      const body = 'plain';
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) });
      res.end(body);
    });
    const port = await listen(server);
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'csp.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'csp.example', headers: { accept: '*/*' } }),
        10_000,
        'csp GET',
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe('plain');
      expect(res.head.toLowerCase()).toContain("content-security-policy: script-src 'none'");
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('a 10 MB binary streams — first byte well ahead of the body completing', async () => {
    const leaf = originCa.forgeLeaf('bigfile.example');
    const SIZE = 10 * 1024 * 1024;
    const CHUNK = 128 * 1024;
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(SIZE),
      });
      // Dribble 50ms per chunk (~4s total) — a buffering relay could not
      // deliver byte 1 before the whole body landed.
      let sent = 0;
      const push = () => {
        const n = Math.min(CHUNK, SIZE - sent);
        sent += n;
        res.write(Buffer.alloc(n, 'y'));
        if (sent < SIZE) {
          setTimeout(push, 50);
        } else {
          res.end();
        }
      };
      push();
    });
    const port = await listen(server);
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'bigfile.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const started = Date.now();
      const collected = new Promise<{ ttfb: number; bytes: number }>((resolve) => {
        let ttfb = -1;
        let bytes = 0;
        let headSeen = false;
        client.on('data', (chunk: Buffer) => {
          if (ttfb < 0) {
            ttfb = Date.now() - started;
          }
          let rest = chunk;
          if (!headSeen) {
            // Count the body only — the response head rides the first chunk.
            const idx = chunk.indexOf('\r\n\r\n');
            if (idx < 0) {
              return;
            }
            headSeen = true;
            rest = chunk.subarray(idx + 4);
          }
          bytes += rest.length;
          if (bytes >= SIZE) {
            resolve({ ttfb, bytes });
          }
        });
      });
      client.write(
        'GET /blob HTTP/1.1\r\nHost: bigfile.example\r\nAccept: */*\r\nConnection: close\r\n\r\n',
      );
      const out = await withTimeout(collected, 20_000, '10MB streaming read');
      expect(out.bytes).toBe(SIZE);
      expect(out.ttfb).toBeLessThan(2_000);
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test("a $csp merge on a passthrough is ledgered — csp-rewrite event + counter", async () => {
    const leaf = originCa.forgeLeaf('csp.example');
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      const body = 'plain';
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) });
      res.end(body);
    });
    const port = await listen(server);
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'csp.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'csp.example', headers: { accept: '*/*' } }),
        10_000,
        '$csp-ledger GET',
      );
      expect(res.status).toBe(200);
      expect(res.head.toLowerCase()).toContain("content-security-policy: script-src 'none'");
      // The merge is a real rewrite — counted and journaled, not silent.
      expect(responseProxy.stats().cspRewrites).toBe(before.cspRewrites + 1);
      await waitFor(() =>
        responsePolicy
          .list()
          .some(
            (e) =>
              e.action === 'proxy_event' &&
              e.host === 'csp.example' &&
              (e.reason ?? '').startsWith('csp-rewrite'),
          ),
      );
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test("$csp onto an existing CSP appends a co-equal policy — 'none' still binds", async () => {
    // `script-src 'self'` + `$csp=script-src 'none'`: the wire must carry
    // BOTH policies (`,`-joined policies AND — 'none' still refuses all
    // scripts). A token-merge would emit `script-src 'self' 'none'` where
    // CSP voids 'none' beside live sources — the rule silently dead.
    const leaf = originCa.forgeLeaf('csp.example');
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      const body = 'plain';
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-security-policy': "script-src 'self'",
        'content-length': String(body.length),
      });
      res.end(body);
    });
    const port = await listen(server);
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'csp.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'csp.example', headers: { accept: '*/*' } }),
        10_000,
        'co-equal $csp GET',
      );
      expect(res.status).toBe(200);
      expect(res.head.toLowerCase()).toContain(
        "content-security-policy: script-src 'self', script-src 'none'",
      );
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('injection + $csp on one host: widened policy AND appended rule policy on one header', async () => {
    const page =
      '<html><head></head><body><div class="csp-ad">x</div></body></html>';
    const { server, port } = await htmlOrigin('cspcos.example', page, {
      'content-security-policy': "script-src 'self'",
    });
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cspcos.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'cspcos.example' }),
        10_000,
        'csp+inject GET',
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('<style id="bm-c">.csp-ad{display:none!important}</style>');
      // Widen first, append after: the rule lands as its own policy.
      expect(res.head.toLowerCase()).toContain(
        "content-security-policy: script-src 'self' 'unsafe-inline', frame-src 'none'",
      );
      // One widen (the header) + one appended $csp policy → two rewrites.
      expect(responseProxy.stats().cspRewrites).toBe(before.cspRewrites + 2);
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('a corrupt gzip body on an injectable host flushes through byte-identical (flag 108)', async () => {
    // The codec path preserves original bytes on codec failure: the head
    // claims gzip but the payload is not gunzippable, so decode throws and
    // the untouched wire bytes flush — the response must pass through
    // byte-identical, never a partial decode or a 502.
    const leaf = originCa.forgeLeaf('cosmetic.example');
    const body = 'GZIP-OPAQUE-PAYLOAD';
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-encoding': 'gzip',
        'content-length': String(body.length),
      });
      res.end(body);
    });
    const port = await listen(server);
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cosmetic.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'cosmetic.example' }),
        10_000,
        'encoded-body GET',
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe(body);
      expect(res.head.toLowerCase()).toContain('content-encoding: gzip');
      expect(res.body).not.toContain('bm-c');
      expect(responseProxy.stats().injectionsSkipped).toBe(before.injectionsSkipped + 1);
      expect(responseProxy.stats().htmlInjected).toBe(before.htmlInjected);
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  for (const [codec, compress, decompress] of [
    ['gzip', gzipSync, gunzipSync],
    ['deflate', deflateSync, inflateSync],
    ['br', brotliCompressSync, brotliDecompressSync],
  ] as const) {
    test(`a ${codec} body is decoded, injected, and re-encoded under the same codec (flag 108)`, async () => {
      const leaf = originCa.forgeLeaf('cosmetic.example');
      const page =
        '<html><head></head><body><div class="ad-slot">enc</div></body></html>';
      const wire = compress(Buffer.from(page));
      const server = https.createServer(
        { key: leaf.keyPem, cert: leaf.certPem },
        (_req, res) => {
          res.writeHead(200, {
            'content-type': 'text/html',
            'content-encoding': codec,
            'content-length': String(wire.length),
          });
          res.end(wire);
        },
      );
      const port = await listen(server);
      try {
        const before = responseProxy.stats();
        const { client } = await connectThenTls(
          `localhost:${port}`,
          'cosmetic.example',
          ['http/1.1'],
          responseProxy.port,
        );
        const raw = await withTimeout(
          rawHttpOver(
            client,
            `GET / HTTP/1.1\r\nHost: cosmetic.example\r\nAccept: text/html\r\nAccept-Encoding: ${codec}\r\nConnection: close\r\n\r\n`,
          ),
          10_000,
          `${codec} injected response`,
        );
        const idx = raw.indexOf('\r\n\r\n');
        expect(idx).toBeGreaterThan(-1);
        const head = raw.subarray(0, idx).toString('latin1').toLowerCase();
        const wireBody = raw.subarray(idx + 4);
        // The coding survives — the client decodes what it offered.
        expect(head).toContain(`content-encoding: ${codec}`);
        // …and the length is honestly restamped to the NEW wire bytes.
        expect(head).toContain(`content-length: ${wireBody.length}`);
        const decoded = decompress(wireBody).toString('utf8');
        expect(decoded).toContain('<style id="bm-c">.ad-slot{display:none!important}</style>');
        expect(decoded).toContain('bm_flag');
        expect(responseProxy.stats().htmlInjected).toBe(before.htmlInjected + 1);
        client.destroy();
      } finally {
        await closeServer(server);
      }
    });
  }

  test('an unsupported content-encoding still passes through (inject-skip: encoded)', async () => {
    const leaf = originCa.forgeLeaf('cosmetic.example');
    const body = 'ZSTD-OPAQUE-PAYLOAD';
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-encoding': 'zstd',
        'content-length': String(body.length),
      });
      res.end(body);
    });
    const port = await listen(server);
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cosmetic.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'cosmetic.example' }),
        10_000,
        'unsupported-encoding GET',
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe(body);
      expect(res.head.toLowerCase()).toContain('content-encoding: zstd');
      expect(res.body).not.toContain('bm-c');
      expect(responseProxy.stats().injectionsSkipped).toBe(before.injectionsSkipped + 1);
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('absent content-type + markup body injects — the bounded sniff (flag 109)', async () => {
    const leaf = originCa.forgeLeaf('cosmetic.example');
    const page =
      '<!doctype html><html><head></head><body><div class="ad-slot">x</div></body></html>';
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      // No content-type at all — the buffered prefix must declare itself.
      res.writeHead(200, { 'content-length': String(page.length) });
      res.end(page);
    });
    const port = await listen(server);
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cosmetic.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'cosmetic.example' }),
        10_000,
        'absent-CT GET',
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('<style id="bm-c">');
      expect(responseProxy.stats().htmlInjected).toBe(before.htmlInjected + 1);
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('text/plain + markup body injects; text/plain + NUL binary passes through (flag 109)', async () => {
    const leaf = originCa.forgeLeaf('cosmetic.example');
    const page = '<html><head></head><body><div class="ad-slot">t</div></body></html>';
    const binary = Buffer.concat([
      Buffer.from('PK\x03\x04', 'latin1'),
      Buffer.from([0, 1, 2, 3, 4, 5]),
      Buffer.alloc(256, 0x42),
    ]);
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
      const isBin = req.url === '/bin';
      const body = isBin ? binary : Buffer.from(page);
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': String(body.length),
      });
      res.end(body);
    });
    const port = await listen(server);
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cosmetic.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/plain', host: 'cosmetic.example' }),
        10_000,
        'text/plain markup GET',
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('<style id="bm-c">');
      const bin = await withTimeout(
        httpRequestOver(client, { path: '/bin', host: 'cosmetic.example' }),
        10_000,
        'text/plain binary GET',
      );
      expect(bin.status).toBe(200);
      // httpRequestOver decodes utf8 — assert length honesty + no marker
      // rather than byte equality (the NUL run mangles utf8). An untouched
      // length proves the splice never ran — the sniff's NUL veto flushed
      // the bytes verbatim (inject-skip: not-html).
      expect(bin.head.toLowerCase()).toContain(`content-length: ${binary.length}`);
      expect(bin.body).not.toContain('bm-c');
      expect(responseProxy.stats().injectionsSkipped).toBe(before.injectionsSkipped + 1);
      expect(responseProxy.stats().htmlInjected).toBe(before.htmlInjected + 1);
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('a 304 on an injectable host passes through — no synthesized body, no restamped length', async () => {
    // Buffer-inject on a bodiless status fabricates a body the protocol
    // forbids (an h2 DATA frame on 304 is a violation) and restamps a
    // content-length the status doesn't own.
    const leaf = originCa.forgeLeaf('cosmetic.example');
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      res.writeHead(304, { 'content-type': 'text/html' });
      res.end();
    });
    const port = await listen(server);
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cosmetic.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const wire = await withTimeout(
        rawHttpOver(
          client,
          'GET / HTTP/1.1\r\nHost: cosmetic.example\r\nAccept: */*\r\nConnection: close\r\n\r\n',
        ),
        10_000,
        '304 response',
      );
      const text = wire.toString('latin1');
      expect(text).toContain('304');
      const idx = text.indexOf('\r\n\r\n');
      expect(idx).toBeGreaterThan(-1);
      const head = text.slice(0, idx).toLowerCase();
      const tail = text.slice(idx + 4);
      expect(tail).toBe(''); // nothing synthesized behind the head
      expect(head).not.toContain('content-length'); // and none restamped
      expect(tail).not.toContain('bm-c');
      expect(responseProxy.stats().htmlInjected).toBe(before.htmlInjected);
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('a HEAD request on an injectable host keeps the upstream head verbatim', async () => {
    const page =
      '<html><head></head><body><div class="ad-slot">x</div></body></html>';
    const leaf = originCa.forgeLeaf('cosmetic.example');
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      // Node h1 suppresses the body for HEAD — the head still carries the
      // would-be content-length.
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-length': String(page.length),
      });
      res.end(page);
    });
    const port = await listen(server);
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cosmetic.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const wire = await withTimeout(
        rawHttpOver(
          client,
          'HEAD / HTTP/1.1\r\nHost: cosmetic.example\r\nAccept: text/html\r\nConnection: close\r\n\r\n',
        ),
        10_000,
        'HEAD response',
      );
      const text = wire.toString('latin1');
      const idx = text.indexOf('\r\n\r\n');
      const head = idx < 0 ? text : text.slice(0, idx).toLowerCase();
      const tail = idx < 0 ? '' : text.slice(idx + 4);
      // The upstream's would-be length rides through unstamped-over — the
      // buggy path rewrote it to the injected markup's length.
      expect(head).toContain(`content-length: ${page.length}`);
      expect(head).toContain('200');
      expect(tail).not.toContain('bm-c');
      expect(responseProxy.stats().htmlInjected).toBe(before.htmlInjected);
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('an injector throw flushes the buffered body verbatim — counted, never hung', async () => {
    // Regression: the 'end' handler set `flushed` before its try, so the
    // catch's flushRaw() no-op'd — the client hung with the head unsent
    // and the buffered bytes held.
    const leaf = originCa.forgeLeaf('throwinj.example');
    const page = '<html><head></head><body>verbatim-bytes</body></html>';
    const origin = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-length': String(page.length),
      });
      res.end(page);
    });
    const port = await listen(origin);
    try {
      const probe = fakeResponse();
      const events: ResponseEvent[] = [];
      const evaluator = createRequestEvaluator([]);
      // A payload that passes hasInjectableContent (`hide` as a bare string
      // still has .length) but throws at render (`'x'.join` is not a
      // function) — the injector-error path under test.
      const malformedIndex = {
        forHost: () =>
          ({
            hide: 'x',
            styles: [],
            scriptlets: [],
            skippedScriptlets: 0,
          }) as unknown as CosmeticPayload,
        size: () => ({
          selectors: 0,
          exceptions: 0,
          scriptlets: 0,
          scriptletExceptions: 0,
          styles: 0,
        }),
        stats: {} as CosmeticIndex['stats'],
      } as CosmeticIndex;
      relayRequest(
        {
          method: 'GET',
          url: '/',
          host: 'throwinj.example',
          headers: {},
          body: Readable.from([]),
          protocol: 'h1',
        },
        probe.res,
        { host: '127.0.0.1', port, servername: 'throwinj.example' },
        {
          upstreamCaCerts: [originCa.caCertPem],
          response: {
            url: 'https://throwinj.example/',
            host: 'throwinj.example',
            method: 'GET',
            verdict: evaluator.evaluate('https://throwinj.example/'),
            cosmeticIndex: malformedIndex,
            onEvent: (event) => events.push(event),
          },
        },
      );
      await waitFor(
        () => probe.statuses.length > 0 && probe.bodyBytes().length >= page.length,
      );
      expect(probe.statuses[0]).toBe(200);
      expect(probe.bodyBytes().toString('utf8')).toBe(page);
      expect(events.some((e) => e.kind === 'inject-skip' && e.reason === 'error')).toBe(true);
      await probeEngineAlive('injthrow');
    } finally {
      await closeServer(origin);
    }
  });

  test('a throwing onEvent listener never reaches the byte path — injection still lands (flag 113)', async () => {
    // The event sink is diagnostics: a listener exception inside the
    // stream's 'end' handler must not escape into the mutation accounting
    // (an injected page miscounted as a skip) or the byte path (a wedge or
    // a 502 on a page the upstream served fine).
    const leaf = originCa.forgeLeaf('cosmetic.example');
    const page = '<html><head></head><body><div class="ad-slot">v</div></body></html>';
    const origin = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-length': String(page.length),
      });
      res.end(page);
    });
    const port = await listen(origin);
    try {
      const probe = fakeResponse();
      const evaluator = createRequestEvaluator(rules);
      const cosmetic = createCosmeticIndex(rules);
      let listenerCalls = 0;
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        relayRequest(
          {
            method: 'GET',
            url: '/',
            host: 'cosmetic.example',
            headers: {},
            body: Readable.from([]),
            protocol: 'h1',
          },
          probe.res,
          { host: '127.0.0.1', port, servername: 'cosmetic.example' },
          {
            upstreamCaCerts: [originCa.caCertPem],
            response: {
              url: 'https://cosmetic.example/',
              host: 'cosmetic.example',
              method: 'GET',
              verdict: evaluator.evaluate('https://cosmetic.example/'),
              cosmeticIndex: cosmetic,
              onEvent: () => {
                listenerCalls++;
                throw new Error('listener boom');
              },
            },
          },
        );
        await waitFor(() => probe.statuses.length > 0 && probe.bodyBytes().length > page.length);
        expect(probe.statuses[0]).toBe(200);
        // The injection landed — the listener's throw rode past the splice,
        // not into it.
        expect(probe.bodyBytes().toString('utf8')).toContain('bm-c');
        expect(listenerCalls).toBeGreaterThan(0); // the throw really fired
        expect(probe.isDestroyed()).toBe(false);
        await probeEngineAlive('evthrow');
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      await closeServer(origin);
    }
  });

  test('a chunked html body dripping under the cap flushes on the buffer deadline', async () => {
    // The accumulation phase is bounded by BUFFER_FLUSH_FACTOR × the
    // upstream response deadline: without it a body that never 'end's (and
    // never overflows) would show the client nothing.
    const dripProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator(rules),
      cosmeticIndex: createCosmeticIndex(rules),
      policy,
      upstreamCaCerts: [originCa.caCertPem],
      upstreamConnectTimeoutMs: 2_000,
      upstreamResponseTimeoutMs: 300, // → 600ms buffer deadline
    });
    const leaf = originCa.forgeLeaf('cosmetic.example');
    const origin = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }); // no CL — chunked upstream
      res.write('<html><head></head><body>drip-');
      setTimeout(() => res.write('middle-'), 1_200);
      setTimeout(() => res.end('tail</body></html>'), 2_400);
    });
    const port = await listen(origin);
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cosmetic.example',
        ['http/1.1'],
        dripProxy.port,
      );
      const started = Date.now();
      const collected = new Promise<{ ttfb: number; text: string }>((resolve) => {
        let ttfb = -1;
        let text = '';
        client.on('data', (chunk: Buffer) => {
          if (ttfb < 0) {
            ttfb = Date.now() - started;
          }
          text += chunk.toString('latin1');
          if (text.includes('</html>')) {
            resolve({ ttfb, text });
          }
        });
        client.once('close', () => resolve({ ttfb, text }));
      });
      client.write(
        'GET / HTTP/1.1\r\nHost: cosmetic.example\r\nAccept: */*\r\nConnection: close\r\n\r\n',
      );
      const out = await withTimeout(collected, 15_000, 'deadline-flush response');
      // The body completes verbatim — flushed raw past the deadline, never
      // a partial injection — but the first byte lands at the 600ms
      // deadline, not at the upstream's ~2.4s 'end'. The pieces arrive in
      // order inside the chunked framing (hex sizes interleave).
      expect(out.text).toContain('drip-');
      expect(out.text).toContain('middle-');
      expect(out.text).toContain('tail</body></html>');
      expect(out.text.indexOf('drip-')).toBeLessThan(out.text.indexOf('middle-'));
      expect(out.text.indexOf('middle-')).toBeLessThan(out.text.indexOf('tail</body></html>'));
      expect(out.text).not.toContain('bm-c');
      expect(out.ttfb).toBeGreaterThanOrEqual(0);
      expect(out.ttfb).toBeLessThan(1_800);
      client.destroy();
    } finally {
      await closeServer(origin);
      await dripProxy.close();
    }
  });

  test('a >253-char request host reaching the ledger sink fails soft — no engine kill', async () => {
    // `pipeline.host` is client bytes (the request URL's authority): a Host
    // header past the 253-char hostname cap reaches `recordEvent`, whose
    // `requireHost` throws — unguarded, that throw escapes the response
    // handler as an uncaughtException and takes the whole engine. The audit
    // line must simply never land; the flow (and every other) carries on.
    const longHost = `${'a'.repeat(250)}.example`; // 262 chars — over POLICY_HOST_MAX_LENGTH
    const auditPolicy = PolicyStore.ephemeral();
    const auditProxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator(["*$csp=img-src 'none'"]),
      policy: auditPolicy,
      upstreamCaCerts: [originCa.caCertPem],
      upstreamConnectTimeoutMs: 2_000,
    });
    const { server, port } = await httpsOrigin('audit.example');
    try {
      const before = auditProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'audit.example',
        ['http/1.1'],
        auditProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: longHost }),
        10_000,
        'long-host GET',
      );
      // The merge applied (the stat counted it) and the response delivered —
      // the ledger throw was swallowed inside the event sink.
      expect(res.status).toBe(200);
      expect(res.head.toLowerCase()).toContain("content-security-policy: img-src 'none'");
      expect(auditProxy.stats().cspRewrites).toBe(before.cspRewrites + 1);
      expect(auditPolicy.list().every((e) => e.host.length <= 253)).toBe(true);
      // The same keep-alive flow still serves — the handler survived.
      const second = await withTimeout(
        httpRequestOver(client, { path: '/two', host: 'audit.example' }),
        10_000,
        'post-incident request',
      );
      expect(second.status).toBe(200);
      client.destroy();
      await probeEngineAlive('longhost');
    } finally {
      await closeServer(server);
      await auditProxy.close();
    }
  });

  test('injection budget: a held buffer makes the next page skip busy; the slot returns when it resolves', async () => {
    // The budget object is observable here — drive relayRequest directly so
    // the concurrency and the counter restore are both deterministic.
    const evaluator = createRequestEvaluator(rules);
    const cosmetic = createCosmeticIndex(rules);
    const budget = { inflight: 0, max: 1 };
    const events: ResponseEvent[] = [];

    // Origin A writes its head + a partial body, then parks — the relay's
    // buffer holds the only injection slot mid-accumulation.
    const leafA = originCa.forgeLeaf('cosmetic.example');
    let park: http.ServerResponse | null = null;
    const originA = https.createServer(
      { key: leafA.keyPem, cert: leafA.certPem },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><head>');
        park = res;
      },
    );
    const portA = await listen(originA);
    const pageB = '<html><head></head><body><div class="ad-slot">b</div></body></html>';
    const { server: originB, port: portB } = await htmlOrigin('cosmetic.example', pageB);
    try {
      const drive = (port: number, res: RelayResponse, host = 'cosmetic.example') =>
        relayRequest(
          {
            method: 'GET',
            url: '/',
            host,
            headers: {},
            body: Readable.from([]),
            protocol: 'h1',
          },
          res,
          { host: '127.0.0.1', port, servername: 'cosmetic.example' },
          {
            upstreamCaCerts: [originCa.caCertPem],
            response: {
              url: `https://${host}/`,
              host,
              method: 'GET',
              verdict: evaluator.evaluate(`https://${host}/`),
              cosmeticIndex: cosmetic,
              injectionBudget: budget,
              onEvent: (event) => events.push(event),
            },
          },
        );

      const probeA = fakeResponse();
      drive(portA, probeA.res);
      // The head arriving runs decideResponse — the slot is taken synchronously.
      await waitFor(() => budget.inflight === 1);

      const probeB = fakeResponse();
      drive(portB, probeB.res);
      await waitFor(
        () => events.some((e) => e.kind === 'inject-skip' && e.reason === 'busy'),
      );
      // B streamed verbatim — a full budget never queues memory.
      await waitFor(() => probeB.bodyBytes().length >= pageB.length);
      expect(probeB.bodyBytes().toString('utf8')).toBe(pageB);
      expect(probeB.bodyBytes().toString('utf8')).not.toContain('bm-c');

      // Resolving A's parked body completes its injection and frees the slot
      // (`inflight === 1` above already proved the handler ran and parked).
      park!.end('</head><body>A</body></html>');
      await waitFor(() => budget.inflight === 0);
      expect(events.some((e) => e.kind === 'html-inject')).toBe(true);

      // …and a later page takes the freed slot — the counter was restored,
      // not permanently spent.
      const probeC = fakeResponse();
      drive(portB, probeC.res);
      await waitFor(() => probeC.bodyBytes().length > pageB.length);
      expect(probeC.bodyBytes().toString('utf8')).toContain('bm-c');
    } finally {
      await closeServer(originA);
      await closeServer(originB);
    }
  });

  test('a declared non-document context keeps its accept-encoding — no wasted narrowing', async () => {
    const { server, port, lastRequest } = await htmlOrigin(
      'cosmetic.example',
      '<html><head></head><body>x</body></html>',
    );
    try {
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'cosmetic.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const image = await withTimeout(
        httpRequestOver(client, {
          path: '/i.png',
          host: 'cosmetic.example',
          headers: {
            'sec-fetch-dest': 'image',
            accept: 'image/png',
            'accept-encoding': 'gzip, deflate',
          },
        }),
        10_000,
        'typed-encoding image GET',
      );
      expect(image.status).toBe(200);
      // An image-declared fetch can never render the markup — the gzip
      // offer rides through verbatim rather than paying any narrow.
      expect(lastRequest()?.headers['accept-encoding']).toBe('gzip, deflate');

      // The same host under a document declaration narrows the offer to
      // the decodable subset — which is all of it here.
      const doc = await withTimeout(
        httpRequestOver(client, {
          path: '/',
          host: 'cosmetic.example',
          headers: {
            'sec-fetch-dest': 'document',
            accept: 'text/html',
            'accept-encoding': 'gzip, deflate',
          },
        }),
        10_000,
        'typed-encoding document GET',
      );
      expect(doc.status).toBe(200);
      expect(lastRequest()?.headers['accept-encoding']).toBe('gzip, deflate');
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('a host with only unknown scriptlets skips injection but still counts them', async () => {
    // `unknowncos.example` carries only `##+js(totally-fake-name)` — nothing
    // the runtime knows. The page must pass byte-identical while the card's
    // skipped-scriptlets figure still sees the coverage gap.
    const page = '<html><head></head><body><div>x</div></body></html>';
    const { server, port } = await htmlOrigin('unknowncos.example', page);
    try {
      const before = responseProxy.stats();
      const { client } = await connectThenTls(
        `localhost:${port}`,
        'unknowncos.example',
        ['http/1.1'],
        responseProxy.port,
      );
      const res = await withTimeout(
        httpRequestOver(client, { path: '/', host: 'unknowncos.example' }),
        10_000,
        'unknown-scriptlet GET',
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe(page);
      const after = responseProxy.stats();
      expect(after.htmlInjected).toBe(before.htmlInjected);
      expect(after.injectionsSkipped).toBe(before.injectionsSkipped + 1);
      expect(after.skippedScriptlets).toBe(before.skippedScriptlets + 1);
      client.destroy();
    } finally {
      await closeServer(server);
    }
  });
});
