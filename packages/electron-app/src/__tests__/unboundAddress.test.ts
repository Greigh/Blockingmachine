/**
 * Resolver addresses.
 *
 * Split from the probe tests along the module boundary: this file needs no `dns` import and no
 * socket, which is the property that keeps the renderer out of Node's resolver.
 */

import { describe, test, expect } from '@jest/globals';
import {
  DEFAULT_UNBOUND_RESOLVER_ADDRESS,
  DEFAULT_UNBOUND_RESOLVER_PORT,
  isLoopbackResolvHost,
  parseUnboundResolverAddress,
  pickReferenceTarget,
  resolveUnboundResolver,
} from '../unboundAddress';

describe('parseUnboundResolverAddress', () => {
  test('takes a bare host and applies the DNS port', () => {
    const parsed = parseUnboundResolverAddress('192.168.1.1');
    expect(parsed).toEqual({
      ok: true,
      target: { host: '192.168.1.1', port: DEFAULT_UNBOUND_RESOLVER_PORT, label: '192.168.1.1:53' },
    });
  });

  test('honours an explicit port, which a non-default Unbound needs', () => {
    expect(parseUnboundResolverAddress('192.168.1.1:5335')).toEqual({
      ok: true,
      target: { host: '192.168.1.1', port: 5335, label: '192.168.1.1:5335' },
    });
  });

  test('tolerates a pasted URL, because that is what is on screen above the field', () => {
    expect(parseUnboundResolverAddress('http://192.168.1.1:9191/unbound.conf')).toEqual({
      ok: true,
      target: { host: '192.168.1.1', port: 9191, label: '192.168.1.1:9191' },
    });
  });

  test('keeps IPv6 brackets off the host but keeps the port', () => {
    expect(parseUnboundResolverAddress('[fd00::1]:5335')).toEqual({
      ok: true,
      target: { host: 'fd00::1', port: 5335, label: 'fd00::1:5335' },
    });
    expect(parseUnboundResolverAddress('fd00::1')).toEqual({
      ok: true,
      target: { host: 'fd00::1', port: DEFAULT_UNBOUND_RESOLVER_PORT, label: 'fd00::1:53' },
    });
  });

  test('does not read a bare IPv6 literal as a host and a port', () => {
    // `::1:5353` has four colon-separated parts, so the `host:port` branch does not match it and the
    // whole string used to become the host with port 53 \u2014 a query to an address that cannot exist,
    // reported as a dead resolver. A bare literal is not split at all: brackets are how a port is
    // given, and without them there is nothing to separate.
    expect(parseUnboundResolverAddress('::1')).toEqual({
      ok: true,
      target: { host: '::1', port: DEFAULT_UNBOUND_RESOLVER_PORT, label: '::1:53' },
    });
    expect(parseUnboundResolverAddress('::1:5353')).toEqual({
      ok: true,
      target: { host: '::1:5353', port: DEFAULT_UNBOUND_RESOLVER_PORT, label: '::1:5353:53' },
    });
    // And a hostname with a port still reads as a host and a port, which is the case the branch is
    // actually for.
    expect(parseUnboundResolverAddress('unbound.lan:5353')).toEqual({
      ok: true,
      target: { host: 'unbound.lan', port: 5353, label: 'unbound.lan:5353' },
    });
    expect(parseUnboundResolverAddress('unbound.lan')).toEqual({
      ok: true,
      target: { host: 'unbound.lan', port: DEFAULT_UNBOUND_RESOLVER_PORT, label: 'unbound.lan:53' },
    });
  });

  test('refuses nothing-useful rather than querying a guess', () => {
    for (const bad of ['', '   ', null, undefined]) {
      expect(parseUnboundResolverAddress(bad).ok).toBe(false);
    }
    expect(parseUnboundResolverAddress('192.168.1.1:0').ok).toBe(false);
    expect(parseUnboundResolverAddress('192.168.1.1:70000').ok).toBe(false);
    expect(parseUnboundResolverAddress('http://').ok).toBe(false);
  });

  test('refuses a host with whitespace in it', () => {
    // Otherwise a pasted "192.168.1.1 53" becomes a query to a name that cannot exist, which is
    // indistinguishable from an unreachable resolver.
    expect(parseUnboundResolverAddress('192.168.1.1 53').ok).toBe(false);
    expect(parseUnboundResolverAddress('not a host:99').ok).toBe(false);
  });
});

