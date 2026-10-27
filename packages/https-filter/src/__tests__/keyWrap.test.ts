/**
 * OS-wrapped CA key at rest (design spec §5.1, flag 97).
 *
 * The persisted CA key lives as `ca.key.enc` — a `BMKEYWRAP1`-magicked
 * AES-256-GCM envelope sealed under a 32-byte secret the OS credential store
 * holds — with 0600 `ca.key.pem` as the no-backend fallback and the legacy
 * layout these stores migrate forward from.
 *
 * Every case here runs against a mock {@link KeyWrapBackend}: the whole wrap
 * path — generation, migration, unwrap-or-throw, rotate — is exercisable
 * without touching a real keychain. The one exception is the
 * `BM_LIVE_KEYCHAIN=1` describe at the bottom, which drives the real
 * `security` CLI under a throwaway service name and cleans up after itself.
 */

import { afterAll, describe, expect, jest, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import forge from 'node-forge';
import { CertAuthority } from '../ca/certAuthority.js';
import {
  CaKeyUnwrapError,
  PowerShellProtectedDataBackend,
  resolveBackend,
  SecretToolBackend,
  SecurityCliBackend,
  unwrapKeyMaterial,
  wrapKeyMaterial,
  WRAP_SECRET_LENGTH,
  type KeyWrapBackend,
} from '../ca/keyWrap.js';

const execFileAsync = promisify(execFile);

const ENC_FILE = 'ca.key.enc';
const PEM_FILE = 'ca.key.pem';

/** In-memory OS store — the wrap path's full test seam. */
class MockKeyWrapBackend implements KeyWrapBackend {
  readonly name = 'mock-keychain';
  stored: Buffer | null = null;
  storeError: Error | null = null;
  loadError: Error | null = null;

  async load(): Promise<Buffer | null> {
    if (this.loadError !== null) {
      throw this.loadError;
    }
    return this.stored === null ? null : Buffer.from(this.stored);
  }

  async store(secret: Buffer): Promise<void> {
    if (this.storeError !== null) {
      throw this.storeError;
    }
    this.stored = Buffer.from(secret);
  }
}

async function makeDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** The dirs a test body creates get swept in one afterAll. */
const scratchDirs: string[] = [];
async function scratch(prefix: string): Promise<string> {
  const dir = await makeDir(prefix);
  scratchDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('the BMKEYWRAP1 envelope', () => {
  const pem =
    '-----BEGIN RSA PRIVATE KEY-----\nfake-key-material-for-the-test\n-----END RSA PRIVATE KEY-----\n';
  const secret = randomBytes(WRAP_SECRET_LENGTH);

  test('seals to a magic-tagged blob that unwraps back to the plaintext', () => {
    const blob = wrapKeyMaterial(Buffer.from(pem, 'utf8'), secret);
    expect(blob.subarray(0, 10).toString('ascii')).toBe('BMKEYWRAP1');
    // magic ‖ 12 B nonce ‖ 16 B tag ‖ ciphertext
    expect(blob.length).toBe(10 + 12 + 16 + Buffer.byteLength(pem, 'utf8'));
    expect(unwrapKeyMaterial(blob, secret).toString('utf8')).toBe(pem);
  });

  test('a wrong secret fails GCM authentication → CaKeyUnwrapError', () => {
    const blob = wrapKeyMaterial(Buffer.from(pem, 'utf8'), secret);
    expect(() => unwrapKeyMaterial(blob, randomBytes(WRAP_SECRET_LENGTH))).toThrow(
      CaKeyUnwrapError,
    );
  });

  test('a corrupt ciphertext byte fails authentication → CaKeyUnwrapError', () => {
    const blob = wrapKeyMaterial(Buffer.from(pem, 'utf8'), secret);
    const corrupted = Buffer.from(blob);
    corrupted[corrupted.length - 1] ^= 0xff;
    expect(() => unwrapKeyMaterial(corrupted, secret)).toThrow(CaKeyUnwrapError);
  });

  test('a foreign blob without the magic → CaKeyUnwrapError', () => {
    expect(() => unwrapKeyMaterial(Buffer.from('not an envelope'), secret)).toThrow(
      CaKeyUnwrapError,
    );
    expect(() => unwrapKeyMaterial(randomBytes(64), secret)).toThrow(CaKeyUnwrapError);
  });

  test('a wrong-length secret is refused in both directions', () => {
    const short = randomBytes(16);
    const blob = wrapKeyMaterial(Buffer.from(pem, 'utf8'), secret);
    expect(() => wrapKeyMaterial(Buffer.from(pem, 'utf8'), short)).toThrow(CaKeyUnwrapError);
    expect(() => unwrapKeyMaterial(blob, short)).toThrow(CaKeyUnwrapError);
  });
});

describe('CertAuthority with a wrap backend', () => {
  test('generates into ca.key.enc — no plaintext key ever lands on disk', async () => {
    const dir = await scratch('bm-kw-fresh-');
    const backend = new MockKeyWrapBackend();
    const authority = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });

    expect(authority.keyWrapped).toBe(true);
    expect(authority.keyWrapBackend).toBe('mock-keychain');
    expect(existsSync(join(dir, ENC_FILE))).toBe(true);
    expect(existsSync(join(dir, PEM_FILE))).toBe(false);
    // The envelope keeps the key file's 0600 posture.
    expect(statSync(join(dir, ENC_FILE)).mode & 0o777).toBe(0o600);
    // The stored secret is the whole secret — 32 bytes in the mock's "keychain".
    expect(backend.stored?.length).toBe(WRAP_SECRET_LENGTH);

    // The on-disk envelope is ciphertext, not PEM — no key material readable.
    const enc = await readFile(join(dir, ENC_FILE));
    expect(enc.toString('utf8')).not.toContain('PRIVATE KEY');
    expect(() => forge.pki.privateKeyFromPem(enc.toString('utf8'))).toThrow();

    // And the authority still does its real job end-to-end.
    const leaf = forge.pki.certificateFromPem(authority.forgeLeaf('wrap.example').certPem);
    expect(forge.pki.certificateFromPem(authority.caCertPem).verify(leaf)).toBe(true);
  });

  test('reopening unwraps with the backend secret and serves the same CA', async () => {
    const dir = await scratch('bm-kw-reopen-');
    const backend = new MockKeyWrapBackend();
    const first = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });
    const second = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });
    expect(second.caCertPem).toBe(first.caCertPem);
    expect(second.keyWrapped).toBe(true);
  });

  test('a backend holding a different secret → open refuses, fail closed', async () => {
    const dir = await scratch('bm-kw-wrong-');
    const backend = new MockKeyWrapBackend();
    const first = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });

    const wrongBackend = new MockKeyWrapBackend();
    wrongBackend.stored = randomBytes(WRAP_SECRET_LENGTH);
    await expect(
      CertAuthority.open({ storeDir: dir, keyWrapBackend: wrongBackend }),
    ).rejects.toThrow(CaKeyUnwrapError);
    // Fail closed means the store is untouched — the first authority's
    // identity is still exactly what sits on disk.
    expect(existsSync(join(dir, ENC_FILE))).toBe(true);
    expect(first.caCertPem).toContain('BEGIN CERTIFICATE');
  });

  test('enc file + no backend at all → open refuses, fail closed', async () => {
    const dir = await scratch('bm-kw-nobackend-');
    await CertAuthority.open({ storeDir: dir, keyWrapBackend: new MockKeyWrapBackend() });
    expect(existsSync(join(dir, ENC_FILE))).toBe(true);
    await expect(
      CertAuthority.open({ storeDir: dir, keyWrapBackend: null }),
    ).rejects.toThrow(CaKeyUnwrapError);
  });

  test('backend that errors at load → open refuses, fail closed', async () => {
    const dir = await scratch('bm-kw-loadfail-');
    const backend = new MockKeyWrapBackend();
    await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });
    backend.loadError = new Error('keychain unavailable');
    await expect(
      CertAuthority.open({ storeDir: dir, keyWrapBackend: backend }),
    ).rejects.toThrow(CaKeyUnwrapError);
  });

  test('a stray plaintext key beside the envelope is orphaned, not read', async () => {
    const dir = await scratch('bm-kw-stray-');
    const backend = new MockKeyWrapBackend();
    const first = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });

    const strayPem = '-----BEGIN RSA PRIVATE KEY-----\nstray\n-----END RSA PRIVATE KEY-----\n';
    await writeFile(join(dir, PEM_FILE), strayPem, 'utf8');
    const reopened = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });

    expect(reopened.caCertPem).toBe(first.caCertPem);
    expect(existsSync(join(dir, PEM_FILE))).toBe(false);
    expect(await readFile(join(dir, `${PEM_FILE}.orphan`), 'utf8')).toBe(strayPem);
  });
});

