/**
 * Per-app tunnel bypass (Android, flag 128): the package-name set persisted
 * natively (SharedPreferences) and applied via `VpnService.Builder`'s
 * `addDisallowedApplication` — an excluded app never enters the tunnel at
 * all, so nothing it does is DNS-filtered or spliced to the hub.
 *
 * This file is the pure-logic seam: package-name validation and the
 * free-text list parsing the settings card applies. The bridge calls live
 * on `LocalVpn` (`setDisallowedApps`/`getDisallowedApps`).
 */

/**
 * This app's own package — the preset the card offers. Excluding ourselves
 * keeps the app's hub API/SSE traffic off the tun it manages (upstream dials
 * are `protect()`ed anyway, but the control channel deserves a direct path).
 */
export const SELF_PACKAGE = 'com.blockingmachine.mobile';

/** Hard cap mirrored by the native bridge — keeps a pasted dictionary from ballooning the prefs store. */
export const MAX_BYPASS_PACKAGES = 512;

/** Manifest package-name shape — every dot-segment must start with a letter. */
const PACKAGE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && PACKAGE_NAME_RE.test(name);
}

export interface ParsedPackageList {
  /** Valid, de-duplicated package names in input order. */
  packages: string[];
  /** Tokens that failed validation or overflowed the cap — the card names them. */
  rejected: string[];
}

/**
 * Parse a comma/whitespace/semicolon-separated package list: trim, validate
 * against the manifest grammar, dedupe (first occurrence wins), cap at
 * `max`. Losers land in `rejected` so the card can name what didn't make it.
 */
export function parsePackageList(text: string, max: number = MAX_BYPASS_PACKAGES): ParsedPackageList {
  const seen = new Set<string>();
  const packages: string[] = [];
  const rejected: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const tok = raw.trim();
    if (!tok) continue;
    if (!isValidPackageName(tok)) {
      rejected.push(tok);
      continue;
    }
    if (seen.has(tok)) continue;
    if (packages.length >= max) {
      rejected.push(tok);
      continue;
    }
    seen.add(tok);
    packages.push(tok);
  }
  return { packages, rejected };
}
