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
 * big-int work. A present-but-unparseable CA store throws out of `open` (the
 * proxy refuses to start rather than silently minting over a corrupt store —
 * spec §7); a half-written store (crash between the two file writes) is
 * treated as fresh state and regenerated.
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
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
 * fails the charset. The proxy's passthrough path relies on this never letting
 * a non-DNS-name through to `forgeLeaf`.
 */
export function isValidSni(sni: string): boolean {
  if (sni === 'localhost') {
    return true;
  }
  if (sni.length === 0 || sni.length > 253 || !sni.includes('.')) {
    return false;
  }
  return sni
    .split('.')
    .every((label) => label.length <= 63 && /^[a-z0-9-]+$/i.test(label));
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

    const certPem = await readIfExists(join(storeDir, CA_CERT_FILENAME));
    const keyPem = await readIfExists(join(storeDir, CA_KEY_FILENAME));

    if (certPem !== null && keyPem !== null) {
      // Both present: parse failures propagate — a corrupt CA store refuses to
      // start rather than silently regenerating under an installed trust root.
      const caCert = forge.pki.certificateFromPem(certPem);
      const caKey = forge.pki.privateKeyFromPem(keyPem);
      return new CertAuthority(storeDir, caCert, caKey);
    }

    // Fresh dir or half-written store: either way there is no usable pair, so
    // generate — the CA was never trusted anywhere if its key never landed.
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
  // writeFile's mode only applies on create — chmod pins it on overwrite too.
  await writeFile(keyPath, forge.pki.privateKeyToPem(key), { mode: 0o600 });
  await chmod(keyPath, 0o600);
  await writeFile(
    join(storeDir, CA_CERT_FILENAME),
    forge.pki.certificateToPem(cert),
    'utf8',
  );
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
