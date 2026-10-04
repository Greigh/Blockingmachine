/**
 * The feed server's optional bearer gate.
 *
 * What is worth pinning is the asymmetry: unset means *everyone* is authorised, set means the
 * exact `Bearer` value is required — because the gate is opt-in hardening for an untrusted LAN,
 * and a wrong answer in either direction is a real fault (silently open, or a working LAN
 * deployment locked out).
 */

import { describe, expect, test } from '@jest/globals';
import { feedTokenAuthorised } from '../feedAuth';

describe('feedTokenAuthorised', () => {
  test('an unset token authorises every caller, header or not', () => {
    for (const configured of [undefined, null, '', '   ']) {
      expect(feedTokenAuthorised(configured, undefined)).toBe(true);
      expect(feedTokenAuthorised(configured, 'Bearer anything')).toBe(true);
    }
  });

  test('a configured token requires the exact Bearer value', () => {
    expect(feedTokenAuthorised('s3cret', 'Bearer s3cret')).toBe(true);
  });

  test('refuses a missing header, the wrong token, and the wrong scheme', () => {
    expect(feedTokenAuthorised('s3cret', undefined)).toBe(false);
    expect(feedTokenAuthorised('s3cret', '')).toBe(false);
    expect(feedTokenAuthorised('s3cret', 'Bearer wrong')).toBe(false);
    expect(feedTokenAuthorised('s3cret', 'Bearer ')).toBe(false);
    // A different auth scheme carrying the same secret is not a bearer token.
    expect(feedTokenAuthorised('s3cret', 'Basic s3cret')).toBe(false);
    expect(feedTokenAuthorised('s3cret', 's3cret')).toBe(false);
  });

  test('refuses near-misses that only differ by length or case', () => {
    expect(feedTokenAuthorised('s3cret', 'Bearer s3cret2')).toBe(false);
    expect(feedTokenAuthorised('s3cret', 'Bearer s3cre')).toBe(false);
    expect(feedTokenAuthorised('s3cret', 'Bearer S3CRET')).toBe(false);
  });
});
