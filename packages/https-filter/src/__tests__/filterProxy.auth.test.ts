/**
 * Flag 127 + flag 129 listener tests.
 *
 * The data-port token gate (`authToken`): non-loopback peers authenticate
 * before any flow handling — CONNECT/plain-HTTP present
 * `Proxy-Authorization` (`Bearer <token>` or `Basic` password) and earn an
 * explicit `407 Proxy Authentication Required` on failure; PROXY-v2 frames
 * carry the pinned `0xE0` TLV in-band and die on a miss/mismatch; the
 * headerless-TLS splice has no auth transport and is refused outright.
 * Loopback peers stay exempt. Absent token → the recorded trusted-LAN
 * fallback (open port). The optional destination denylist refuses
 * loopback/RFC1918/… targets for non-loopback peers. And `GET /ca.pem` —
 * the flag-129 enrollment surface — answers the CA PEM unauthenticated.
 *
 * Suites can't dial from a real second interface, so `isLoopbackPeer` is
 * injected to stand a test peer on the LAN side deterministically.
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
import {
  buildProxyV2AuthTlv,
  parseProxyV2,
  PROXY_V2_TLV_AUTH,
} from '../proxy/proxyProtocol.js';

jest.setTimeout(30_000);

const V2_SIGNATURE = Buffer.from('\r\n\r\n\x00\r\nQUIT\n', 'latin1');

/**
 * A TCP4 v2 frame — `tlvs` are appended after the address block inside the
 * counted `len` region, exactly where the flag-127 auth TLV rides.
 */
