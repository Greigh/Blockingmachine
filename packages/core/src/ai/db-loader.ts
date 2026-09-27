/**
 * Blockingmachine AI Reputation Database Loader
 *
 * Loads domain/token classification lists from:
 *   1. The bundled base data (reputation.ts hardcoded constants)
 *   2. A remote JSON patch file fetched from GitHub (or another configured URL)
 *      — hot-patching new entries or removing false positives without rebuilding
 *
 * Remote patch format: packages/core/src/ai/db/patch-schema.json
 * Manifest (URL + TTL): packages/core/src/ai/db/manifest.json
 *
 * The loader is intentionally simple and dependency-free (uses only Node built-ins).
 * All merges are additive — the remote patch can only add to or remove from lists,
 * it cannot replace logic. Safety: only string array fields are merged.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DbPatch {
  schemaVersion: 1;
  patchedAt: string;
  add?: Partial<DbLists>;
  remove?: Partial<DbLists>;
  /** Extend or add brand ecosystem domain arrays */
  brandEcosystems?: Record<string, string[]>;
}

export interface DbLists {
  highAbuseTlds: string[];
  adNetworks: string[];
  trackerNetworks: string[];
  cloudSuffixes: string[];
  cdnSuffixes: string[];
  iotTrusted: string[];
  vendorSuffixes: string[];
  platformSuffixes: string[];
  multiTenantPlatforms: string[];
  untrustedHosting: string[];
  cdnRoutingSuffixes: string[];
  suspiciousAdTokens: string[];
  suspiciousTrackerTokens: string[];
  specificNetworkTokens: string[];
  highProfileBrands: string[];
  dictionaryExemptions: string[];
  benignEndpointLabels: string[];
  dnsSuffixes: string[];
}

export interface DbManifest {
  schemaVersion: number;
  version: string;
  remoteUrl: string;
  remoteTtlSeconds: number;
  lastUpdated: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DB_DIR = new URL('./db', import.meta.url).pathname;
const MANIFEST_PATH = join(DB_DIR, 'manifest.json');
/** Local cache of the last fetched remote patch, stored next to the DB dir */
const CACHE_PATH = join(DB_DIR, '.remote-patch-cache.json');

const LIST_KEYS: Array<keyof DbLists> = [
  'highAbuseTlds', 'adNetworks', 'trackerNetworks', 'cloudSuffixes',
  'cdnSuffixes', 'iotTrusted', 'vendorSuffixes', 'platformSuffixes',
  'multiTenantPlatforms', 'untrustedHosting', 'cdnRoutingSuffixes',
  'suspiciousAdTokens', 'suspiciousTrackerTokens', 'specificNetworkTokens',
  'highProfileBrands', 'dictionaryExemptions', 'benignEndpointLabels', 'dnsSuffixes',
];

// ─── Manifest ─────────────────────────────────────────────────────────────────

function loadManifest(): DbManifest {
  return _require(MANIFEST_PATH) as DbManifest;
}

// ─── Patch merging ────────────────────────────────────────────────────────────

/**
 * Applies a patch on top of existing lists.
 * add entries are deduplicated; remove entries are filtered out.
 */
export function applyPatch(
  base: DbLists,
  patch: DbPatch,
  brandEcosystems: Record<string, readonly string[]>,
): { lists: DbLists; brandEcosystems: Record<string, readonly string[]> } {
  const lists: DbLists = { ...base };

  for (const key of LIST_KEYS) {
    const toAdd = patch.add?.[key] ?? [];
    const toRemove = new Set(patch.remove?.[key] ?? []);
    const merged = [...new Set([...lists[key], ...toAdd])].filter(
      (v) => !toRemove.has(v),
    );
    (lists as unknown as Record<string, string[]>)[key] = merged;
  }

  // Merge brand ecosystems
  const mergedEco: Record<string, readonly string[]> = { ...brandEcosystems };
  if (patch.brandEcosystems) {
    for (const [brand, domains] of Object.entries(patch.brandEcosystems)) {
      const existing = mergedEco[brand] ?? [];
      mergedEco[brand] = [...new Set([...existing, ...domains])];
    }
  }

  return { lists, brandEcosystems: mergedEco };
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  fetchedAt: number;
  patch: DbPatch;
}

function readCache(): CacheEntry | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    mkdirSync(DB_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(entry, null, 2), 'utf8');
  } catch {
    // Non-fatal — we'll just re-fetch next time
  }
}

