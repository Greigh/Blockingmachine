/**
 * Learned-model featurizer — TypeScript port of the M1 Python featurizer.
 *
 * This MUST reproduce the Python `featurize_vector` bit-for-bit (within
 * 1e-9): the GBDT was trained on Python-computed vectors, and any drift
 * here silently invalidates every weight. The contract is enforced by
 * the jest parity test over `learned-fixtures.json`
 * (src/__tests__/learned-model.test.ts), regenerated from Python by
 * `gen_ts_assets.py`.
 *
 * Porting notes (each verified against CPython 3.12 semantics):
 * - Normalization: strip() -> trim(), lower(), rstrip('.'); empty throws.
 * - Entropy sums in first-appearance order, matching collections.Counter.
 * - `token_hits` uses non-overlapping substring counts (str.count).
 * - `bigram_anomaly` is the mean of -log P over table hits; the table
 *   covers the full 38x38 bigram space so the miss branch is dead code
 *   for alphabet input, kept for exactness.
 * - `ip_literal` mirrors ipaddress.ip_address: strict IPv4 (no leading
 *   zeros, 0-255) plus IPv6 with :: compression and embedded IPv4.
 * - vowel_ratio is vowels / ALPHABETIC chars (not / length) — check the
 *   Python before "fixing" this.
 * - Non-ASCII input: length/counts iterate Unicode code points
 *   (Array.from), matching Python. Digit/alpha classification for
 *   non-ASCII uses Unicode property checks, approximating
 *   str.isdigit()/str.isalpha(). Real DNS input is ASCII/punycode, so
 *   this path is out-of-contract but deterministic.
 */
import {
  LEARNED_BIGRAM_LOG_PROBS,
  LEARNED_COMMON_TLDS,
  LEARNED_FEATURE_NAMES,
  LEARNED_FEATURE_NAMES_V2,
  LEARNED_SUSPICIOUS_TLDS,
  LEARNED_TOKENS,
} from './featureSpec.js';

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_HEX_RE = /^[0-9a-fA-F]{1,4}$/;
const UNICODE_ALPHA_RE = /\p{Alphabetic}/u;
const UNICODE_DIGIT_RE = /\p{Nd}/u;

/**
 * Normalize a domain exactly like the Python featurizer.
 * @throws on empty input (mirrors Python's ValueError).
 */
export function normalizeLearnedDomain(domain: string): string {
  const d = domain.trim().toLowerCase().replace(/\.+$/, '');
  if (!d) {
    throw new Error('learned featurizer: empty domain');
  }
  return d;
}

function isStrictIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const octet = m[i];
    // ipaddress rejects leading zeros ("01.2.3.4" is not an IP literal)
    if (octet.length > 1 && octet.startsWith('0')) return false;
    if (Number(octet) > 255) return false;
  }
  return true;
}

/** Parse one side of a '::' split; IPv4 tail counts as two groups. */
function parseIpv6Side(side: string): string[] | null {
  if (side === '') return [];
  const groups = side.split(':');
  const out: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g === '') return null;
    if (g.includes('.')) {
      if (i !== groups.length - 1) return null; // embedded IPv4 must be last
      if (!isStrictIpv4(g)) return null;
      out.push('v4hi', 'v4lo');
    } else {
      if (!IPV6_HEX_RE.test(g)) return null;
      out.push(g);
    }
  }
  return out;
}

function isIpv6Literal(s: string): boolean {
  // Strip %zone scope id (accepted by ipaddress, never a bare DNS name).
  const addr = s.includes('%') ? s.slice(0, s.indexOf('%')) : s;
  if (addr.includes(':::')) return false;
  const parts = addr.split('::');
  if (parts.length > 2) return false;
  if (parts.length === 1) {
    const groups = parseIpv6Side(addr);
    return groups !== null && groups.length === 8;
  }
  const head = parseIpv6Side(parts[0]);
  const tail = parseIpv6Side(parts[1]);
  if (head === null || tail === null) return false;
  // '::' must compress at least one group.
  return head.length + tail.length < 8;
}

/** Mirrors ipaddress.ip_address(d): 1.0 if the domain is an IP literal. */
export function isIpLiteralAddress(s: string): boolean {
  return isStrictIpv4(s) || isIpv6Literal(s);
}

/**
 * Behavioral + graph observations for one domain (feature schema v2).
 *
 * Produced by the daemon's observation pipeline (M4 crawler). Every
 * field is optional: a domain may be unobserved, or an individual
 * probe may have failed. Missing fields become NaN, which the GBDT
 * routes via each split's default_left — exactly like the Python v2
 * featurizer (features2.py). Omit the whole argument for the v1
 * lexical-only vector.
 */
