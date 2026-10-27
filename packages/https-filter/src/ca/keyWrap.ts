/**
 * OS-backed wrap for the CA private key at rest (design spec §5.1, flag 97).
 *
 * The CA key never persists as raw PEM where a backend can protect it: it is
 * AES-256-GCM-sealed under a random 32-byte wrap secret that lives in the
 * platform's own credential store, and the sealed blob lands in `ca.key.enc`
 * beside `ca.pem`. The on-disk envelope alone is useless — an attacker needs
 * the OS principal (the user's unlocked login keychain, Secret Service
 * session, or Windows logon session), not just same-UID file access.
 *
 * Backends, resolved per platform by {@link resolveBackend}:
 *
 *  - **darwin** — the `security` CLI against the login keychain. The secret
 *    is stored as a generic password (`add-generic-password -U`), fed to
 *    `security -i` on stdin so it never rides an argv vector, and read back
 *    with `find-generic-password -w`. `/usr/bin/security` is probed by path —
 *    it is a system binary that has shipped at that path since macOS 10.0.
 *  - **linux** — `secret-tool` (libsecret / Secret Service). The raw secret
 *    travels on stdin (`secret-tool store`); argv only ever carries the
 *    non-secret lookup attributes. Resolved via PATH and probed with
 *    `--version` — no absolute path exists to pin (usr/bin vs. /usr/local
 *    vs. snap), and a spawn ENOENT is the unavailable signal. This is the
 *    spec's "0600 file + Secret Service attempt": no daemon, no wrap — the
 *    plaintext 0600 posture remains, honestly reported via `keyWrapped`.
 *  - **win32** — `powershell.exe` driving .NET
 *    `[Security.Cryptography.ProtectedData]` (DPAPI, CurrentUser scope). The
 *    protected blob is a file, not a store entry — it lands beside the CA
 *    files when a store dir is supplied, else under `%APPDATA%`. The secret
 *    itself reaches the script on stdin; the blob path crosses via env var.
 *  - anything else — `null`: unavailable. Never an error, just the truth.
 *
 * Every spawn is `spawn`-with-an-argv-array (execFile-style — no shell
 * string, no quoting surface) with a hard timeout, and no log line or error
 * message ever carries secret or key material.
 */

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The wrapped CA key file — sits beside `ca.pem` in the 0700 store dir. */
export const CA_KEY_ENC_FILENAME = 'ca.key.enc';

/** The plaintext CA key file — legacy form, and the no-backend fallback. */
export const CA_KEY_PEM_FILENAME = 'ca.key.pem';

/**
 * Envelope format: `BMKEYWRAP1` magic (10 B) ‖ 12 B nonce ‖ 16 B GCM tag ‖
 * ciphertext. Fixed-layout binary, not PEM — a parseable-looking blob would
 * invite tools (and humans) to mistake it for a plain key file.
 */
const WRAP_MAGIC = Buffer.from('BMKEYWRAP1', 'ascii');
const WRAP_NONCE_LENGTH = 12;
const WRAP_TAG_LENGTH = 16;
const WRAP_HEADER_LENGTH = WRAP_MAGIC.length + WRAP_NONCE_LENGTH + WRAP_TAG_LENGTH;

/** AES-256 wants a 32-byte key; the OS store holds exactly this. */
export const WRAP_SECRET_LENGTH = 32;

/** Every external call is bounded — a wedged helper must not park `open`. */
const SPAWN_TIMEOUT_MS = 10_000;

/**
 * The distinct failure an unusable wrapped key throws (spec §7: fail
 * closed). An `ca.key.enc` that cannot be unwrapped — no backend, no stored
 * secret, wrong secret, corrupt blob — must never silently mint a fresh CA
 * over an installed trust root, so `open` propagates this instead of
 * falling back to plaintext or regenerating.
 */
export class CaKeyUnwrapError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CaKeyUnwrapError';
  }
}

