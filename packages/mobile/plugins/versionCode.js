// @ts-check
/**
 * semver → Android versionCode, shared by app.config.js and tests.
 *
 * Scheme: code = major*1_000_000 + minor*10_000 + patch*100 + prerelease, where
 * a stable release scores prerelease = 99 and a `-rc.N` / `-beta.N` / `-alpha.N`
 * prerelease scores N (clamped 0–98). Monotonic across the version line:
 *   1.0.0-rc.9  → 1_000_009
 *   1.0.0-rc.11 → 1_000_011
 *   1.0.0       → 1_000_099  (stable sorts above every prerelease of that patch)
 *   1.0.1       → 1_000_199
 *   1.1.0       → 1_010_099
 * minor/patch above 99 and major above 2_100 throw rather than silently wrap —
 * the scheme stays inside Play's 2_100_000_000 ceiling for any sane version.
 *
 * An explicit `BM_ANDROID_VERSION_CODE` env override wins when set (rebuilds
 * of the same version, hotfix chains); it must be a positive int.
 */
const STABLE_PRE = 99;

/** @param {string | undefined} pre the prerelease suffix, e.g. "rc.11" @returns {number} */
function parsePrerelease(pre) {
  if (!pre) return STABLE_PRE;
  const m = pre.match(/(?:rc|beta|alpha)\.?(\d+)/i);
  if (m) return Math.min(parseInt(m[1], 10), STABLE_PRE - 1);
  const n = pre.match(/(\d+)/);
  return n ? Math.min(parseInt(n[1], 10), STABLE_PRE - 1) : 0;
}

/** @param {string} version e.g. "1.0.0-rc.11" @returns {number} */
function versionToCode(version) {
  const m = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) throw new Error(`versionToCode: unparseable version "${version}"`);
  const [, major, minor, patch] = m.map((s, i) => (i === 4 ? s : Number(s)));
  const [M, mn, p] = [Number(major), Number(minor), Number(patch)];
  if (M > 2100 || mn > 99 || p > 99) {
    throw new Error(`versionToCode: "${version}" exceeds the encoding scheme (major>2100 or minor/patch>99)`);
  }
  return M * 1_000_000 + mn * 10_000 + p * 100 + parsePrerelease(m[4]);
}

/** versionCode for a build: BM_ANDROID_VERSION_CODE override, else derived.
 *  @param {string} version e.g. "1.0.0-rc.11"
 *  @param {Record<string, string | undefined>} [env]
 *  @returns {number} */
function resolveVersionCode(version, env = process.env) {
  const raw = env.BM_ANDROID_VERSION_CODE;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 2_100_000_000) {
      throw new Error(`BM_ANDROID_VERSION_CODE must be an integer in [1, 2100000000], got "${raw}"`);
    }
    return n;
  }
  return versionToCode(version);
}

module.exports = { versionToCode, resolveVersionCode };
