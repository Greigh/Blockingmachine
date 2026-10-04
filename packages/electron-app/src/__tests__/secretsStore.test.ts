/**
 * The `safeStorage` seal behind the stored credentials.
 *
 * What is worth pinning is the migration's asymmetry: a plaintext value upgrades exactly
 * once, when it is read — an unavailable cipher never gets a run at deleting plaintext it
 * could not re-encrypt — and a stale encrypted copy can never shadow a newer plaintext write
 * or resurrect a cleared secret. The cipher is a fake standing in for `safeStorage`, and the
 * store is a Map, so every branch runs without Electron.
 */

import { describe, expect, test } from '@jest/globals';
import {
  readSecret,
  readSecretField,
  sealSecretField,
  secretStorageAvailable,
  writeSecret,
  type SecretCipher,
  type SecretStoreLike,
} from '../secretsStore';

/** A reversible fake cipher — the shape `safeStorage` has, not its crypto. */
function fakeCipher(available = true): SecretCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plaintext: string) => Buffer.from(`enc(${plaintext})`),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString();
      if (!text.startsWith('enc(') || !text.endsWith(')')) throw new Error('not a sealed value');
      return text.slice(4, -1);
    },
  };
}

function fakeStore(initial: Record<string, unknown> = {}): SecretStoreLike & {
  entries: Map<string, unknown>;
} {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    get: (key: string) => entries.get(key),
    set: (key: string, value: unknown) => void entries.set(key, value),
    delete: (key: string) => void entries.delete(key),
  };
}

describe('readSecret', () => {
  test('prefers the sealed value and decrypts it', () => {
    const cipher = fakeCipher();
    const store = fakeStore({ piholeApiKeyEncrypted: 'enc(decoded)' });
    // The store carries the fake cipher's own base64 shape — re-encode it the way
    // writeSecret would have.
    store.set('piholeApiKeyEncrypted', Buffer.from('enc(decoded)').toString('base64'));
    expect(readSecret(store, cipher, 'piholeApiKey')).toBe('decoded');
  });

  test('migrates a plaintext value on first read when a cipher is available', () => {
    const cipher = fakeCipher();
    const store = fakeStore({ piholeApiKey: 'plain-token' });

    expect(readSecret(store, cipher, 'piholeApiKey')).toBe('plain-token');
    // The upgrade is complete: plaintext gone, sealed form in its place.
    expect(store.entries.has('piholeApiKey')).toBe(false);
    expect(typeof store.entries.get('piholeApiKeyEncrypted')).toBe('string');
    // And the second read answers from the sealed copy — this is the once-only part.
    expect(readSecret(store, cipher, 'piholeApiKey')).toBe('plain-token');
  });

  test('leaves plaintext alone when no cipher is available', () => {
    const cipher = fakeCipher(false);
    const store = fakeStore({ piholeApiKey: 'plain-token' });

    expect(readSecret(store, cipher, 'piholeApiKey')).toBe('plain-token');
    expect(store.entries.get('piholeApiKey')).toBe('plain-token');
    expect(store.entries.has('piholeApiKeyEncrypted')).toBe(false);
  });

  test('falls back to plaintext when the sealed value is corrupt', () => {
    const cipher = fakeCipher();
    const store = fakeStore({
      piholeApiKey: 'still-there',
      piholeApiKeyEncrypted: 'not-valid-base64-payload',
    });
    expect(readSecret(store, cipher, 'piholeApiKey')).toBe('still-there');
  });

  test('a plaintext write wins over a stale sealed copy — and migrates over it', () => {
    // The failure this pins: an encrypted read that prefers the sealed slot resurrects the
    // old token after a plaintext write (the no-keychain session's write, a hand edit, a
    // restore), so the app authenticates with a credential the user replaced.
    const cipher = fakeCipher();
    const store = fakeStore({
      piholeApiKey: 'new-token',
      piholeApiKeyEncrypted: Buffer.from('enc(old-token)').toString('base64'),
    });

    expect(readSecret(store, cipher, 'piholeApiKey')).toBe('new-token');
    // The read also completes the migration the plaintext was waiting for.
    expect(store.entries.has('piholeApiKey')).toBe(false);
    expect(
      cipher.decryptString(
        Buffer.from(store.entries.get('piholeApiKeyEncrypted') as string, 'base64'),
      ),
    ).toBe('new-token');
  });

  test('with no cipher, plaintext alongside a stale sealed copy still wins', () => {
    const cipher = fakeCipher(false);
    const store = fakeStore({
      haToken: 'new-token',
      haTokenEncrypted: Buffer.from('enc(old-token)').toString('base64'),
    });
    expect(readSecret(store, cipher, 'haToken')).toBe('new-token');
    expect(store.entries.get('haToken')).toBe('new-token');
  });

  test('returns an empty string for a missing key rather than a crash', () => {
    expect(readSecret(fakeStore(), fakeCipher(), 'piholeApiKey')).toBe('');
  });
});

