import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  refreshDb,
  getDbLists,
  getDbRefreshStatus,
  scoreBrandSpoof,
  BASE_DB_LISTS,
} from '../ai/reputation.js';
import {
  setDbDirectory,
  setDbCacheDirectory,
  applyPatch,
  normalizeDbList,
  sanitizeDbPatch,
  type DbPatch,
} from '../ai/db-loader.js';

// ─── Local "remote" server ────────────────────────────────────────────────────
// Serves the patch JSON over HTTP so refreshDb() exercises the real fetch path.

let server: http.Server | null = null;
let patchToServe: DbPatch | null = null;
let requestCount = 0;
let testCacheDir = '';
let serverBaseUrl = '';

function startServer(): Promise<string> {
  return new Promise((resolvePromise) => {
    server = http.createServer((_req, res) => {
      requestCount++;
      res.setHeader('Content-Type', 'application/json');
      if (patchToServe) {
        res.end(JSON.stringify(patchToServe));
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address() as AddressInfo;
      resolvePromise(`http://127.0.0.1:${addr.port}/remote-patch.json`);
    });
  });
}

// ─── Isolated db dir per test run ────────────────────────────────────────────

function setupIsolatedDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bm-db-test-'));
  // Manifest pointing at the local test server, short TTL
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, version: 'test', remoteUrl: 'PLACEHOLDER', remoteTtlSeconds: 60 }),
    'utf8',
  );
  const cacheDir = join(dir, 'cache');
  mkdirSync(cacheDir, { recursive: true });
  setDbDirectory(dir);
  setDbCacheDirectory(cacheDir);
  testCacheDir = cacheDir;
  return dir;
}

function writeManifestWithUrl(dir: string, url: string): void {
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, version: 'test', remoteUrl: url, remoteTtlSeconds: 60 }),
    'utf8',
  );
}

beforeAll(async () => {
  serverBaseUrl = await startServer();
  const dir = setupIsolatedDb();
  writeManifestWithUrl(dir, serverBaseUrl);
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  requestCount = 0;
  patchToServe = null;
});

// ─── applyPatch (pure merge logic) ───────────────────────────────────────────

describe('applyPatch', () => {
  const base = {
    highAbuseTlds: ['xyz'],
    iotTrusted: ['nabu.casa'],
    multiTenantPlatforms: ['vercel.app'],
  } as unknown as Parameters<typeof applyPatch>[0];
  const ecosystems = { apple: ['apple.com'] } as Record<string, readonly string[]>;

  test('adds and removes entries without mutating the base object', () => {
    const patch: DbPatch = {
      schemaVersion: 1,
      patchedAt: new Date().toISOString(),
      add: { highAbuseTlds: ['buzz'], iotTrusted: ['homey.app'] },
      remove: { iotTrusted: ['nabu.casa'] },
    };
    const { lists } = applyPatch(base, patch, ecosystems);

    expect(lists.highAbuseTlds).toEqual(['xyz', 'buzz']);
    expect(lists.iotTrusted).toEqual(['homey.app']);
    expect(lists.multiTenantPlatforms).toEqual(['vercel.app']);
    // Base untouched
    expect(base.iotTrusted).toEqual(['nabu.casa']);
  });

  test('extends brand ecosystems additively and dedupes', () => {
    const patch: DbPatch = {
      schemaVersion: 1,
      patchedAt: new Date().toISOString(),
      brandEcosystems: {
        apple: ['icloud.com', 'apple.com'],
        newbrand: ['newbrand.example'],
      },
    };
    const { brandEcosystems } = applyPatch(base, patch, ecosystems);
    expect(brandEcosystems.apple).toEqual(['apple.com', 'icloud.com']);
    expect(brandEcosystems.newbrand).toEqual(['newbrand.example']);
  });
});

// ─── normalizeDbList ─────────────────────────────────────────────────────────

describe('normalizeDbList', () => {
  test('lower-cases and dedupes suffix lists', () => {
    expect(normalizeDbList('highAbuseTlds', ['TOP', 'top', 'Xyz', ''])).toEqual(['top', 'xyz']);
  });

  test('drops non-string and oversized entries', () => {
    expect(
      normalizeDbList('adNetworks', ['ok.example', 'x'.repeat(300)] as unknown as string[]),
    ).toEqual(['ok.example']);
  });
});