describe('plaintext → wrapped migration', () => {
  test('an existing plaintext pair wraps in place — same CA, PEM orphaned', async () => {
    const dir = await scratch('bm-kw-migrate-');
    const plaintext = await CertAuthority.open({ storeDir: dir, keyWrapBackend: null });
    const legacyKeyPem = await readFile(join(dir, PEM_FILE), 'utf8');
    const legacyCertPem = plaintext.caCertPem;

    const migrated = await CertAuthority.open({
      storeDir: dir,
      keyWrapBackend: new MockKeyWrapBackend(),
    });

    // Migration repackages the key — it must never rotate the identity.
    expect(migrated.caCertPem).toBe(legacyCertPem);
    expect(migrated.keyWrapped).toBe(true);
    expect(migrated.keyWrapBackend).toBe('mock-keychain');
    expect(existsSync(join(dir, ENC_FILE))).toBe(true);
    expect(existsSync(join(dir, PEM_FILE))).toBe(false);
    // The plaintext half is preserved under the repo's .orphan convention.
    expect(await readFile(join(dir, `${PEM_FILE}.orphan`), 'utf8')).toBe(legacyKeyPem);
    // And the migrated store keeps working.
    const leaf = forge.pki.certificateFromPem(migrated.forgeLeaf('migrate.example').certPem);
    expect(forge.pki.certificateFromPem(migrated.caCertPem).verify(leaf)).toBe(true);
  });

  test('a backend that cannot hold a secret leaves the plaintext posture', async () => {
    const dir = await scratch('bm-kw-stubborn-');
    const backend = new MockKeyWrapBackend();
    backend.storeError = new Error('keychain locked');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const authority = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });
      expect(authority.keyWrapped).toBe(false);
      expect(authority.keyWrapBackend).toBeUndefined();
      expect(existsSync(join(dir, PEM_FILE))).toBe(true);
      expect(existsSync(join(dir, ENC_FILE))).toBe(false);
      expect(warn).toHaveBeenCalled();
      // The engine is honest and still works.
      const leaf = forge.pki.certificateFromPem(authority.forgeLeaf('plain.example').certPem);
      expect(forge.pki.certificateFromPem(authority.caCertPem).verify(leaf)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('rotate and the wrap', () => {
  test('a wrapped store regenerates into a fresh envelope — never plaintext', async () => {
    const dir = await scratch('bm-kw-rotate-');
    const backend = new MockKeyWrapBackend();
    const authority = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });
    const before = authority.caCertPem;

    await authority.rotate();

    expect(authority.caCertPem).not.toBe(before);
    expect(authority.keyWrapped).toBe(true);
    expect(existsSync(join(dir, ENC_FILE))).toBe(true);
    expect(existsSync(join(dir, PEM_FILE))).toBe(false);
    const reopened = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });
    expect(reopened.caCertPem).toBe(authority.caCertPem);
    const leaf = forge.pki.certificateFromPem(reopened.forgeLeaf('post.example').certPem);
    expect(forge.pki.certificateFromPem(reopened.caCertPem).verify(leaf)).toBe(true);
  });

  test('a wrapped store whose backend dies refuses to rotate into plaintext', async () => {
    const dir = await scratch('bm-kw-deadbackend-');
    const backend = new MockKeyWrapBackend();
    const authority = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });
    const before = authority.caCertPem;
    const heldSecret = backend.stored;

    // Backend loses the entry AND cannot write a new one.
    backend.stored = null;
    backend.storeError = new Error('keychain gone');
    await expect(authority.rotate()).rejects.toThrow(CaKeyUnwrapError);

    // Persist-first posture: the on-disk envelope and in-memory identity are
    // still the original working CA.
    expect(authority.caCertPem).toBe(before);
    backend.stored = heldSecret;
    backend.storeError = null;
    const reopened = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });
    expect(reopened.caCertPem).toBe(before);
  });

  test('a plaintext store upgrades on rotate once the backend can hold a secret', async () => {
    const dir = await scratch('bm-kw-upgrade-');
    const backend = new MockKeyWrapBackend();
    backend.storeError = new Error('locked for now');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const authority = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });
      expect(authority.keyWrapped).toBe(false);

      backend.storeError = null;
      await authority.rotate();

      expect(authority.keyWrapped).toBe(true);
      expect(existsSync(join(dir, ENC_FILE))).toBe(true);
      expect(existsSync(join(dir, PEM_FILE))).toBe(false);
      const reopened = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });
      expect(reopened.caCertPem).toBe(authority.caCertPem);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('resolveBackend', () => {
  test('unknown platforms get no backend — plaintext is the honest answer', async () => {
    await expect(resolveBackend('freebsd')).resolves.toBeNull();
    await expect(resolveBackend('aix')).resolves.toBeNull();
    await expect(resolveBackend('not-a-platform')).resolves.toBeNull();
  });

  test('darwin resolves the security-CLI backend exactly on macOS', async () => {
    const backend = await resolveBackend('darwin');
    if (process.platform === 'darwin') {
      expect(backend).toBeInstanceOf(SecurityCliBackend);
      expect(backend?.name).toContain('keychain');
    } else {
      // /usr/bin/security exists nowhere else — the probe is honest.
      expect(backend).toBeNull();
    }
  });

  test('win32 resolves the DPAPI backend exactly on Windows', async () => {
    const backend = await resolveBackend('win32');
    if (process.platform === 'win32') {
      expect(backend).toBeInstanceOf(PowerShellProtectedDataBackend);
    } else {
      // powershell.exe is not on PATH outside Windows.
      expect(backend).toBeNull();
    }
  });

  test('linux resolves secret-tool only where the binary exists', async () => {
    const backend = await resolveBackend('linux');
    // Host-dependent: CI and most dev machines have no secret-tool → null;
    // a libsecret box gets the real backend. Either is a legitimate answer.
    expect(backend === null || backend instanceof SecretToolBackend).toBe(true);
  });
});

