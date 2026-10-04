import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'http';
import https from 'https';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import type { Server } from 'https';
import { formatSinkholeError } from '../sinkholeNet';
import { sinkholeFetch } from '../sinkholeFetch';

describe('local untrusted TLS for sinkhole requests', () => {
  let server: Server;
  let port = 0;
  const dir = mkdtempSync(join(tmpdir(), 'bm-tls-'));
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');

  beforeAll(async () => {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '1',
      '-nodes',
      '-subj', '/CN=homeassistant.local',
      '-addext', 'subjectAltName=DNS:homeassistant.local',
    ], { stdio: 'ignore' });

    const { readFileSync } = await import('fs');
    await new Promise<void>((resolve) => {
      server = https.createServer(
        { cert: readFileSync(certPath), key: readFileSync(keyPath) },
        (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        },
      );
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  test('rejects a self-signed local certificate until the toggle is enabled', async () => {
    const url = `https://127.0.0.1:${port}/api/`;
    await expect(sinkholeFetch(url, { allowInsecureLocalTls: false, timeoutMs: 4000 })).rejects.toBeTruthy();
    try {
      await sinkholeFetch(url, { allowInsecureLocalTls: false, timeoutMs: 4000 });
    } catch (err) {
      const message = formatSinkholeError(err, {
        display: url.replace(/\/api\/$/, ''),
        host: '127.0.0.1',
        port,
        scheme: 'https',
      }, { allowInsecureLocalTls: false });
      expect(message).toContain('TLS certificate rejected');
      expect(message).toContain('Allow untrusted TLS certificates (local only)');
      expect(message).not.toMatch(/fetch failed/i);
    }
  });

  test('accepts a self-signed certificate for a private host when the toggle is on', async () => {
    const url = `https://127.0.0.1:${port}/api/`;
    const res = await sinkholeFetch(url, { allowInsecureLocalTls: true, timeoutMs: 4000 });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});

describe('redirect credential handling', () => {
  // Two loopback ports are different origins to the fetch spec, which is exactly the
  // boundary a redirect must not carry a sinkhole token across.
  let redirector: http.Server;
  let collector: http.Server;
  let redirectorPort = 0;
  let collectorPort = 0;
  const seenAuthorizations: Array<string | undefined> = [];

  function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  }

  beforeAll(async () => {
    collector = http.createServer((req, res) => {
      seenAuthorizations.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    collectorPort = await listen(collector);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => redirector.close(() => resolve()));
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  });

  async function startRedirector(target: string): Promise<void> {
    redirector = http.createServer((_req, res) => {
      res.writeHead(302, { location: target });
      res.end();
    });
    redirectorPort = await listen(redirector);
  }

  test('drops Authorization across a cross-origin redirect', async () => {
    await startRedirector(`http://127.0.0.1:${collectorPort}/target`);
    const res = await sinkholeFetch(`http://127.0.0.1:${redirectorPort}/hop`, {
      allowInsecureLocalTls: true,
      headers: { authorization: 'Bearer sinkhole-token', 'content-type': 'application/json' },
      timeoutMs: 4000,
    });
    expect(res.ok).toBe(true);
    expect(seenAuthorizations).toEqual([undefined]);
  });

  test('keeps Authorization on a same-origin redirect', async () => {
    seenAuthorizations.length = 0;
    // One server: the first request redirects, the second records its own Authorization.
    const self = http.createServer((req, res) => {
      if (req.url === '/hop') {
        res.writeHead(302, { location: '/target' });
        res.end();
        return;
      }
      seenAuthorizations.push(req.headers.authorization);
      res.writeHead(200).end('ok');
    });
    const selfPort = await listen(self);
    try {
      const res = await sinkholeFetch(`http://127.0.0.1:${selfPort}/hop`, {
        allowInsecureLocalTls: true,
        headers: { authorization: 'Bearer sinkhole-token' },
        timeoutMs: 4000,
      });
      expect(res.ok).toBe(true);
      expect(seenAuthorizations).toEqual(['Bearer sinkhole-token']);
    } finally {
      await new Promise<void>((resolve) => self.close(() => resolve()));
    }
  });
});