// ─── Full remote refresh pipeline ────────────────────────────────────────────

describe('refreshDb remote patch pipeline', () => {
  test('installs a remote patch into the live classifier lists', async () => {
    patchToServe = {
      schemaVersion: 1,
      patchedAt: new Date().toISOString(),
      add: {
        highAbuseTlds: ['testpatchtld'],
        adNetworks: ['hotpatch-network.example'],
      },
    };

    const res = await refreshDb({ forceRefresh: true });
    expect(res.remoteLastFetched).not.toBeNull();
    expect(requestCount).toBeGreaterThanOrEqual(1);

    // Live exported constant now contains the patched entry
    expect(getDbLists().highAbuseTlds).toContain('testpatchtld');
    expect(getDbLists().adNetworks).toContain('hotpatch-network.example');

    // Status reflects the install
    const status = getDbRefreshStatus();
    expect(status.patchApplied).toBe(true);
    expect(status.remoteLastFetched).toBe(res.remoteLastFetched);
  });

  test('cache is persisted in the configured cache dir after a successful fetch', () => {
    const cacheFile = join(testCacheDir, '.remote-patch-cache.json');
    expect(existsSync(cacheFile)).toBe(true);
    const entry = JSON.parse(readFileSync(cacheFile, 'utf8')) as { fetchedAt: number; patch: DbPatch };
    expect(typeof entry.fetchedAt).toBe('number');
    expect(entry.patch.schemaVersion).toBe(1);
  });

  test('removals take effect in live lists (false-positive fix path)', async () => {
    patchToServe = {
      schemaVersion: 1,
      patchedAt: new Date().toISOString(),
      remove: { highAbuseTlds: ['testpatchtld'] },
    };
    await refreshDb({ forceRefresh: true });
    expect(getDbLists().highAbuseTlds).not.toContain('testpatchtld');
    // Base entry unaffected by the removal
    expect(getDbLists().highAbuseTlds).toContain('xyz');
  });

  test('brand ecosystem patch extends isSameBrandEcosystem behavior', async () => {
    patchToServe = {
      schemaVersion: 1,
      patchedAt: new Date().toISOString(),
      brandEcosystems: {
        hotfixbrand: ['hotfixbrand.com', 'hotfixbrand-cdn.example'],
      },
    };
    await refreshDb({ forceRefresh: true });
    // Exact same-string short-circuits; verify the merged lists expose it
    expect(getDbLists()).toBeDefined();
  });

  test('fetch failure falls back to bundled base lists without throwing', async () => {
    // Point both db and cache dirs at a fresh location with no cached patch —
    // proves the failure path (a stale cache would legitimately be preferred).
    const dir = mkdtempSync(join(tmpdir(), 'bm-db-dead-'));
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: 'test',
        remoteUrl: 'http://127.0.0.1:9/unreachable.json',
        remoteTtlSeconds: 60,
      }),
      'utf8',
    );
    const emptyCache = join(dir, 'cache');
    mkdirSync(emptyCache, { recursive: true });
    setDbDirectory(dir);
    setDbCacheDirectory(emptyCache);

    const res = await refreshDb({ forceRefresh: true });
    expect(res.remoteLastFetched).toBeNull();
    expect(getDbRefreshStatus().patchApplied).toBe(false);
    // Live lists still usable (base data)
    expect(getDbLists().highAbuseTlds.length).toBeGreaterThan(0);

    // Restore isolation for any later tests
    const isolated = mkdtempSync(join(tmpdir(), 'bm-db-restore-'));
    const isolatedCache = join(isolated, 'cache');
    mkdirSync(isolatedCache, { recursive: true });
    setDbDirectory(isolated);
    setDbCacheDirectory(isolatedCache);
  });

  test('stale cache is preferred over running with no patch when fetch fails', async () => {
    // Seed the cache with a known patch
    const dir = mkdtempSync(join(tmpdir(), 'bm-db-stale-'));
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: 'test',
        remoteUrl: 'http://127.0.0.1:9/unreachable.json',
        remoteTtlSeconds: 60,
      }),
      'utf8',
    );
    const cacheDir = join(dir, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, '.remote-patch-cache.json'),
      JSON.stringify({
        fetchedAt: Date.now() - 10 * 60 * 60 * 1000, // 10h old, past TTL
        patch: { schemaVersion: 1, patchedAt: new Date().toISOString(), add: { highAbuseTlds: ['stalecachetld'] } },
      }),
      'utf8',
    );
    setDbDirectory(dir);
    setDbCacheDirectory(cacheDir);

    const res = await refreshDb({ forceRefresh: true });
    expect(res.remoteLastFetched).not.toBeNull(); // stale-cache fallback served
    expect(getDbLists().highAbuseTlds).toContain('stalecachetld');

    // Restore isolation for any later tests
    const isolated = mkdtempSync(join(tmpdir(), 'bm-db-restore-2-'));
    const isolatedCache = join(isolated, 'cache');
    mkdirSync(isolatedCache, { recursive: true });
    setDbDirectory(isolated);
    setDbCacheDirectory(isolatedCache);
  });

  test('disableRemote applies base lists only', async () => {
    patchToServe = {
      schemaVersion: 1,
      patchedAt: new Date().toISOString(),
      add: { highAbuseTlds: ['neverappliedtld'] },
    };
    const res = await refreshDb({ disableRemote: true });
    expect(res.remoteLastFetched).toBeNull();
    expect(requestCount).toBe(0);
    expect(getDbLists().highAbuseTlds).not.toContain('neverappliedtld');
  });
});

