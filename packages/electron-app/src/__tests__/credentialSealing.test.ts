/**
 * Wiring pins for the credential-sealing findings (M3, M4).
 *
 * Two leaks shared a boundary: `feedToken` sat plaintext in config.json while its sibling
 * credentials went through safeStorage, and `get-sinkhole-config` handed decrypted values
 * to the renderer — which forwards console errors to the main log, so a stray
 * `console.error(config)` wrote live credentials to disk. The contract now: everything
 * reads/writes through the secret store, the renderer only ever receives presence flags,
 * and clearing is an explicit `clearSecrets` intent — a blank field means "unchanged".
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const main = readFileSync(join(appRoot, 'src/index.ts'), 'utf8');

function blockFrom(anchor: string, length = 2000): string {
  const start = main.indexOf(anchor);
  if (start < 0) throw new Error(`anchor not found in index.ts: ${anchor}`);
  // Stop at the next handler so a fixed-length window can't spill into a neighbouring
  // handler and pin its identifiers (e.g. set-feed-token's `token: unknown` param).
  const next = main.indexOf('ipcMain.handle(', start + anchor.length);
  const end = next > start ? Math.min(start + length, next) : start + length;
  return main.slice(start, end);
}

describe('feed token sealing', () => {
  test('the feed server resolves the token through the secret store', () => {
    const auth = blockFrom('const configuredToken', 300);
    expect(auth).toContain("readSecret(storeRef, safeStorage, 'feedToken')");
    expect(auth).not.toContain("storeRef.get('feedToken')");
  });

  test('get-feed-token returns a presence flag, never the value', () => {
    const handler = blockFrom("ipcMain.handle('get-feed-token'");
    expect(handler).toContain('configured:');
    expect(handler).not.toContain('token:');
  });

  test('set-feed-token writes through writeSecret and treats blank as unchanged', () => {
    const handler = blockFrom("ipcMain.handle('set-feed-token'");
    expect(handler).toContain("writeSecret(store, safeStorage, 'feedToken'");
    expect(handler).toContain('unchanged: true');
  });

  test('an explicit clear-feed-token channel exists for write-only clearing', () => {
    const handler = blockFrom("ipcMain.handle('clear-feed-token'");
    expect(handler).toContain("writeSecret(store, safeStorage, 'feedToken', '')");
  });

  test('no plaintext feedToken store access remains', () => {
    expect(main).not.toContain("store.get('feedToken')");
    expect(main).not.toContain("store.set('feedToken'");
  });
});

describe('sinkhole secrets are write-only', () => {
  test('get-sinkhole-config returns configured flags instead of decrypted values', () => {
    const handler = blockFrom("ipcMain.handle('get-sinkhole-config'");
    expect(handler).toContain('piholeApiKeyConfigured');
    expect(handler).toContain('adguardHomePasswordConfigured');
    expect(handler).toContain('haTokenConfigured');
    // A bare `piholeApiKey:` field would mean the plaintext still crosses the bridge.
    expect(handler).not.toContain('piholeApiKey: readSecret');
    expect(handler).not.toContain('adguardHomePassword: readSecret');
    expect(handler).not.toContain('haToken: readSecret');
  });

  test('set-sinkhole-config honours the explicit clearSecrets intent', () => {
    const handler = blockFrom("ipcMain.handle('set-sinkhole-config'", 3000);
    expect(handler).toContain('clearSecrets');
    expect(handler).toContain('val.trim().length > 0');
  });
});
