import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
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