// ─── Remote fetch ─────────────────────────────────────────────────────────────

/**
 * Fetches the remote patch from the manifest URL.
 * Returns null on any error so the loader can fall back to base data gracefully.
 */
async function fetchRemotePatch(url: string): Promise<DbPatch | null> {
  try {
    // Dynamic import so this module stays compatible with environments where
    // node-fetch hasn't been installed (tests, etc.)
    const fetchFn: typeof fetch =
      typeof globalThis.fetch === 'function'
        ? globalThis.fetch
        : (await import('node-fetch')).default as unknown as typeof fetch;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchFn(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Blockingmachine-db-loader/1' },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as DbPatch;
      if (json.schemaVersion !== 1) return null;
      return json;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface LoadedDb {
  lists: DbLists;
  brandEcosystems: Record<string, readonly string[]>;
  /** ISO string of when the remote patch was last successfully fetched */
  remoteLastFetched: string | null;
}

/**
 * Loads the reputation database.
 *
 * @param baseLists - The hardcoded base lists from reputation.ts
 * @param baseBrandEcosystems - The hardcoded brand ecosystems from reputation.ts
 * @param options.disableRemote - Skip remote fetch entirely (useful in offline/test envs)
 * @param options.forceRefresh - Ignore cache TTL and force a fresh remote fetch
 */
export async function loadDb(
  baseLists: DbLists,
  baseBrandEcosystems: Record<string, readonly string[]>,
  options: { disableRemote?: boolean; forceRefresh?: boolean } = {},
): Promise<LoadedDb> {
  const manifest = loadManifest();

  if (options.disableRemote || !manifest.remoteUrl) {
    return { lists: baseLists, brandEcosystems: baseBrandEcosystems, remoteLastFetched: null };
  }

  // Check cache
  const cache = readCache();
  const now = Date.now();
  const ttlMs = manifest.remoteTtlSeconds * 1000;
  const cacheValid = cache && (now - cache.fetchedAt) < ttlMs && !options.forceRefresh;

  let remotePatch: DbPatch | null = cacheValid ? cache.patch : null;
  let fetchedAt: number = cacheValid ? cache.fetchedAt : now;

  if (!cacheValid) {
    remotePatch = await fetchRemotePatch(manifest.remoteUrl);
    if (remotePatch) {
      fetchedAt = now;
      writeCache({ fetchedAt, patch: remotePatch });
    } else if (cache) {
      // Fall back to stale cache rather than running with no patch
      remotePatch = cache.patch;
      fetchedAt = cache.fetchedAt;
    }
  }

  if (!remotePatch) {
    return { lists: baseLists, brandEcosystems: baseBrandEcosystems, remoteLastFetched: null };
  }

  const { lists, brandEcosystems } = applyPatch(baseLists, remotePatch, baseBrandEcosystems);

  return {
    lists,
    brandEcosystems,
    remoteLastFetched: new Date(fetchedAt).toISOString(),
  };
}

/**
 * Synchronous loader — uses only the local cache, never fetches.
 * Suitable for hot paths where await is not available.
 */
export function loadDbSync(
  baseLists: DbLists,
  baseBrandEcosystems: Record<string, readonly string[]>,
): LoadedDb {
  const cache = readCache();
  if (!cache) {
    return { lists: baseLists, brandEcosystems: baseBrandEcosystems, remoteLastFetched: null };
  }
  const { lists, brandEcosystems } = applyPatch(baseLists, cache.patch, baseBrandEcosystems);
  return {
    lists,
    brandEcosystems,
    remoteLastFetched: new Date(cache.fetchedAt).toISOString(),
  };
}
