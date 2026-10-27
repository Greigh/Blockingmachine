/**
 * Per-device certificate authority + leaf forge (design spec §5.1).
 *
 * The root CA is generated on first `open` — never shipped, never leaves the
 * device — and persisted under a 0700 store dir. The private key rests in one
 * of two forms (flag 97):
 *
 *  - `ca.key.enc` — AES-256-GCM under a 32-byte wrap secret held by the OS
 *    credential store (`BMKEYWRAP1` envelope, still 0600). This is the spec's
 *    encryption-at-rest posture: the file alone mints nothing without the OS
 *    principal that owns the wrap secret.
 *  - `ca.key.pem` — 0600 plaintext, the fallback when the platform offers no
 *    usable wrap backend (and the legacy layout existing stores started as).
 *
 * `open` unwraps `ca.key.enc` fail-closed — no backend, no stored secret, or
 * a failed GCM tag throws {@link CaKeyUnwrapError} rather than minting over
 * an installed trust root (spec §7). A plaintext pair migrates forward: the
 * key is wrapped and the PEM orphaned the first time a backend resolves.
 * `keyWrapped`/`keyWrapBackend` on the authority say which form is live.
 *
 * Leaves are minted per trusted SNI (RSA-2048, 30-day, SAN dns=<sni>,
 * serverAuth EKU), signed by the CA, and cached in an LRU so hot hosts never
 * re-pay the RSA keygen. `rotate()` replaces the CA and clears the leaf
 * cache — no leaf ever survives its issuer — and re-wraps: the new key
 * lands in the same storage form the old one had, and a wrapped store
 * refuses to rotate into plaintext (never silently downgrades).
 *
 * All x509 work goes through the vendored `node-forge`; its RSA keygen defers
 * to Node's native `crypto.generateKeyPair(Sync)`, so nothing here does pure-JS
 * big-int work. A present-but-unparseable CA store — or a parseable pair whose
 * cert and key don't correspond — throws out of `open` (the proxy refuses to
 * start rather than silently mint over a corrupt store, spec §7); a
 * half-written store regenerates, preserving the orphan half as `.orphan`.
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import forge from 'node-forge';
import {
  CA_KEY_ENC_FILENAME,
  CA_KEY_PEM_FILENAME,
  CaKeyUnwrapError,
  resolveBackend,
  unwrapKeyMaterial,
  wrapKeyMaterial,
  WRAP_SECRET_LENGTH,
  type KeyWrapBackend,
} from './keyWrap.js';

export interface LeafMaterial {
  certPem: string;
  keyPem: string;
}

const CA_CERT_FILENAME = 'ca.pem';
const CA_KEY_FILENAME = CA_KEY_PEM_FILENAME; // 'ca.key.pem'
const CA_KEY_WRAP_FILENAME = CA_KEY_ENC_FILENAME; // 'ca.key.enc'

const LEAF_CACHE_LIMIT = 500;
const CA_VALIDITY_MS = 10 * 365.25 * 24 * 60 * 60 * 1000; // 10 years
const LEAF_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Backdates absorb client clock skew: a leaf minted against a client whose
// clock runs a minute fast must not read as not-yet-valid.
const CA_NOT_BEFORE_SKEW_MS = 60 * 60 * 1000;
const LEAF_NOT_BEFORE_SKEW_MS = 5 * 60 * 1000;

const CA_SUBJECT: forge.pki.CertificateField[] = [
  { name: 'commonName', value: 'Blockingmachine HTTPS Filter CA' },
  { name: 'organizationName', value: 'Greigh Studios LLC' },
];

/**
 * How the CA key rests on disk for this authority instance.
 *
 *  - `wrapped` — `ca.key.enc` is the live key file. `backend` is the OS
 *    store that supplied the wrap secret (kept so `rotate` can re-wrap
 *    without re-resolving).
 *  - `auto` — true when `open` resolved the backend itself; `rotate` then
 *    re-resolves so a backend that appeared since is an upgrade. An
 *    injected backend (`open`'s `keyWrapBackend` — null meaning "forced
 *    plaintext", e.g. tests) is sticky: `rotate` reuses exactly it.
 */
interface KeyWrapState {
  wrapped: boolean;
  backend: KeyWrapBackend | null;
  auto: boolean;
}

