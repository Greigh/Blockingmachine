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
import tls from 'node:tls';
import { createRequestEvaluator } from '@blockingmachine/core';
import { CertAuthority } from '../ca/certAuthority.js';
import { PolicyStore } from '../policy/policyStore.js';
import { startProxy, type RunningProxy } from '../proxy/filterProxy.js';

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
});
