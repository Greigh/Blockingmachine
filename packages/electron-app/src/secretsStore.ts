/**
 * Secret-at-rest handling behind `safeStorage`.
 *
 * Every credential the hub holds — the Pi-hole token, the AdGuard Home password, the Home
 * Assistant token, the AI provider key — used to sit in electron-store as plaintext JSON,
 * readable by anything with file access to the profile directory. `safeStorage` encrypts with
 * the OS keychain (Keychain on macOS, DPAPI on Windows, libsecret where it exists) precisely
 * for this, so the stored form is `${key}Encrypted` as a base64 string and the plaintext key
 * is deleted on write.
 *
 * The cipher is injected rather than imported from 'electron' for the same reason `feedAuth`
 * and `sinkholeNet` take their dependencies: `index.ts` hands in `safeStorage`, a test hands
 * in a fake, and the module stays loadable where Electron is not.
 *
 * Where encryption is unavailable (`isEncryptionAvailable() === false` — a Linux session with
 * no libsecret), the callers keep their plaintext behaviour rather than refusing to run, and
 * `secretStorageAvailable` is what lets the settings surface say so instead of silently
 * storing weaker than the user expects.
 */

/** The slice of Electron's `safeStorage` this module needs — the whole API surface, by shape. */
export interface SecretCipher {
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
  isEncryptionAvailable(): boolean;
}

/** The slice of electron-store the secret paths touch. */
export interface SecretStoreLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

const encryptedKey = (key: string) => `${key}Encrypted`;

function decryptMaybe(cipher: SecretCipher, encoded: unknown): string | null {
  if (typeof encoded !== 'string' || !encoded) return null;
  try {
    return cipher.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    // A corrupt or foreign-base64 value is not a credential — fall through to whatever the
    // plaintext key still holds rather than failing the whole read on it.
    return null;
  }
}

export function secretStorageAvailable(cipher: SecretCipher): boolean {
  try {
    return cipher.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Reads a flat store secret, migrating a legacy plaintext value on first touch.
 *
 * Migration is the read doing double duty on purpose: the upgrade happens the first time the
 * value is needed rather than on a launch sweep, so an unavailable cipher never gets a run at
 * deleting plaintext it could not re-encrypt, and a working one upgrades each key exactly
 * once, when it is actually used.
 */
export function readSecret(store: SecretStoreLike, cipher: SecretCipher, key: string): string {
  const plain = store.get(key);
  const value = typeof plain === 'string' ? plain : '';
  if (value) {
    // Plaintext alongside a sealed copy is always the *newer* write — every sealed write
    // deletes the plaintext key, so its presence means something wrote after the seal. It
    // wins, and a working cipher upgrades it in place rather than letting the stale sealed
    // value shadow it.
    if (secretStorageAvailable(cipher)) {
      store.set(encryptedKey(key), cipher.encryptString(value).toString('base64'));
      store.delete(key);
    }
    return value;
  }

  return decryptMaybe(cipher, store.get(encryptedKey(key))) ?? '';
}

/**
 * Writes a flat store secret. With a cipher available the plaintext key is always removed —
 * an empty value clears both forms, so clearing a field cannot resurrect the stale encrypted
 * copy the next read would otherwise prefer.
 */
export function writeSecret(
  store: SecretStoreLike,
  cipher: SecretCipher,
  key: string,
  value: unknown,
): void {
  const plaintext = typeof value === 'string' ? value : '';
  if (secretStorageAvailable(cipher)) {
    if (plaintext) {
      store.set(encryptedKey(key), cipher.encryptString(plaintext).toString('base64'));
    } else {
      store.delete(encryptedKey(key));
    }
    store.delete(key);
    return;
  }
  store.set(key, plaintext);
  store.delete(encryptedKey(key));
}

/**
 * The same two forms inside a nested config object (`aiConfig.apiKey`).
 *
 * `readSecretField` answers the effective value for consumers; `sealSecretField` produces the
 * object to persist — plaintext field out, `${field}Encrypted` in when a cipher is available,
 * unchanged plaintext when it is not. An absent plaintext field leaves an existing encrypted
 * one alone, so a config update that does not touch the key cannot lose it.
 */
export function readSecretField(
  obj: Record<string, unknown> | undefined,
  cipher: SecretCipher,
  field: string,
): string {
  if (!obj) return '';
  const plain = obj[field];
  // Same rule as `readSecret`: a plaintext field that survived a seal is a newer write than
  // the sealed copy — `sealSecretField` treats it as authoritative and so must the read.
  if (typeof plain === 'string' && plain) return plain;
  return decryptMaybe(cipher, obj[`${field}Encrypted`]) ?? '';
}

export function sealSecretField(
  obj: Record<string, unknown>,
  cipher: SecretCipher,
  field: string,
): Record<string, unknown> {
  const sealed = { ...obj };
  const plain = sealed[field];
  if (typeof plain === 'string' && plain && secretStorageAvailable(cipher)) {
    sealed[`${field}Encrypted`] = cipher.encryptString(plain).toString('base64');
    delete sealed[field];
  } else if (typeof plain === 'string') {
    // Plaintext present means the encrypted copy — reachable only while a cipher could not
    // re-encrypt — is stale, and a read prefers it. Delete it either way: an emptied secret
    // clears both forms, and a plaintext write with no cipher must not leave a stale sealed
    // value for the day encryption comes back.
    delete sealed[`${field}Encrypted`];
    if (!plain) delete sealed[field];
  }
  return sealed;
}