export interface CertAuthorityOpenOptions {
  storeDir: string;
  /**
   * The OS key-wrap backend for `ca.key.enc`. `undefined` (the default)
   * resolves the platform backend via {@link resolveBackend}; an explicit
   * `null` forces the plaintext 0600 posture; an explicit backend is used
   * as given (the test seam — a mock store exercises the whole wrap path
   * without touching a real keychain).
   */
  keyWrapBackend?: KeyWrapBackend | null;
}

/**
 * SNI gate: per-label [a-z0-9-] (case-insensitive), labels ≤63 chars, total
 * ≤253, at least one dot — or the literal `localhost`. Trailing/leading/double
 * dots leave an empty label and fail; anything else (spaces, `!`, underscores)
 * fails the charset. IPv4 literals and all-numeric final labels are not DNS
 * names either — the proxy passthroughs those flows rather than mint a
 * dNSName leaf for an address.
 */
/**
 * SNI normalization for verdict/policy/compare use — DNS is case-insensitive
 * and wire SNI may carry a trailing dot (FQDN form). This does not validate;
 * {@link isValidSni} is the forge gate. `blocked.com.` and `Blocked.COM` both
 * normalize to `blocked.com` so the same name is judged, pinned, and forged.
 */
export function normalizeSni(sni: string): string {
  return sni.toLowerCase().replace(/\.+$/, '');
}

export function isValidSni(sni: string): boolean {
  if (sni === 'localhost') {
    return true;
  }
  if (sni.length === 0 || sni.length > 253 || !sni.includes('.')) {
    return false;
  }
  const labels = sni.split('.');
  if (!labels.every((label) => label.length <= 63 && /^[a-z0-9-]+$/i.test(label))) {
    return false;
  }
  // isIPv4 catches real dotted-quads; the numeric-final-label rule catches
  // IP-shaped misses like `1.2.3.999` and all-numeric "TLDs", neither of which
  // is a DNS name a CA may issue for.
  if (isIPv4(sni) || /^\d+$/.test(labels[labels.length - 1])) {
    return false;
  }
  return true;
}

/**
 * 16 random bytes with the top bit forced clear — the serial lands verbatim in
 * the cert's DER INTEGER (x509.js `hexToBytes`), so an unmasked high bit would
 * encode negative; `|| 0x01` keeps a zero first byte minimal-encoding-legal.
 */
function randomSerialHex(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) || 0x01;
  return bytes.toString('hex');
}

function generateRsaKeyPair(): Promise<forge.pki.rsa.KeyPair> {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048 }, (err, keypair) => {
      if (err) {
        reject(err);
      } else {
        resolve(keypair);
      }
    });
  });
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