/**
 * One OS credential store's hold on the 32-byte wrap secret. `load` answers
 * `null` when nothing is stored — that is "not enrolled yet", distinct from
 * a throw, which means "the store itself is unreachable/broken". `store`
 * persists (or replaces) the secret.
 */
export interface KeyWrapBackend {
  readonly name: string;
  load(): Promise<Buffer | null>;
  store(secret: Buffer): Promise<void>;
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * argv-array spawn with optional stdin and a kill-on-timeout bound — the
 * repo's no-shell convention. The returned error never echoes args/stdin:
 * store calls carry secret material on stdin and argv contents are nobody's
 * business in a log line either way.
 */
function runFile(
  file: string,
  args: string[],
  opts: { input?: Buffer; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? SPAWN_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${file} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    };
    child.once('error', (err) => settle(() => reject(err)));
    // A binary that exits before reading stdin (absent tool, early failure)
    // would otherwise surface our write as an unhandled EPIPE stream error.
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('close', (code) =>
      settle(() =>
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        }),
      ),
    );
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

function decodeStoredSecret(raw: Buffer): Buffer | null {
  const text = raw.toString('utf8').trim();
  if (text === '') {
    return null;
  }
  const secret = Buffer.from(text, 'base64');
  // A truncated/corrupt store entry decodes to the wrong length — treat it
  // as unusable so callers overwrite it rather than wrap under garbage.
  return secret.length === WRAP_SECRET_LENGTH ? secret : null;
}

/**
 * Seal `plaintext` (the CA key PEM bytes) under `secret`. Output layout is
 * the documented {@link WRAP_MAGIC} envelope.
 */