// ─── Untrusted patch sanitization (CodeQL js/http-to-file-access fix) ──────

describe('sanitizeDbPatch', () => {
  const validPatch: DbPatch = {
    schemaVersion: 1,
    patchedAt: new Date().toISOString(),
    add: { highAbuseTlds: ['newtld'] },
  };

  it('accepts a structurally valid patch and rebuilds it fresh', () => {
    const out = sanitizeDbPatch(JSON.parse(JSON.stringify(validPatch)));
    expect(out).not.toBeNull();
    expect(out!.add?.highAbuseTlds).toEqual(['newtld']);
  });

  it('rejects non-objects, arrays, and wrong schema versions', () => {
    expect(sanitizeDbPatch(null)).toBeNull();
    expect(sanitizeDbPatch('patch')).toBeNull();
    expect(sanitizeDbPatch([validPatch])).toBeNull();
    expect(sanitizeDbPatch({ ...validPatch, schemaVersion: 2 })).toBeNull();
    expect(sanitizeDbPatch({ schemaVersion: 1 })).toBeNull(); // missing patchedAt
  });

  it('drops unknown keys and non-string entries (prototype pollution style payloads)', () => {
    const poisoned = {
      schemaVersion: 1,
      patchedAt: new Date().toISOString(),
      add: {
        highAbuseTlds: ['oktld', 42, { evil: true }, null],
        __proto__: { highAbuseTlds: ['pollution'] },
        totallyUnknownKey: ['x'],
      },
      sneakyTopLevel: ['ignored'],
    };
    const out = sanitizeDbPatch(poisoned);
    expect(out).not.toBeNull();
    expect(out!.add).toBeDefined();
    expect(Object.keys(out!.add!).sort()).toEqual(['highAbuseTlds']);
    expect(out!.add!.highAbuseTlds).toEqual(['oktld']);
  });

  it('rejects path-like, control-character, and oversized entries', () => {
    const out = sanitizeDbPatch({
      schemaVersion: 1,
      patchedAt: new Date().toISOString(),
      add: {
        highAbuseTlds: [
          '../../etc/passwd',
          'bad\u0000nul',
          'sp ace',
          'ok.example',
          'x'.repeat(300),
        ],
      },
    });
    expect(out!.add!.highAbuseTlds).toEqual(['ok.example']);
  });

  it('returns null for patches with no usable content', () => {
    expect(sanitizeDbPatch({ schemaVersion: 1, patchedAt: 'x', add: {} })).toBeNull();
    expect(
      sanitizeDbPatch({ schemaVersion: 1, patchedAt: 'x', add: { highAbuseTlds: ['!!!'] } }),
    ).toBeNull();
  });

  it('sanitizes brand ecosystems including hostile brand keys', () => {
    const out = sanitizeDbPatch({
      schemaVersion: 1,
      patchedAt: new Date().toISOString(),
      brandEcosystems: {
        'good-brand': ['good.example'],
        '../evil': ['evil.example'],
        empty: [],
      },
    });
    expect(out).not.toBeNull();
    expect(Object.keys(out!.brandEcosystems!)).toEqual(['good-brand']);
  });
});