async function readBufferIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/** The `.orphan` convention for one path — absent is not an error. */
async function orphanIfExists(path: string): Promise<void> {
  try {
    await rename(path, `${path}.orphan`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * The cert/key correspondence check every loaded pair must pass — a crash
 * mid-rotate can leave a new key beside the old cert, and every leaf minted
 * from a mismatched pair fails chain verification. `publicKeyToPem` emits
 * deterministic SPKI, so equal keys compare equal.
 */
function assertCaPair(
  caCert: forge.pki.Certificate,
  caKey: forge.pki.rsa.PrivateKey,
  storeDir: string,
): void {
  const certPubPem = forge.pki.publicKeyToPem(caCert.publicKey);
  const keyPubPem = forge.pki.publicKeyToPem(forge.pki.setRsaPublicKey(caKey.n, caKey.e));
  if (certPubPem !== keyPubPem) {
    throw new Error(
      `Blockingmachine CA store at ${storeDir} is inconsistent: ` +
        `${CA_CERT_FILENAME} and the CA key are not the same pair`,
    );
  }
}

/**
 * Load the wrap secret from a backend, minting and storing a fresh one when
 * the store holds none (first wrap, or a lost entry — self-healing). Any
 * backend failure — unreachable store, refused write — answers `null` so
 * the caller degrades to plaintext; a backend that resolved but cannot hold
 * a secret must not turn a working plaintext store into a thrown `open`.
 *
 * The post-store re-`load` is load-bearing, not paranoia: two opens racing
 * their first wrap each see "no secret", generate, and store — and on a
 * last-write-wins store (the keychain's `-U`), the loser's generated secret
 * is gone before its envelope is even written. Persisting under a secret
 * the store no longer holds would brick `ca.key.enc` on the next open.
 * Re-reading returns whichever secret actually won — or `null` when the
 * store is too broken to read back what it just claimed to write.
 */
async function acquireWrapSecret(backend: KeyWrapBackend): Promise<Buffer | null> {
  try {
    const existing = await backend.load();
    if (existing !== null && existing.length === WRAP_SECRET_LENGTH) {
      return existing;
    }
    await backend.store(randomBytes(WRAP_SECRET_LENGTH));
    const settled = await backend.load();
    return settled !== null && settled.length === WRAP_SECRET_LENGTH ? settled : null;
  } catch {
    return null;
  }
}

export class CertAuthority {
  private caCert: forge.pki.Certificate;
  private caKey: forge.pki.rsa.PrivateKey;
  private caKeyIdentifier: string;
  private caPem: string;
  private readonly storeDir: string;
  private keyWrap: KeyWrapState;
  private readonly leafCache = new Map<string, LeafMaterial>();
  /**
   * The in-flight rotation, when one is running — `rotate` persists through
   * shared `*.tmp` paths, so a second concurrent call must never interleave
   * its writes; it awaits this same outcome instead (one rotation, one
   * consistent store).
   */
  private rotateInFlight: Promise<void> | null = null;

  private constructor(
    storeDir: string,
    caCert: forge.pki.Certificate,
    caKey: forge.pki.rsa.PrivateKey,
    keyWrap: KeyWrapState,
  ) {
    this.storeDir = storeDir;
    this.caCert = caCert;
    this.caKey = caKey;
    this.keyWrap = keyWrap;
    this.caKeyIdentifier = caCert.generateSubjectKeyIdentifier().getBytes();
    this.caPem = forge.pki.certificateToPem(caCert);
  }

  get caCertPem(): string {
    return this.caPem;
  }

  /**
   * Whether the on-disk CA key is the `ca.key.enc` envelope (AES-256-GCM
   * under an OS-stored secret) rather than `ca.key.pem` plaintext — spec
   * §5.1's encryption-at-rest signal, surfaced on `GET /v1/proxy/ca`.
   */
  get keyWrapped(): boolean {
    return this.keyWrap.wrapped;
  }

  /** Backend name behind the wrap (e.g. `macos-keychain(security-cli)`), or `undefined` on a plaintext store. */
  get keyWrapBackend(): string | undefined {
    return this.keyWrap.wrapped ? (this.keyWrap.backend?.name ?? undefined) : undefined;
  }

  static async open(opts: CertAuthorityOpenOptions): Promise<CertAuthority> {
    const { storeDir } = opts;
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to dirs it creates — pin it on reopen too.
    await chmod(storeDir, 0o700);

    const certPath = join(storeDir, CA_CERT_FILENAME);
    const keyPath = join(storeDir, CA_KEY_FILENAME);
    const encPath = join(storeDir, CA_KEY_WRAP_FILENAME);
    const certPem = await readIfExists(certPath);
    const keyPem = await readIfExists(keyPath);
    const encBlob = await readBufferIfExists(encPath);

    // `undefined` resolves the platform backend; an explicit value — a real
    // backend or forced-off null — is used verbatim (and sticks for rotate).
    const autoBackend = opts.keyWrapBackend === undefined;
    const backend: KeyWrapBackend | null = autoBackend
      ? await resolveBackend(process.platform, { storeDir })
      : (opts.keyWrapBackend ?? null);

    if (encBlob !== null) {
      if (certPem !== null) {
        // Wrapped store — the key only exists behind the OS secret. Fail
        // closed on every unwrap problem (spec §7): an unusable envelope
        // must never silently mint a new CA under an installed trust root.
        const caKey = await unwrapStoredCaKey(encBlob, backend, encPath);
        // Parse failures propagate — same refuse-to-start posture as the
        // plaintext path.
        const caCert = forge.pki.certificateFromPem(certPem);
        assertCaPair(caCert, caKey, storeDir);
        // Re-pin the mode on load — a restored/copied envelope may carry
        // looser bits; the ciphertext is still the whole secret surface.
        await chmod(encPath, 0o600);
        // A plaintext key beside a live envelope is migration debris from
        // an interrupted wrap — the envelope is authoritative; the PEM is
        // preserved, never read.
        await orphanIfExists(keyPath);
        return new CertAuthority(storeDir, caCert, caKey, {
          wrapped: true,
          backend,
          auto: autoBackend,
        });
      }
      // Lone envelope half — a torn store's debris. Same convention as a
      // lone PEM key: preserved, never read, fresh pair generated below.
      await orphanIfExists(encPath);
    }

    if (certPem !== null && keyPem !== null) {
      // Both present: parse failures propagate — a corrupt CA store refuses
      // to start rather than silently regenerating under an installed trust
      // root.
      const caCert = forge.pki.certificateFromPem(certPem);
      const caKey = forge.pki.privateKeyFromPem(keyPem);
      assertCaPair(caCert, caKey, storeDir);
      // Migration (flag 97): this pair predates the wrap — seal it now under
      // the backend's secret, write the envelope, orphan the PEM. The same
      // CA keeps serving (this is a repackaging, not a rotation). No usable
      // backend leaves the plaintext posture as it was.
      if (await tryPersistWrapped(storeDir, backend, caCert, caKey)) {
        return new CertAuthority(storeDir, caCert, caKey, {
          wrapped: true,
          backend,
          auto: autoBackend,
        });
      }
      // Re-pin the mode on load: writeFile only applies it at create time,
      // and a restored/copied store may carry looser bits.
      await chmod(keyPath, 0o600);
      return new CertAuthority(storeDir, caCert, caKey, {
        wrapped: false,
        backend,
        auto: autoBackend,
      });
    }

    // Fresh dir or half-written store: either way there is no usable pair.
    // An orphan key is preserved, not truncated — if the cert was manually
    // trusted and its file lost, this key is that CA's only copy. An orphan
    // cert gets the same treatment for forensics; `.orphan` files are inert
    // (nothing reads them) and latest-wins on repeat events.
    await orphanIfExists(keyPath);
    await orphanIfExists(certPath);
    const { cert, key } = await generateCaIdentity();
    const wrapped = await tryPersistWrapped(storeDir, backend, cert, key);
    if (!wrapped) {
      await persistCaFiles(storeDir, cert, key);
    }
    // The backend is retained even when the wrap failed — it stays the
    // authority's wrap channel so a later `rotate` can retry the upgrade.
    return new CertAuthority(storeDir, cert, key, {
      wrapped,
      backend,
      auto: autoBackend,
    });
  }

  forgeLeaf(sni: string): LeafMaterial {
    if (!isValidSni(sni)) {
      throw new Error(`cannot forge leaf for invalid SNI: ${JSON.stringify(sni)}`);
    }
    // DNS is case-insensitive: normalize so cache hits and SANs are stable.
    const host = sni.toLowerCase();

    const cached = this.leafCache.get(host);
    if (cached) {
      // Map preserves insertion order: delete + set marks the entry MRU.
      this.leafCache.delete(host);
      this.leafCache.set(host, cached);
      return cached;
    }

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.serialNumber = randomSerialHex();
    const now = Date.now();
    cert.validity.notBefore = new Date(now - LEAF_NOT_BEFORE_SKEW_MS);
    cert.validity.notAfter = new Date(now + LEAF_VALIDITY_MS);
    cert.setSubject([{ name: 'commonName', value: host }]);
    cert.setIssuer(this.caCert.subject.attributes);
    cert.publicKey = keys.publicKey;
    cert.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        critical: true,
      },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [{ type: 2, value: host }], // 2 = dNSName
      },
      { name: 'subjectKeyIdentifier' },
      { name: 'authorityKeyIdentifier', keyIdentifier: this.caKeyIdentifier },
    ]);
    cert.sign(this.caKey, forge.md.sha256.create());

    const material: LeafMaterial = {
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    };

    if (this.leafCache.size >= LEAF_CACHE_LIMIT) {
      const oldest = this.leafCache.keys().next();
      if (!oldest.done) {
        this.leafCache.delete(oldest.value);
      }
    }
    this.leafCache.set(host, material);
    return material;
  }

  /**
   * Replace the CA identity, serialized: two rotations racing would share
   * the `ca.pem.tmp`/`ca.key.*.tmp` paths and could interleave into a torn
   * store (one rotation's cert beside the other's key). A second call while
   * one is in flight awaits the same outcome rather than running a parallel
   * persist — one rotation settles, then the next call rotates cleanly.
   */
  async rotate(): Promise<void> {
    if (this.rotateInFlight !== null) {
      return this.rotateInFlight;
    }
    const rotation = this.rotateOnce();
    this.rotateInFlight = rotation;
    try {
      await rotation;
    } finally {
      this.rotateInFlight = null;
    }
  }

  private async rotateOnce(): Promise<void> {
    // Persist before swapping in-memory state: a failed write leaves the
    // previous (working) CA live instead of a forged-nowhere identity.
    const { cert, key } = await generateCaIdentity();

    // Re-wrap in the same form the store opened with. An auto-resolved
    // backend re-resolves (a backend that appeared since is an upgrade);
    // an injected one is reused verbatim. A wrapped store whose backend can
    // no longer supply a secret refuses to rotate into plaintext — the
    // storage posture never silently downgrades, so `keyWrapped` can go
    // false → true but never true → false without a deliberate delete.
    const backend = this.keyWrap.auto
      ? await resolveBackend(process.platform, { storeDir: this.storeDir })
      : this.keyWrap.backend;
    const secret = backend !== null ? await acquireWrapSecret(backend) : null;

    if (secret !== null) {
      await persistWrappedCa(this.storeDir, cert, key, secret);
      this.keyWrap = { wrapped: true, backend, auto: this.keyWrap.auto };
    } else {
      if (this.keyWrap.wrapped) {
        throw new CaKeyUnwrapError(
          'the OS key-wrap backend can no longer supply the wrap secret — ' +
            'refusing to rotate the CA key into plaintext',
        );
      }
      if (backend !== null) {
        console.warn(
          `[https-filter] key-wrap backend ${backend.name} cannot hold the ` +
            'wrap secret — rotated CA key persists as 0600 plaintext',
        );
      }
      await persistCaFiles(this.storeDir, cert, key);
      // Retain the backend — it stays the wrap channel so the next rotate
      // retries the upgrade instead of settling into permanent plaintext.
      this.keyWrap = { wrapped: false, backend, auto: this.keyWrap.auto };
    }

    this.caCert = cert;
    this.caKey = key;
    this.caKeyIdentifier = cert.generateSubjectKeyIdentifier().getBytes();
    this.caPem = forge.pki.certificateToPem(cert);
    this.leafCache.clear();
  }
}

