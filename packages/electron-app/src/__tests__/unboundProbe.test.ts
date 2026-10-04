/**
 * Unbound resolver probing.
 *
 * The check is only as good as its reading of a failed lookup, so most of these tests are about the
 * three outcomes Node hides behind one rejection: NXDOMAIN (the drop-in is loaded), NODATA (the
 * name exists and the drop-in is not), and a timeout (the resolver said nothing at all). Getting
 * those confused is how a dead resolver gets reported as a working blocklist.
 *
 * No socket is opened: the DNS call is injected. Address parsing lives in `unboundAddress.test.ts`.
 */

import { describe, test, expect } from '@jest/globals';
import { classifyLookupFailure, probeUnboundResolver, queryUnboundResolver, type UnboundResolverQuery } from '../unboundProbe';
import { RESOLVER_CONTROL_DOMAIN } from '../unboundReachability';

describe('classifyLookupFailure', () => {
  test('reads NXDOMAIN as the proof a canary is looking for', () => {
    expect(classifyLookupFailure({ code: 'ENOTFOUND' }).state).toBe('nxdomain');
    expect(classifyLookupFailure({ code: 'NXDOMAIN' }).state).toBe('nxdomain');
  });

  test('separates NODATA from NXDOMAIN', () => {
    expect(classifyLookupFailure({ code: 'ENODATA' }).state).toBe('nodata');
  });

  test('reads silence as silence, not as a missing block', () => {
    expect(classifyLookupFailure({ code: 'ETIMEOUT' }).state).toBe('timeout');
    expect(classifyLookupFailure({ code: 'ESERVFAIL' }).state).toBe('timeout');
    expect(classifyLookupFailure({ name: 'TimeoutError' }).state).toBe('timeout');
    expect(classifyLookupFailure({ code: 'ECONNREFUSED' }).state).toBe('refused');
  });

  test('keeps the code so the detail line can name what went wrong', () => {
    expect(classifyLookupFailure({ code: 'ECONNREFUSED' }).detail).toBe('ECONNREFUSED');
    expect(classifyLookupFailure(new Error('socket hang up')).state).toBe('error');
    expect(classifyLookupFailure(new Error('socket hang up')).detail).toBe('socket hang up');
    expect(classifyLookupFailure({}).state).toBe('error');
  });

  test('reads an address it cannot be pointed at as its own thing, not as a failed lookup', () => {
    // `dns` rejects a hostname with this, synchronously. It is not a failure of the resolver: no
    // query was sent, so calling it one would send the user to check a resolver that was never asked.
    expect(classifyLookupFailure({ code: 'ERR_INVALID_IP_ADDRESS' })).toEqual({
      state: 'unqueryable',
      detail: 'ERR_INVALID_IP_ADDRESS',
    });
  });
});

describe('queryUnboundResolver', () => {
  test('a hostname target answers with a verdict instead of throwing', () => {
    // The real call, against a name rather than an IP. `setServers` used to sit one line above the
    // `try`, so this threw out of `probeUnboundResolver` and out of the IPC handler as a rejected
    // promise \u2014 the one address a router-hosted deployment uses was the one that could not be
    // checked at all.
    return expect(
      queryUnboundResolver('doubleclick.net', { host: 'unbound.lan', port: 53, label: 'unbound.lan:53' }, 250),
    ).resolves.toEqual({ state: 'unqueryable', detail: 'ERR_INVALID_IP_ADDRESS' });
  });
});

describe('probeUnboundResolver', () => {
  const target = { host: '127.0.0.1', port: 53, label: '127.0.0.1:53' };

  test('asks both questions together and labels which is which', async () => {
    const asked: string[] = [];
    const query: UnboundResolverQuery = async (domain) => {
      asked.push(domain);
      return domain === 'doubleclick.net'
        ? { state: 'nxdomain' }
        : { state: 'resolved', addresses: ['93.184.216.34'] };
    };

    const result = await probeUnboundResolver({
      target,
      canaryDomain: 'doubleclick.net',
      controlDomain: RESOLVER_CONTROL_DOMAIN,
      query,
    });

    expect(asked.sort()).toEqual([RESOLVER_CONTROL_DOMAIN, 'doubleclick.net'].sort());
    expect(result.target).toBe('127.0.0.1:53');
    expect(result.canary.domain).toBe('doubleclick.net');
    expect(result.canary.answer.state).toBe('nxdomain');
    expect(result.control.answer.state).toBe('resolved');
  });

  test('asks the reference about the canary, and reports when there is none to ask', async () => {
    const asked: Array<{ domain: string; who: string }> = [];
    const query: UnboundResolverQuery = async (domain, t) => {
      asked.push({ domain, who: t.label });
      return { state: 'nxdomain' };
    };
    const referenceTarget = { host: '1.1.1.1', port: 53, label: '1.1.1.1:53' };

    const withReference = await probeUnboundResolver({
      target,
      canaryDomain: 'doubleclick.net',
      controlDomain: RESOLVER_CONTROL_DOMAIN,
      referenceTarget,
      query,
    });
    expect(asked.filter((entry) => entry.who === '1.1.1.1:53')).toEqual([
      { domain: 'doubleclick.net', who: '1.1.1.1:53' },
    ]);
    expect(withReference.reference?.target).toBe('1.1.1.1:53');

    const without = await probeUnboundResolver({
      target,
      canaryDomain: 'doubleclick.net',
      controlDomain: RESOLVER_CONTROL_DOMAIN,
      query,
    });
    // Null, not a fabricated answer — the verdict turns on the difference.
    expect(without.reference).toBeNull();
  });

  test('one dead query does not discard the other answer', async () => {
    // Promise.all over a query that converts every failure into an answer state: a resolver that
    // refuses the control name still has an opinion worth showing about the canary.
    const query: UnboundResolverQuery = async (domain) =>
      domain === RESOLVER_CONTROL_DOMAIN
        ? { state: 'timeout', detail: 'ETIMEOUT' }
        : { state: 'nxdomain' };

    const result = await probeUnboundResolver({
      target,
      canaryDomain: 'doubleclick.net',
      controlDomain: RESOLVER_CONTROL_DOMAIN,
      query,
    });

    expect(result.canary.answer.state).toBe('nxdomain');
    expect(result.control.answer.state).toBe('timeout');
  });
});
