/**
 * Entrypoint test — `startFilterProxy` wiring (plan Task 7).
 *
 * Boots the whole engine the way `daemonManager` will (P1: spawned under
 * `ELECTRON_RUN_AS_NODE` as `filterProxy.cjs`): a temp `storeDir` for the CA
 * and policy ledger, a `rulesPath` for the compiled ruleset, ephemeral ports.
 * Asserts the control port answers real HTTP, the data port takes a real
 * CONNECT flow, and `close()` tears both listeners down.
 */

import { describe, expect, jest, test } from '@jest/globals';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFilterProxy } from '../index.js';

jest.setTimeout(30_000);

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Read until the HTTP header terminator or the socket closes. */
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

describe('startFilterProxy entrypoint', () => {
  test('boots the full stack: control answers 200, the data port takes CONNECT, close() reaps both', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bm-https-filter-entry-'));
    const echo = net.createServer((socket) => socket.on('data', (c) => socket.write(c)));
    const echoPort = await listen(echo);
    let app: Awaited<ReturnType<typeof startFilterProxy>> | null = null;
    try {
      const rulesPath = join(dir, 'rules.txt');
      await writeFile(rulesPath, '||entry-blocked.example^\n');
      app = await startFilterProxy({
        storeDir: join(dir, 'store'),
        rulesPath,
        dataPort: 0,
        controlPort: 0,
      });

      // CA + policy stores materialized under the store dir.
      expect(app.authority.caCertPem).toContain('BEGIN CERTIFICATE');
      await stat(join(dir, 'store', 'ca', 'ca.pem'));

      // Control port answers a real HTTP read.
      const res = await fetch(`http://127.0.0.1:${app.controlPort}/v1/proxy/status`);
      expect(res.status).toBe(200);
      const status = (await res.json()) as Record<string, any>;
      expect(status.status).toBe('running');
      expect(status.dataPort).toBe(app.proxy.port);
      expect(status.rulesLoaded).toBe(1);

      // Data port: the loaded ruleset blocks a matching CONNECT outright.
      const blocked = net.connect({ host: '127.0.0.1', port: app.proxy.port });
      await once(blocked, 'connect');
      blocked.write('CONNECT entry-blocked.example:443 HTTP/1.1\r\n\r\n');
      const blockedHead = await withTimeout(readHttpHead(blocked), 5_000, 'blocked CONNECT');
      expect(blockedHead.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
      blocked.destroy();

      // Data port: an allowed CONNECT to a literal IP blind-tunnels bytes.
      const sock = net.connect({ host: '127.0.0.1', port: app.proxy.port });
      await once(sock, 'connect');
      sock.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\n`);
      const head = await withTimeout(readHttpHead(sock), 5_000, 'echo CONNECT');
      expect(head.split('\r\n')[0]).toBe('HTTP/1.1 200 Connection Established');
      sock.write('flow-through');
      expect((await withTimeout(collectBytes(sock, 12), 5_000, 'echo bytes')).toString()).toBe(
        'flow-through',
      );
      sock.destroy();
    } finally {
      await app?.close();
      echo.close();
      await rm(dir, { recursive: true, force: true });
    }

    // close() reaped both listeners — fresh connects are refused.
    await expect(
      once(net.connect({ host: '127.0.0.1', port: app!.controlPort }), 'error'),
    ).resolves.toBeDefined();
    await expect(
      once(net.connect({ host: '127.0.0.1', port: app!.proxy.port }), 'error'),
    ).resolves.toBeDefined();
  });
});