/**
 * Unwrap `ca.key.enc` into a private key — every failure path throws the
 * same {@link CaKeyUnwrapError} so `open` fails closed, whether the problem
 * is "no backend", "no stored secret", or "blob did not authenticate".
 */
async function unwrapStoredCaKey(
  blob: Buffer,
  backend: KeyWrapBackend | null,
  encPath: string,
): Promise<forge.pki.rsa.PrivateKey> {
  if (backend === null) {
    throw new CaKeyUnwrapError(
      `CA key envelope at ${encPath} requires an OS key-wrap backend that ` +
        'this platform does not provide — refusing to start rather than mint ' +
        'over an unreadable store. Remove ca.key.enc and ca.pem to regenerate ' +
        '(the trust-root install must be repeated).',
    );
  }
  let secret: Buffer | null;
  try {
    secret = await backend.load();
  } catch (err) {
    throw new CaKeyUnwrapError(
      `key-wrap backend ${backend.name} failed to load the wrap secret for ${encPath}`,
      { cause: err },
    );
  }
  if (secret === null) {
    throw new CaKeyUnwrapError(
      `key-wrap backend ${backend.name} holds no wrap secret for ${encPath} — ` +
        'the OS credential entry may have been deleted. Remove ca.key.enc and ' +
        'ca.pem to regenerate (the trust-root install must be repeated).',
    );
  }
  const keyPem = unwrapKeyMaterial(blob, secret).toString('utf8');
  // A GCM-authenticated blob yields exactly what was wrapped — a forge
  // parse error here is corruption upstream of the envelope, not plaintext.
  return forge.pki.privateKeyFromPem(keyPem);
}

