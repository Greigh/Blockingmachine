/**
 * OS trust-store operations on the HTTPS-filter proxy CA (P1 Task 4, extended
 * to win32/linux in P3 Task 3).
 *
 * The proxy engine runs as a dedicated service user under the capture
 * installs (`_blockingmachine` on darwin, `blockingmachine` on linux,
 * LocalSystem on win32), so it cannot write the operator's trust stores —
 * trust install is a user-session operation owned by the app/CLI, which is
 * why these live in `core` (the shared dep both already carry).
 *
 * Darwin semantics below were verified live on this machine (macOS,
 * `security` CLI):
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
 * win32 semantics (`certutil`, the inbox tool — NOT the nss certutil):
 * - The engine's CA is minted per-device-per-user, so the **current-user**
 *   `Root` store (`certutil -user …`) is the honest default — the machine
 *   store needs admin and would anchor the CA for every user on the box.
 *   Chrome/Edge (and Firefox with `security.enterprise_roots.enabled`) read
 *   the Windows store; Firefox's own NSS `cert9.db` is handled by the
 *   per-profile `firefox*Ca` ops below — they drive the *NSS* certutil when
 *   one exists (PATH plus conventional locations like Homebrew's `nss` keg)
 *   and answer `tool-missing` when it does not (known-issues 116,
 *   firefox-nss-cert9). The Windows *inbox* certutil cannot touch NSS dbs;
 *   the resolver's usage-signature probe is what keeps it from being picked.
 * - `certutil -user -verifystore Root <sha1-thumb>` looks the cert up in the
 *   store and dumps it (`Cert Hash(sha1): …`); a miss exits nonzero with
 *   `Cannot find object or property.` / CRYPT_E_NOT_FOUND (0x80092004).
 *   Windows keys CA trust off Root-store membership — there is no separate
 *   trust-attribute write like macOS's TrustSettings, so presence IS the
 *   trusted state. A copy parked in a non-Root store (e.g. `CA`) is inert
 *   for filtering and deliberately not scanned.
 * - `certutil -user -addstore Root <file>` needs no admin for the user store
 *   (an interactive root-cert warning dialog may appear — that IS the
 *   consent UI, the macOS auth-sheet analog). An access-denied/elevation
 *   failure maps to `needs-admin`; the escalation is `certutil -addstore
 *   Root` (machine scope) from an elevated prompt.
 *
 * linux semantics (two mechanisms, preferred in order):
 * - NSS `certutil` on `~/.pki/nssdb` — the user-scope store Chrome/Chromium
 *   (and NSS-linked clients) read. `certutil -L -d sql:<db>` lists
 *   `nickname → trust flags`; a fingerprint-matched row whose SSL field
 *   carries `T` (e.g. `CT,,`) is a trust root. `-A -t "CT,C,C"` installs,
 *   `-D -n <nick>` removes, `-N --empty-password` creates the db. No admin
 *   needed — the db is the user's own.
 * - The distro system store (`/usr/local/share/ca-certificates/*.crt` +
 *   `update-ca-certificates` on Debian-likes; the live bundle is checked at
 *   `/etc/ssl/certs/ca-certificates.crt`, and the RHEL-family
 *   `/etc/pki/tls/certs/ca-bundle.crt` is probed for presence only — its
 *   `update-ca-trust` write path is flagged, not implemented). Writes need
 *   root, so a missing certutil + present system store answers
 *   `needs-admin` and the caller prints the sudo line
 *   (`linuxSystemStoreCommands`). certutil missing AND no system paths at
 *   all → `unsupported` (known-issues 117, linux-no-ca-store).
 * - Fingerprint matching against the system store is done in-process with
 *   `X509Certificate` rather than by shelling `openssl` — the fallback path
 *   exists precisely for minimal systems where helper tools may be absent,
 *   so it must not depend on a third tool.
 */

import { execFile } from "node:child_process";
import { X509Certificate, randomBytes } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Outcome of probing the OS trust store for the proxy CA. */
export type CaTrustState =
  /** Chain validation reaches a trust root — TLS will verify. */
  | "trusted"
  /** Present in the store but NOT anchored as a trust root. */
  | "installed-untrusted"
  /** No store copy whose SHA-256 matches this PEM. */
  | "absent"
  /** This platform has no implemented trust-store ops. */
  | "unsupported";

export type CaInstallOutcome = "installed" | "needs-admin" | "unsupported";
/**
 * `needs-admin` joined the union in P3: the linux system-store remove
 * (`sudo rm` + `update-ca-certificates`) cannot run unprivileged, and win32
 * machine-store removals may hit elevation failures.
 */
export type CaRemoveOutcome = "removed" | "absent" | "needs-admin" | "unsupported";

/** Normalized result of one tool invocation — exit 0 or not, never throws for a nonzero exit. */
export interface SecurityRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The P3 spawn seam — `(file, args)` execFile-style, never a shell string —
 * so one injection point covers every tool: `security` on darwin, `certutil`
 * on win32, NSS `certutil` on linux. Injectable so unit tests never touch a
 * real store; spawn-level failures (missing binary, timeout kill) reject
 * rather than masquerade as a command result.
 */
export type PlatformRunResult = SecurityRunResult;
export type PlatformRunner = (file: string, args: string[]) => Promise<PlatformRunResult>;

/**
 * The P1 seam, kept for back-compat: `security`'s argv with the tool name
 * implicit. Existing tests inject it unchanged; a caller that only supplies
 * `runner` gets a PlatformRunner that answers for `security` alone and
 * rejects any other tool — win32/linux suites use `platformRunner`.
 */
export type SecurityRunner = (args: string[]) => Promise<SecurityRunResult>;

