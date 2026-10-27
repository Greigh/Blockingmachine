/**
 * Per-device CA + leaf forge contract (design spec §5.1).
 *
 * The CA is generated on first open, persisted under a 0700 store dir with the
 * private key at 0600, and never shipped. Leaves are RSA-2048, 30-day, SAN
 * dns=<sni>, signed by the CA, LRU-capped. These tests pin the on-disk layout,
 * the forge semantics, the invalid-SNI boundary that the proxy relies on to
 * decide passthrough, and rotation.
 *
 * Every `open` here passes `keyWrapBackend: null` — the no-backend plaintext
 * posture — so the suite pins the legacy `ca.key.pem` layout and never
 * touches a real OS credential store. The wrapped `ca.key.enc` path is
 * covered against a mock backend in `keyWrap.test.ts`, and the real
 * `security`-CLI leg lives behind `BM_LIVE_KEYCHAIN=1` there.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    const authority = await CertAuthority.open({ storeDir, keyWrapBackend: null });

    const certStat = statSync(join(storeDir, 'ca.pem'));
    const keyStat = statSync(join(storeDir, 'ca.key.pem'));
    expect(certStat.isFile()).toBe(true);
    expect(keyStat.isFile()).toBe(true);
    expect(keyStat.mode & 0o777).toBe(0o600);
    expect(statSync(storeDir).mode & 0o777).toBe(0o700);
    expect(authority.caCertPem).toContain('BEGIN CERTIFICATE');
  });

  test('a no-backend store reports the plaintext posture honestly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bm-ca-plaintext-'));
    try {
      const authority = await CertAuthority.open({ storeDir: dir, keyWrapBackend: null });
      expect(authority.keyWrapped).toBe(false);
      expect(authority.keyWrapBackend).toBeUndefined();
      expect(existsSync(join(dir, 'ca.key.pem'))).toBe(true);
      expect(existsSync(join(dir, 'ca.key.enc'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reopening the same store dir returns the same CA', async () => {
    const first = await CertAuthority.open({ storeDir, keyWrapBackend: null });
    const second = await CertAuthority.open({ storeDir, keyWrapBackend: null });
    expect(second.caCertPem).toBe(first.caCertPem);
  });
});

describe('forgeLeaf', () => {
  test('mints a leaf whose SAN is the SNI, issued and verifiable by the CA', async () => {
    const authority = await CertAuthority.open({ storeDir, keyWrapBackend: null });
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
    const authority = await CertAuthority.open({ storeDir, keyWrapBackend: null });
    const first = authority.forgeLeaf('cache.example.com');
    const second = authority.forgeLeaf('cache.example.com');
    expect(second.certPem).toBe(first.certPem);
    expect(second.keyPem).toBe(first.keyPem);
  });
});

describe('isValidSni / forgeLeaf rejection', () => {
  test('empty and non-hostname SNIs throw instead of minting a malformed leaf', async () => {
    const authority = await CertAuthority.open({ storeDir, keyWrapBackend: null });
    expect(() => authority.forgeLeaf('')).toThrow();
    expect(() => authority.forgeLeaf('not a host!')).toThrow();
    expect(() => authority.forgeLeaf('trailing-dot.example.')).toThrow();
    expect(() => authority.forgeLeaf(`a.${'b'.repeat(250)}.com`)).toThrow();
    expect(() => authority.forgeLeaf('93.184.216.34')).toThrow();
  });

  test('boundary accept/reject per the SNI grammar', () => {
    expect(isValidSni('localhost')).toBe(true);
    expect(isValidSni('cdn.example.com')).toBe(true);
    expect(isValidSni('A-B.EXAMPLE.com')).toBe(true);
    expect(isValidSni('v2.api3.example.com')).toBe(true);
    expect(isValidSni('')).toBe(false);
    expect(isValidSni('no-dot')).toBe(false);
    expect(isValidSni('not a host!')).toBe(false);
    expect(isValidSni('trailing.example.')).toBe(false);
    expect(isValidSni('.leading.example')).toBe(false);
    expect(isValidSni('under_score.example')).toBe(false);
    expect(isValidSni(`a.${'b'.repeat(250)}.com`)).toBe(false);
    // IP literals are not DNS names — the proxy passthroughs them, never forges.
    expect(isValidSni('93.184.216.34')).toBe(false);
    expect(isValidSni('1.2.3.999')).toBe(false);
  });
});

describe('rotate', () => {
  test('produces a different CA cert and clears forged leaves', async () => {
    const authority = await CertAuthority.open({ storeDir, keyWrapBackend: null });
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

describe('store refusal + recovery', () => {
  test('a mismatched-but-parseable ca.pem/ca.key.pem pair refuses to open', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'bm-ca-mismatch-a-'));
    const dirB = await mkdtemp(join(tmpdir(), 'bm-ca-mismatch-b-'));
    try {
      await CertAuthority.open({ storeDir: dirA, keyWrapBackend: null });
      await CertAuthority.open({ storeDir: dirB, keyWrapBackend: null });
      // Simulate a torn rotate: B's key beside A's cert — both parse fine but
      // are not a pair, and every leaf minted from them would fail verify.
      const bKey = await readFile(join(dirB, 'ca.key.pem'), 'utf8');
      await writeFile(join(dirA, 'ca.key.pem'), bKey, 'utf8');
      await expect(CertAuthority.open({ storeDir: dirA, keyWrapBackend: null })).rejects.toThrow();
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  test('a corrupt ca.pem refuses to open rather than regenerating', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bm-ca-corrupt-'));
    try {
      await CertAuthority.open({ storeDir: dir, keyWrapBackend: null });
      await writeFile(join(dir, 'ca.pem'), 'this is not a certificate\n', 'utf8');
      await expect(CertAuthority.open({ storeDir: dir, keyWrapBackend: null })).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an orphan key surviving its cert is preserved, not truncated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bm-ca-orphan-'));
    try {
      const first = await CertAuthority.open({ storeDir: dir, keyWrapBackend: null });
      const orphanKey = await readFile(join(dir, 'ca.key.pem'), 'utf8');
      await rm(join(dir, 'ca.pem'));

      const second = await CertAuthority.open({ storeDir: dir, keyWrapBackend: null });

      expect(second.caCertPem).not.toBe(first.caCertPem);
      expect(await readFile(join(dir, 'ca.key.pem.orphan'), 'utf8')).toBe(orphanKey);
      // The replacement pair itself must be a working pair.
      const caCert = forge.pki.certificateFromPem(second.caCertPem);
      const leaf = forge.pki.certificateFromPem(second.forgeLeaf('orphan.example').certPem);
      expect(caCert.verify(leaf)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rotate persists — a reopened authority verifies new leaves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bm-ca-rotate-'));
    try {
      const authority = await CertAuthority.open({ storeDir: dir, keyWrapBackend: null });
      await authority.rotate();

      const reopened = await CertAuthority.open({ storeDir: dir, keyWrapBackend: null });
      expect(reopened.caCertPem).toBe(authority.caCertPem);
      const caCert = forge.pki.certificateFromPem(reopened.caCertPem);
      const leaf = forge.pki.certificateFromPem(
        reopened.forgeLeaf('post-rotate.example').certPem,
      );
      expect(caCert.verify(leaf)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
