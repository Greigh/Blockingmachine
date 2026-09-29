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
 *
 * Every entry point is non-fatal: any I/O or network failure degrades to the
 * bundled base lists instead of throwing, so classifiers always have data.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

// NOTE (bundler safety): this module must stay free of createRequire(),
// require(), and static relative-path literals like new URL('./db', ...).
// The Electron app bundles this code with webpack, which treats those as
// build-time module dependencies and fails CI with "Module not found" or
// "Critical dependency" errors. All file access below goes through node:fs
// with runtime-computed paths only. A regression test enforces this.
// See packages/core/src/__tests__/db-bundler-safety.test.ts

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

// ─── Path resolution ──────────────────────────────────────────────────────────
//
// The db/ directory sits next to this module at build time (tsconfig copies the
// JSON files into dist/ai/db). In packaged Electron apps the module may be
// bundled/asar-mapped, so we also probe the monorepo-relative locations and
// process.cwd() candidates. The first existing directory wins.

/**
 * Best-effort directory of the compiled module, used only as a path hint.
 * Wrapped defensively: bundlers may rewrite or stub import.meta, so this can
 * legitimately fail — the remaining candidates cover every supported layout.
 */
function getModuleDirHint(): string | null {
  try {
    const moduleUrl = typeof import.meta !== 'undefined' && import.meta?.url ? import.meta.url : null;
    if (!moduleUrl) return null;
    return dirname(new URL(moduleUrl).pathname);
  } catch {
    return null;
  }
}

function resolveDbDirCandidates(): string[] {
  const moduleDir = getModuleDirHint();
  const candidates = [
    resolve(process.cwd(), 'packages/core/src/ai/db'),
    resolve(process.cwd(), 'src/ai/db'),
  ];
  if (moduleDir) {
    candidates.unshift(
      join(moduleDir, 'db'),
      resolve(moduleDir, '../../src/ai/db'),
      resolve(moduleDir, '../../ai/db'),
    );
  }
  return candidates;
}

let dbDir: string | null = null;