export interface BehavioralObservation {
  redirectCount?: number | null;
  fetchError?: boolean | null;
  hasSetCookie?: boolean | null;
  cookieCount?: number | null;
  bodyKeywordHits?: number | null;
  httpsOk?: boolean | null;
  certFreeCa?: boolean | null;
  cnameDepth?: number | null;
}

function toBehavioralNumber(v: number | boolean | null | undefined): number {
  if (v === null || v === undefined) return NaN;
  return typeof v === 'boolean' ? (v ? 1 : 0) : v;
}

/**
 * Feature vector in LEARNED_FEATURE_NAMES order (v1), or
 * LEARNED_FEATURE_NAMES_V2 order when behavioral observations are given.
 * Pure function of (domain, obs); deterministic across runtimes.
 */
export function featurizeLearned(domain: string, obs?: BehavioralObservation): number[] {
  const d = normalizeLearnedDomain(domain);
  const cps = Array.from(d); // code points == UTF-16 units for ASCII
  const n = cps.length;
  const labels = d.split('.');
  const tld = labels[labels.length - 1];

  // Shannon entropy, first-appearance order (== Python Counter order).
  const counts = new Map<string, number>();
  for (const ch of cps) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / n;
    entropy -= p * Math.log2(p);
  }

  let digits = 0;
  let alpha = 0;
  let vowels = 0;
  let hyphens = 0;
  let longestRun = 0;
  let run = 0;
  for (const ch of cps) {
    let isDigit: boolean;
    let isAlpha: boolean;
    if (ch <= '\x7f') {
      isDigit = ch >= '0' && ch <= '9';
      isAlpha = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
    } else {
      // Out-of-contract input; approximate Python str.isdigit/isalpha.
      isDigit = UNICODE_DIGIT_RE.test(ch);
      isAlpha = UNICODE_ALPHA_RE.test(ch);
    }
    if (isDigit) {
      digits++;
      run++;
      if (run > longestRun) longestRun = run;
    } else {
      run = 0;
    }
    if (isAlpha) {
      alpha++;
      if (VOWELS.has(ch)) vowels++;
    }
    if (ch === '-') hyphens++;
  }

  // Non-overlapping substring counts == Python str.count.
  let tokenHits = 0;
  for (const t of LEARNED_TOKENS) {
    tokenHits += d.split(t).length - 1;
  }

  let bgSum = 0;
  let bgCount = 0;
  for (let i = 0; i + 1 < cps.length; i++) {
    const lp = LEARNED_BIGRAM_LOG_PROBS[cps[i] + cps[i + 1]];
    if (lp !== undefined) {
      bgSum += lp;
      bgCount++;
    }
  }
  const bigramAnomaly = bgCount > 0 ? -bgSum / bgCount : 0;

  const feats: Record<string, number> = {
    len: n,
    label_depth: labels.length,
    entropy,
    digit_ratio: digits / n,
    hyphen_ratio: hyphens / n,
    tld_rarity: LEARNED_COMMON_TLDS.has(tld) ? 0 : 1,
    bigram_anomaly: bigramAnomaly,
    punycode: labels.some((l) => l.startsWith('xn--')) ? 1 : 0,
    ip_literal: isIpLiteralAddress(d) ? 1 : 0,
    token_hits: tokenHits,
    token_density: tokenHits / labels.length,
    max_label_len: Math.max(...labels.map((l) => Array.from(l).length)),
    vowel_ratio: alpha > 0 ? vowels / alpha : 0,
    tld_suspicious: LEARNED_SUSPICIOUS_TLDS.has(tld) ? 1 : 0,
    max_digit_run_ratio: longestRun / n,
  };

  // Order is the contract: a missing/renamed feature throws here,
  // loudly, instead of silently shifting every weight.
  if (obs === undefined) {
    return LEARNED_FEATURE_NAMES.map((name) => {
      const v = feats[name];
      if (v === undefined) {
        throw new Error(`learned featurizer: unknown feature "${name}"`);
      }
      return v;
    });
  }
  const behavioral: Record<string, number> = {
    redirect_count: toBehavioralNumber(obs.redirectCount),
    fetch_error: toBehavioralNumber(obs.fetchError),
    has_set_cookie: toBehavioralNumber(obs.hasSetCookie),
    cookie_count: toBehavioralNumber(obs.cookieCount),
    body_kw_hits: toBehavioralNumber(obs.bodyKeywordHits),
    https_ok: toBehavioralNumber(obs.httpsOk),
    cert_free_ca: toBehavioralNumber(obs.certFreeCa),
    cname_depth: toBehavioralNumber(obs.cnameDepth),
  };
  const all = { ...feats, ...behavioral };
  return LEARNED_FEATURE_NAMES_V2.map((name) => {
    const v = all[name];
    if (v === undefined) {
      throw new Error(`learned featurizer: unknown feature "${name}"`);
    }
    return v;
  });
}