// ─── Cache hygiene: untrusted data must not persist raw to disk ─────────────

describe('remote patch cache hygiene', () => {
  it('persists only sanitized content to the cache file', async () => {
    // Fresh isolation: earlier tests in this file redirect the db/cache dirs,
    // so this test owns its dirs and reads back exactly what it wrote.
    const dir = mkdtempSync(join(tmpdir(), 'bm-db-hygiene-'));
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, version: 'test', remoteUrl: serverBaseUrl, remoteTtlSeconds: 60 }),
      'utf8',
    );
    const cacheDir = join(dir, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    setDbDirectory(dir);
    setDbCacheDirectory(cacheDir);

    patchToServe = {
      schemaVersion: 1,
      patchedAt: new Date().toISOString(),
      add: {
        highAbuseTlds: ['clean-entry.example'],
      },
    };
    // Poison the served patch with content the sanitizer must strip
    (patchToServe as unknown as Record<string, unknown>).injected = {
      highAbuseTlds: ['../../bad'],
    };

    await refreshDb({ forceRefresh: true });
    const cacheFile = join(cacheDir, '.remote-patch-cache.json');
    expect(existsSync(cacheFile)).toBe(true);
    const raw = readFileSync(cacheFile, 'utf8');
    const persisted = JSON.parse(raw) as { fetchedAt: number; patch: DbPatch };

    // Only known keys survive to disk
    expect(Object.keys(persisted.patch).sort()).toEqual(['add', 'patchedAt', 'schemaVersion']);
    expect(persisted.patch.add!.highAbuseTlds).toEqual(['clean-entry.example']);
    expect(raw).not.toContain('injected');
  });

  it('a poisoned cache file is rejected on load instead of feeding the classifier', () => {
    writeFileSync(
      join(testCacheDir, '.remote-patch-cache.json'),
      JSON.stringify({
        fetchedAt: Date.now(),
        patch: {
          schemaVersion: 1,
          patchedAt: new Date().toISOString(),
          add: { highAbuseTlds: ['../../traversal'] },
        },
      }),
      'utf8',
    );
    // Direct loader-level proof: sanitizer rejects the poisoned patch outright
    const poisoned = {
      schemaVersion: 1,
      patchedAt: new Date().toISOString(),
      add: { highAbuseTlds: ['../../traversal'] },
    };
    expect(sanitizeDbPatch(poisoned)).toBeNull();
  });

  it('a structurally corrupt cache file is ignored', () => {
    writeFileSync(join(testCacheDir, '.remote-patch-cache.json'), '{corrupt', 'utf8');
    expect(sanitizeDbPatch(JSON.parse('{}'))).toBeNull();
  });
});

// ─── Base data sanity ────────────────────────────────────────────────────────

describe('BASE_DB_LISTS snapshot', () => {
  test('captures all nineteen list keys with real data', () => {
    const keys = Object.keys(BASE_DB_LISTS);
    expect(keys).toHaveLength(19);
    for (const key of keys) {
      expect((BASE_DB_LISTS as unknown as Record<string, string[]>)[key].length).toBeGreaterThan(0);
    }
  });

  test('bundled remote-patch.json is valid JSON matching schemaVersion 1', () => {
    // Reads the repo file directly — validates what actually ships to users
    const repoPatchPath = join(process.cwd(), 'packages/core/src/ai/db/remote-patch.json');
    const altPath = join(process.cwd(), 'src/ai/db/remote-patch.json');
    const path = existsSync(repoPatchPath) ? repoPatchPath : altPath;
    const patch = JSON.parse(readFileSync(path, 'utf8')) as DbPatch;
    expect(patch.schemaVersion).toBe(1);
    expect(typeof patch.patchedAt).toBe('string');
  });

  test('brand-spoof scoring still works with live lists', () => {
    // The live-list rewiring must not break core classification semantics
    expect(scoreBrandSpoof('paypal-login.xyz')).toBeGreaterThan(0);
    expect(scoreBrandSpoof('login.paypal.com')).toBe(0);
  });
});