/**
 * Wrap `key`'s PEM under the backend's secret and persist `ca.key.enc` +
 * `ca.pem`, orphaning the legacy PEM only after the envelope is durable.
 * Answers false — plaintext posture — when the backend is absent or cannot
 * hold a secret.
 */
async function tryPersistWrapped(
  storeDir: string,
  backend: KeyWrapBackend | null,
  cert: forge.pki.Certificate,
  key: forge.pki.rsa.PrivateKey,
): Promise<boolean> {
  if (backend === null) {
    return false;
  }
  const secret = await acquireWrapSecret(backend);
  if (secret === null) {
    console.warn(
      `[https-filter] key-wrap backend ${backend.name} cannot hold the ` +
        'wrap secret — CA key persists as 0600 plaintext',
    );
    return false;
  }
  try {
    await persistWrappedCa(storeDir, cert, key, secret);
  } catch (err) {
    // A torn envelope persist cannot leave an inconsistent store — the
    // envelope rename is atomic, and the PEM orphan only happens after it —
    // so the plaintext fallback here always lands on a coherent pair.
    console.warn(
      `[https-filter] wrapped persist of the CA key failed — ` +
        'CA key persists as 0600 plaintext:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
  return true;
}

async function persistCaFiles(
  storeDir: string,
  cert: forge.pki.Certificate,
  key: forge.pki.rsa.PrivateKey,
): Promise<void> {
  const keyPath = join(storeDir, CA_KEY_FILENAME);
  const certPath = join(storeDir, CA_CERT_FILENAME);
  // tmp-then-rename per file: a crash mid-persist can still split the pair
  // (a new key beside the old cert — which open()'s correspondence check
  // catches), but a same-dir rename is atomic on POSIX, so a torn half-file
  // can never reach the real paths.
  const keyTmp = `${keyPath}.tmp`;
  const certTmp = `${certPath}.tmp`;
  // writeFile's mode only applies on create — chmod pins it regardless.
  await writeFile(keyTmp, forge.pki.privateKeyToPem(key), { mode: 0o600 });
  await chmod(keyTmp, 0o600);
  await writeFile(certTmp, forge.pki.certificateToPem(cert), 'utf8');
  await rename(keyTmp, keyPath);
  await rename(certTmp, certPath);
  // A plaintext store must never sit beside a stale envelope — the envelope
  // is authoritative at open, so a leftover would unwrap to the wrong key
  // and wedge the store on the next start. Orphan it like any half-store.
  await orphanIfExists(join(storeDir, CA_KEY_WRAP_FILENAME));
}

/**
 * The wrapped counterpart of {@link persistCaFiles}: envelope first, cert
 * second, and the legacy PEM orphaned only after the new form is durable —
 * so a crash between the renames leaves a still-consistent plaintext pair
 * that re-migrates on next open rather than an unpaired envelope.
 */
async function persistWrappedCa(
  storeDir: string,
  cert: forge.pki.Certificate,
  key: forge.pki.rsa.PrivateKey,
  secret: Buffer,
): Promise<void> {
  const encPath = join(storeDir, CA_KEY_WRAP_FILENAME);
  const certPath = join(storeDir, CA_CERT_FILENAME);
  const encTmp = `${encPath}.tmp`;
  const certTmp = `${certPath}.tmp`;
  const blob = wrapKeyMaterial(
    Buffer.from(forge.pki.privateKeyToPem(key), 'utf8'),
    secret,
  );
  await writeFile(encTmp, blob, { mode: 0o600 });
  await chmod(encTmp, 0o600);
  await writeFile(certTmp, forge.pki.certificateToPem(cert), 'utf8');
  await rename(encTmp, encPath);
  await rename(certTmp, certPath);
  await orphanIfExists(join(storeDir, CA_KEY_FILENAME));
}

async function generateCaIdentity(): Promise<{
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
}> {
  const keys = await generateRsaKeyPair();
  const cert = forge.pki.createCertificate();
  cert.serialNumber = randomSerialHex();
  const now = Date.now();
  cert.validity.notBefore = new Date(now - CA_NOT_BEFORE_SKEW_MS);
  cert.validity.notAfter = new Date(now + CA_VALIDITY_MS);
  cert.setSubject(CA_SUBJECT);
  cert.setIssuer(CA_SUBJECT); // self-signed
  cert.publicKey = keys.publicKey;
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}
