/**
 * Which filenames the feed server is allowed to hand out.
 *
 * The output directory is user-chosen and shared: `~/Documents/Blockingmachine` typically holds
 * the compiled lists *and* whatever else lives beside them — configs, package manifests, source
 * trees, stray exports. The route used to accept any `basename(pathname)`, so `GET /config.yaml`
 * or `GET /../package.json` happily served files that were never a feed. An allowlist is the
 * honest contract: a feed server serves feeds, and everything else is a 404.
 *
 * Two members are dynamic rather than named: the configured `savePath` basename, because the
 * user picks it, and the `processed_<format>.<ext>` family the multi-format exporter writes.
 */

/** Top-level artifacts the app writes (or a resolver deployment can legitimately fetch). */
const SERVE_EXACT_NAMES = new Set([
  'browser.txt',
  'adguardbrowser.txt',
  'dns.txt',
  'adguarddns.txt',
  'malware.txt',
  'hotlist.txt',
  // Legacy list names the loader already treats as filter lists on disk.
  'filter-list.txt',
  'hosts.txt',
]);

/** Extensions the multi-format exporter can write (`processed_<format><ext>`). */
const PROCESSED_EXTENSIONS = new Set(['.txt', '.conf', '.action', '.rpz']);

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
};

/**
 * Whether a requested basename names a compiled feed artifact. `saveName` is the basename of the
 * configured main output so a user-chosen filename keeps working. Matching is case-insensitive —
 * the routes already lower-case the path before it reaches here.
 */
export function isServableFeedFile(cleanName: string, saveName: string): boolean {
  if (!cleanName || cleanName.startsWith('.')) return false;
  const lower = cleanName.toLowerCase();
  if (lower === saveName.toLowerCase() && saveName) return true;
  if (SERVE_EXACT_NAMES.has(lower)) return true;
  if (lower.startsWith('processed_') && PROCESSED_EXTENSIONS.has(extensionOf(lower))) {
    return true;
  }
  return false;
}
