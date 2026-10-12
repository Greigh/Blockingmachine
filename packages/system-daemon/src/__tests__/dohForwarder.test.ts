import { describe, expect, test } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DohForwarder } from '../server/dohForwarder.js';

/**
 * The DoH forwarder sits on the daemon's per-query path, so its failure modes
 * are daemon failure modes. These tests stub the upstream with a local HTTP
 * server and prove the guards the constructor's doc comment promises:
 * bounded bodies, refused redirects, and a constructor that rejects
 * link-local targets outright.
 */

const QUERY = Buffer.from([0xab, 0xcd, 0x01, 0x00, 0x00, 0x01]); // shape, not semantics

function serve(handler: http.RequestListener): Promise<{ url: string; hits: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const state = { hits: 0 };
    const server = http.createServer((req, res) => {
      state.hits += 1;
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/dns-query`,
        get hits() {
          return state.hits;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      } as { url: string; hits: number; close: () => Promise<void> });
    });
  });
}

describe('DohForwarder upstream guards', () => {
  test('returns the upstream answer for a normal dns-message', async () => {
    const answer = Buffer.from([0xab, 0xcd, 0x81, 0x80]);
    const upstream = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/dns-message' });
      res.end(answer);
    });
    try {
      const forwarder = new DohForwarder(upstream.url);
      const result = await forwarder.resolvePacket(QUERY);
      expect(result).toEqual(answer);
      expect(upstream.hits).toBe(1);
    } finally {
      await upstream.close();
    }
  });

  test('refuses a body that outgrows a real DNS message', async () => {
    const upstream = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/dns-message' });
      res.end(Buffer.alloc(512 * 1024, 0x41)); // 512 KiB — 8× any legal wire message
    });
    try {
      const forwarder = new DohForwarder(upstream.url);
      const result = await forwarder.resolvePacket(QUERY);
      // The bound trips: the caller encodes SERVFAIL instead of holding the body.
      expect(result).toBeNull();
    } finally {
      await upstream.close();
    }
  });

  test('does not follow a redirect — the query never reaches the target', async () => {
    const target = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/dns-message' });
      res.end(Buffer.from([0x00]));
    });
    const redirector = await serve((_req, res) => {
      res.writeHead(302, { Location: target.url });
      res.end();
    });
    try {
      const forwarder = new DohForwarder(redirector.url);
      const result = await forwarder.resolvePacket(QUERY);
      expect(result).toBeNull();
      expect(redirector.hits).toBe(1);
      expect(target.hits).toBe(0);
    } finally {
      await redirector.close();
      await target.close();
    }
  });

  test('constructor refuses link-local/metadata upstreams but keeps loopback', () => {
    expect(() => new DohForwarder('http://169.254.169.254/latest/meta-data'))
      .toThrow(/endpoint policy/);
    expect(() => new DohForwarder('http://[::1]:5053/dns-query')).not.toThrow();
    expect(() => new DohForwarder('https://dns.quad9.net/dns-query')).not.toThrow();
  });
});