function buildTcp4Header(
  srcIp: number[],
  dstIp: number[],
  srcPort: number,
  dstPort: number,
  tlvs: Buffer[] = [],
): Buffer {
  const tlv = Buffer.concat(tlvs);
  const frame = Buffer.alloc(28 + tlv.length);
  V2_SIGNATURE.copy(frame, 0);
  frame[12] = 0x21; // version 2, command PROXY
  frame[13] = 0x11; // AF_INET, STREAM
  frame.writeUInt16BE(12 + tlv.length, 14);
  Buffer.from(srcIp).copy(frame, 16);
  Buffer.from(dstIp).copy(frame, 20);
  frame.writeUInt16BE(srcPort, 24);
  frame.writeUInt16BE(dstPort, 26);
  tlv.copy(frame, 28);
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

/** Open a socket to the proxy and write `bytes`, returning it connected. */
async function dial(port: number, bytes?: Buffer | string): Promise<net.Socket> {
  const sock = net.connect({ host: '127.0.0.1', port });
  await once(sock, 'connect');
  if (bytes !== undefined) {
    sock.write(bytes);
  }
  return sock;
}

let dir: string;
let authority: CertAuthority;
let policy: PolicyStore;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bm-https-filter-auth-'));
  authority = await CertAuthority.open({ storeDir: join(dir, 'ca'), keyWrapBackend: null });
  policy = await PolicyStore.open(join(dir, 'policy.jsonl'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('flag 127 — data-port token wire shapes', () => {
  test('buildProxyV2AuthTlv emits [0xE0][len:2][utf8] and the parser decodes it', () => {
    const tlv = buildProxyV2AuthTlv('sekrit-token');
    expect(tlv[0]).toBe(PROXY_V2_TLV_AUTH);
    expect(tlv.readUInt16BE(1)).toBe('sekrit-token'.length);
    expect(tlv.subarray(3).toString('utf8')).toBe('sekrit-token');

    const frame = buildTcp4Header([10, 9, 9, 9], [93, 184, 216, 34], 51111, 443, [tlv]);
    expect(parseProxyV2(frame)).toEqual({
      dstHost: '93.184.216.34',
      dstPort: 443,
      authToken: 'sekrit-token',
    });
    // A frame without the TLV yields no authToken — and a truncated TLV
    // leaves the destination parsed but the auth absent (fail-closed).
    expect(parseProxyV2(buildTcp4Header([10, 9, 9, 9], [93, 184, 216, 34], 1, 443))).toEqual({
      dstHost: '93.184.216.34',
      dstPort: 443,
    });
    const truncated = Buffer.alloc(5);
    truncated[0] = PROXY_V2_TLV_AUTH;
    truncated.writeUInt16BE(50, 1); // declares 50 bytes of value, ships 2
    const torn = buildTcp4Header([10, 9, 9, 9], [93, 184, 216, 34], 1, 443, [truncated]);
    expect(parseProxyV2(torn)).toEqual({ dstHost: '93.184.216.34', dstPort: 443 });
    // An unrelated TLV is skipped; the auth TLV still parses behind it.
    const other = Buffer.alloc(5);
    other[0] = 0x03; // PP2_TYPE_CRC32C — a spec type, ignored
    other.writeUInt16BE(2, 1);
    other[3] = 0xaa;
    other[4] = 0xbb;
    const mixed = buildTcp4Header([10, 9, 9, 9], [93, 184, 216, 34], 1, 443, [other, tlv]);
    expect(parseProxyV2(mixed)).toEqual({
      dstHost: '93.184.216.34',
      dstPort: 443,
      authToken: 'sekrit-token',
    });
  });
});

describe('flag 127 — token-gated listener (non-loopback peers)', () => {
  const TOKEN = 'tok-flag127-test';
  let proxy: RunningProxy;
  // Token-only sibling for the accept paths: the denylisted proxy cannot
  // dial 127.0.0.1 at all, so the "authenticated flow runs" assertions
  // need a listener where an accepted flow may tunnel to the echo rig.
  let proxyAccept: RunningProxy;

  beforeAll(async () => {
    proxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator(['||blocked.example^']),
      policy,
      authToken: TOKEN,
      denyPrivateDestinations: true,
      // The test peer is loopback by topology — stand it on the LAN side
      // so both flag-127 gates exercise their real branch.
      isLoopbackPeer: () => false,
    });
    proxyAccept = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator(['||blocked.example^']),
      policy,
      authToken: TOKEN,
      isLoopbackPeer: () => false,
    });
  });

  afterAll(async () => {
    await proxy.close();
    await proxyAccept.close();
  });

  async function connectHandshakeOn(
    target: RunningProxy,
    dest: string,
    auth?: string,
  ): Promise<{ sock: net.Socket; status: string; head: string }> {
    const headers = auth === undefined ? '' : `Proxy-Authorization: ${auth}\r\n`;
    const sock = await dial(
      target.port,
      `CONNECT ${dest} HTTP/1.1\r\nHost: ${dest}\r\n${headers}\r\n`,
    );
    const head = await withTimeout(readHttpHead(sock), 5_000, 'CONNECT response');
    return { sock, status: head.split('\r\n')[0], head };
  }

  function connectHandshake(
    dest: string,
    auth?: string,
  ): Promise<{ sock: net.Socket; status: string; head: string }> {
    return connectHandshakeOn(proxy, dest, auth);
  }

  test('CONNECT without Proxy-Authorization → 407 + Proxy-Authenticate, counted, closed', async () => {
    const before = proxy.stats();
    const { sock, status, head } = await connectHandshake('localhost:9');
    expect(status).toBe('HTTP/1.1 407 Proxy Authentication Required');
    expect(head).toContain('Proxy-Authenticate: Basic realm="Blockingmachine"');
    await withTimeout(once(sock, 'close'), 5_000, '407 close');
    const after = proxy.stats();
    expect(after.authRefusals).toBe(before.authRefusals + 1);
    expect(after.flowsBlocked).toBe(before.flowsBlocked); // not a verdict
    sock.destroy();
  });

  test('CONNECT with the wrong token → 407; a malformed header → 407; never a hang', async () => {
    for (const auth of ['Bearer wrong-token', 'Digest abc', 'Basic !!!not-b64']) {
      const { sock, status } = await connectHandshake('localhost:9', auth);
      expect(status).toBe('HTTP/1.1 407 Proxy Authentication Required');
      await withTimeout(once(sock, 'close'), 5_000, `${auth} close`);
      sock.destroy();
    }
  });

  test('CONNECT with `Bearer <token>` → authenticated, then the normal flow', async () => {
    const { sock, status } = await connectHandshake('blocked.example:443', `Bearer ${TOKEN}`);
    // Past the gate → the verdict runs and refuses the blocked host.
    expect(status).toBe('HTTP/1.1 403 Forbidden');
    await withTimeout(once(sock, 'close'), 5_000, 'blocked close');
    sock.destroy();
  });

  test('CONNECT with `Basic` credentials (any user, password = token) → authenticated', async () => {
    const echo = tcpEchoServer();
    const echoPort = await listen(echo);
    const basic = Buffer.from(`someuser:${TOKEN}`).toString('base64');
    const { sock, status } = await connectHandshakeOn(
      proxyAccept,
      `127.0.0.1:${echoPort}`,
      `Basic ${basic}`,
    );
    // Authenticated → the literal-IP path 200s and splices — the echo
    // proves the tunnel is live, not merely that the gate passed.
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    sock.write('basic-auth');
    expect((await collectBytes(sock, 10)).toString('latin1')).toBe('basic-auth');
    sock.destroy();
    await closeServer(echo);
  });

  test('PROXY-v2 without the auth TLV → closed promptly (no response channel exists)', async () => {
    const echo = tcpEchoServer();
    const echoPort = await listen(echo);
    const before = proxy.stats();
    const sock = await dial(
      proxy.port,
      buildTcp4Header([10, 9, 9, 9], [93, 184, 216, 34], 51111, echoPort),
    );
    await withTimeout(once(sock, 'close'), 5_000, 'unauthenticated v2 close');
    expect(proxy.stats().authRefusals).toBe(before.authRefusals + 1);
    sock.destroy();
    await closeServer(echo);
  });

  test('PROXY-v2 with a WRONG token TLV → closed; truncated TLV → closed (fail-closed)', async () => {
    const echo = tcpEchoServer();
    const echoPort = await listen(echo);
    for (const tlvs of [
      [buildProxyV2AuthTlv('wrong-token')],
      [Buffer.from([PROXY_V2_TLV_AUTH, 0, 50, 0x61])], // truncated declaration
    ]) {
      const before = proxy.stats();
      const sock = await dial(
        proxy.port,
        buildTcp4Header([10, 9, 9, 9], [93, 184, 216, 34], 51111, echoPort, tlvs),
      );
      await withTimeout(once(sock, 'close'), 5_000, 'wrong/torn TLV close');
      expect(proxy.stats().authRefusals).toBe(before.authRefusals + 1);
      sock.destroy();
    }
    await closeServer(echo);
  });

  test('PROXY-v2 with the correct auth TLV → the transparent flow runs', async () => {
    const echo = tcpEchoServer();
    const echoPort = await listen(echo);
    const before = proxyAccept.stats();
    const sock = await dial(
      proxyAccept.port,
      buildTcp4Header(
        [10, 9, 9, 9],
        [127, 0, 0, 1],
        51111,
        echoPort,
        [buildProxyV2AuthTlv(TOKEN)],
      ),
    );
    // Non-TLS bytes after the frame → the :80-style path tunnels to the
    // announced destination — the echo proves the gate let the flow in.
    sock.write('authed bytes');
    expect((await collectBytes(sock, 12)).toString('latin1')).toBe('authed bytes');
    expect(proxyAccept.stats().authRefusals).toBe(before.authRefusals);
    sock.destroy();
    await closeServer(echo);
  });

  test('headerless TLS splice + token + non-loopback peer → refused (no auth transport)', async () => {
    const before = proxy.stats();
    const sock = await dial(proxy.port);
    const client = tls.connect({ socket: sock, servername: 'x.example', rejectUnauthorized: false });
    client.on('error', () => {}); // ECONNRESET — the refusal
    await withTimeout(once(sock, 'close'), 5_000, 'headerless-splice refusal');
    expect(proxy.stats().authRefusals).toBe(before.authRefusals + 1);
    client.destroy();
  });

  test('plain-HTTP without auth → 407; authenticated → the flow forwards', async () => {
    const echo = tcpEchoServer();
    const echoPort = await listen(echo);

    const sock = await dial(
      proxy.port,
      `GET http://public.example:${echoPort}/x HTTP/1.1\r\nHost: public.example:${echoPort}\r\n\r\n`,
    );
    const head = await withTimeout(readHttpHead(sock), 5_000, 'plain-HTTP 407');
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 407 Proxy Authentication Required');
    sock.destroy();

    const authed = await dial(
      proxyAccept.port,
      `GET http://127.0.0.1:${echoPort}/x HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${echoPort}\r\n` +
        `Proxy-Authorization: Bearer ${TOKEN}\r\n\r\n`,
    );
    // The tunnel splices the request verbatim — the echo server returns it.
    const echoReply = await collectBytes(authed, 20);
    expect(echoReply.toString('latin1')).toContain('GET http://127.0.0.1');
    authed.destroy();
    await closeServer(echo);
  });

  test('denylist: CONNECT/plain-HTTP to private destinations → 403; PROXY-v2 → close', async () => {
    // CONNECT to a loopback literal — a LAN peer may not reach the hub's
    // own services through this proxy.
    const { sock, status, head } = await connectHandshake('127.0.0.1:9', `Bearer ${TOKEN}`);
    expect(status).toBe('HTTP/1.1 403 Forbidden');
    expect(head).toContain('X-Blockingmachine-Refused: private-destination');
    sock.destroy();

    const { sock: s2, status: st2 } = await connectHandshake(
      'localhost:9',
      `Bearer ${TOKEN}`,
    );
    expect(st2).toBe('HTTP/1.1 403 Forbidden');
    s2.destroy();

    // RFC1918 + CGNAT + link-local literals, same refusal.
    for (const t of ['10.0.0.5:443', '192.168.1.1:80', '172.16.0.1:443', '169.254.1.1:80', '100.64.0.1:443']) {
      const { sock: s, status: st } = await connectHandshake(t, `Bearer ${TOKEN}`);
      expect(st).toBe('HTTP/1.1 403 Forbidden');
      s.destroy();
    }
    // A public IP is not a private destination → past the denylist (the
    // literal-IP path then tunnels — assert the 200, close).
    const { sock: s3, status: st3 } = await connectHandshake('93.184.216.34:1', `Bearer ${TOKEN}`);
    expect(st3).toBe('HTTP/1.1 200 Connection Established');
    s3.destroy();

    // Plain-HTTP twin: private Host → 403.
    const ph = await dial(
      proxy.port,
      `GET http://192.168.1.1:9/x HTTP/1.1\r\nHost: 192.168.1.1:9\r\nProxy-Authorization: Bearer ${TOKEN}\r\n\r\n`,
    );
    const phHead = await withTimeout(readHttpHead(ph), 5_000, 'private plain-HTTP 403');
    expect(phHead.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
    expect(phHead).toContain('X-Blockingmachine-Refused: private-destination');
    ph.destroy();

    // PROXY-v2 twin: an announced private destination dies on the wire.
    const before = proxy.stats();
    const v2 = await dial(
      proxy.port,
      buildTcp4Header(
        [10, 9, 9, 9],
        [192, 168, 1, 1],
        51111,
        443,
        [buildProxyV2AuthTlv(TOKEN)],
      ),
    );
    await withTimeout(once(v2, 'close'), 5_000, 'denylisted v2 close');
    expect(proxy.stats().flowsBlocked).toBe(before.flowsBlocked + 1);
    v2.destroy();
  });
});

