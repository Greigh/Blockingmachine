import { describe, expect, it } from '@jest/globals';
import { credentialAllowed, isLocalNetworkHost } from '../utils/urlSafety.js';

// The credential-scope predicate decides where a LAN bearer token may travel:
// TLS anywhere, cleartext only to provably-local hosts. Independent mirrors in
// packages/homeassistant-addon/feedSource.js and
// custom_components/blockingmachine/lan.py implement the same spec — these
// cases pin the canonical behavior they all must share.

describe('isLocalNetworkHost', () => {
  it('accepts names that cannot resolve off the LAN', () => {
    expect(isLocalNetworkHost('http://localhost:9191/feed')).toBe(true);
    expect(isLocalNetworkHost('http://hub.local:9191/feed')).toBe(true);
    expect(isLocalNetworkHost('http://nas.lan/feed')).toBe(true);
    expect(isLocalNetworkHost('http://nas.internal/feed')).toBe(true);
    expect(isLocalNetworkHost('http://printer.home.arpa/feed')).toBe(true);
    expect(isLocalNetworkHost('http://foo.localhost/feed')).toBe(true);
    // A single label can only resolve through the LAN's own suffix search.
    expect(isLocalNetworkHost('http://hub/feed')).toBe(true);
  });

  it('accepts local IPv4 literals', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '172.31.255.1', '192.168.1.20', '169.254.10.10']) {
      expect(isLocalNetworkHost(`http://${host}/feed`)).toBe(true);
    }
  });

  it('rejects public IPv4 literals — including adjacent-octet boundaries', () => {
    for (const host of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '192.167.0.1', '193.168.0.1']) {
      expect(isLocalNetworkHost(`http://${host}/feed`)).toBe(false);
    }
  });

  it('rejects shared and special-purpose IPv4 ranges', () => {
    // CGNAT, benchmarking, documentation, multicast, broadcast, unspecified —
    // none of these is a legitimate LAN credential target.
    for (const host of ['100.64.0.1', '198.18.0.1', '192.0.2.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '0.0.0.0']) {
      expect(isLocalNetworkHost(`http://${host}/feed`)).toBe(false);
    }
  });

  it('accepts local IPv6 literals', () => {
    expect(isLocalNetworkHost('http://[::1]:9191/feed')).toBe(true);
    expect(isLocalNetworkHost('http://[fe80::1]/feed')).toBe(true);
    expect(isLocalNetworkHost('http://[fd00::7]/feed')).toBe(true);
    expect(isLocalNetworkHost('http://[fc12::9]/feed')).toBe(true);
  });

  it('decodes v4-mapped IPv6 in both URL serializations', () => {
    // The WHATWG parser rewrites ::ffff:10.0.0.5 as ::ffff:a00:5 — the trap
    // the first handwritten copies of this predicate missed.
    expect(isLocalNetworkHost('http://[::ffff:10.0.0.5]/feed')).toBe(true);
    expect(isLocalNetworkHost('http://[::ffff:a00:5]/feed')).toBe(true);
    // A mapped *public* v4 stays public — mapping is not locality.
    expect(isLocalNetworkHost('http://[::ffff:8.8.8.8]/feed')).toBe(false);
  });

  it('rejects public IPv6 literals and the unspecified address', () => {
    expect(isLocalNetworkHost('http://[2606:4700:4700::1111]/feed')).toBe(false);
    expect(isLocalNetworkHost('http://[ff02::1]/feed')).toBe(false);
    // '::' cannot be reached — nothing is provably-local about a non-destination.
    expect(isLocalNetworkHost('http://[::]/feed')).toBe(false);
  });

  it('sees through WHATWG IPv4 canonicalization', () => {
    // Integer/short/hex IPv4 spellings are normalized before hostname checks.
    expect(isLocalNetworkHost('http://2130706433/feed')).toBe(true); // 127.0.0.1
    expect(isLocalNetworkHost('http://127.1/feed')).toBe(true); // 127.0.0.1
    expect(isLocalNetworkHost('http://134744072/feed')).toBe(false); // 8.8.8.8
  });

  it('is case-insensitive on names and hex', () => {
    expect(isLocalNetworkHost('http://Hub.LOCAL/feed')).toBe(true);
    expect(isLocalNetworkHost('http://[FE80::1]/feed')).toBe(true);
    expect(isLocalNetworkHost('http://EXAMPLE.com/feed')).toBe(false);
  });

  it('rejects public and malformed URLs', () => {
    expect(isLocalNetworkHost('http://feeds.example.com/feed')).toBe(false);
    expect(isLocalNetworkHost('https://feeds.example.com/feed')).toBe(false);
    expect(isLocalNetworkHost('not a url')).toBe(false);
    expect(isLocalNetworkHost('')).toBe(false);
  });
});

describe('credentialAllowed', () => {
  it('allows TLS to any host', () => {
    expect(credentialAllowed('https://feeds.example.com/x')).toBe(true);
    expect(credentialAllowed('https://8.8.8.8/x')).toBe(true);
  });

  it('allows cleartext only to local hosts', () => {
    expect(credentialAllowed('http://hub.local:9191/x')).toBe(true);
    expect(credentialAllowed('http://192.168.1.10:9191/x')).toBe(true);
    expect(credentialAllowed('http://8.8.8.8/x')).toBe(false);
    expect(credentialAllowed('http://feeds.example.com/x')).toBe(false);
  });
});