describe('isLoopbackResolvHost', () => {
  test('counts every spelling of this machine as one resolver', () => {
    for (const host of ['127.0.0.1', '127.0.0.53', '::1', 'localhost', 'LOCALHOST', '[::1]']) {
      expect(isLoopbackResolvHost(host)).toBe(true);
    }
    for (const host of ['192.168.1.1', '100.100.100.100', 'fd00::1', '']) {
      expect(isLoopbackResolvHost(host)).toBe(false);
    }
  });
});

describe('resolveUnboundResolver', () => {
  test('falls back to the conventional address when nothing is set', () => {
    // A check that cannot run because a field is blank is worse than one that queries the resolver
    // the hub is almost always sitting on — and the verdict names the address either way.
    for (const blank of ['', '   ', null, undefined]) {
      const resolved = resolveUnboundResolver(blank);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.resolved.target.label).toBe(`${DEFAULT_UNBOUND_RESOLVER_ADDRESS}:53`);
      expect(resolved.resolved.usedDefault).toBe(true);
    }
  });

  test('uses the typed address when there is one, and says it is not the default', () => {
    const resolved = resolveUnboundResolver('192.168.1.1:5335');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.resolved.target.label).toBe('192.168.1.1:5335');
    expect(resolved.resolved.usedDefault).toBe(false);
  });

  test('does not quietly replace a typo with the default', () => {
    // Querying localhost for an address the user got wrong would produce a confident verdict about
    // a resolver they never named.
    const resolved = resolveUnboundResolver('192.168.1.1:99999');
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.message).toContain('99999');
  });
});

describe('pickReferenceTarget', () => {
  const tested = { host: '127.0.0.1', port: 53, label: '127.0.0.1:53' };

  test('takes the machine\u2019s own resolver when nothing is named, so no name leaves the network', () => {
    const picked = pickReferenceTarget(tested, '', ['192.168.1.1']);
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.reference.target.label).toBe('192.168.1.1:53');
    expect(picked.reference.source).toBe('system');
  });

  test('refuses a reference that is the resolver under test', () => {
    // A second question to the same instance cannot confirm anything: it would answer NXDOMAIN for
    // its own reasons and the check would read that as corroboration.
    const explicit = pickReferenceTarget(tested, '127.0.0.1:53', []);
    expect(explicit.ok).toBe(false);
    if (explicit.ok) return;
    expect(explicit.message).toContain('resolver under test');

    // The same applies to one picked from the system list — and to its other spellings, which are
    // the layout a machine with IPv6 loopback configured actually reports.
    expect(pickReferenceTarget(tested, '', ['127.0.0.1']).ok).toBe(false);
    expect(pickReferenceTarget(tested, '', ['::1', '127.0.0.1']).ok).toBe(false);
    expect(pickReferenceTarget(tested, '', ['localhost']).ok).toBe(false);
  });

  test('looks past the machine\u2019s loopback entry to a server that can answer', () => {
    const picked = pickReferenceTarget(tested, '', ['127.0.0.1', '1.1.1.1']);
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.reference.target.label).toBe('1.1.1.1:53');
  });

  test('takes an explicit address over the system list, and flags it as the user\u2019s choice', () => {
    const picked = pickReferenceTarget(tested, '1.1.1.1', ['192.168.1.1']);
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.reference.target.label).toBe('1.1.1.1:53');
    expect(picked.reference.source).toBe('explicit');
  });

  test('reports a typo rather than silently falling back to a system server', () => {
    expect(pickReferenceTarget(tested, 'not a host:99', []).ok).toBe(false);
  });

  test('reports nothing available when the machine resolves through the deployment itself', () => {
    // This is the case that must not become a fabricated confirmation.
    const picked = pickReferenceTarget(tested, '', ['127.0.0.1']);
    expect(picked.ok).toBe(false);
    if (picked.ok) return;
    expect(picked.message).toContain('resolves through the resolver under test');
  });
});
