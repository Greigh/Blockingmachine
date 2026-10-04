/**
 * A persistent verdict cache for the embedded Mini-AI classifier.
 *
 * The hub's compilation runs `classify()` over every host the blocklist names — ~162s on the
 * real ~190k-host list and the slowest part of the build. Yet a weekly recompile mostly re-reads
 * last week's hosts, because blocklists churn at the edges, not wholesale. This module is the
 * persistence layer that makes that pass incremental: a host the classifier already answered
 * for — under the *same* model and vocabulary — is served from the record rather than re-scored.
 *
 * ## What a cached verdict is keyed on
 *
 * A verdict is not a property of a hostname; it is the answer a particular classifier gives to
 * one. Three things can change that answer between compilations, and all three are hashed into
 * the fingerprint:
 *
 *  - **The model weights** (`MODEL_WEIGHTS` serialised). A retrained or re-tuned model is a
 *    different classifier.
 *  - **The live vocabulary** (`getDbLists()`, canonicalised — sorted per list, deduplicated).
 *    A reputation-DB hot patch or a regenerated tier vocabulary changes verdicts without any
 *    code shipping, so the lists are part of the key, not ambient state.
 *  - **User feedback tunings** (`exportFeedback()`). A whitelisted domain must not keep serving
 *    the verdict that made the user correct it.
 *
 * The fingerprint covers the feature-extraction code only when the caller supplies a build
 * identity — a packaged build stamps the git SHA it was cut from, so a new binary is a new
 * cache epoch without a manual bump. With no buildId the program is still invisible to the
 * hash, and the manual contract stands: when a change to `extractDomainFeatures` or the weight
 * *shape* ships unstamped, bump {@link VERDICT_CACHE_FORMAT} and the old file stops matching
 * on its own.
 *
 * ## What is stored
 *
 * The full category per host, not just the malware bit — a verdict that only answers today's
 * question would make the next consumer (a consent tier, a confidence histogram) a breaking
 * change to the cache format. Entries for hosts no longer on the list are dropped on write:
 * the cache is pruned to the current candidate set, so it cannot grow by accumulating hosts
 * that fell off the sources.
 *
 * A cache file that fails to parse, whose format predates this one, or whose fingerprint does
 * not match the live classifier is simply not a cache — the caller falls back to a full pass.
 * A corrupt file must never produce a verdict: every entry's category is validated against
 * {@link THREAT_CATEGORIES} on read, and unknown values are dropped entry by entry rather than
 * trusted.
 */

import { sha256Hex } from './learned/sha256.js';
import { getDbLists } from './reputation.js';
import { MODEL_WEIGHTS } from './MiniAiClassifier.js';
import { THREAT_CATEGORIES, type ThreatCategory } from './types.js';

/**
 * The cache-file format version — bump when the classifier's feature extraction or any other
 * code path that feeds a verdict changes in a way the fingerprint cannot see (weights, lists
 * and feedback *are* hashed; the program that turns a hostname into features is not). A file
 * written under another format reads as no cache, never as a stale one.
 */
export const VERDICT_CACHE_FORMAT = 1;

export interface VerdictCacheFile {
  format: number;
  /** `classifierInputFingerprint` of the classifier state that produced `verdicts`. */
  fingerprint: string;
  /** Host → the category the classifier reported for it. */
  verdicts: Record<string, ThreatCategory>;
}

const KNOWN_CATEGORIES = new Set<string>(THREAT_CATEGORIES);

/**
 * The invalidation key for a cached verdict. Deterministic across processes: the vocabulary
 * lists are sorted before hashing so a hot patch that merely reorders a list does not mint a
 * new classifier, and the feedback map is hashed key-sorted for the same reason.
 */
export function classifierInputFingerprint(
  feedback: Record<string, number>,
  buildId?: string,
): string {
  const lists = getDbLists() as unknown as Record<string, unknown>;
  const listDigest = Object.keys(lists)
    .sort()
    .map((key) => {
      const value = lists[key];
      const entries = Array.isArray(value)
        ? [...new Set(value.map(String))].sort().join(',')
        : JSON.stringify(value);
      return `${key}=${entries}`;
    })
    .join('|');
  const feedbackDigest = Object.keys(feedback)
    .sort()
    .map((key) => `${key}:${feedback[key]}`)
    .join('|');
  return sha256Hex(
    [
      `v${VERDICT_CACHE_FORMAT}`,
      // The caller-stamped build identity — the one input that can see an extraction-code
      // change the other three cannot. Omitting it keeps today's behaviour for callers that
      // have no build id to offer.
      ...(buildId ? [`build:${buildId}`] : []),
      `weights:${JSON.stringify(MODEL_WEIGHTS)}`,
      `lists:${listDigest}`,
      `feedback:${feedbackDigest}`,
    ].join('\n'),
  );
}

/**
 * Parses a cache file. Malformed JSON, a foreign format, a non-string fingerprint or a verdict
 * that is not a known category are all refused — a file that cannot be trusted whole is not a
 * cache. Individual entries whose category is unknown are dropped rather than failing the file:
 * a cache is a hint, and a good entry beside a bad one is still a good entry.
 */
export function parseVerdictCache(text: string): VerdictCacheFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const file = raw as { format?: unknown; fingerprint?: unknown; verdicts?: unknown };
  if (file.format !== VERDICT_CACHE_FORMAT) return null;
  if (typeof file.fingerprint !== 'string' || file.fingerprint.length === 0) return null;
  if (!file.verdicts || typeof file.verdicts !== 'object' || Array.isArray(file.verdicts)) {
    return null;
  }

  // Rebuilt into a null-prototype record: a hand-edited file could plant `__proto__` or
  // `constructor` keys, and indexing into them later would read inherited properties instead.
  const verdicts: Record<string, ThreatCategory> = Object.create(null);
  for (const [host, category] of Object.entries(file.verdicts as Record<string, unknown>)) {
    if (typeof host !== 'string' || typeof category !== 'string') continue;
    if (!KNOWN_CATEGORIES.has(category)) continue;
    verdicts[host] = category as ThreatCategory;
  }
  return { format: file.format, fingerprint: file.fingerprint, verdicts };
}

/**
 * Serialises the cache deterministically: verdict keys are sorted, so two compilations that
 * reach the same verdicts write the same bytes and a diff shows a real change rather than a
 * reordering — the same contract `malware.txt` itself keeps.
 */
export function serializeVerdictCache(
  fingerprint: string,
  verdicts: ReadonlyMap<string, ThreatCategory> | Record<string, ThreatCategory>,
): string {
  const record =
    verdicts instanceof Map
      ? Object.fromEntries(verdicts)
      : verdicts;
  const sorted: Record<string, ThreatCategory> = Object.create(null);
  for (const host of Object.keys(record).sort()) {
    sorted[host] = record[host];
  }
  const file: VerdictCacheFile = { format: VERDICT_CACHE_FORMAT, fingerprint, verdicts: sorted };
  return `${JSON.stringify(file)}\n`;
}
