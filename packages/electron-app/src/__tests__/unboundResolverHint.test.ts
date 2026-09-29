/**
 * The words under the two resolver fields.
 *
 * These are short, but they carry the two facts that decide whether a verdict is readable: that a
 * default address is a default, and that a reference resolver is what makes NXDOMAIN mean
 * something. The tests pin the *reason* each sentence exists rather than its wording, so the text
 * can be reworded without the guarantees drifting.
 */

import { describe, test, expect } from '@jest/globals';
import { unboundReferenceHint, unboundResolverHint } from '../unboundDeploy';

describe('unboundResolverHint', () => {
  test('surfaces an unusable address instead of describing a query that will not run', () => {
    expect(unboundResolverHint({ error: 'That is not an address.', effective: null })).toBe(
      'That is not an address.',
    );
  });

  test('says the conventional address is a default, not a choice the user made', () => {
    const hint = unboundResolverHint({ effective: '127.0.0.1:53', usedDefault: true });
    expect(hint).toContain('No address is set');
    expect(hint).toContain('127.0.0.1:53');
    // The point of the sentence: a wrong guess is visible, not silent.
    expect(hint).toContain('visible rather than silent');
  });

  test('names the address this machine already resolves through when it differs', () => {
    // This is the cost of defaulting to localhost: the common wrong answer is a resolver running on
    // the router, and the fix is an address the machine already knows.
    const hint = unboundResolverHint({
      effective: '127.0.0.1:53',
      usedDefault: true,
      systemServers: ['192.168.1.1'],
    });
    expect(hint).toContain('This machine resolves through 192.168.1.1');
    expect(hint).toContain('if Unbound runs there');
  });

  test('does not suggest a loopback server or the address already in use', () => {
    const hint = unboundResolverHint({
      effective: '127.0.0.1:53',
      usedDefault: true,
      systemServers: ['127.0.0.1', '::1'],
    });
    expect(hint).not.toContain('This machine resolves through');
  });

  test('describes a chosen address as the one the check uses', () => {
    const hint = unboundResolverHint({ effective: '192.168.1.1:5335' });
    expect(hint).toContain('queries 192.168.1.1:5335');
    expect(hint).toContain('not 127.0.0.1');
  });

  test('has something to say when there is no address at all', () => {
    expect(unboundResolverHint({ effective: null })).toContain('runs against this address');
  });
});

describe('unboundReferenceHint', () => {
  test('explains the failure it exists to prevent, and what to do about it', () => {
    const hint = unboundReferenceHint({ effective: null, source: 'none' });
    expect(hint).toContain('unconfirmed');
    expect(hint).toContain('exists before reading NXDOMAIN as proof');
  });

  test('says whose address the reference is, since a system one was not chosen', () => {
    expect(unboundReferenceHint({ effective: '192.168.1.1:53', source: 'system' })).toContain(
      'this machine\u2019s own configured resolver',
    );
    expect(unboundReferenceHint({ effective: '1.1.1.1:53', source: 'explicit' })).toContain(
      'the address you set',
    );
  });

  test('names the reverse case too: a name that was never registered answers the same way', () => {
    const hint = unboundReferenceHint({ effective: '1.1.1.1:53', source: 'explicit' });
    expect(hint).toContain('never registered');
  });

  test('surfaces a reference that cannot be used', () => {
    expect(
      unboundReferenceHint({ error: 'The reference resolver is the resolver under test.', effective: null }),
    ).toBe('The reference resolver is the resolver under test.');
  });
});
