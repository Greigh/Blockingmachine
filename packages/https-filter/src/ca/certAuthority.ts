/**
 * Per-device certificate authority + leaf forge (design spec §5.1).
 *
 * The root CA is generated on first `open` — never shipped, never leaves the
 * device — and persisted as `ca.pem` + `ca.key.pem` under a 0700 store dir with
 * the private key at 0600. Leaves are minted per trusted SNI (RSA-2048,
 * 30-day, SAN dns=<sni>, serverAuth EKU), signed by the CA, and cached in an
 * LRU so hot hosts never re-pay the RSA keygen. `rotate()` replaces the CA and
 * clears the leaf cache — no leaf ever survives its issuer.
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

export interface LeafMaterial {
  certPem: string;
  keyPem: string;
}

const CA_CERT_FILENAME = 'ca.pem';
const CA_KEY_FILENAME = 'ca.key.pem';

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

export class CertAuthority {
  private caCert: forge.pki.Certificate;
  private caKey: forge.pki.rsa.PrivateKey;
  private caKeyIdentifier: string;
  private caPem: string;
  private readonly storeDir: string;
  private readonly leafCache = new Map<string, LeafMaterial>();

  private constructor(
    storeDir: string,
    caCert: forge.pki.Certificate,
    caKey: forge.pki.rsa.PrivateKey,
  ) {
    this.storeDir = storeDir;
    this.caCert = caCert;
    this.caKey = caKey;
    this.caKeyIdentifier = caCert.generateSubjectKeyIdentifier().getBytes();
    this.caPem = forge.pki.certificateToPem(caCert);
  }

  get caCertPem(): string {
    return this.caPem;
  }

  static async open(opts: { storeDir: string }): Promise<CertAuthority> {
    const { storeDir } = opts;
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to dirs it creates — pin it on reopen too.
    await chmod(storeDir, 0o700);

    const certPath = join(storeDir, CA_CERT_FILENAME);
    const keyPath = join(storeDir, CA_KEY_FILENAME);
    const certPem = await readIfExists(certPath);
    const keyPem = await readIfExists(keyPath);

    if (certPem !== null && keyPem !== null) {
      // Both present: parse failures propagate — a corrupt CA store refuses to
      // start rather than silently regenerating under an installed trust root.
      const caCert = forge.pki.certificateFromPem(certPem);
      const caKey = forge.pki.privateKeyFromPem(keyPem);
      // Parseable is not enough: a crash mid-rotate can leave a new key beside
      // the old cert — every forged leaf would then fail chain verification.
      // publicKeyToPem emits deterministic SPKI, so equal keys compare equal.
      const certPubPem = forge.pki.publicKeyToPem(caCert.publicKey);
      const keyPubPem = forge.pki.publicKeyToPem(
        forge.pki.setRsaPublicKey(caKey.n, caKey.e),
      );
      if (certPubPem !== keyPubPem) {
        throw new Error(
          `Blockingmachine CA store at ${storeDir} is inconsistent: ` +
            `${CA_CERT_FILENAME} and ${CA_KEY_FILENAME} are not the same pair`,
        );
      }
      // Re-pin the mode on load: writeFile only applies it at create time, and
      // a restored/copied store may carry looser bits.
      await chmod(keyPath, 0o600);
      return new CertAuthority(storeDir, caCert, caKey);
    }

    // Fresh dir or half-written store: either way there is no usable pair.
    // An orphan key is preserved, not truncated — if the cert was manually
    // trusted and its file lost, this key is that CA's only copy. An orphan
    // cert gets the same treatment for forensics; `.orphan` files are inert
    // (nothing reads them) and latest-wins on repeat events.
    if (keyPem !== null) {
      await rename(keyPath, `${keyPath}.orphan`);
    }
    if (certPem !== null) {
      await rename(certPath, `${certPath}.orphan`);
    }
    const { cert, key } = await generateCaIdentity();
    await persistCaFiles(storeDir, cert, key);
    return new CertAuthority(storeDir, cert, key);
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

  async rotate(): Promise<void> {
    // Persist before swapping in-memory state: a failed write leaves the
    // previous (working) CA live instead of a forged-nowhere identity.
    const { cert, key } = await generateCaIdentity();
    await persistCaFiles(this.storeDir, cert, key);
    this.caCert = cert;
    this.caKey = key;
    this.caKeyIdentifier = cert.generateSubjectKeyIdentifier().getBytes();
    this.caPem = forge.pki.certificateToPem(cert);
    this.leafCache.clear();
  }
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