describe('writeSecret', () => {
  test('stores only the sealed form when a cipher is available', () => {
    const cipher = fakeCipher();
    const store = fakeStore();
    writeSecret(store, cipher, 'haToken', 'secret-value');

    expect(store.entries.has('haToken')).toBe(false);
    const sealed = store.entries.get('haTokenEncrypted');
    expect(typeof sealed).toBe('string');
    expect(cipher.decryptString(Buffer.from(sealed as string, 'base64'))).toBe('secret-value');
  });

  test('clearing a secret removes both forms', () => {
    const cipher = fakeCipher();
    const store = fakeStore({ haToken: 'old' });
    writeSecret(store, cipher, 'haToken', 'new');
    writeSecret(store, cipher, 'haToken', '');

    expect(store.entries.has('haToken')).toBe(false);
    expect(store.entries.has('haTokenEncrypted')).toBe(false);
    expect(readSecret(store, cipher, 'haToken')).toBe('');
  });

  test('with no cipher, writes plaintext and drops any stale sealed copy', () => {
    const cipher = fakeCipher(false);
    const store = fakeStore({ haTokenEncrypted: Buffer.from('enc(stale)').toString('base64') });
    writeSecret(store, cipher, 'haToken', 'fresh-plain');

    expect(store.entries.get('haToken')).toBe('fresh-plain');
    // The stale sealed copy is gone — a read must never prefer a value older than the write.
    expect(store.entries.has('haTokenEncrypted')).toBe(false);
  });
});

describe('nested config secrets', () => {
  test('readSecretField answers the effective value through either form', () => {
    const cipher = fakeCipher();
    expect(
      readSecretField({ apiKeyEncrypted: Buffer.from('enc(k1)').toString('base64') }, cipher, 'apiKey'),
    ).toBe('k1');
    expect(readSecretField({ apiKey: 'k2' }, cipher, 'apiKey')).toBe('k2');
    // Parity with `readSecret`: a surviving plaintext field is the newer write, so the stale
    // sealed sibling does not shadow it.
    expect(
      readSecretField(
        { apiKey: 'new-key', apiKeyEncrypted: Buffer.from('enc(old-key)').toString('base64') },
        cipher,
        'apiKey',
      ),
    ).toBe('new-key');
    expect(readSecretField(undefined, cipher, 'apiKey')).toBe('');
  });

  test('sealSecretField replaces plaintext with the sealed sibling', () => {
    const cipher = fakeCipher();
    const sealed = sealSecretField({ apiKey: 'live-key', provider: 'gemini' }, cipher, 'apiKey');

    expect(sealed.apiKey).toBeUndefined();
    expect(typeof sealed.apiKeyEncrypted).toBe('string');
    expect(
      cipher.decryptString(Buffer.from(sealed.apiKeyEncrypted as string, 'base64')),
    ).toBe('live-key');
    expect(sealed.provider).toBe('gemini');
  });

  test('an absent field leaves an existing sealed value alone', () => {
    const cipher = fakeCipher();
    const existing = Buffer.from('enc(keep)').toString('base64');
    const sealed = sealSecretField({ apiKeyEncrypted: existing, provider: 'openai' }, cipher, 'apiKey');
    expect(sealed.apiKeyEncrypted).toBe(existing);
  });

  test('an emptied field clears both forms', () => {
    const cipher = fakeCipher();
    const sealed = sealSecretField({ apiKey: '', apiKeyEncrypted: 'x' }, cipher, 'apiKey');
    expect(sealed.apiKey).toBeUndefined();
    expect(sealed.apiKeyEncrypted).toBeUndefined();
  });
});

describe('secretStorageAvailable', () => {
  test('mirrors the cipher and survives a throwing probe', () => {
    expect(secretStorageAvailable(fakeCipher(true))).toBe(true);
    expect(secretStorageAvailable(fakeCipher(false))).toBe(false);
    const throwing: SecretCipher = {
      ...fakeCipher(),
      isEncryptionAvailable: () => {
        throw new Error('not ready');
      },
    };
    expect(secretStorageAvailable(throwing)).toBe(false);
  });
});
