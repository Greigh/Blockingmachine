/**
 * Proxy listener tests (design spec §5.2, plan Task 4).
 *
 * Exercises all three first-bytes dispatch paths on the data port — PROXY-v2
 * transparent flows, explicit CONNECT, and helper-spliced first-bytes-TLS —
 * plus the two helpers they stand on: the v2 binary parser and the bounded
 * ClientHello peek. Blind-tunnel paths are proven by "handshake completes and
 * bytes echo through" (including that `head` replay carries the peeked
 * ClientHello upstream intact); allowed flows with a valid SNI now terminate
 * (Task 5), proven by the forged cert the client sees.
 */

import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { createRequestEvaluator } from '@blockingmachine/core';
import { CertAuthority } from '../ca/certAuthority.js';
import { PolicyStore } from '../policy/policyStore.js';
import { startProxy, type RunningProxy } from '../proxy/filterProxy.js';
import { parseProxyV2 } from '../proxy/proxyProtocol.js';
import { peekClientHello, type ClientHelloPeek } from '../proxy/sniPeek.js';

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

function tlsEchoServer(keyPem: string, certPem: string): net.Server {
  return tls.createServer({ key: keyPem, cert: certPem }, (socket) => {
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
function collectBytes(sock: net.Socket | tls.TLSSocket, n: number): Promise<Buffer> {
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

let dir: string;
let authority: CertAuthority;
let policy: PolicyStore;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bm-https-filter-proxy-'));
  authority = await CertAuthority.open({ storeDir: join(dir, 'ca') });
  policy = await PolicyStore.open(join(dir, 'policy.jsonl'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseProxyV2', () => {
  test('round-trips a hand-built TCP4 v2 header (93.184.216.34:443)', () => {
    const frame = buildTcp4Header([10, 0, 0, 9], [93, 184, 216, 34], 40440, 443);
    expect(parseProxyV2(frame)).toEqual({ dstHost: '93.184.216.34', dstPort: 443 });
  });

  test('round-trips a TCP6 v2 header', () => {
    const frame = Buffer.alloc(52);
    V2_SIGNATURE.copy(frame, 0);
    frame[12] = 0x21;
    frame[13] = 0x21; // AF_INET6, STREAM
    frame.writeUInt16BE(36, 14);
    frame.writeUInt16BE(1, 16 + 16 + 14); // dst ::1 — last group of the dst addr
    frame.writeUInt16BE(8443, 16 + 36 - 2); // dst port is the final u16
    expect(parseProxyV2(frame)).toEqual({ dstHost: '0:0:0:0:0:0:0:1', dstPort: 8443 });
  });

  test('rejects garbage, wrong version, LOCAL command, wrong family, truncation', () => {
    expect(parseProxyV2(Buffer.from('GET / HTTP/1.1\r\n\r\n'))).toBeNull();
    expect(parseProxyV2(Buffer.alloc(0))).toBeNull();

    const badVersion = buildTcp4Header([10, 0, 0, 9], [93, 184, 216, 34], 1, 443);
    badVersion[12] = 0x11; // version 1 — binary header is v2-only
    expect(parseProxyV2(badVersion)).toBeNull();

    const localCmd = buildTcp4Header([10, 0, 0, 9], [93, 184, 216, 34], 1, 443);
    localCmd[12] = 0x20; // LOCAL — address block is to be ignored, no dst to route
    expect(parseProxyV2(localCmd)).toBeNull();

    const unixFam = buildTcp4Header([10, 0, 0, 9], [93, 184, 216, 34], 1, 443);
    unixFam[13] = 0x31; // AF_UNIX — not a TCP flow
    expect(parseProxyV2(unixFam)).toBeNull();

    const truncated = buildTcp4Header([10, 0, 0, 9], [93, 184, 216, 34], 1, 443).subarray(0, 20);
    expect(parseProxyV2(truncated)).toBeNull();
  });
});

describe('peekClientHello', () => {
  test('returns the ClientHello SNI and a head that replays into a completing handshake', async () => {
    const leaf = authority.forgeLeaf('peek.example');
    const upstream = tlsEchoServer(leaf.keyPem, leaf.certPem);
    const upstreamPort = await listen(upstream);

    let peeked: ClientHelloPeek | null = null;
    const splice = net.createServer((sock) => {
      void (async () => {
        peeked = await peekClientHello(sock, 5_000);
        // Replay the consumed head into the real TLS server, then splice —
        // the same motion the proxy's blind tunnel performs.
        const up = net.connect({ host: '127.0.0.1', port: upstreamPort });
        up.once('connect', () => {
          up.write(peeked!.head);
          sock.pipe(up);
          up.pipe(sock);
        });
        const kill = () => {
          sock.destroy();
          up.destroy();
        };
        sock.once('error', kill);
        up.once('error', kill);
      })();
    });
    const port = await listen(splice);

    const client = tls.connect({
      port,
      host: '127.0.0.1',
      servername: 'peek.example',
      rejectUnauthorized: false,
    });
    await once(client, 'secureConnect');

    expect(peeked).not.toBeNull();
    expect(peeked!.isTls).toBe(true);
    expect(peeked!.sni).toBe('peek.example');
    expect(peeked!.head.length).toBeGreaterThan(5);
    expect(peeked!.head[0]).toBe(0x16);

    // The replayed head carried a complete ClientHello — echo flows both ways.
    client.write('ping');
    expect((await collectBytes(client, 4)).toString('latin1')).toBe('ping');

    client.destroy();
    await closeServer(splice);
    await closeServer(upstream);
  });

  test('non-TLS first bytes come back isTls:false with the head preserved', async () => {
    let result: ClientHelloPeek | null = null;
    let settled!: () => void;
    const saw = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const listener = net.createServer((sock) => {
      void peekClientHello(sock, 5_000).then((peeked) => {
        result = peeked;
        settled();
      });
    });
    const port = await listen(listener);

    const client = net.connect({ port, host: '127.0.0.1' }, () => {
      client.write('GET / HTTP/1.1\r\n\r\n');
    });
    await saw;
    expect(result).not.toBeNull();
    expect(result!.isTls).toBe(false);
    expect(result!.sni).toBeNull();
    expect(result!.head.toString('latin1')).toBe('GET / HTTP/1.1\r\n\r\n');

    client.destroy();
    await closeServer(listener);
  });
});

describe('startProxy listeners', () => {
  let proxy: RunningProxy;

  beforeAll(async () => {
    proxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator(['||blocked.example^', '||blocked.com^']),
      policy,
    });
  });

  afterAll(async () => {
    await proxy.close();
  });

  async function connectHandshake(
    target: string,
  ): Promise<{ sock: net.Socket; status: string; head: string }> {
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(sock, 'connect');
    sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    const head = await withTimeout(readHttpHead(sock), 5_000, 'CONNECT response');
    return { sock, status: head.split('\r\n')[0], head };
  }

  test('CONNECT to a blocked host → 403 + X-Blockingmachine-Rule, then close', async () => {
    const before = proxy.stats();
    const { sock, status, head } = await connectHandshake('blocked.example:443');
    expect(status).toBe('HTTP/1.1 403 Forbidden');
    expect(head).toContain('X-Blockingmachine-Rule: ||blocked.example^');
    expect(head).toContain('Content-Length: 0');
    await withTimeout(once(sock, 'close'), 5_000, 'socket close');
    const after = proxy.stats();
    expect(after.flowsBlocked).toBe(before.flowsBlocked + 1);
    expect(after.flowsTotal).toBe(before.flowsTotal + 1);
  });

  test('CONNECT to an allowed host → 200, then the forged-leaf endpoint terminates TLS', async () => {
    const upstream = tcpEchoServer();
    const upstreamPort = await listen(upstream);

    const before = proxy.stats();
    const { sock, status } = await connectHandshake(`localhost:${upstreamPort}`);
    expect(status).toBe('HTTP/1.1 200 Connection Established');

    const client = tls.connect({
      socket: sock,
      servername: 'good.example',
      rejectUnauthorized: false,
    });
    await withTimeout(once(client, 'secureConnect'), 10_000, 'terminated handshake');
    // The handshake ran against a leaf forged for the announced SNI — proof
    // the flow terminated here instead of blind-tunneling to the echo server.
    expect(client.getPeerCertificate().subject.CN).toBe('good.example');
    expect(proxy.stats().flowsTerminated).toBe(before.flowsTerminated + 1);
    expect(proxy.stats().flowsTunneled).toBe(before.flowsTunneled);

    client.destroy();
    await closeServer(upstream);
  });

  test('CONNECT to a literal IP blind-tunnels — no evaluation, no peek, plain bytes echo', async () => {
    const echo = tcpEchoServer();
    const echoPort = await listen(echo);

    const { sock, status } = await connectHandshake(`127.0.0.1:${echoPort}`);
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    sock.write('raw tcp, never a ClientHello');
    expect((await collectBytes(sock, 23)).toString('latin1')).toBe('raw tcp, never a ClientHello');

    sock.destroy();
    await closeServer(echo);
  });

  test('CONNECT then non-TLS bytes → clean close inside the peek bound, counted', async () => {
    const before = proxy.stats();
    const { sock, status } = await connectHandshake('localhost:9');
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    sock.write('this is not a ClientHello');
    await withTimeout(once(sock, 'close'), 10_000, 'garbage close');
    expect(proxy.stats().flowsTotal).toBe(before.flowsTotal + 1);
    sock.destroy();
  });

  test('a bypassed host tunnels — no verdict needed, no peek, plain bytes echo', async () => {
    policy.addBypass('x.localhost');
    const echo = tcpEchoServer();
    const echoPort = await listen(echo);

    const { sock, status } = await connectHandshake(`x.localhost:${echoPort}`);
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    // Non-TLS bytes survive: the bypass path never waits on a ClientHello.
    sock.write('plain bytes on a bypassed flow');
    expect((await collectBytes(sock, 29)).toString('latin1')).toBe(
      'plain bytes on a bypassed flow',
    );

    sock.destroy();
    await closeServer(echo);
  });

  test('PROXY-v2 frame → transparent flow: allowed SNI terminates on the forged leaf', async () => {
    const upstream = tcpEchoServer();
    const upstreamPort = await listen(upstream);

    const before = proxy.stats();
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(sock, 'connect');
    sock.write(buildTcp4Header([10, 9, 9, 9], [127, 0, 0, 1], 51111, upstreamPort));
    const client = tls.connect({
      socket: sock,
      servername: 'v2.example',
      rejectUnauthorized: false,
    });
    await withTimeout(once(client, 'secureConnect'), 10_000, 'v2 terminated handshake');
    expect(client.getPeerCertificate().subject.CN).toBe('v2.example');
    expect(proxy.stats().flowsTerminated).toBe(before.flowsTerminated + 1);

    client.destroy();
    await closeServer(upstream);
  });

  test('PROXY-v2 frame to a blocked SNI → silent close (no response exists on raw TLS)', async () => {
    const upstream = tcpEchoServer();
    const upstreamPort = await listen(upstream);

    const before = proxy.stats();
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(sock, 'connect');
    sock.write(buildTcp4Header([10, 9, 9, 9], [127, 0, 0, 1], 51111, upstreamPort));
    const client = tls.connect({
      socket: sock,
      servername: 'blocked.example',
      rejectUnauthorized: false,
    });
    client.on('error', () => {}); // ECONNRESET expected — the proxy just drops
    await withTimeout(once(sock, 'close'), 10_000, 'blocked transparent close');
    expect(proxy.stats().flowsBlocked).toBe(before.flowsBlocked + 1);

    client.destroy();
    await closeServer(upstream);
  });

  test('PROXY-v2 with a trailing-dot blocked SNI (blocked.com.) → dropped, never tunneled', async () => {
    let upstreamSawConnection = false;
    const upstream = net.createServer((socket) => {
      upstreamSawConnection = true;
      socket.on('data', (chunk) => socket.write(chunk));
    });
    const upstreamPort = await listen(upstream);

    const before = proxy.stats();
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(sock, 'connect');
    sock.write(buildTcp4Header([10, 9, 9, 9], [127, 0, 0, 1], 51111, upstreamPort));
    const client = tls.connect({
      socket: sock,
      servername: 'blocked.com.', // FQDN form — invalid SNI, but the verdict must still run
      rejectUnauthorized: false,
    });
    client.on('error', () => {}); // ECONNRESET expected — the proxy drops the flow
    await withTimeout(once(sock, 'close'), 10_000, 'trailing-dot blocked close');
    expect(proxy.stats().flowsBlocked).toBe(before.flowsBlocked + 1);
    // Give a would-be tunnel a beat to exist — it must not: the verdict ran on
    // the normalized name and dropped the flow before any upstream dial.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(upstreamSawConnection).toBe(false);

    client.destroy();
    await closeServer(upstream);
  });

  test('helper-spliced TLS without a PROXY header → valid SNI terminates (upstream is sni:443)', async () => {
    const before = proxy.stats();
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(sock, 'connect');
    const client = tls.connect({
      socket: sock,
      servername: 'spliced.example',
      rejectUnauthorized: false,
    });
    await withTimeout(once(client, 'secureConnect'), 10_000, 'spliced terminated handshake');
    expect(client.getPeerCertificate().subject.CN).toBe('spliced.example');
    expect(proxy.stats().flowsTerminated).toBe(before.flowsTerminated + 1);
    expect(proxy.stats().flowsTotal).toBe(before.flowsTotal + 1);
    client.destroy();
    await withTimeout(once(sock, 'close'), 10_000, 'spliced close');
  });

  test('garbage first bytes → immediate close, counted', async () => {
    const before = proxy.stats();
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(sock, 'connect');
    sock.write('HELLO this is no protocol');
    await withTimeout(once(sock, 'close'), 5_000, 'garbage dispatch close');
    expect(proxy.stats().flowsTotal).toBe(before.flowsTotal + 1);
  });
});
