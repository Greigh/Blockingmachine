/**
 * The add-on's filtering DNS resolver — the desktop's system daemon embedded
 * as dns-daemon.mjs. This is what makes "point the router's DHCP DNS at the
 * Home Assistant box" work end-to-end: a blocked name must sinkhole, an
 * allowed name must forward over the configured DoH upstream (stubbed here),
 * TCP must answer what UDP answers, a compile must hot-reload the trie, and
 * the add-on's protection toggle must reach the resolver — a DNS daemon that
 * keeps blocking while the dashboard says "paused" would be a lie.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { connect as netConnect } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const TOKEN = 'test-feed-token-9e2d41';

/** Minimal DNS wire query — header + qname labels + qtype/qclass. */
function dnsQuery(id, name, type = 1) {
  const labels = name.split('.').map((l) => {
    const b = Buffer.from(l, 'ascii');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD
  header.writeUInt16BE(1, 4); // QDCOUNT
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, ...labels, Buffer.alloc(1), tail]);
}

/** What this suite asserts on: response id, rcode, and the first A answer's IP. */
function parseAnswer(msg) {
  return {
    id: msg.readUInt16BE(0),
    rcode: msg.readUInt16BE(2) & 0x000f,
    ancount: msg.readUInt16BE(6),
    // A sinkhole/forwarded answer ends with the 4 IPv4 octets — both the
    // daemon's A-record reply and the stub upstream's land there.
    lastIpv4: msg.length >= 4 ? [...msg.subarray(msg.length - 4)].join('.') : null,
  };
}

function udpQuery(port, packet) {
  return new Promise((resolve, reject) => {
    const sock = createSocket('udp4');
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('UDP query timed out'));
    }, 5000);
    sock.once('message', (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg);
    });
    sock.send(packet, port, '127.0.0.1');
  });
}

function tcpQuery(port, packet) {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, '127.0.0.1');
    const head = Buffer.alloc(2);
    head.writeUInt16BE(packet.length);
    const chunks = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('TCP query timed out'));
    }, 5000);
    sock.on('data', (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        clearTimeout(timer);
        sock.destroy();
        resolve(buf.subarray(2, 2 + buf.readUInt16BE(0)));
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.write(Buffer.concat([head, packet]));
  });
}

function httpJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method || 'GET', headers: opts.headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** A stub DoH upstream — RFC 8484 POST application/dns-message → canned answer. */
async function startStubUpstream(t) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const q = Buffer.concat(chunks);
      // Echo the query with response flags + an A answer to 93.184.216.34 —
      // the pointer-compression name (0xC00C) refers back to the question.
      const resp = Buffer.concat([
        q.subarray(0, 2),
        Buffer.from([0x81, 0x80]),
        q.subarray(4, 6),
        Buffer.from([0, 1, 0, 0, 0, 0]),
        q.subarray(12),
        Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34]),
      ]);
      res.writeHead(200, { 'Content-Type': 'application/dns-message' });
      res.end(resp);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return server.address().port;
}

async function startServer(t, stubPort) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bm-dns-'));
  await writeFile(join(dataDir, 'dns.txt'), '||doubleclick.net^\n', 'utf8');
  await writeFile(join(dataDir, 'browser.txt'), '', 'utf8');

  const feedPort = 49300 + Math.floor(Math.random() * 400);
  const dnsPort = 49800 + Math.floor(Math.random() * 400);
  const dnsControlPort = 48300 + Math.floor(Math.random() * 400);
  const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
  const child = spawn('node', [serverPath], {
    env: {
      ...process.env,
      FEED_PORT: String(feedPort),
      DATA_DIR: dataDir,
      FEED_TOKEN: TOKEN,
      AUTO_COMPILE: 'disabled',
      DNS_FILTER: 'true',
      DNS_PORT: String(dnsPort),
      DNS_CONTROL_PORT: String(dnsControlPort),
      DNS_UPSTREAM: `http://127.0.0.1:${stubPort}/dns-query`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true });
  });

  // Ready when the feed server answers — the daemon loads rules from the
  // on-disk feedFile before that, so the resolver is up by then too.
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await httpJson(`http://127.0.0.1:${feedPort}/v1/status?token=${TOKEN}`);
      if (res.status === 200) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('feed server did not answer within 20s');
    await delay(200);
  }
  return { child, dataDir, feedPort, dnsPort, dnsControlPort };
}

