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

/**
 * A minimal well-formed ClientHello for `servername`, split across two TLS
 * records so the SNI extension lives in the second — the shape that used to
 * parse `sni: null`. Byte layout per RFC 5246: record(hdr5+payload) wrapping
 * handshake(type1+len3+body) = version(2) + random(32) + session_id(len1) +
 * cipher_suites(len2) + compression(len1) + extensions(len2, [type2+len2+data]).
 */
function buildFragmentedClientHello(servername: string): Buffer {
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n);
    return b;
  };
  const u24 = (n: number) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const record = (payload: Buffer) =>
    Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(payload.length), payload]);

  const name = Buffer.from(servername, 'ascii');
  const serverNameList = Buffer.concat([u16(1 + 2 + name.length), Buffer.from([0]), u16(name.length), name]);
  const sniExt = Buffer.concat([u16(0), u16(serverNameList.length), serverNameList]);
  const ciphers = u16(2);
  const cipherList = Buffer.from([0x13, 0x01]); // TLS_AES_128_GCM_SHA256
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // client_version TLS 1.2
    Buffer.alloc(32), // random — content irrelevant to the parser
    Buffer.from([0]), // session_id length 0
    ciphers,
    cipherList,
    Buffer.from([1, 0]), // compression_methods: [null]
    u16(sniExt.length),
    sniExt,
  ]);
  const handshake = Buffer.concat([Buffer.from([0x01]), u24(body.length), body]);
  // Split inside the extension block so record 1 alone cannot yield the SNI.
  const cut = 4 + body.length - (sniExt.length - 2);
  return Buffer.concat([record(handshake.subarray(0, cut)), record(handshake.subarray(cut))]);
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
  authority = await CertAuthority.open({ storeDir: join(dir, 'ca'), keyWrapBackend: null });
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

  test('a ClientHello fragmented across two records still yields its SNI', async () => {
    const hello = buildFragmentedClientHello('frag.example');
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

    const client = net.connect({ port, host: '127.0.0.1' });
    await once(client, 'connect');
    // Deliver the two records in two writes — a peek that only ever read
    // record 1 would see a truncated extension block and come back sni:null.
    client.write(hello.subarray(0, Math.floor(hello.length / 2)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.write(hello.subarray(Math.floor(hello.length / 2)));
    await withTimeout(saw, 6_000, 'fragmented peek');

    expect(result).not.toBeNull();
    expect(result!.isTls).toBe(true);
    expect(result!.sni).toBe('frag.example');
    expect(result!.head).toEqual(hello);

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

  test('CONNECT aimed at the data port itself → 400, never a self-dial', async () => {
    // Literal-IP CONNECTs normally blind-tunnel — but a target that IS this
    // listener would splice the client's next bytes back into dispatch and
    // chain flows until fds run out. The refusal must outrank even the
    // no-verdict literal-IP path.
    for (const target of [`127.0.0.1:${proxy.port}`, `localhost:${proxy.port}`]) {
      const before = proxy.stats();
      const { sock, status } = await connectHandshake(target);
      expect(status).toBe('HTTP/1.1 400 Bad Request');
      await withTimeout(once(sock, 'close'), 5_000, 'self-target close');
      // Exactly one counted flow — no inner connection was accepted.
      expect(proxy.stats().flowsTotal).toBe(before.flowsTotal + 1);
      expect(proxy.stats().flowsTunneled).toBe(before.flowsTunneled);
      sock.destroy();
    }
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

  describe('PROXY-v2 non-TLS flows (flag 93)', () => {
  /** A fresh TCP connection to the shared data listener. */
  async function openSock(): Promise<net.Socket> {
    const sock = net.connect({ host: '127.0.0.1', port: proxy.port });
    await once(sock, 'connect');
    return sock;
  }

  test('v2-framed GET http://blocked.example/ → 403 + covering rule, upstream never dialed', async () => {
    let upstreamSaw = false;
    const upstream = net.createServer((socket) => {
      upstreamSaw = true;
      socket.on('data', (chunk) => socket.write(chunk));
    });
    const upstreamPort = await listen(upstream);
    try {
      const before = proxy.stats();
      const sock = await openSock();
      sock.write(
        Buffer.concat([
          buildTcp4Header([10, 9, 9, 9], [127, 0, 0, 1], 51121, upstreamPort),
          Buffer.from(
            'GET http://blocked.example/x HTTP/1.1\r\nHost: blocked.example\r\n\r\n',
            'latin1',
          ),
        ]),
      );
      const head = await withTimeout(readHttpHead(sock), 5_000, 'v2 blocked response');
      expect(head).toContain('HTTP/1.1 403 Forbidden');
      expect(head).toContain('X-Blockingmachine-Rule: ||blocked.example^');
      await withTimeout(once(sock, 'close'), 5_000, 'blocked flow close');
      // Give a would-be dial a beat — the flow must have died at the verdict.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(upstreamSaw).toBe(false);
      expect(proxy.stats().flowsBlocked).toBe(before.flowsBlocked + 1);
      sock.destroy();
    } finally {
      await closeServer(upstream);
    }
  });

  test('v2-framed non-HTTP bytes still blind-tunnel to the announced destination', async () => {
    const upstream = tcpEchoServer();
    const upstreamPort = await listen(upstream);
    try {
      const sock = await openSock();
      sock.write(
        Buffer.concat([
          buildTcp4Header([10, 9, 9, 9], [127, 0, 0, 1], 51122, upstreamPort),
          Buffer.from('this is not an HTTP request', 'latin1'),
        ]),
      );
      expect((await collectBytes(sock, 27)).toString('latin1')).toBe(
        'this is not an HTTP request',
      );
      sock.destroy();
    } finally {
      await closeServer(upstream);
    }
  });

  test('v2-framed allowed GET tunnels to the v2-announced destination — the dial is the header, not the URL', async () => {
    // 'v2allowed.example' does not resolve here; the flow only answers if the
    // splice dialed the frame's dstHost:dstPort — proof the parsed authority
    // fed the verdict and the header fed the dial.
    const upstream = tcpEchoServer();
    const upstreamPort = await listen(upstream);
    try {
      const before = proxy.stats();
      const sock = await openSock();
      const request =
        'GET http://v2allowed.example/x?q=1 HTTP/1.1\r\nHost: v2allowed.example\r\n\r\n';
      sock.write(
        Buffer.concat([
          buildTcp4Header([10, 9, 9, 9], [127, 0, 0, 1], 51123, upstreamPort),
          Buffer.from(request, 'latin1'),
        ]),
      );
      const echoed = await collectBytes(sock, request.length);
      expect(echoed.toString('latin1')).toBe(request);
      expect(proxy.stats().flowsTunneled).toBe(before.flowsTunneled + 1);
      sock.destroy();
    } finally {
      await closeServer(upstream);
    }
  });

  test('v2-framed allowed request-target + blocked Host header → both authorities evaluated, 403', async () => {
    const upstream = tcpEchoServer();
    const upstreamPort = await listen(upstream);
    try {
      const sock = await openSock();
      sock.write(
        Buffer.concat([
          buildTcp4Header([10, 9, 9, 9], [127, 0, 0, 1], 51124, upstreamPort),
          Buffer.from(
            'GET http://v2allowed.example/x HTTP/1.1\r\nHost: blocked.example\r\n\r\n',
            'latin1',
          ),
        ]),
      );
      const head = await withTimeout(readHttpHead(sock), 5_000, 'v2 host-blocked response');
      expect(head).toContain('HTTP/1.1 403 Forbidden');
      sock.destroy();
    } finally {
      await closeServer(upstream);
    }
  });

  test('v2-framed authorities that disagree but individually allow → 400, never forwarded', async () => {
    const upstream = tcpEchoServer();
    const upstreamPort = await listen(upstream);
    try {
      const sock = await openSock();
      sock.write(
        Buffer.concat([
          buildTcp4Header([10, 9, 9, 9], [127, 0, 0, 1], 51125, upstreamPort),
          Buffer.from(
            'GET http://allowed-one.example/x HTTP/1.1\r\nHost: allowed-two.example\r\n\r\n',
            'latin1',
          ),
        ]),
      );
      const head = await withTimeout(readHttpHead(sock), 5_000, 'v2 mismatch response');
      expect(head).toContain('HTTP/1.1 400 Bad Request');
      sock.destroy();
    } finally {
      await closeServer(upstream);
    }
  });

  test('a paused proxy tunnels a v2-framed blocked request — verdicts off, connectivity on', async () => {
    const upstream = tcpEchoServer();
    const upstreamPort = await listen(upstream);
    proxy.setPaused(true);
    try {
      const request =
        'GET http://blocked.example/x HTTP/1.1\r\nHost: blocked.example\r\n\r\n';
      const sock = await openSock();
      sock.write(
        Buffer.concat([
          buildTcp4Header([10, 9, 9, 9], [127, 0, 0, 1], 51126, upstreamPort),
          Buffer.from(request, 'latin1'),
        ]),
      );
      const echoed = await collectBytes(sock, request.length);
      expect(echoed.toString('latin1')).toBe(request);
      sock.destroy();
    } finally {
      proxy.setPaused(false);
      await closeServer(upstream);
    }
  });

  test('a bypassed host tunnels on a v2 non-TLS flow — no verdict runs', async () => {
    policy.addBypass('v2bypass.example');
    const upstream = tcpEchoServer();
    const upstreamPort = await listen(upstream);
    try {
      const request =
        'GET http://v2bypass.example/x HTTP/1.1\r\nHost: v2bypass.example\r\n\r\n';
      const sock = await openSock();
      sock.write(
        Buffer.concat([
          buildTcp4Header([10, 9, 9, 9], [127, 0, 0, 1], 51127, upstreamPort),
          Buffer.from(request, 'latin1'),
        ]),
      );
      const echoed = await collectBytes(sock, request.length);
      expect(echoed.toString('latin1')).toBe(request);
      sock.destroy();
    } finally {
      await closeServer(upstream);
    }
  });
  });
});