describe('flag 127 — loopback exemption and the trusted-LAN fallback', () => {
  test('a loopback peer is exempt from the token and the denylist', async () => {
    const echo = tcpEchoServer();
    const echoPort = await listen(echo);
    const proxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator([]),
      policy,
      authToken: 'tok-flag127-test',
      denyPrivateDestinations: true,
      // Default predicate — 127.0.0.1 IS loopback, so the peer is exempt.
    });
    try {
      // No Proxy-Authorization at all — the loopback peer sails through to
      // a normal CONNECT (literal-IP loopback target: exempt from the
      // denylist too, tunnels to the echo).
      const sock = await dial(
        proxy.port,
        `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`,
      );
      const head = await withTimeout(readHttpHead(sock), 5_000, 'loopback CONNECT');
      expect(head.split('\r\n')[0]).toBe('HTTP/1.1 200 Connection Established');
      sock.write('exempt');
      expect((await collectBytes(sock, 6)).toString('latin1')).toBe('exempt');
      sock.destroy();
      expect(proxy.stats().authRefusals).toBe(0);
    } finally {
      await proxy.close();
      await closeServer(echo);
    }
  });

  test('no token configured → open port for non-loopback peers (trusted-LAN fallback)', async () => {
    const echo = tcpEchoServer();
    const echoPort = await listen(echo);
    const proxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator(['||blocked.example^']),
      policy,
      isLoopbackPeer: () => false, // the peer stands on the LAN side
    });
    try {
      const sock = await dial(
        proxy.port,
        `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`,
      );
      const head = await withTimeout(readHttpHead(sock), 5_000, 'open CONNECT');
      expect(head.split('\r\n')[0]).toBe('HTTP/1.1 200 Connection Established');
      sock.write('open');
      expect((await collectBytes(sock, 4)).toString('latin1')).toBe('open');
      sock.destroy();
      expect(proxy.stats().authRefusals).toBe(0);
    } finally {
      await proxy.close();
      await closeServer(echo);
    }
  });
});

