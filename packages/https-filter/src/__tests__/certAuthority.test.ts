/**
 * Per-device CA + leaf forge contract (design spec §5.1).
 *
 * The CA is generated on first open, persisted under a 0700 store dir with the
 * private key at 0600, and never shipped. Leaves are RSA-2048, 30-day, SAN
 * dns=<sni>, signed by the CA, LRU-capped. These tests pin the on-disk layout,
 * the forge semantics, the invalid-SNI boundary that the proxy relies on to
 * decide passthrough, and rotation.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { CertAuthority, isValidSni } from '../ca/certAuthority.js';

let storeDir: string;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'bm-https-filter-ca-'));
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe('CertAuthority.open', () => {
  test('writes ca.pem + ca.key.pem under the store dir with the key at mode 0600', async () => {
    const authority = await CertAuthority.open({ storeDir });

    const certStat = statSync(join(storeDir, 'ca.pem'));
    const keyStat = statSync(join(storeDir, 'ca.key.pem'));
    expect(certStat.isFile()).toBe(true);
    expect(keyStat.isFile()).toBe(true);
    expect(keyStat.mode & 0o777).toBe(0o600);
    expect(statSync(storeDir).mode & 0o777).toBe(0o700);
    expect(authority.caCertPem).toContain('BEGIN CERTIFICATE');
  });

  test('reopening the same store dir returns the same CA', async () => {
    const first = await CertAuthority.open({ storeDir });
    const second = await CertAuthority.open({ storeDir });
    expect(second.caCertPem).toBe(first.caCertPem);
  });
});

describe('forgeLeaf', () => {
  test('mints a leaf whose SAN is the SNI, issued and verifiable by the CA', async () => {
    const authority = await CertAuthority.open({ storeDir });
    const leaf = authority.forgeLeaf('cdn.example.com');

    const leafCert = forge.pki.certificateFromPem(leaf.certPem);
    const caCert = forge.pki.certificateFromPem(authority.caCertPem);

    const san = leafCert.getExtension('subjectAltName') as
      | { altNames?: Array<{ type: number; value: string }> }
      | undefined;
    const dnsNames = (san?.altNames ?? [])
      .filter((altName) => altName.type === 2) // dNSName
      .map((altName) => altName.value);
    expect(dnsNames).toContain('cdn.example.com');

    expect(leafCert.issuer.hash).toBe(caCert.subject.hash);
    expect(caCert.verify(leafCert)).toBe(true);
    expect(leaf.keyPem).toContain('PRIVATE KEY');
  });

  test('second forge of the same SNI returns the cached material', async () => {
    const authority = await CertAuthority.open({ storeDir });
    const first = authority.forgeLeaf('cache.example.com');
    const second = authority.forgeLeaf('cache.example.com');
    expect(second.certPem).toBe(first.certPem);
    expect(second.keyPem).toBe(first.keyPem);
  });
});

describe('isValidSni / forgeLeaf rejection', () => {
  test('empty and non-hostname SNIs throw instead of minting a malformed leaf', async () => {
    const authority = await CertAuthority.open({ storeDir });
    expect(() => authority.forgeLeaf('')).toThrow();
    expect(() => authority.forgeLeaf('not a host!')).toThrow();
    expect(() => authority.forgeLeaf('trailing-dot.example.')).toThrow();
    expect(() => authority.forgeLeaf(`a.${'b'.repeat(250)}.com`)).toThrow();
  });

  test('boundary accept/reject per the SNI grammar', () => {
    expect(isValidSni('localhost')).toBe(true);
    expect(isValidSni('cdn.example.com')).toBe(true);
    expect(isValidSni('A-B.EXAMPLE.com')).toBe(true);
    expect(isValidSni('')).toBe(false);
    expect(isValidSni('no-dot')).toBe(false);
    expect(isValidSni('not a host!')).toBe(false);
    expect(isValidSni('trailing.example.')).toBe(false);
    expect(isValidSni('.leading.example')).toBe(false);
    expect(isValidSni('under_score.example')).toBe(false);
    expect(isValidSni(`a.${'b'.repeat(250)}.com`)).toBe(false);
  });
});

describe('rotate', () => {
  test('produces a different CA cert and clears forged leaves', async () => {
    const authority = await CertAuthority.open({ storeDir });
    const before = authority.caCertPem;
    const leafBefore = authority.forgeLeaf('rotate.example.com');

    await authority.rotate();

    expect(authority.caCertPem).not.toBe(before);
    const leafAfter = authority.forgeLeaf('rotate.example.com');
    expect(leafAfter.certPem).not.toBe(leafBefore.certPem);

    const newCa = forge.pki.certificateFromPem(authority.caCertPem);
    const newLeaf = forge.pki.certificateFromPem(leafAfter.certPem);
    expect(newCa.verify(newLeaf)).toBe(true);
  });
});
