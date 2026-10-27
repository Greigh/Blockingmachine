/**
 * Request-pipeline integration tests (design spec §5.5, plan Task 6).
 *
 * The verdict seam inside a terminated flow: per-request `evaluate` →
 * `blocked` answers a synthetic 403 before any upstream dial, and
 * allowed/exception requests relay only after `applyRequestTransforms` has
 * run — `$removeparam` strips land on the wire the origin sees, and an
 * exception carrying the same modifier cancels the strip upstream-style.
 *
 * The flow terminates on SNI `origin.test` so per-request Host headers can
 * exercise per-host verdicts on one keep-alive connection — the same
 * per-request evaluation Review Focus #4 pinned.
 */

import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
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

/** One h1 request on `sock`, reading status/head/body back. */
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
let originCa: CertAuthority; // a *separate* CA signing the local origin's cert
let policy: PolicyStore;
let proxy: RunningProxy;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bm-https-filter-pipeline-'));
  authority = await CertAuthority.open({ storeDir: join(dir, 'proxy-ca'), keyWrapBackend: null });
  originCa = await CertAuthority.open({ storeDir: join(dir, 'origin-ca'), keyWrapBackend: null });
  policy = await PolicyStore.open(join(dir, 'policy.jsonl'));
  proxy = await startProxy({
    bindHost: '127.0.0.1',
    dataPort: 0,
    authority,
    evaluator: createRequestEvaluator([
      '||origin.test^$removeparam=utm',
      '||blocked.test^',
      '*$removeparam=token',
      '@@||x.test^$removeparam=token',
    ]),
    policy,
    upstreamCaCerts: [originCa.caCertPem],
    upstreamConnectTimeoutMs: 2_000,
  });
});

afterAll(async () => {
  await proxy.close();
  await rm(dir, { recursive: true, force: true });
});

/** CONNECT to `target` through the data listener, then TLS up over the tunnel. */
async function connectThenTls(target: string, servername: string): Promise<tls.TLSSocket> {
  const raw = net.connect({ host: '127.0.0.1', port: proxy.port });
  await once(raw, 'connect');
  raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const head = await withTimeout(readHttpHead(raw), 5_000, 'CONNECT response');
  expect(head.split('\r\n')[0]).toBe('HTTP/1.1 200 Connection Established');
  const client = tls.connect({
    socket: raw,
    servername,
    ca: authority.caCertPem, // the device-trusted MITM CA
    ALPNProtocols: ['http/1.1'],
  });
  await withTimeout(once(client, 'secureConnect'), 10_000, 'terminated handshake');
  return client;
}

describe('request pipeline — transforms and verdicts on a terminated flow', () => {
  const seen: string[] = [];
  let origin: https.Server;
  let originPort: number;

  beforeAll(async () => {
    // Every request the upstream actually receives lands in `seen` — the
    // strip assertions run against the wire form, not a client-side guess.
    const leaf = originCa.forgeLeaf('origin.test');
    origin = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (req, res) => {
      seen.push(req.url ?? '');
      const body = `origin ${req.method} ${req.url} host=${req.headers.host}`;
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) });
      res.end(body);
    });
    originPort = await new Promise<number>((resolve, reject) => {
      origin.once('error', reject);
      origin.listen(0, '127.0.0.1', () => {
        resolve((origin.address() as net.AddressInfo).port);
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  });

  test('$removeparam strip lands upstream: GET /?utm=1&k=2 → origin sees /?k=2', async () => {
    const client = await connectThenTls(`localhost:${originPort}`, 'origin.test');
    try {
      const res = await withTimeout(
        httpRequestOver(client, { path: '/?utm=1&k=2', host: 'origin.test' }),
        10_000,
        'removeparam GET',
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe('origin GET /?k=2 host=origin.test');
      expect(seen).toContain('/?k=2');
    } finally {
      client.destroy();
    }
  });

  test('blocked request answers 403 + X-Blockingmachine-Rule before any upstream dial', async () => {
    const client = await connectThenTls(`localhost:${originPort}`, 'origin.test');
    try {
      const before = seen.length;
      const res = await withTimeout(
        httpRequestOver(client, { path: '/?a=1', host: 'blocked.test' }),
        10_000,
        'blocked GET',
      );
      expect(res.status).toBe(403);
      expect(res.head.toLowerCase()).toContain('x-blockingmachine-rule: ||blocked.test^');
      expect(res.head.toLowerCase()).toContain('content-length: 0');
      expect(res.body).toBe('');
      // The verdict fired pre-dial — the origin saw nothing of this request.
      expect(seen.length).toBe(before);
    } finally {
      client.destroy();
    }
  });

  test('@@…$removeparam exception cancels the strip: token param is preserved upstream', async () => {
    const client = await connectThenTls(`localhost:${originPort}`, 'origin.test');
    try {
      const res = await withTimeout(
        httpRequestOver(client, { path: '/?token=abc&k=2', host: 'x.test' }),
        10_000,
        'exception GET',
      );
      expect(res.status).toBe(200);
      // The generic *$removeparam=token applies everywhere — but the x.test
      // exception suppresses it, so the token param rides through verbatim.
      expect(res.body).toBe('origin GET /?token=abc&k=2 host=x.test');
      expect(seen).toContain('/?token=abc&k=2');
    } finally {
      client.destroy();
    }
  });

  test('the same generic strip still applies to a non-excepted host', async () => {
    const client = await connectThenTls(`localhost:${originPort}`, 'origin.test');
    try {
      const res = await withTimeout(
        httpRequestOver(client, { path: '/?token=abc&k=2', host: 'y.test' }),
        10_000,
        'non-excepted GET',
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe('origin GET /?k=2 host=y.test');
      expect(seen).toContain('/?k=2');
    } finally {
      client.destroy();
    }
  });
});