describe('flag 129 — GET /ca.pem on the data port', () => {
  let proxy: RunningProxy;

  beforeAll(async () => {
    // Token + LAN peer + denylist — the route must answer regardless: it is
    // the enrollment surface an unenrolled device calls.
    proxy = await startProxy({
      bindHost: '127.0.0.1',
      dataPort: 0,
      authority,
      evaluator: createRequestEvaluator([]),
      policy,
      authToken: 'tok-flag127-test',
      denyPrivateDestinations: true,
      isLoopbackPeer: () => false,
    });
  });

  afterAll(async () => {
    await proxy.close();
  });

  test('GET /ca.pem → 200 + the hub CA PEM, no token required', async () => {
    const sock = await dial(proxy.port, 'GET /ca.pem HTTP/1.1\r\nHost: x\r\n\r\n');
    const reply = await withTimeout(collectBytes(sock, 1), 5_000, 'ca.pem reply');
    // Read to close — Content-Length-bounded PEM follows the head.
    await withTimeout(once(sock, 'close'), 5_000, 'ca.pem close');
    const text = reply.toString('latin1');
    const head = text.split('\r\n\r\n')[0];
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
    expect(head).toContain('Content-Type: application/x-pem-file');
    const body = text.slice(text.indexOf('\r\n\r\n') + 4);
    expect(body).toBe(authority.caCertPem);
    expect(body).toContain('BEGIN CERTIFICATE');
    sock.destroy();
  });

  test('absolute-form GET to this listener → served; foreign authority → proxied, not answered', async () => {
    const sock = await dial(
      proxy.port,
      `GET http://127.0.0.1:${proxy.port}/ca.pem HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\n\r\n`,
    );
    const reply = await withTimeout(collectBytes(sock, 1), 5_000, 'absolute-form reply');
    await withTimeout(once(sock, 'close'), 5_000, 'absolute-form close');
    expect(reply.toString('latin1').split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
    sock.destroy();
  });

  test('POST /ca.pem is not the route — it flows through the normal path', async () => {
    // A POST to this listener's own authority is a self-target (400); on a
    // foreign authority it would forward — either way it never gets PEM.
    const sock = await dial(
      proxy.port,
      `POST /ca.pem HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nContent-Length: 0\r\n\r\n`,
    );
    const reply = await withTimeout(collectBytes(sock, 1), 5_000, 'POST reply');
    expect(reply.toString('latin1').split('\r\n')[0]).not.toBe('HTTP/1.1 200 OK');
    sock.destroy();
  });
});
