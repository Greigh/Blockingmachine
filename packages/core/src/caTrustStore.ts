/**
 * OS trust-store operations on the HTTPS-filter proxy CA (P1 Task 4).
 *
 * The proxy engine runs as the `_blockingmachine` user under the macOS capture
 * install, so it cannot write the user's login keychain — trust install is a
 * user-session operation owned by the app/CLI, which is why these live in
 * `core` (the shared dep both already carry) rather than in the engine.
 *
 * Darwin semantics below were verified live on this machine (macOS, `security`
 * CLI):
 *
 * - `find-certificate -a -c <CN>` exits **0 whether or not it matches** — the
 *   absent case is empty stdout, so presence is judged by the printed
 *   `SHA-256 hash:` lines (from `-Z`) matching the PEM's fingerprint, which
 *   also refuses a same-common-name impostor.
 * - `verify-cert -c <file>` (basic policy, NO `-p ssl` — a CA carries no
 *   serverAuth EKU, so even the real ISRG root fails that policy) exits 0 only
 *   when the cert validates to a trust root: ISRG Root X1 passes, a
 *   present-but-untrusted cert exits 1 (`CSSMERR_TP_NOT_TRUSTED`), and an
 *   absent cert fails identically — hence find-certificate must run first.
 * - `add-trusted-cert -d -r trustRoot -k <login.keychain-db> <file>` needs
 *   authorization; in a session that cannot surface the consent prompt it
 *   fails `SecTrustSettingsSetTrustSettings: The authorization was denied.`
 *   (exit 1) — but the certificate still lands in the keychain untrusted, so a
 *   `needs-admin` result may leave `installed-untrusted` state behind.
 * - `delete-certificate -t -Z <sha256>` removes the cert AND its user-domain
 *   trust settings in one op with no authorization needed (verified: exit 0,
 *   cert gone). Admin-domain settings (what `-d` writes) need
 *   `remove-trusted-cert -d`, which answers "item could not be found" when
 *   none exist.
 *
 * win32/linux return 'unsupported' — a named P3 stub, not a half-implementation.
 */