function getDbDir(): string | null {
  if (dbDir) return dbDir;
  for (const candidate of resolveDbDirCandidates()) {
    try {
      if (existsSync(join(candidate, 'manifest.json'))) {
        dbDir = candidate;
        return dbDir;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Overrides the directory the loader reads manifest.json / remote-patch.json
 * from and writes its cache into. Call once at app startup (e.g. Electron
 * main process pointing at a writable userData path) before refreshDb().
 */
export function setDbDirectory(dir: string): void {
  dbDir = resolve(dir);
}

let cacheDir: string | null = null;

/**
 * Overrides where the fetched remote-patch cache is written. Use this in
 * packaged apps where the bundled db directory is read-only (asar).
 */
export function setDbCacheDirectory(dir: string): void {
  cacheDir = resolve(dir);
}

function getCachePath(): string {
  if (cacheDir) return join(cacheDir, '.remote-patch-cache.json');
  const moduleDir = getModuleDirHint();
  return join(getDbDir() ?? moduleDir ?? process.cwd(), '.remote-patch-cache.json');
}

const LIST_KEYS: Array<keyof DbLists> = [
  'highAbuseTlds', 'adNetworks', 'trackerNetworks', 'cloudSuffixes',
  'cdnSuffixes', 'iotTrusted', 'vendorSuffixes', 'platformSuffixes',
  'multiTenantPlatforms', 'untrustedHosting', 'cdnRoutingSuffixes',
  'suspiciousAdTokens', 'suspiciousTrackerTokens', 'specificNetworkTokens',
  'highProfileBrands', 'dictionaryExemptions', 'benignEndpointLabels', 'dnsSuffixes',
];

/** Keys whose merged entries are lower-cased and de-duplicated on install. */
const LOWERCASE_KEYS = new Set<keyof DbLists>([
  'highAbuseTlds', 'adNetworks', 'trackerNetworks', 'cloudSuffixes',
  'cdnSuffixes', 'iotTrusted', 'vendorSuffixes', 'platformSuffixes',
  'multiTenantPlatforms', 'untrustedHosting', 'cdnRoutingSuffixes',
  'suspiciousAdTokens', 'suspiciousTrackerTokens', 'specificNetworkTokens',
  'highProfileBrands', 'dictionaryExemptions', 'benignEndpointLabels', 'dnsSuffixes',
]);

// ─── Manifest ─────────────────────────────────────────────────────────────────

function loadManifest(): DbManifest | null {
  try {
    const dir = getDbDir();
    if (!dir) return null;
    // Plain fs read + JSON.parse — bundler-safe (no require/createRequire).
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as DbManifest;
    if (!manifest || typeof manifest !== 'object') return null;
    return manifest;
  } catch {
    // Missing or unparseable manifest — remote patching stays disabled and the
    // bundled base lists are used unchanged.
    return null;
  }
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
    const merged = [...new Set([...(lists[key] ?? []), ...toAdd])].filter(
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

// ─── Patch sanitization ──────────────────────────────────────────────────────
//
// The remote patch is untrusted network data. Before it may reach any consumer
// (live classifier lists or the on-disk cache), it is rebuilt from scratch:
// only known keys survive, and every value must be a plain, bounded string.
// writeCache() therefore never persists raw network input — it writes only
// sanitized, size-capped data to a fixed, allowlisted path.

/** Hard cap on the serialized sanitized patch. Legit patches are a few KB. */
const MAX_PATCH_JSON_LENGTH = 256 * 1024;
/** Per-string-entry cap; domains/tokens never exceed the RFC hostname limit. */
const MAX_ENTRY_LENGTH = 253;
/** Per-list cap on entries — prevents unbounded memory growth from a hostile patch. */
const MAX_ENTRIES_PER_LIST = 20_000;

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    // Accept printable-ASCII hostname/token content only. This drops control
    // characters, homoglyph tricks, whitespace smuggling, and path separators.
    if (trimmed.length === 0 || trimmed.length > MAX_ENTRY_LENGTH) continue;
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= MAX_ENTRIES_PER_LIST) break;
  }
  return out;
}

function sanitizeBrandEcosystems(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [brand, domains] of Object.entries(value as Record<string, unknown>)) {
    const cleanBrand = typeof brand === 'string' ? brand.trim() : '';
    if (!cleanBrand || cleanBrand.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(cleanBrand)) continue;
    const cleanDomains = sanitizeStringArray(domains);
    if (cleanDomains.length > 0) out[cleanBrand] = cleanDomains;
  }
  return out;
}

/**
 * Rebuilds an untrusted patch into a structurally validated DbPatch.
 * Returns null when the input is not a usable schemaVersion-1 patch object.
 * Every output value is freshly constructed — no references into the raw input.
 */
export function sanitizeDbPatch(input: unknown): DbPatch | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return null;
  if (typeof raw.patchedAt !== 'string' || raw.patchedAt.length > 64) return null;

  const knownKeys = new Set<string>(LIST_KEYS.map(String));
  const sanitizeSection = (section: unknown): Partial<DbLists> | undefined => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) return undefined;
    const out: Partial<DbLists> = {};
    let touched = 0;
    for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
      if (!knownKeys.has(key)) continue;
      const clean = sanitizeStringArray(value);
      if (clean.length > 0) {
        (out as Record<string, string[]>)[key] = clean;
        touched++;
      }
    }
    return touched > 0 ? out : undefined;
  };

  const add = sanitizeSection(raw.add);
  const remove = sanitizeSection(raw.remove);
  const brandEcosystems = sanitizeBrandEcosystems(raw.brandEcosystems);

  if (!add && !remove && Object.keys(brandEcosystems).length === 0) return null;

  const patch: DbPatch = {
    schemaVersion: 1,
    patchedAt: raw.patchedAt,
  };
  if (add) patch.add = add;
  if (remove) patch.remove = remove;
  if (Object.keys(brandEcosystems).length > 0) patch.brandEcosystems = brandEcosystems;
  return patch;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  fetchedAt: number;
  patch: DbPatch;
}