test('blocked name sinkholes on UDP and TCP; allowed name forwards to DoH upstream', async (t) => {
  const stubPort = await startStubUpstream(t);
  const { dnsPort } = await startServer(t, stubPort);

  // Blocked A → sinkhole 0.0.0.0 over both transports.
  const udpBlocked = parseAnswer(await udpQuery(dnsPort, dnsQuery(0x1234, 'doubleclick.net', 1)));
  assert.equal(udpBlocked.ancount, 1);
  assert.equal(udpBlocked.lastIpv4, '0.0.0.0');

  const tcpBlocked = parseAnswer(await tcpQuery(dnsPort, dnsQuery(0x1235, 'doubleclick.net', 1)));
  assert.equal(tcpBlocked.lastIpv4, '0.0.0.0');

  // Blocked MX → NXDOMAIN (type-confused answers are worse than no answer).
  const mx = parseAnswer(await udpQuery(dnsPort, dnsQuery(0x1236, 'doubleclick.net', 15)));
  assert.equal(mx.rcode, 3);
  assert.equal(mx.ancount, 0);

  // Allowed A → the stub upstream's 93.184.216.34 — proves forwarding works.
  const allowed = parseAnswer(await udpQuery(dnsPort, dnsQuery(0x1237, 'example.com', 1)));
  assert.equal(allowed.lastIpv4, '93.184.216.34');
});

test('protection toggle reaches the resolver; status reports the daemon', async (t) => {
  const stubPort = await startStubUpstream(t);
  const { dnsPort, feedPort } = await startServer(t, stubPort);

  const status = await httpJson(`http://127.0.0.1:${feedPort}/v1/status?token=${TOKEN}`);
  const body = JSON.parse(status.body.toString('utf8'));
  assert.equal(body.dnsFilter.enabled, true);
  assert.equal(body.dnsFilter.running, true);
  assert.equal(body.dnsFilter.port, dnsPort);
  assert.ok(body.dnsFilter.stats.rulesLoaded >= 1);

  // Pause → the same blocked name now forwards upstream (not sinkholed).
  await httpJson(`http://127.0.0.1:${feedPort}/v1/protection?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"enabled":false}',
  });
  const paused = parseAnswer(await udpQuery(dnsPort, dnsQuery(0x2231, 'doubleclick.net', 1)));
  assert.equal(paused.lastIpv4, '93.184.216.34');

  // Resume → sinkhole again.
  await httpJson(`http://127.0.0.1:${feedPort}/v1/protection?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"enabled":true}',
  });
  const resumed = parseAnswer(await udpQuery(dnsPort, dnsQuery(0x2232, 'doubleclick.net', 1)));
  assert.equal(resumed.lastIpv4, '0.0.0.0');
});

test('a feed compile hot-reloads the resolver trie', async (t) => {
  const stubPort = await startStubUpstream(t);
  const { dnsPort, feedPort, dataDir } = await startServer(t, stubPort);

  await writeFile(join(dataDir, 'dns.txt'), '||doubleclick.net^\n||dns-blocked.test^\n', 'utf8');
  await httpJson(`http://127.0.0.1:${feedPort}/v1/compile?token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  await delay(500);

  const ans = parseAnswer(await udpQuery(dnsPort, dnsQuery(0x3231, 'dns-blocked.test', 1)));
  assert.equal(ans.lastIpv4, '0.0.0.0');
});