import { execFile } from "node:child_process";
import { X509Certificate, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Outcome of probing the OS trust store for the proxy CA. */
export type CaTrustState =
  /** Chain validation reaches a trust root — TLS will verify. */
  | "trusted"
  /** In the keychain but NOT anchored as a trust root. */
  | "installed-untrusted"
  /** No keychain copy whose SHA-256 matches this PEM. */
  | "absent"
  /** This platform has no implemented trust-store ops (P3). */
  | "unsupported";

export type CaInstallOutcome = "installed" | "needs-admin" | "unsupported";
export type CaRemoveOutcome = "removed" | "absent" | "unsupported";

/** Normalized result of one `security` invocation — exit 0 or not, never throws for a nonzero exit. */
export interface SecurityRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn seam — takes `security`'s argv (execFile-style, never a shell string)
 * and resolves with the normalized result. Injectable so unit tests never
 * touch a real keychain; spawn-level failures (missing binary, timeout kill)
 * reject rather than masquerade as a command result.
 */
export type SecurityRunner = (args: string[]) => Promise<SecurityRunResult>;

export interface CaTrustStoreOptions {
  runner?: SecurityRunner;
  /** Test seam — force a platform answer (e.g. the 'unsupported' leg on darwin). */
  platform?: NodeJS.Platform;
  /** HOME override for the login keychain path; falls back to process.env.HOME then os.homedir(). */
  homeDir?: string;
  /** Tmp-PEM directory override — tests point it at a known dir to assert cleanup. */
  tmpDir?: string;
}

const SECURITY_TIMEOUT_MS = 10_000;

/** The default runner: `security <args>`, no shell, 10s bound, stderr captured. */
function defaultSecurityRunner(args: string[]): Promise<SecurityRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      args,
      { timeout: SECURITY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          // Spawn-level failure: ENOENT, EACCES, or a timeout kill (`code`
          // is null/non-numeric there, `killed` may be set). A nonzero exit
          // is a *result*; a missing or killed binary is not.
          reject(
            new Error(
              `security ${args[0] ?? ""} could not run: ${error.message}`,
            ),
          );
          return;
        }
        resolve({
          code: error ? ((error as { code: number }).code ?? 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

function resolveRunner(opts?: CaTrustStoreOptions): SecurityRunner {
  return opts?.runner ?? defaultSecurityRunner;
}

function resolvePlatform(opts?: CaTrustStoreOptions): NodeJS.Platform {
  return opts?.platform ?? process.platform;
}

/** `$HOME/Library/Keychains/login.keychain-db`, with the HOME fallback chain the spec asks for. */
export function macOsLoginKeychainPath(homeDir?: string): string {
  const home = homeDir ?? process.env.HOME ?? os.homedir();
  return path.join(home, "Library", "Keychains", "login.keychain-db");
}

/** Extract the CN RDN from an `X509Certificate.subject` string — never guessed. */
export function commonNameFromSubject(subject: string): string | null {
  // Node renders multi-RDN subjects newline-separated (`C=US\nO=…\nCN=…`);
  // comma-separated spellings and RFC2253 `\,` escapes are both handled.
  const match = /(?:^|[\n,])\s*CN=((?:\\.|[^\\\n,])*)/.exec(subject);
  if (!match) return null;
  const cn = match[1].replace(/\\(.)/g, "$1").trim();
  return cn.length > 0 ? cn : null;
}

/** The identity a keychain op keys on: CN for `find -c`, SHA-256 for exact-match. */
function caIdentity(caPem: string): { commonName: string; fingerprint256: string } {
  // Throws on non-PEM/garbage — callers surface that honestly.
  const cert = new X509Certificate(caPem);
  const commonName = commonNameFromSubject(cert.subject);
  if (!commonName) {
    throw new Error(
      "CA certificate subject carries no CN — the keychain lookup needs a name to search by",
    );
  }
  return {
    commonName,
    // X509Certificate renders colon-pairs; `security -Z` prints bare uppercase hex.
    fingerprint256: cert.fingerprint256.replace(/:/g, "").toUpperCase(),
  };
}

/** `SHA-256 hash: <HEX>` lines from `find-certificate -Z` output. */
function sha256HashesIn(stdout: string): string[] {
  const hashes: string[] = [];
  for (const match of stdout.matchAll(/^SHA-256 hash:\s*([0-9A-Fa-f]+)/gm)) {
    hashes.push(match[1].toUpperCase());
  }
  return hashes;
}

/** True when a `find-certificate -Z -a -c <CN>` result contains this exact cert. */
function certPresentInFindOutput(stdout: string, fingerprint256: string): boolean {
  return sha256HashesIn(stdout).includes(fingerprint256);
}

/**
 * The messages macOS emits when the trust-write cannot get authorization in
 * this context — verified live: `SecTrustSettingsSetTrustSettings: The
 * authorization was denied.` These all mean "the unprivileged spawn cannot
 * complete here" → the caller escalates (osascript/sudo). Note `security`
 * prints them on stderr AND still files the cert into the keychain.
 */
const NEEDS_ADMIN_PATTERN =
  /authorization was denied|errSecAuthFailed|interaction is not allowed|not authorized|permission denied|operation not permitted|user canceled|requires? (?:an? )?admin/i;

function isAuthorizationFailure(result: SecurityRunResult): boolean {
  return NEEDS_ADMIN_PATTERN.test(result.stderr) || NEEDS_ADMIN_PATTERN.test(result.stdout);
}

/** stderr/stdout trimmed to one line — never carries cert bytes (argv is paths/flags only). */
function sanitizeToolError(result: SecurityRunResult): string {
  const raw = (result.stderr || result.stdout || `exit ${result.code}`).trim();
  return raw.replace(/\s+/g, " ").slice(0, 300);
}

/**
 * The PEM has to land on disk for `security` to consume it — 0600 in the
 * system tmp dir (or the test-injected one), random name, always unlinked.
 */
async function withTmpPem<T>(
  caPem: string,
  tmpDir: string | undefined,
  fn: (pemPath: string) => Promise<T>,
): Promise<T> {
  const dir = tmpDir ?? os.tmpdir();
  const pemPath = path.join(
    dir,
    `bm-ca-${process.pid}-${randomBytes(6).toString("hex")}.pem`,
  );
  await fs.writeFile(pemPath, caPem, { mode: 0o600 });
  try {
    return await fn(pemPath);
  } finally {
    await fs.rm(pemPath, { force: true }).catch(() => {});
  }
}

/**
 * Probe whether the CA behind `caPem` is anchored in this machine's trust
 * store. Two `security` calls: `find-certificate` proves presence (fingerprint
 * match, not name), `verify-cert` proves the trust anchor (basic policy —
 * exit 0 only when validation reaches a trust root). darwin only.
 */
export async function trustStatus(
  caPem: string,
  options?: CaTrustStoreOptions,
): Promise<CaTrustState> {
  if (resolvePlatform(options) !== "darwin") return "unsupported";

  const { commonName, fingerprint256 } = caIdentity(caPem);
  const run = resolveRunner(options);

  const found = await run(["find-certificate", "-Z", "-a", "-c", commonName]);
  // Verified live: find-certificate exits 0 even on a miss, so a nonzero exit
  // is a real failure (corrupt keychain, bad argv) — never report 'absent'
  // for a lookup that could not run.
  if (found.code !== 0) {
    throw new Error(`security find-certificate failed: ${sanitizeToolError(found)}`);
  }
  if (!certPresentInFindOutput(found.stdout, fingerprint256)) {
    return "absent";
  }

  return withTmpPem(caPem, options?.tmpDir, async (pemPath) => {
    const verify = await run(["verify-cert", "-c", pemPath]);
    return verify.code === 0 ? "trusted" : "installed-untrusted";
  });
}

/**
 * Install the CA into the login keychain anchored as a trust root:
 * `security add-trusted-cert -d -r trustRoot -k <login.keychain-db> <pem>`.
 *
 * `-d` writes the trust setting to the admin domain, so this generally needs
 * an administrator consent — in a GUI session the spawn itself IS the consent
 * prompt; in a headless/locked context it fails and this returns
 * `'needs-admin'` so the caller can escalate (osascript admin prompt in the
 * app, a printed sudo line in the CLI). Verified live: a denied attempt still
 * files the cert into the keychain untrusted, so `trustStatus` afterwards
 * reads `installed-untrusted`, not `absent`.
 *
 * On a reported success the status is re-probed: `'absent'` afterwards means
 * `security` lied and this throws rather than claim an install.
 */
export async function installCa(
  caPem: string,
  options?: CaTrustStoreOptions,
): Promise<CaInstallOutcome> {
  if (resolvePlatform(options) !== "darwin") return "unsupported";

  // Parse first — a garbage PEM fails before any spawn, and the same identity
  // the status probe uses is what the post-check re-verifies.
  caIdentity(caPem);
  const keychain = macOsLoginKeychainPath(options?.homeDir);
  const run = resolveRunner(options);

  return withTmpPem(caPem, options?.tmpDir, async (pemPath) => {
    const result = await run([
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-k",
      keychain,
      pemPath,
    ]);
    if (result.code === 0) {
      const post = await trustStatus(caPem, options);
      if (post === "absent") {
        throw new Error(
          "security add-trusted-cert reported success but the certificate is not in the keychain",
        );
      }
      return "installed" as const;
    }
    if (isAuthorizationFailure(result)) return "needs-admin" as const;
    throw new Error(`security add-trusted-cert failed: ${sanitizeToolError(result)}`);
  });
}

/**
 * Remove the CA from the trust store and the keychain. Sequence (verified):
 * `delete-certificate -t -Z <sha256>` drops the cert AND its user-domain trust
 * settings without needing authorization; `remove-trusted-cert -d <pem>` then
 * clears admin-domain settings (what `add-trusted-cert -d` wrote) — that call
 * is best-effort: "item could not be found" means there was nothing to clear,
 * and an authorization failure leaves settings keyed to a now-deleted cert,
 * which are inert. The post-check re-probes presence so a surviving copy is a
 * thrown failure, never a quiet 'removed'.
 */
export async function removeCa(
  caPem: string,
  options?: CaTrustStoreOptions,
): Promise<CaRemoveOutcome> {
  if (resolvePlatform(options) !== "darwin") return "unsupported";

  const { commonName, fingerprint256 } = caIdentity(caPem);
  const run = resolveRunner(options);

  const find = async () => {
    const result = await run(["find-certificate", "-Z", "-a", "-c", commonName]);
    if (result.code !== 0) {
      throw new Error(`security find-certificate failed: ${sanitizeToolError(result)}`);
    }
    return result;
  };

  const initial = await find();
  if (!certPresentInFindOutput(initial.stdout, fingerprint256)) {
    return "absent";
  }

  return withTmpPem(caPem, options?.tmpDir, async (pemPath) => {
    // Clear admin-domain trust settings first — the cert file suffices, it
    // does not have to still be in a keychain for this to parse.
    await run(["remove-trusted-cert", "-d", pemPath]);

    const deleted = await run(["delete-certificate", "-t", "-Z", fingerprint256]);
    if (deleted.code !== 0 && !isAuthorizationFailure(deleted)) {
      throw new Error(`security delete-certificate failed: ${sanitizeToolError(deleted)}`);
    }

    const post = await find();
    if (certPresentInFindOutput(post.stdout, fingerprint256)) {
      throw new Error(
        "security delete-certificate ran but the certificate is still in the keychain — removal needs administrator rights",
      );
    }
    return "removed" as const;
  });
}