function readCache(): CacheEntry | null {
  try {
    const cachePath = getCachePath();
    if (!existsSync(cachePath)) return null;
    // The cache file itself is treated as untrusted: it may be stale, corrupt,
    // or tampered with, so it passes through the same sanitizer as remote data.
    const entry = JSON.parse(readFileSync(cachePath, 'utf8')) as CacheEntry;
    if (!entry || typeof entry.fetchedAt !== 'number' || !Number.isFinite(entry.fetchedAt)) return null;
    const patch = sanitizeDbPatch(entry.patch);
    if (!patch) return null;
    return { fetchedAt: entry.fetchedAt, patch };
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    // Defense-in-depth: persist only the sanitized rebuild, never the raw
    // network response. Path is fixed by getCachePath(); content is fully
    // validated and size-capped.
    const cleanPatch = sanitizeDbPatch(entry.patch);
    if (!cleanPatch) return;
    const serialized = JSON.stringify({ fetchedAt: entry.fetchedAt, patch: cleanPatch });
    if (serialized.length > MAX_PATCH_JSON_LENGTH) return;
    const cachePath = getCachePath();
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, serialized, 'utf8');
  } catch {
    // Non-fatal — read-only installs just re-fetch next session
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

    // Only http(s) — no file:, ftp:, data:, or custom protocol tricks.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return null;
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchFn(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Blockingmachine-db-loader/1' },
      });
      if (!res.ok) return null;
      // Read the body as text with a hard cap before parsing, so a hostile or
      // misconfigured server cannot balloon memory with a giant payload.
      const contentLength = Number(res.headers?.get?.('content-length') ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_PATCH_JSON_LENGTH) return null;
      const rawBody = await res.text();
      if (rawBody.length > MAX_PATCH_JSON_LENGTH) return null;
      const json: unknown = JSON.parse(rawBody);
      // The only gate between the network and consumers/cache is full sanitization.
      return sanitizeDbPatch(json);
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
 * Never throws — on any failure it degrades to the bundled base lists.
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
  try {
    const manifest = loadManifest();
    if (options.disableRemote || !manifest || !manifest.remoteUrl) {
      return { lists: baseLists, brandEcosystems: baseBrandEcosystems, remoteLastFetched: null };
    }

    // Check cache
    const cache = readCache();
    const now = Date.now();
    const ttlMs = Math.max(60, Number(manifest.remoteTtlSeconds) || 3600) * 1000;
    const cacheValid = Boolean(cache) && (now - cache!.fetchedAt) < ttlMs && !options.forceRefresh;

    let remotePatch: DbPatch | null = cacheValid ? cache!.patch : null;
    let fetchedAt: number = cacheValid ? cache!.fetchedAt : now;

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
  } catch {
    // Absolute last resort — classifiers must always have usable lists.
    return { lists: baseLists, brandEcosystems: baseBrandEcosystems, remoteLastFetched: null };
  }
}

/**
 * Synchronous loader — uses only the local cache, never fetches.
 * Suitable for hot paths where await is not available.
 */
export function loadDbSync(
  baseLists: DbLists,
  baseBrandEcosystems: Record<string, readonly string[]>,
): LoadedDb {
  try {
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
  } catch {
    return { lists: baseLists, brandEcosystems: baseBrandEcosystems, remoteLastFetched: null };
  }
}

/**
 * Normalizes and de-duplicates a merged list before installing it into the
 * live classifier sets. Suffix/token lists are case-insensitive, so entries
 * are lower-cased for consistent Set matching.
 */
export function normalizeDbList(key: keyof DbLists, values: readonly string[]): string[] {
  const cleaned = values.filter(
    (v) => typeof v === 'string' && v.length > 0 && v.length <= 253,
  );
  const normalized = LOWERCASE_KEYS.has(key)
    ? cleaned.map((v) => v.toLowerCase())
    : cleaned;
  return [...new Set(normalized)];
}
