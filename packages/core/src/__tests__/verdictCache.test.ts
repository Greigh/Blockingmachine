/**
 * The verdict cache is what lets a weekly recompilation ask the classifier only about the hosts
 * that churned. Its contract is all about *when a cached verdict may be believed*:
 *
 *  - The fingerprint is the classifier's identity for this purpose — same weights, vocabulary
 *    and feedback, same fingerprint; a token added to the live lists or a user's whitelist
 *    tuning is a different classifier and every stored verdict is correctly declined.
 *  - Serialisation is deterministic, so a compilation that changed nothing rewrites the same
 *    bytes and a diff of the cache file means something.
 *  - A file that does not parse, predates the format, or carries a verdict that is not a real
 *    category is refused rather than partially trusted — a corrupt cache must be a cache miss,
 *    never a wrong answer.
 */

import { describe, expect, test } from '@jest/globals';
import {
  VERDICT_CACHE_FORMAT,
  classifierInputFingerprint,
  parseVerdictCache,
  serializeVerdictCache,
} from '../ai/verdictCache.js';
import { withTemporaryVocabulary } from '../ai/reputation.js';
import type { ThreatCategory } from '../ai/types.js';

describe('the classifier input fingerprint', () => {
  test('is deterministic for the same classifier state', () => {
    expect(classifierInputFingerprint({})).toBe(classifierInputFingerprint({}));
  });

  test('changes when the live vocabulary changes', () => {
    // A reputation hot patch between compilations is exactly the case the fingerprint exists for:
    // the same code, the same host, a different answer — so the lists are part of the key.
    const before = classifierInputFingerprint({});
    const after = withTemporaryVocabulary({ trackerTokens: ['a-brand-new-tracker-vendor'] }, () =>
      classifierInputFingerprint({}),
    );
    expect(after).not.toBe(before);
    // And it does not matter which list the change lands in.
    const afterConsent = withTemporaryVocabulary({ consentTokens: ['a-brand-new-cmp'] }, () =>
      classifierInputFingerprint({}),
    );
    expect(afterConsent).not.toBe(before);
  });

  test('changes when the user has tuned a domain', () => {
    // A whitelisted host must not serve the verdict that made the user correct it — the feedback
    // map is hashed so a tuning mints a fresh cache epoch rather than a per-host exception.
    expect(classifierInputFingerprint({ 'example.com': -1 })).not.toBe(
      classifierInputFingerprint({}),
    );
    // Order of the map is irrelevant to the classifier, so it is irrelevant to the fingerprint.
    expect(classifierInputFingerprint({ 'a.example': 1, 'b.example': -1 })).toBe(
      classifierInputFingerprint({ 'b.example': -1, 'a.example': 1 }),
    );
  });

  test('does not change when a list is merely reordered', () => {
    // Canonicalisation sorts each list before hashing: a hot patch that rewrites the same set in
    // a different order is the same classifier and must not cost a full pass.
    const before = classifierInputFingerprint({});
    const reordered = withTemporaryVocabulary(
      { adTokens: ['zzz-last', 'aaa-first'], replace: false },
      () => classifierInputFingerprint({}),
    );
    const sameReordered = withTemporaryVocabulary(
      { adTokens: ['aaa-first', 'zzz-last'], replace: false },
      () => classifierInputFingerprint({}),
    );
    expect(reordered).toBe(sameReordered);
    expect(reordered).not.toBe(before);
  });

  test('changes when the build identity changes, so a new binary is a new cache epoch', () => {
    // Feature extraction code is the one input weights/lists/feedback cannot see — the caller's
    // build stamp is how a changed program still invalidates. Omitting it keeps the unstamped
    // behaviour rather than inventing one.
    const stamped = classifierInputFingerprint({}, 'v1.0.0+abcdef');
    const nextBuild = classifierInputFingerprint({}, 'v1.0.0+123456');
    const unstamped = classifierInputFingerprint({});
    expect(stamped).not.toBe(nextBuild);
    expect(stamped).not.toBe(unstamped);
    expect(classifierInputFingerprint({}, 'v1.0.0+abcdef')).toBe(stamped);
  });
});

describe('the verdict cache file', () => {
  const fp = 'a-fingerprint';

  test('round-trips and serialises deterministically', () => {
    const verdicts: Record<string, ThreatCategory> = {
      'tracker.example': 'Telemetry/Analytics',
      'ads.example': 'Advertising',
      'cmp.example': 'Consent/Annoyance',
      'clean.example': 'Clean',
    };
    const text = serializeVerdictCache(fp, verdicts);
    expect(parseVerdictCache(text)).toEqual({
      format: VERDICT_CACHE_FORMAT,
      fingerprint: fp,
      verdicts,
    });
    // Same verdicts, different construction order — same bytes, or a recompile diffs the cache
    // file for no reason.
    const reversed = Object.fromEntries(Object.entries(verdicts).reverse());
    expect(serializeVerdictCache(fp, reversed)).toBe(text);
    // And a Map serialises to the same bytes as the equivalent record.
    expect(serializeVerdictCache(fp, new Map(Object.entries(verdicts)))).toBe(text);
  });

  test('refuses anything that is not this format', () => {
    expect(parseVerdictCache('not json')).toBeNull();
    expect(parseVerdictCache('null')).toBeNull();
    expect(parseVerdictCache('[]')).toBeNull();
    expect(parseVerdictCache('{}')).toBeNull();
    // A future or past format is deliberately not read: the shape of "a verdict" is a format
    // concern, and reading anyway would smear the contract across versions.
    expect(
      parseVerdictCache(
        JSON.stringify({ format: VERDICT_CACHE_FORMAT + 1, fingerprint: fp, verdicts: {} }),
      ),
    ).toBeNull();
    expect(parseVerdictCache(JSON.stringify({ format: VERDICT_CACHE_FORMAT, verdicts: {} }))).toBeNull();
  });

  test('drops entries that are not real categories, keeping the honest ones', () => {
    const parsed = parseVerdictCache(
      JSON.stringify({
        format: VERDICT_CACHE_FORMAT,
        fingerprint: fp,
        verdicts: {
          'good.example': 'Advertising',
          'not-a-category.example': 'Definitely Malware',
          'numeric.example': 42,
        },
      }),
    )!;
    expect(parsed.verdicts).toEqual({ 'good.example': 'Advertising' });
    expect(Object.hasOwn(parsed.verdicts, 'not-a-category.example')).toBe(false);
  });

  test('cannot be polluted through its keys', () => {
    // A hand-edited file can plant `__proto__` or `constructor` keys; the rebuilt record has no
    // prototype, so they can never surface as inherited properties on lookup.
    const parsed = parseVerdictCache(
      serializeVerdictCache(
        fp,
        Object.fromEntries([
          ['real.example', 'Clean'],
          ['constructor', 'Malware/Phishing'],
        ]),
      ),
    )!;
    expect(Object.hasOwn(parsed.verdicts, 'constructor')).toBe(true);
    expect(Object.hasOwn(parsed.verdicts, 'hasOwnProperty')).toBe(false);
    // An honest host absent from the file stays absent — the caller must reclassify it.
    expect(Object.hasOwn(parsed.verdicts, 'absent.example')).toBe(false);
  });
});