// The one leg that touches a real OS credential store — env-gated like the
// repo's other live rehearsals (dnsmasqDeployLive et al.). Runs a throwaway
// service name and deletes the entry afterwards; the production entry is
// never touched.
const runLiveKeychain = process.env.BM_LIVE_KEYCHAIN === '1' && process.platform === 'darwin';

(runLiveKeychain ? describe : describe.skip)('the real security-CLI backend (BM_LIVE_KEYCHAIN=1)', () => {
  const service = `com.blockingmachine.https-filter.test.${process.pid}`;
  const account = 'blockingmachine-test';
  const backend = new SecurityCliBackend({ service, account });

  async function deleteEntry(): Promise<void> {
    try {
      await execFileAsync('/usr/bin/security', [
        'delete-generic-password',
        '-a',
        account,
        '-s',
        service,
      ]);
    } catch {
      // Already absent — cleanup is idempotent.
    }
  }

  afterAll(deleteEntry);

  test('store → load round-trips a 32-byte secret through the login keychain', async () => {
    await deleteEntry(); // start clean regardless of prior state
    await expect(backend.load()).resolves.toBeNull();

    const secret = randomBytes(WRAP_SECRET_LENGTH);
    await backend.store(secret);
    await expect(backend.load()).resolves.toEqual(secret);

    // Re-store replaces in place (-U) rather than duplicating the entry.
    const renewed = randomBytes(WRAP_SECRET_LENGTH);
    await backend.store(renewed);
    await expect(backend.load()).resolves.toEqual(renewed);
  });

  test('a full open → wrapped store → reopen cycle against the real keychain', async () => {
    const dir = await scratch('bm-kw-live-');
    await deleteEntry();
    try {
      const authority = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });
      expect(authority.keyWrapped).toBe(true);
      expect(authority.keyWrapBackend).toBe('macos-keychain(security-cli)');
      expect(existsSync(join(dir, ENC_FILE))).toBe(true);
      expect(existsSync(join(dir, PEM_FILE))).toBe(false);

      const reopened = await CertAuthority.open({ storeDir: dir, keyWrapBackend: backend });
      expect(reopened.caCertPem).toBe(authority.caCertPem);
      const leaf = forge.pki.certificateFromPem(
        reopened.forgeLeaf('live.example').certPem,
      );
      expect(forge.pki.certificateFromPem(reopened.caCertPem).verify(leaf)).toBe(true);
    } finally {
      await deleteEntry();
    }
  });
});