export function wrapKeyMaterial(plaintext: Buffer, secret: Buffer): Buffer {
  if (secret.length !== WRAP_SECRET_LENGTH) {
    throw new CaKeyUnwrapError(
      `wrap secret must be ${WRAP_SECRET_LENGTH} bytes, got ${secret.length}`,
    );
  }
  const nonce = randomBytes(WRAP_NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', secret, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([WRAP_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}

/**
 * Reverse of {@link wrapKeyMaterial}. Every failure — bad magic, short
 * blob, wrong-length secret, failed GCM authentication — throws the same
 * {@link CaKeyUnwrapError}: callers cannot distinguish (and must not act
 * differently on) "wrong secret" vs. "corrupt file".
 */
export function unwrapKeyMaterial(blob: Buffer, secret: Buffer): Buffer {
  if (secret.length !== WRAP_SECRET_LENGTH) {
    throw new CaKeyUnwrapError(
      `wrap secret must be ${WRAP_SECRET_LENGTH} bytes, got ${secret.length}`,
    );
  }
  if (
    blob.length < WRAP_HEADER_LENGTH ||
    !blob.subarray(0, WRAP_MAGIC.length).equals(WRAP_MAGIC)
  ) {
    throw new CaKeyUnwrapError(
      'CA key envelope is not a BMKEYWRAP1 blob — refusing to unwrap',
    );
  }
  const nonce = blob.subarray(WRAP_MAGIC.length, WRAP_MAGIC.length + WRAP_NONCE_LENGTH);
  const tag = blob.subarray(
    WRAP_MAGIC.length + WRAP_NONCE_LENGTH,
    WRAP_HEADER_LENGTH,
  );
  const ciphertext = blob.subarray(WRAP_HEADER_LENGTH);
  try {
    const decipher = createDecipheriv('aes-256-gcm', secret, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new CaKeyUnwrapError(
      'CA key envelope failed AES-256-GCM authentication — wrong wrap secret or corrupt blob',
      { cause: err },
    );
  }
}

/** Production keychain coordinates for the macOS backend. */
export const KEYCHAIN_SERVICE = 'com.blockingmachine.https-filter.ca-key-wrap';
export const KEYCHAIN_ACCOUNT = 'blockingmachine-ca';

const SECURITY_BIN = '/usr/bin/security';
const SECRET_TOOL_BIN = 'secret-tool';
const POWERSHELL_BIN = 'powershell.exe';

/**
 * macOS login-keychain backend via the `security` CLI. The store leg pipes
 * `add-generic-password` into `security -i` rather than passing `-w` on
 * argv — same-UID processes can read a peer's argv, and the wrap secret
 * riding a command line would hand it to exactly the adversary the wrap
 * exists against. `-U` makes re-store an in-place update, so a renewed
 * secret never doubles the entry.
 */
export class SecurityCliBackend implements KeyWrapBackend {
  readonly name = 'macos-keychain(security-cli)';
  private readonly service: string;
  private readonly account: string;

  constructor(opts: { service?: string; account?: string } = {}) {
    this.service = opts.service ?? KEYCHAIN_SERVICE;
    this.account = opts.account ?? KEYCHAIN_ACCOUNT;
  }

  async load(): Promise<Buffer | null> {
    let result: RunResult;
    try {
      result = await runFile(SECURITY_BIN, [
        'find-generic-password',
        '-a',
        this.account,
        '-s',
        this.service,
        '-w',
      ]);
    } catch {
      return null;
    }
    // Exit 44 is errSecItemNotFound; any other nonzero (locked keychain,
    // errSecInteractionNotAllowed) reads as "no usable secret" the same way.
    if (result.code !== 0) {
      return null;
    }
    return decodeStoredSecret(result.stdout);
  }

  async store(secret: Buffer): Promise<void> {
    const result = await runFile(SECURITY_BIN, ['-i'], {
      input: Buffer.from(
        `add-generic-password -a ${this.account} -s ${this.service} -w ${secret.toString('base64')} -U\n`,
        'utf8',
      ),
    });
    if (result.code !== 0) {
      throw new Error(`security -i add-generic-password exited ${result.code}`);
    }
  }
}

/**
 * Linux Secret Service backend via `secret-tool` (libsecret). The secret
 * goes on stdin — `secret-tool store` reads it there — while argv carries
 * only the lookup attributes. Lookup output is the stored secret verbatim;
 * we keep it base64 so a stray newline in any frontend's output cannot
 * corrupt the byte count.
 */
export class SecretToolBackend implements KeyWrapBackend {
  readonly name = 'linux-secret-service(secret-tool)';
  /** Attribute pair identifying the entry in the default collection. */
  private readonly attrs: string[];

  constructor(opts: { attributes?: string[] } = {}) {
    this.attrs = opts.attributes ?? [
      'service',
      'com.blockingmachine.https-filter',
      'purpose',
      'ca-key-wrap',
    ];
  }

  async load(): Promise<Buffer | null> {
    let result: RunResult;
    try {
      result = await runFile(SECRET_TOOL_BIN, ['lookup', ...this.attrs]);
    } catch {
      return null;
    }
    // Nonzero = no match or no daemon — identical from the caller's side.
    if (result.code !== 0) {
      return null;
    }
    return decodeStoredSecret(result.stdout);
  }

  async store(secret: Buffer): Promise<void> {
    const result = await runFile(
      SECRET_TOOL_BIN,
      ['store', '--label=Blockingmachine HTTPS filter CA key wrap', ...this.attrs],
      { input: Buffer.from(secret.toString('base64'), 'utf8') },
    );
    if (result.code !== 0) {
      throw new Error(`secret-tool store exited ${result.code}`);
    }
  }
}

/**
 * Where the Windows backend's DPAPI blob lives when no CA store dir is
 * known — beside the CA files is preferred (`resolveBackend` passes the
 * store dir), this is only the standalone fallback.
 */
export function defaultWrapBlobPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'Blockingmachine', 'https-filter', 'ca.keywrap.blob');
}

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command'] as const;

/**
 * Windows DPAPI backend via `powershell.exe` and .NET
 * `[Security.Cryptography.ProtectedData]` (CurrentUser scope — the same
 * protection class the spec's "DPAPI on Windows" names). DPAPI outputs a
 * blob, not a store handle, so the blob is a file; it sits under the CA
 * store dir when one is supplied so the whole secret surface stays inside
 * the 0700 directory. The plaintext secret crosses on stdin, never argv;
 * the blob path crosses via env var.
 */
export class PowerShellProtectedDataBackend implements KeyWrapBackend {
  readonly name = 'windows-dpapi(powershell-protecteddata)';
  private readonly blobPath: string;

  constructor(blobPath: string) {
    this.blobPath = blobPath;
  }

  private envWithBlobPath(): NodeJS.ProcessEnv {
    return { ...process.env, BM_WRAP_BLOB_PATH: this.blobPath };
  }

  async load(): Promise<Buffer | null> {
    let result: RunResult;
    try {
      result = await runFile(
        POWERSHELL_BIN,
        [
          ...POWERSHELL_ARGS,
          [
            '$p = $env:BM_WRAP_BLOB_PATH;',
            'if (-not (Test-Path $p)) { exit 3 }',
            '$b = [System.IO.File]::ReadAllBytes($p);',
            '$s = [System.Security.Cryptography.ProtectedData]::Unprotect(',
            '  $b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
            '[Console]::Out.Write([Convert]::ToBase64String($s))',
          ].join(' '),
        ],
        { env: this.envWithBlobPath() },
      );
    } catch {
      return null;
    }
    if (result.code !== 0) {
      return null;
    }
    return decodeStoredSecret(result.stdout);
  }

  async store(secret: Buffer): Promise<void> {
    const result = await runFile(
      POWERSHELL_BIN,
      [
        ...POWERSHELL_ARGS,
        [
          '$p = $env:BM_WRAP_BLOB_PATH;',
          '[System.IO.Directory]::CreateDirectory((Split-Path $p -Parent)) | Out-Null;',
          '$s = [Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());',
          '$e = [System.Security.Cryptography.ProtectedData]::Protect(',
          '  $s, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
          '[System.IO.File]::WriteAllBytes($p, $e)',
        ].join(' '),
      ],
      { input: Buffer.from(secret.toString('base64'), 'utf8'), env: this.envWithBlobPath() },
    );
    if (result.code !== 0) {
      throw new Error(`powershell ProtectedData.Protect exited ${result.code}`);
    }
  }
}

export interface ResolveBackendOptions {
  /**
   * The CA store dir — the Windows backend parks its DPAPI blob inside it
   * (`<storeDir>/ca.keywrap.blob`) so the whole secret surface shares the
   * 0700 directory. Ignored by the macOS/Linux backends.
   */
  storeDir?: string;
}

/**
 * Pick the platform's wrap backend, or `null` when none is usable — the
 * honest answer the caller degrades to 0600 plaintext on, never an error.
 * Probing is cheap and side-effect-free: the macOS leg is a filesystem
 * access check, linux runs `secret-tool --version` (spawn ENOENT ⇒ absent),
 * win32 runs a no-op `powershell.exe` command.
 */
export async function resolveBackend(
  platform: string = process.platform,
  opts: ResolveBackendOptions = {},
): Promise<KeyWrapBackend | null> {
  switch (platform) {
    case 'darwin': {
      try {
        await access(SECURITY_BIN, fsConstants.X_OK);
        return new SecurityCliBackend();
      } catch {
        return null;
      }
    }
    case 'linux': {
      try {
        // `--version` exits 0 on libsecret's CLI; a spawn ENOENT means the
        // binary (and usually any Secret Service daemon) is absent.
        await runFile(SECRET_TOOL_BIN, ['--version']);
        return new SecretToolBackend();
      } catch {
        return null;
      }
    }
    case 'win32': {
      try {
        await runFile(POWERSHELL_BIN, [...POWERSHELL_ARGS, 'exit 0']);
        const blobPath = opts.storeDir
          ? join(opts.storeDir, 'ca.keywrap.blob')
          : defaultWrapBlobPath();
        return new PowerShellProtectedDataBackend(blobPath);
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}