export interface CaTrustStoreOptions {
  runner?: SecurityRunner;
  platformRunner?: PlatformRunner;
  /** Test seam — force a platform answer (e.g. the 'unsupported' leg on darwin). */
  platform?: NodeJS.Platform;
  /** HOME override for the login keychain / nssdb path; falls back to process.env.HOME then os.homedir(). */
  homeDir?: string;
  /** Tmp-PEM directory override — tests point it at a known dir to assert cleanup. */
  tmpDir?: string;
  /**
   * Test seam — the linux system-store probe paths. `sourceDirs` holds the
   * drop-in CA dirs (`/usr/local/share/ca-certificates`), `bundleFiles` the
   * live aggregated bundles `update-ca-certificates` produces.
   */
  linuxSystemStore?: { sourceDirs?: string[]; bundleFiles?: string[] };
}

const TOOL_TIMEOUT_MS = 10_000;

/**
 * The default runner: `execFile(file, args)`, no shell, 10s bound, stderr
 * captured — the same discipline `security` got on darwin, now shared by
 * certutil on every platform. Exported for sibling OS-write modules
 * (`systemProxy.ts`) that run the same seam against different tools.
 */
export function defaultPlatformRunner(file: string, args: string[]): Promise<PlatformRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: TOOL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          // Spawn-level failure: ENOENT, EACCES, or a timeout kill (`code`
          // is null/non-numeric there, `killed` may be set). A nonzero exit
          // is a *result*; a missing or killed binary is not.
          reject(
            new Error(
              `${file} ${args[0] ?? ""} could not run: ${error.message}`,
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

function resolveRunner(opts?: CaTrustStoreOptions): PlatformRunner {
  if (opts?.platformRunner) return opts.platformRunner;
  if (opts?.runner) {
    // Legacy seam — the fake receives `security`'s bare argv, so it can only
    // ever answer for that one tool. Anything else rejects loudly rather
    // than feeding a foreign argv into a `security`-shaped fake.
    const legacy = opts.runner;
    return (file, args) =>
      file === "security"
        ? legacy(args)
        : Promise.reject(
            new Error(
              `the runner seam only fakes 'security' — '${file}' needs the platformRunner seam`,
            ),
          );
  }
  return defaultPlatformRunner;
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

/**
 * The identity the store ops key on: CN for name-keyed lookups (keychain
 * `find -c`, nss nickname), SHA-256 for exact-match, SHA-1 for Windows
 * "thumbprint"-keyed certutil calls (the OS's native cert id is sha1).
 */
function caIdentity(caPem: string): {
  commonName: string;
  fingerprint256: string;
  fingerprintSha1: string;
} {
  // Throws on non-PEM/garbage — callers surface that honestly.
  const cert = new X509Certificate(caPem);
  const commonName = commonNameFromSubject(cert.subject);
  if (!commonName) {
    throw new Error(
      "CA certificate subject carries no CN — the store lookups need a name to search by",
    );
  }
  return {
    commonName,
    // X509Certificate renders colon-pairs; `security -Z` prints bare uppercase hex.
    fingerprint256: cert.fingerprint256.replace(/:/g, "").toUpperCase(),
    fingerprintSha1: cert.fingerprint.replace(/:/g, "").toUpperCase(),
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

/**
 * The win32/linux flavors of the same boundary: certutil's E_ACCESSDENIED
 * (0x80070005) and "requires elevation" wordings, plus the POSIX EACCES
 * surface — all mean "this spawn cannot complete unprivileged".
 */
const ELEVATION_PATTERN =
  /access is denied|0x80070005|E_ACCESSDENIED|requires? elevation|elevation required|requested operation requires|requires? (?:an? )?administrator/i;

function isAuthorizationFailure(result: SecurityRunResult): boolean {
  return (
    NEEDS_ADMIN_PATTERN.test(result.stderr) ||
    NEEDS_ADMIN_PATTERN.test(result.stdout) ||
    ELEVATION_PATTERN.test(result.stderr) ||
    ELEVATION_PATTERN.test(result.stdout)
  );
}

/** stderr/stdout trimmed to one line — never carries cert bytes (argv is paths/flags only). */
function sanitizeToolError(result: SecurityRunResult): string {
  const raw = (result.stderr || result.stdout || `exit ${result.code}`).trim();
  return raw.replace(/\s+/g, " ").slice(0, 300);
}

/**
 * The PEM has to land on disk for the tools to consume it — 0600 in the
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

// ============================================================================
// darwin — verified live semantics, see the module header
// ============================================================================

/**
 * Two `security` calls: `find-certificate` proves presence (fingerprint
 * match, not name), `verify-cert` proves the trust anchor (basic policy —
 * exit 0 only when validation reaches a trust root).
 */
async function darwinTrustStatus(
  caPem: string,
  run: PlatformRunner,
  options?: CaTrustStoreOptions,
): Promise<CaTrustState> {
  const { commonName, fingerprint256 } = caIdentity(caPem);

  const found = await run("security", ["find-certificate", "-Z", "-a", "-c", commonName]);
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
    const verify = await run("security", ["verify-cert", "-c", pemPath]);
    return verify.code === 0 ? "trusted" : "installed-untrusted";
  });
}

async function darwinInstallCa(
  caPem: string,
  run: PlatformRunner,
  options?: CaTrustStoreOptions,
): Promise<CaInstallOutcome> {
  // Parse first — a garbage PEM fails before any spawn, and the same identity
  // the status probe uses is what the post-check re-verifies.
  caIdentity(caPem);
  const keychain = macOsLoginKeychainPath(options?.homeDir);

  return withTmpPem(caPem, options?.tmpDir, async (pemPath) => {
    const result = await run("security", [
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-k",
      keychain,
      pemPath,
    ]);
    if (result.code === 0) {
      const post = await darwinTrustStatus(caPem, run, options);
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

async function darwinRemoveCa(
  caPem: string,
  run: PlatformRunner,
  options?: CaTrustStoreOptions,
): Promise<CaRemoveOutcome> {
  const { commonName, fingerprint256 } = caIdentity(caPem);

  const find = async () => {
    const result = await run("security", ["find-certificate", "-Z", "-a", "-c", commonName]);
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
    await run("security", ["remove-trusted-cert", "-d", pemPath]);

    const deleted = await run("security", ["delete-certificate", "-t", "-Z", fingerprint256]);
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

// ============================================================================
// win32 — certutil -user against the CurrentUser Root store
// ============================================================================

/**
 * certutil's not-found surface on a store lookup: CRYPT_E_NOT_FOUND
 * (0x80092004) / "Cannot find object or property.", or the generic
 * "Element not found" (0x80070490) when the queried id matches nothing.
 */
const WIN_CERT_NOT_FOUND =
  /cannot find object or property|CRYPT_E_NOT_FOUND|0x80092004|element not found|0x80070490/i;

/** `Cert Hash(sha1): ab cd …` lines a `-verifystore` hit prints for each match. */
function certutilHitOnThumbprint(stdout: string, thumbprintSha1: string): boolean {
  for (const match of stdout.matchAll(/Cert Hash\(sha1\):\s*([0-9A-Fa-f ]+)/g)) {
    if (match[1].replace(/\s+/g, "").toUpperCase() === thumbprintSha1) return true;
  }
  return false;
}

/**
 * Presence in the user Root store IS the trusted state — Windows anchors CA
 * trust on store membership, there is no separate trust-setting write. A
 * copy parked in another store (`CA`, `My`) is inert for filtering and is
 * deliberately not scanned: the remove path targets Root, so an inert stray
 * does not deserve an "untrusted" report.
 */
async function win32TrustStatus(
  caPem: string,
  run: PlatformRunner,
): Promise<CaTrustState> {
  const { fingerprintSha1 } = caIdentity(caPem);
  const res = await run("certutil", ["-user", "-verifystore", "Root", fingerprintSha1]);
  if (res.code === 0) {
    // The printed `Cert Hash(sha1)` must match ours — a same-CN impostor or
    // an empty-store "completed successfully" never earns 'trusted'.
    return certutilHitOnThumbprint(res.stdout, fingerprintSha1) ? "trusted" : "absent";
  }
  if (WIN_CERT_NOT_FOUND.test(res.stderr) || WIN_CERT_NOT_FOUND.test(res.stdout)) {
    return "absent";
  }
  throw new Error(`certutil -verifystore failed: ${sanitizeToolError(res)}`);
}

async function win32InstallCa(
  caPem: string,
  run: PlatformRunner,
  options?: CaTrustStoreOptions,
): Promise<CaInstallOutcome> {
  caIdentity(caPem);
  return withTmpPem(caPem, options?.tmpDir, async (pemPath) => {
    // `-user` keeps the write in CurrentUser\Root — no admin needed. The
    // interactive root-cert warning Windows may raise is the consent UI.
    const result = await run("certutil", ["-user", "-addstore", "Root", pemPath]);
    if (result.code === 0) {
      const post = await win32TrustStatus(caPem, run);
      if (post !== "trusted") {
        throw new Error(
          "certutil -addstore reported success but the certificate is not in the user Root store",
        );
      }
      return "installed" as const;
    }
    // Access denied / elevation-required → the honest escalation is an
    // elevated `certutil -addstore Root` against the machine store.
    if (isAuthorizationFailure(result)) return "needs-admin" as const;
    throw new Error(`certutil -addstore failed: ${sanitizeToolError(result)}`);
  });
}

async function win32RemoveCa(
  caPem: string,
  run: PlatformRunner,
): Promise<CaRemoveOutcome> {
  const { fingerprintSha1 } = caIdentity(caPem);
  const initial = await win32TrustStatus(caPem, run);
  if (initial !== "trusted") return "absent";

  const deleted = await run("certutil", ["-user", "-delstore", "Root", fingerprintSha1]);
  if (deleted.code !== 0 && !isAuthorizationFailure(deleted)) {
    throw new Error(`certutil -delstore failed: ${sanitizeToolError(deleted)}`);
  }
  const post = await win32TrustStatus(caPem, run);
  if (post === "trusted") {
    if (isAuthorizationFailure(deleted)) return "needs-admin" as const;
    throw new Error(
      "certutil -delstore ran but the certificate is still in the Root store — removal needs administrator rights",
    );
  }
  return "removed" as const;
}

// ============================================================================
// linux — NSS certutil on ~/.pki/nssdb, else the distro system store
// ============================================================================

/** The user-scope NSS db Chrome/Chromium read on linux. */
function linuxNssDbSpec(homeDir?: string): { spec: string; dir: string } {
  const home = homeDir ?? process.env.HOME ?? os.homedir();
  const dir = path.join(home, ".pki", "nssdb");
  return { spec: `sql:${dir}`, dir };
}

/** certutil's "the db does not exist" surface — distinct from a hard failure. */
const NSS_DB_MISSING =
  /SEC_ERROR_BAD_DATABASE|SEC_ERROR_LEGACY_DATABASE|bad database|does not exist|no such file or directory/i;

interface NssRow {
  nick: string;
  /** The `SSL,S/MIME,JAR/XPI` trust-flag triple, e.g. `CT,C,C` or `P,,`. */
  flags: string;
}

/**
 * `certutil -L` output is a fixed-width table whose last column is the
 * `X,Y,Z` trust triple — rows are `nickname<pad>flags`; the column header
 * ("…SSL,S/MIME,JAR/XPI") contains '/' so it can never parse as a row.
 */
function parseCertutilList(stdout: string): NssRow[] {
  const rows: NssRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(.+?)\s{2,}([A-Za-z']{0,4}(?:,[A-Za-z']{0,4}){2})\s*$/.exec(line);
    if (m) rows.push({ nick: m[1].trim(), flags: m[2] });
  }
  return rows;
}

/** First flag field (SSL) carrying `T` means "trusted CA for server certs". */
function nssRowTrusts(row: NssRow): boolean {
  return row.flags.split(",")[0].includes("T");
}

type NssListing =
  | { kind: "listed"; rows: NssRow[] }
  /** certutil did not spawn — the NSS path does not exist on this box. */
  | { kind: "no-certutil" }
  /** certutil ran but the db is absent/unreadable-as-db — creatable. */
  | { kind: "no-db" };

async function linuxProbeNssDb(
  run: PlatformRunner,
  dbSpec: string,
): Promise<NssListing> {
  let res: SecurityRunResult;
  try {
    res = await run("certutil", ["-L", "-d", dbSpec]);
  } catch {
    // The runner rejects only on spawn-level failure — ENOENT (no certutil)
    // or a kill; both mean the NSS mechanism is not usable here.
    return { kind: "no-certutil" };
  }
  if (res.code === 0) return { kind: "listed", rows: parseCertutilList(res.stdout) };
  if (NSS_DB_MISSING.test(res.stderr) || NSS_DB_MISSING.test(res.stdout)) {
    return { kind: "no-db" };
  }
  throw new Error(`certutil -L failed: ${sanitizeToolError(res)}`);
}

/** SHA-256 of the first PEM block in a `-a` dump, or null when it won't parse. */
function fingerprint256OfPemOutput(stdout: string): string | null {
  const m = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(stdout);
  if (!m) return null;
  try {
    return new X509Certificate(m[0]).fingerprint256.replace(/:/g, "").toUpperCase();
  } catch {
    return null;
  }
}

/**
 * Fingerprint-match every listed nickname — presence is keyed on the cert's
 * sha256 (never the nickname), so a same-CN impostor parked under our
 * nickname cannot answer for the real CA. On a match the row's trust flags
 * decide trusted vs installed-untrusted.
 */
async function linuxNssState(
  run: PlatformRunner,
  dbSpec: string,
  rows: NssRow[],
  fingerprint256: string,
): Promise<CaTrustState | null> {
  for (const row of rows) {
    const dump = await run("certutil", ["-L", "-n", row.nick, "-a", "-d", dbSpec]);
    if (dump.code !== 0) continue; // a vanished/unreadable nick — keep scanning
    if (fingerprint256OfPemOutput(dump.stdout) === fingerprint256) {
      return nssRowTrusts(row) ? "trusted" : "installed-untrusted";
    }
  }
  return null;
}

const LINUX_CA_SOURCE_DIRS = ["/usr/local/share/ca-certificates"];
const LINUX_CA_BUNDLE_FILES = [
  "/etc/ssl/certs/ca-certificates.crt", // Debian/Ubuntu (update-ca-certificates)
  "/etc/pki/tls/certs/ca-bundle.crt", // RHEL/Fedora (update-ca-trust output — read-only probe)
];

interface LinuxSystemStoreProbe {
  state: "trusted" | "installed-untrusted" | "absent";
  /** Any source dir or bundle file exists at all — the mechanism exists. */
  storePresent: boolean;
  /** The cert's fingerprint is in a live bundle — trusted by openssl/gnutls clients. */
  inBundle: boolean;
  /** The cert sits in a source dir but no bundle — staged, update-ca-certificates pending. */
  inSource: boolean;
}

async function linuxProbeSystemStore(
  fingerprint256: string,
  options?: CaTrustStoreOptions,
): Promise<LinuxSystemStoreProbe> {
  const sourceDirs = options?.linuxSystemStore?.sourceDirs ?? LINUX_CA_SOURCE_DIRS;
  const bundleFiles = options?.linuxSystemStore?.bundleFiles ?? LINUX_CA_BUNDLE_FILES;

  let storePresent = false;
  let inSource = false;
  let inBundle = false;

  for (const dir of sourceDirs) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue; // absent dir — other candidates still count
    }
    storePresent = true;
    for (const name of names) {
      if (!name.endsWith(".crt")) continue;
      let data: Buffer;
      try {
        data = await fs.readFile(path.join(dir, name));
      } catch {
        continue;
      }
      try {
        if (
          new X509Certificate(data).fingerprint256
            .replace(/:/g, "")
            .toUpperCase() === fingerprint256
        ) {
          inSource = true;
        }
      } catch {
        // Not a parseable cert — foreign content in the dir is not our problem.
      }
    }
  }

  for (const file of bundleFiles) {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    storePresent = true;
    // The bundle is PEM blocks concatenated — fingerprint each in-process
    // (no openssl dependency; this fallback path exists for minimal systems).
    for (const m of text.matchAll(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    )) {
      try {
        if (
          new X509Certificate(m[0]).fingerprint256
            .replace(/:/g, "")
            .toUpperCase() === fingerprint256
        ) {
          inBundle = true;
          break;
        }
      } catch {
        continue;
      }
    }
    if (inBundle) break;
  }

  return {
    state: inBundle ? "trusted" : inSource ? "installed-untrusted" : "absent",
    storePresent,
    inBundle,
    inSource,
  };
}

async function linuxTrustStatus(
  caPem: string,
  run: PlatformRunner,
  options?: CaTrustStoreOptions,
): Promise<CaTrustState> {
  const { fingerprint256 } = caIdentity(caPem);
  const { spec } = linuxNssDbSpec(options?.homeDir);

  const probe = await linuxProbeNssDb(run, spec);
  if (probe.kind === "listed") {
    const state = await linuxNssState(run, spec, probe.rows, fingerprint256);
    if (state) return state;
  }

  const sys = await linuxProbeSystemStore(fingerprint256, options);
  // Neither mechanism exists at all → the platform genuinely cannot be
  // driven (known-issues 117, linux-no-ca-store). A working certutil alone still
  // means 'absent' is honest — the db is creatable on install.
  if (!sys.storePresent && probe.kind === "no-certutil") return "unsupported";
  return sys.state;
}

async function linuxInstallCa(
  caPem: string,
  run: PlatformRunner,
  options?: CaTrustStoreOptions,
): Promise<CaInstallOutcome> {
  const { commonName, fingerprint256 } = caIdentity(caPem);
  const { spec, dir } = linuxNssDbSpec(options?.homeDir);

  const probe = await linuxProbeNssDb(run, spec);
  if (probe.kind === "no-certutil") {
    // No NSS tooling → the only store left is the distro one, and its write
    // (`cp` + `update-ca-certificates`) needs root. When no system paths
    // exist either, there is no mechanism at all → honest 'unsupported'.
    const sys = await linuxProbeSystemStore(fingerprint256, options);
    if (!sys.storePresent) return "unsupported";
    return "needs-admin"; // the caller prints linuxSystemStoreCommands()
  }

  if (probe.kind === "no-db") {
    // `certutil -N` creates the db; it does not make the directory itself.
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const created = await run("certutil", ["-N", "--empty-password", "-d", spec]);
    if (created.code !== 0) {
      if (isAuthorizationFailure(created)) return "needs-admin" as const;
      throw new Error(`certutil -N failed: ${sanitizeToolError(created)}`);
    }
  }

  return withTmpPem(caPem, options?.tmpDir, async (pemPath) => {
    const add = await run("certutil", [
      "-A",
      "-n",
      commonName,
      "-t",
      "CT,C,C",
      "-d",
      spec,
      "-i",
      pemPath,
    ]);
    if (add.code === 0) {
      const post = await linuxTrustStatus(caPem, run, options);
      if (post !== "trusted") {
        throw new Error(
          `certutil -A reported success but the CA reads '${post}' in the NSS db`,
        );
      }
      return "installed" as const;
    }
    // SEC_ERROR_CERT_NICKNAME_ALREADY_IN_USE means a different cert already
    // holds our nickname — surfaced as a thrown failure, never a quiet
    // overwrite (the same refusal firefoxInstallCa names on its dbSpec).
    if (NSS_NICKNAME_IN_USE.test(add.stderr) || NSS_NICKNAME_IN_USE.test(add.stdout)) {
      throw new Error(
        `certutil -A on ${spec}: the nickname "${commonName}" already holds a different certificate — refusing to overwrite`,
      );
    }
    if (isAuthorizationFailure(add)) return "needs-admin" as const;
    throw new Error(`certutil -A failed: ${sanitizeToolError(add)}`);
  });
}

async function linuxRemoveCa(
  caPem: string,
  run: PlatformRunner,
  options?: CaTrustStoreOptions,
): Promise<CaRemoveOutcome> {
  const { fingerprint256 } = caIdentity(caPem);
  const { spec } = linuxNssDbSpec(options?.homeDir);

  let nssHad = false;
  const probe = await linuxProbeNssDb(run, spec);
  if (probe.kind === "listed") {
    for (const row of probe.rows) {
      const dump = await run("certutil", ["-L", "-n", row.nick, "-a", "-d", spec]);
      if (dump.code !== 0) continue;
      if (fingerprint256OfPemOutput(dump.stdout) !== fingerprint256) continue;
      nssHad = true;
      const del = await run("certutil", ["-D", "-n", row.nick, "-d", spec]);
      if (del.code !== 0 && !isAuthorizationFailure(del)) {
        throw new Error(`certutil -D failed: ${sanitizeToolError(del)}`);
      }
      // Post-state by fingerprint: the nick must now dump a different cert or fail.
      const post = await run("certutil", ["-L", "-n", row.nick, "-a", "-d", spec]);
      if (
        post.code === 0 &&
        fingerprint256OfPemOutput(post.stdout) === fingerprint256
      ) {
        if (isAuthorizationFailure(del)) return "needs-admin" as const;
        throw new Error(
          "certutil -D ran but the certificate is still in the NSS db",
        );
      }
    }
  }

  const sys = await linuxProbeSystemStore(fingerprint256, options);
  if (sys.inBundle || sys.inSource) {
    // The cert lives in the distro store — removal is `sudo rm` +
    // `update-ca-certificates`, which this process cannot run. Any nssdb
    // copy above was still cleaned honestly first.
    return "needs-admin";
  }
  if (!sys.storePresent && probe.kind === "no-certutil") return "unsupported";
  return nssHad ? "removed" : "absent";
}

// ============================================================================
// Firefox's own NSS store — per-profile cert9.db ops via a located certutil
// ============================================================================

/**
 * Firefox never reads the OS trust store we write (win32 user-Root, linux
 * system dirs — or even the macOS keychain without
 * `security.enterprise_roots.enabled`); it keeps per-profile `cert9.db`
 * NSS stores under its own roots. Returns every `cert9.db` that exists —
 * the discovery half of the `firefox*Ca` ops below, and still the evidence
 * a caller needs to name the gap when no NSS certutil exists to write them
 * (known-issues 116, firefox-nss-cert9).
 */
export async function firefoxNssProfileDbs(options?: {
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** Explicit profile roots — the test seam. */
  profileRoots?: string[];
}): Promise<string[]> {
  const platform = options?.platform ?? process.platform;
  const home = options?.homeDir ?? process.env.HOME ?? os.homedir();
  const roots = options?.profileRoots ?? [
    ...(platform === "win32"
      ? [path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Mozilla", "Firefox", "Profiles")]
      : []),
    ...(platform === "darwin"
      ? [path.join(home, "Library", "Application Support", "Firefox", "Profiles")]
      : []),
    ...(platform === "linux" ? [path.join(home, ".mozilla", "firefox")] : []),
  ];
  const dbs: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const db = path.join(root, entry, "cert9.db");
      if (existsSync(db)) dbs.push(db);
    }
  }
  return dbs;
}

/**
 * Per-profile trust state inside a Firefox `cert9.db`. `tool-missing` is a
 * resolution answer, not a probe result — no NSS certutil exists, so that
 * profile's real state was never read; it is reported per-profile because
 * the profile list is itself the evidence that a tool-missing box still has
 * Firefox installed. `installed-untrusted` means the CA is filed but its
 * SSL trust field lacks `C` — present, yet not anchored for TLS issuance.
 */
export type FirefoxProfileTrustState =
  | "trusted"
  | "installed-untrusted"
  | "not-installed"
  | "tool-missing";

/** One profile's row in a `FirefoxTrustReport`. */
export interface FirefoxProfileTrust {
  /** The profile directory's basename (e.g. `abc123.default-release`). */
  profile: string;
  /** Absolute path to the profile's `cert9.db`. */
  dbPath: string;
  /** The `sql:` database spec certutil is invoked with — `sql:<profileDir>`. */
  dbSpec: string;
  state: FirefoxProfileTrustState;
}

/** The result of one op across every discovered Firefox profile. */
export interface FirefoxTrustReport {
  /**
   * The NSS certutil the ops ran through — `"certutil"` when PATH-resolved,
   * an absolute path for a conventional/explicit location, `null` when no
   * NSS certutil exists on this box (the `tool-missing` posture).
   */
  certutil: string | null;
  /** One entry per discovered profile `cert9.db`, in discovery order. */
  profiles: FirefoxProfileTrust[];
}

/**
 * The seams for the Firefox path — `platformRunner` is the same injected
 * spawn seam every other backend uses, so unit tests never touch a real
 * profile or binary.
 */
export interface FirefoxTrustOptions {
  platformRunner?: PlatformRunner;
  platform?: NodeJS.Platform;
  /** HOME override — forwarded to `firefoxNssProfileDbs`. */
  homeDir?: string;
  /** Explicit profile roots — forwarded to `firefoxNssProfileDbs`; the test seam. */
  profileRoots?: string[];
  /**
   * NSS-certutil locations probed after PATH's bare `certutil` — REPLACES the
   * platform's conventional list when provided, so a test can pin `[]` and
   * get a deterministic tool-missing even on a box that really has NSS
   * installed. Candidates that do not exist on disk are skipped without
   * spawning.
   */
  certutilPaths?: string[];
  /** Tmp-PEM directory override for the `-i` input — same seam as `CaTrustStoreOptions.tmpDir`. */
  tmpDir?: string;
}

/**
 * Where an NSS certutil conventionally lives beyond PATH. darwin: Homebrew's
 * `nss` keg on both prefixes — the formula is keg-only, so `certutil` lands
 * in `opt/nss/bin` and is NOT linked into the prefix `bin/` by default (the
 * `bin` paths are still probed for `--force`-linked installs). linux: the
 * usual `libnss3-tools`/`nss-tools` targets, in case the caller's PATH is
 * minimal. win32 has no conventional NSS install root, so PATH is the whole
 * surface there — and the usage-signature probe is what keeps the *inbox*
 * `certutil` (a different tool that cannot touch NSS databases) from being
 * picked up on it.
 */
const NSS_CERTUTIL_LOCATIONS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    "/opt/homebrew/opt/nss/bin/certutil",
    "/usr/local/opt/nss/bin/certutil",
    "/opt/homebrew/bin/certutil",
    "/usr/local/bin/certutil",
  ],
  linux: ["/usr/bin/certutil", "/usr/local/bin/certutil", "/bin/certutil"],
};

/**
 * The line NSS certutil's usage dump always carries — printed for `-H` and
 * for any unrecognized verb, so the probe is version-robust. The Windows
 * inbox certutil's own usage never contains it, which is what makes the
 * bare-PATH candidate safe to try on win32.
 */
const NSS_CERTUTIL_USAGE = /Add a certificate to the database/i;

/**
 * certutil's "the nickname is taken" surface on `-A` — thrown rather than
 * silently retargeted, because the collision means a DIFFERENT certificate
 * already holds the name we would use.
 */
const NSS_NICKNAME_IN_USE = /CERT_NICKNAME_ALREADY_IN_USE/i;

/**
 * Resolve an NSS certutil: PATH's bare `certutil` first, then the
 * conventional locations (or the injected `certutilPaths` list that replaces
 * them). Each candidate is verified by a `-H` usage probe — a spawn
 * rejection means the binary is not there; output without the NSS signature
 * means a different tool answered.
 */
async function resolveNssCertutil(
  run: PlatformRunner,
  options?: FirefoxTrustOptions,
): Promise<string | null> {
  const platform = resolvePlatform(options);
  const candidates = [
    "certutil",
    ...(options?.certutilPaths ?? NSS_CERTUTIL_LOCATIONS[platform] ?? []),
  ];
  for (const candidate of candidates) {
    if (candidate !== "certutil" && !existsSync(candidate)) continue;
    let res: SecurityRunResult;
    try {
      res = await run(candidate, ["-H"]);
    } catch {
      continue; // not spawnable — ENOENT or a kill
    }
    if (NSS_CERTUTIL_USAGE.test(`${res.stdout}\n${res.stderr}`)) {
      return candidate;
    }
    // Ran but is not NSS's certutil — keep looking.
  }
  return null;
}

interface FirefoxProfileRef {
  profile: string;
  dbPath: string;
  dbSpec: string;
}

/** The discovered profiles as the records the per-profile ops iterate. */
async function firefoxProfiles(
  options?: FirefoxTrustOptions,
): Promise<FirefoxProfileRef[]> {
  const dbs = await firefoxNssProfileDbs({
    platform: options?.platform ?? process.platform,
    homeDir: options?.homeDir,
    profileRoots: options?.profileRoots,
  });
  return dbs.map((dbPath) => {
    const dir = path.dirname(dbPath);
    return { profile: path.basename(dir), dbPath, dbSpec: `sql:${dir}` };
  });
}

/**
 * `C` in the SSL field is "trusted CA to issue server certs" — the flag a
 * `cert9.db` row needs before Firefox accepts a MITM CA's forged leaf. `T`
 * only trusts client-cert issuance and `c`/`p` are merely valid, so none of
 * them count for this purpose — which is also why the install writes `C,,`
 * and not the OS-store paths' `CT,C,C` (that would trust the CA for email
 * and object signing too, which the flag deliberately does not grant).
 */
function firefoxRowTrusts(row: NssRow): boolean {
  return row.flags.split(",")[0].includes("C");
}

interface FirefoxProbe {
  state: "trusted" | "installed-untrusted" | "not-installed";
  /** The nickname whose `-a` dump fingerprint-matched — the id `-M`/`-D` need. */
  nickname?: string;
}

/**
 * Read one profile db: `-L` lists nicknames+flags, then each row's cert is
 * fingerprint-verified via its `-a` dump — same discipline as the linux
 * nssdb path, never trusting the nickname alone. A cert9.db that exists but
 * will not open (corrupt, locked) reads `not-installed` — for TLS purposes
 * nothing in it is usable, and a later `-A` would surface its real failure.
 */
async function firefoxProbeProfile(
  run: PlatformRunner,
  certutil: string,
  dbSpec: string,
  fingerprint256: string,
): Promise<FirefoxProbe> {
  const list = await run(certutil, ["-L", "-d", dbSpec]);
  if (list.code !== 0) {
    if (NSS_DB_MISSING.test(list.stderr) || NSS_DB_MISSING.test(list.stdout)) {
      return { state: "not-installed" };
    }
    throw new Error(`certutil -L failed on ${dbSpec}: ${sanitizeToolError(list)}`);
  }
  for (const row of parseCertutilList(list.stdout)) {
    const dump = await run(certutil, ["-L", "-n", row.nick, "-a", "-d", dbSpec]);
    if (dump.code !== 0) continue; // a vanished/unreadable nick — keep scanning
    if (fingerprint256OfPemOutput(dump.stdout) !== fingerprint256) continue;
    return {
      state: firefoxRowTrusts(row) ? "trusted" : "installed-untrusted",
      nickname: row.nick,
    };
  }
  return { state: "not-installed" };
}

/**
 * Probe every discovered Firefox profile `cert9.db` for this CA. Each
 * profile reports independently: `trusted` when a fingerprint-matched row
 * anchors server-cert issuance (`C` in the SSL field), `installed-untrusted`
 * when the cert is filed without it, `not-installed` when no row matches —
 * and `tool-missing` across the board when no NSS certutil exists, reported
 * distinctly from `unsupported` because the mechanism exists and only the
 * tool is absent.
 */
export async function firefoxTrustStatus(
  caPem: string,
  options?: FirefoxTrustOptions,
): Promise<FirefoxTrustReport> {
  const { fingerprint256 } = caIdentity(caPem);
  const run = resolveRunner(options);
  const profiles = await firefoxProfiles(options);
  const certutil = await resolveNssCertutil(run, options);
  const report: FirefoxProfileTrust[] = [];
  for (const ref of profiles) {
    if (certutil === null) {
      report.push({ ...ref, state: "tool-missing" });
      continue;
    }
    const probe = await firefoxProbeProfile(run, certutil, ref.dbSpec, fingerprint256);
    report.push({ ...ref, state: probe.state });
  }
  return { certutil, profiles: report };
}

/**
 * Install the CA into every discovered Firefox profile as a server-cert CA
 * only: `certutil -A -n <name> -t C,, -d sql:<profile> -i <ca.pem>` — `C,,`
 * anchors TLS issuance and nothing else (deliberately NOT `CT,C,C`, which
 * would also trust it for email and object signing). A cert already filed
 * without the flag gets `certutil -M -t C,,` on its real nickname rather
 * than an `-A` that would collide on the name. Every write is re-probed by
 * fingerprint — a claim the post-read cannot confirm throws rather than
 * reports trusted.
 */
export async function firefoxInstallCa(
  caPem: string,
  options?: FirefoxTrustOptions,
): Promise<FirefoxTrustReport> {
  const { commonName, fingerprint256 } = caIdentity(caPem);
  const run = resolveRunner(options);
  const profiles = await firefoxProfiles(options);
  const certutil = await resolveNssCertutil(run, options);

  if (certutil === null || profiles.length === 0) {
    return {
      certutil,
      profiles: profiles.map((ref) => ({
        ...ref,
        state: certutil === null ? ("tool-missing" as const) : ("not-installed" as const),
      })),
    };
  }

  return withTmpPem(caPem, options?.tmpDir, async (pemPath) => {
    const report: FirefoxProfileTrust[] = [];
    for (const ref of profiles) {
      const before = await firefoxProbeProfile(run, certutil, ref.dbSpec, fingerprint256);
      if (before.state === "trusted") {
        report.push({ ...ref, state: "trusted" });
        continue;
      }
      if (before.state === "installed-untrusted" && before.nickname) {
        // The cert is already filed — rewrite its trust flags rather than
        // collide on the nickname with -A.
        const mod = await run(certutil, [
          "-M", "-n", before.nickname, "-t", "C,,", "-d", ref.dbSpec,
        ]);
        if (mod.code !== 0) {
          throw new Error(`certutil -M failed on ${ref.dbSpec}: ${sanitizeToolError(mod)}`);
        }
      } else {
        const add = await run(certutil, [
          "-A", "-n", commonName, "-t", "C,,", "-d", ref.dbSpec, "-i", pemPath,
        ]);
        if (add.code !== 0) {
          if (NSS_NICKNAME_IN_USE.test(add.stderr) || NSS_NICKNAME_IN_USE.test(add.stdout)) {
            throw new Error(
              `certutil -A on ${ref.dbSpec}: the nickname "${commonName}" already holds a different certificate — refusing to overwrite`,
            );
          }
          throw new Error(`certutil -A failed on ${ref.dbSpec}: ${sanitizeToolError(add)}`);
        }
      }
      const post = await firefoxProbeProfile(run, certutil, ref.dbSpec, fingerprint256);
      if (post.state !== "trusted") {
        throw new Error(
          `certutil reported success but the CA reads '${post.state}' in ${ref.dbSpec}`,
        );
      }
      report.push({ ...ref, state: "trusted" });
    }
    return { certutil, profiles: report };
  });
}

/**
 * Remove the CA from every discovered Firefox profile — `certutil -D -n
 * <nick>` against the fingerprint-matched row, so a same-name impostor is
 * never the cert we delete. Profiles with no matching row report
 * `not-installed` (nothing to do); a post-delete probe that still sees the
 * fingerprint throws rather than claiming removal.
 */
export async function firefoxRemoveCa(
  caPem: string,
  options?: FirefoxTrustOptions,
): Promise<FirefoxTrustReport> {
  const { fingerprint256 } = caIdentity(caPem);
  const run = resolveRunner(options);
  const profiles = await firefoxProfiles(options);
  const certutil = await resolveNssCertutil(run, options);
  const report: FirefoxProfileTrust[] = [];
  for (const ref of profiles) {
    if (certutil === null) {
      report.push({ ...ref, state: "tool-missing" });
      continue;
    }
    const before = await firefoxProbeProfile(run, certutil, ref.dbSpec, fingerprint256);
    if (before.state === "not-installed" || !before.nickname) {
      report.push({ ...ref, state: "not-installed" });
      continue;
    }
    const del = await run(certutil, ["-D", "-n", before.nickname, "-d", ref.dbSpec]);
    if (del.code !== 0) {
      throw new Error(`certutil -D failed on ${ref.dbSpec}: ${sanitizeToolError(del)}`);
    }
    const post = await firefoxProbeProfile(run, certutil, ref.dbSpec, fingerprint256);
    if (post.state !== "not-installed") {
      throw new Error(
        `certutil -D ran but the CA still reads '${post.state}' in ${ref.dbSpec}`,
      );
    }
    report.push({ ...ref, state: "not-installed" });
  }
  return { certutil, profiles: report };
}

// ============================================================================
// The escalation lines callers print on 'needs-admin' (linux system store)
// ============================================================================

/** Canonical install target inside the Debian-style source dir. */
export const LINUX_SYSTEM_CA_TARGET =
  "/usr/local/share/ca-certificates/blockingmachine-ca.crt";

/**
 * The manual write paths for the distro system store — `pemPath` is the
 * exported CA file the user produced (`blockingmachine cert export ca.pem`).
 * Rendered for the CLI's needs-admin print and the app's needsAdmin message.
 */
export function linuxSystemStoreCommands(pemPath = "ca.pem"): {
  install: string;
  remove: string;
} {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return {
    install: `sudo cp ${q(pemPath)} ${LINUX_SYSTEM_CA_TARGET} && sudo update-ca-certificates`,
    remove: `sudo rm ${LINUX_SYSTEM_CA_TARGET} && sudo update-ca-certificates`,
  };
}

// ============================================================================
// Public dispatchers — the three ops, per platform
// ============================================================================

/**
 * Probe whether the CA behind `caPem` is anchored in this machine's trust
 * store. darwin: keychain presence + verify-cert. win32: certutil
 * `-verifystore Root` hash-match. linux: nssdb fingerprint+trust-flags, then
 * the distro bundle/source dirs. Other platforms: 'unsupported'.
 */
export async function trustStatus(
  caPem: string,
  options?: CaTrustStoreOptions,
): Promise<CaTrustState> {
  const platform = resolvePlatform(options);
  const run = resolveRunner(options);
  if (platform === "darwin") return darwinTrustStatus(caPem, run, options);
  if (platform === "win32") return win32TrustStatus(caPem, run);
  if (platform === "linux") return linuxTrustStatus(caPem, run, options);
  return "unsupported";
}

/**
 * Install the CA anchored as a trust root. darwin: `add-trusted-cert -d -r
 * trustRoot` against the login keychain — the write itself is the consent
 * prompt in a GUI session; a denied attempt still files the cert untrusted,
 * so `needs-admin` may leave `installed-untrusted` behind. win32:
 * `certutil -user -addstore Root` (no admin; the escalation is the machine
 * store). linux: `certutil -A -t "CT,C,C"` on `~/.pki/nssdb` (db created via
 * `-N` when absent); no certutil → the system store needs root →
 * `needs-admin` and the caller prints `linuxSystemStoreCommands().install`.
 */
export async function installCa(
  caPem: string,
  options?: CaTrustStoreOptions,
): Promise<CaInstallOutcome> {
  const platform = resolvePlatform(options);
  const run = resolveRunner(options);
  if (platform === "darwin") return darwinInstallCa(caPem, run, options);
  if (platform === "win32") return win32InstallCa(caPem, run, options);
  if (platform === "linux") return linuxInstallCa(caPem, run, options);
  return "unsupported";
}

/**
 * Remove the CA from the trust store. darwin: `delete-certificate -t -Z`
 * drops cert + user-domain settings, `remove-trusted-cert -d` clears the
 * admin-domain ones (best-effort). win32: `certutil -user -delstore Root`.
 * linux: `certutil -D` on the nssdb row; a system-store copy needs root →
 * `needs-admin` (`linuxSystemStoreCommands().remove`). Every path re-probes
 * by fingerprint — a surviving copy throws rather than reporting 'removed'.
 */
export async function removeCa(
  caPem: string,
  options?: CaTrustStoreOptions,
): Promise<CaRemoveOutcome> {
  const platform = resolvePlatform(options);
  const run = resolveRunner(options);
  if (platform === "darwin") return darwinRemoveCa(caPem, run, options);
  if (platform === "win32") return win32RemoveCa(caPem, run);
  if (platform === "linux") return linuxRemoveCa(caPem, run, options);
  return "unsupported";
}
