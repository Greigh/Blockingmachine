/**
 * The vocabulary the tiers teach the classifier, tested on its rules rather than on its output.
 *
 * `scripts/derive-tier-vocabulary.mjs` writes `tierVocabulary.generated.ts` from the shipped tiers,
 * and the agreement suite re-derives it to catch a stale file. Neither of those says anything about
 * the *decisions* in between, and those are where the damage would be:
 *
 *   - a token rule that lets an ordinary English word through turns one vendor's name into a block
 *     signal for every host that happens to carry it;
 *   - a seed pass that reads the shipped vocabulary instead of the hand-written one makes the
 *     derivation feed on its own output, which is the failure that made the file non-reproducible;
 *   - a gate that only counts false positives, or that refuses on a metric the candidate never
 *     touched, either ships a regression or refuses every candidate;
 *   - a derivation that admits a token which moved no host would be a hand-written list with a
 *     generator bolted on.
 *
 * So these tests pin the refusals, not the tokens: the tokens are the tiers' business and the
 * generator's, and they are already checked against the tier files. What is checked here is that the
 * rules refuse what they are supposed to refuse, including the specific refusals the shipped
 * vocabulary records in its own provenance.
 */

import { describe, expect, test } from '@jest/globals';
import {
  GENERIC_VOCABULARY_LABELS,
  TIER_MODEL_FAMILIES,
  TIER_VOCABULARY_SOURCES,
  compareTierVocabularyCorpus,
  deriveTierVocabulary,
  isUsableVocabularyToken,
  renderTierVocabularyModule,
  tierVocabularySeeds,
  vocabularyCandidatesFor,
  type TierVocabularyCorpusSample,
  type TierVocabularySeed,
} from '../ai/tierVocabularyDerivation.js';
import { TIER_DERIVED_AD_TOKENS, TIER_DERIVED_TRACKER_TOKENS } from '../ai/tierVocabulary.generated.js';
import {
  HAND_WRITTEN_AD_TOKENS,
  HAND_WRITTEN_TRACKER_TOKENS,
  SUSPICIOUS_AD_TOKENS,
  SUSPICIOUS_TRACKER_TOKENS,
  getDbLists,
  withTemporaryVocabulary,
} from '../ai/reputation.js';
import type { ThreatCategory } from '../ai/types.js';

// ── The token rules ───────────────────────────────────────────────────────────────────────────

describe('vocabulary token rules', () => {
  test('refuses a label short enough to collide with unrelated hosts', () => {
    // The floor is five characters because the four-character names that matter are hand-written
    // where a person can defend them (`fpjs`), and everything shorter than that is an abbreviation
    // that belongs to somebody — `ad`, `ct`, `tr`, `vwo` all match far more than their vendor.
    expect(isUsableVocabularyToken('fpjs')).toBe(false);
    expect(isUsableVocabularyToken('vwo')).toBe(false);
    expect(isUsableVocabularyToken('ad')).toBe(false);
    expect(isUsableVocabularyToken('')).toBe(false);
    expect(isUsableVocabularyToken('magnite')).toBe(true);
    // Four characters is a refusal, five is not: the boundary is stated, not approximate.
    expect(isUsableVocabularyToken('abcd')).toBe(false);
    expect(isUsableVocabularyToken('abcde')).toBe(true);
  });

  test('refuses a label that names a function rather than a company', () => {
    // These are the words a host carries because of what it *is*. Admitting one would make every
    // `analytics.*` or `static.*` host a tracker, which is the false positive the stop-list exists
    // to prevent — and `ads` is in the stop-list even though it is the plainest ad word there is,
    // because a lexical model does not need to be told that `ads.example.com` serves ads. The tier
    // compiler's own vocabulary handles placement; this list is only for names.
    for (const label of ['analytics', 'telemetry', 'tracking', 'static', 'banner', 'pixel', 'stats', 'cdn']) {
      expect(isUsableVocabularyToken(label)).toBe(false);
      expect(GENERIC_VOCABULARY_LABELS.has(label)).toBe(true);
    }
  });

  test('refuses an ordinary English word the shipped tiers happen to contain', () => {
    // `privy.com` is a real consent vendor and a real English word, and the tiers ship it. The
    // refusal is the shipped behaviour rather than a hypothetical: the generated vocabulary records
    // this host as unplaceable for exactly this reason, and it stays that way with the corpus at
    // zero false positives.
    expect(isUsableVocabularyToken('privy')).toBe(false);
  });

  test('judges every label of a compound token, not just the whole string', () => {
    // A dotted or hyphenated token is a zone or a vendor's own compound name. `privacy-mgmt` is a
    // vendor; `foo-ads` would be a generic word wearing a vendor's shape.
    expect(isUsableVocabularyToken('privacy-mgmt')).toBe(true);
    expect(isUsableVocabularyToken('ct.pinterest')).toBe(true);
    expect(isUsableVocabularyToken('foo-ads')).toBe(false);
    expect(isUsableVocabularyToken('cdn.vendor')).toBe(false);
  });

  test('refuses a label with nothing to match on', () => {
    expect(isUsableVocabularyToken('12345')).toBe(false);
    expect(isUsableVocabularyToken('----')).toBe(false);
    expect(isUsableVocabularyToken('a1b2c3')).toBe(true);
    // Normalised before judging, so a caller that forgot to lowercase gets the same answer.
    expect(isUsableVocabularyToken('  MAGNITE  ')).toBe(true);
    expect(isUsableVocabularyToken(undefined as unknown as string)).toBe(false);
  });

  test('refuses a token longer than the longest legal DNS label', () => {
    expect(isUsableVocabularyToken('a'.repeat(63))).toBe(true);
    expect(isUsableVocabularyToken('a'.repeat(64))).toBe(false);
  });
});

describe('vocabulary candidates for a host', () => {
  test('takes the registrable label of a two-label host', () => {
    expect(vocabularyCandidatesFor('magnite.com')).toEqual(['magnite']);
    // Case and trailing dots are the reader's problem, not the caller's.
    expect(vocabularyCandidatesFor('MAGNITE.com')).toEqual(['magnite']);
    expect(vocabularyCandidatesFor('  cookiebot.com.  ')).toEqual(['cookiebot']);
  });

  test('offers the vendor zone before the bare brand', () => {
    // The order is the contract: `business-api.tiktok` places the endpoint without claiming the
    // consumer site, and it is offered first precisely so the narrower form is the one that gets
    // tried. The same host's brand form is second and is the one the corpus refuses.
    expect(vocabularyCandidatesFor('ct.pinterest.com')).toEqual(['ct.pinterest', 'pinterest']);
    expect(vocabularyCandidatesFor('a.b.vendor.example.com')).toEqual(['vendor.example', 'example']);
  });

  test('never splits a label into words that would match somebody else', () => {
    // `privacy-mgmt` is a vendor name and stays whole. The alternative — deriving `privacy` and
    // `mgmt` from it — is how one vendor's token becomes everybody's: `privacy` alone is a label any
    // number of legitimate hosts can carry, which is why a compound label is judged as written.
    expect(vocabularyCandidatesFor('privacy-mgmt.com')).toEqual(['privacy-mgmt']);
    expect(isUsableVocabularyToken('privacy-mgmt')).toBe(true);
  });

  test('offers nothing when no label survives the rules', () => {
    // `privy` is five characters with a letter in it, so length does not save this host: it is
    // refused for being an ordinary English word the tiers happen to contain.
    expect(vocabularyCandidatesFor('privy.com')).toEqual([]);
    // The registrable label is the candidate, so a host whose registrable label is a function word
    // has nothing to offer — the label ahead of it does not rescue it, because the token would have
    // to be `cdn.analytics`, which carries the same refused word.
    expect(vocabularyCandidatesFor('cdn.analytics.com')).toEqual([]);
    // A host that is not a host, and a single label, are both nothing to derive from.
    expect(vocabularyCandidatesFor('')).toEqual([]);
    expect(vocabularyCandidatesFor('localhost')).toEqual([]);
  });

  test('offers the zone form and the brand form as two distinct candidates', () => {
    // They are different strings and different claims: `vendor.vendor` names the zone, `vendor`
    // names the company. Deduplication is by exact value, so a repeated label is still two tries —
    // the narrower one first, which is the order that matters.
    expect(vocabularyCandidatesFor('vendor.vendor.com')).toEqual(['vendor.vendor', 'vendor']);
  });
});

// ── The seed pass ─────────────────────────────────────────────────────────────────────────────

describe('the seed pass', () => {
  const hosts = (hosts: string[]) => new Map([['tier_ads' as const, hosts]]);

  test('seeds exactly the hosts the model cannot place', () => {
    const placed = new Set(['magnite.com']);
    const seedSet = tierVocabularySeeds({
      tierHosts: hosts(['magnite.com', 'ordinary-looking-host.example', 'another.example']),
      tiers: ['tier_ads'],
      classifyHost: (host) => (placed.has(host) ? 'Advertising' : 'Clean'),
    });

    expect(seedSet.seeds.map((seed) => seed.host)).toEqual(['ordinary-looking-host.example', 'another.example']);
    expect(seedSet.hostsRead).toBe(3);
    expect(seedSet.coverage).toEqual([{ tier: 'tier_ads', hosts: 3, unplaceable: 2 }]);
  });

  test('counts a host the model calls clean but the corpus calls malware as a seed', () => {
    // A tier the model contradicts is not a tier the vocabulary should fix by learning the name;
    // the seed is still produced so the derivation has to say what it tried, and the derivation's
    // own family check is what refuses the token.
    const seedSet = tierVocabularySeeds({
      tierHosts: hosts(['odd-host.example']),
      tiers: ['tier_ads'],
      classifyHost: () => 'Malware/Phishing',
    });
    expect(seedSet.seeds).toHaveLength(1);
    expect(seedSet.coverage[0].unplaceable).toBe(1);
  });

  test('carries the tier contract onto every seed and walks the tiers in order', () => {
    const seedSet = tierVocabularySeeds({
      tierHosts: new Map([
        ['tier_ads' as const, ['an-ad.example']],
        ['tier_privacy' as const, ['a-tracker.example']],
      ]),
      tiers: ['tier_ads', 'tier_privacy'],
      classifyHost: () => 'Clean',
    });

    expect(seedSet.seeds.map((seed) => seed.tier)).toEqual(['tier_ads', 'tier_privacy']);
    // The same families the agreement suite grades with, so a seed cannot be admitted under a
    // looser contract than the one the shipped tiers are held to.
    expect(seedSet.seeds[0].families).toEqual(TIER_MODEL_FAMILIES.tier_ads);
    expect(seedSet.seeds[1].families).toEqual(TIER_MODEL_FAMILIES.tier_privacy);
    expect(seedSet.coverage.map((entry) => entry.tier)).toEqual(['tier_ads', 'tier_privacy']);
  });

  test('walks the vocabulary sources by default, in the order they are declared', () => {
    const all = new Map(TIER_VOCABULARY_SOURCES.map((tier) => [tier, ['clean.example']] as const));
    const seedSet = tierVocabularySeeds({ tierHosts: all, classifyHost: () => 'Clean' });

    expect(seedSet.coverage.map((entry) => entry.tier)).toEqual([...TIER_VOCABULARY_SOURCES]);
    expect(seedSet.hostsRead).toBe(TIER_VOCABULARY_SOURCES.length);
    // `tier_security` is not in the sources and so cannot appear, however the map is built.
    expect(seedSet.coverage.some((entry) => entry.tier === 'tier_security')).toBe(false);
  });

  test('treats a missing tier as empty rather than as a failure', () => {
    const seedSet = tierVocabularySeeds({
      tierHosts: new Map(),
      tiers: ['tier_ads'],
      classifyHost: () => 'Clean',
    });
    expect(seedSet.seeds).toEqual([]);
    expect(seedSet.coverage).toEqual([{ tier: 'tier_ads', hosts: 0, unplaceable: 0 }]);
    expect(seedSet.hostsRead).toBe(0);
  });
});

// ── The corpus gate ───────────────────────────────────────────────────────────────────────────

describe('the corpus gate', () => {
  const sample = (overrides: Partial<TierVocabularyCorpusSample> = {}): TierVocabularyCorpusSample => ({
    total: 209,
    lexicalCases: 81,
    cleanCases: 122,
    falsePositives: [],
    falseAlarmsAsMalware: 0,
    accuracy: 0.9809,
    macroF1: 0.8673,
    coverageGaps: 4,
    ...overrides,
  });

  test('admits a candidate that improves the corpus', () => {
    const verdict = compareTierVocabularyCorpus(
      sample(),
      sample({ accuracy: 0.9904, macroF1: 0.8764, coverageGaps: 2 }),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain('passed: 0/122 clean domains flagged');
    expect(verdict.detail).toContain('accuracy 0.9904');
  });

  test('admits a candidate that leaves the corpus exactly as it was', () => {
    // A token that fixes nothing and breaks nothing is not a refusal here; whether it earned its
    // place is the tier's question, and it was already asked.
    expect(compareTierVocabularyCorpus(sample(), sample()).ok).toBe(true);
  });

  test('refuses a candidate that costs a clean domain, and names the domain', () => {
    const verdict = compareTierVocabularyCorpus(
      sample(),
      sample({ falsePositives: [{ domain: 'tiktok.com', called: 'Advertising' }], accuracy: 0.995 }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toBe('refused: 1 new false positive(s) — tiktok.com called Advertising');
  });

  test('refuses a candidate that trades one clean domain for another', () => {
    // Counting would call this break-even. The vocabulary is judged on which hosts it breaks, so a
    // swap is a refusal even when the totals match.
    const baseline = sample({ falsePositives: [{ domain: 'allowed.example', called: 'Advertising' }] });
    const candidate = sample({ falsePositives: [{ domain: 'newly-broken.example', called: 'Advertising' }] });
    const verdict = compareTierVocabularyCorpus(baseline, candidate);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('newly-broken.example called Advertising');
    expect(verdict.detail).not.toContain('allowed.example');
  });

  test('refuses a candidate that survives the false-positive check with a pre-existing one', () => {
    // An inherited false positive is not this candidate's fault, so it is not a refusal — otherwise
    // every candidate would be refused until somebody else's bug was fixed.
    const baseline = sample({ falsePositives: [{ domain: 'pre-existing.example', called: 'Advertising' }] });
    const candidate = sample({ falsePositives: [{ domain: 'pre-existing.example', called: 'Advertising' }] });
    expect(compareTierVocabularyCorpus(baseline, candidate).ok).toBe(true);
  });

  test('refuses a candidate that calls a clean domain malware', () => {
    // The one verdict a vocabulary can produce that is worse than a false positive: the corpus's
    // critical negatives are checked even when no metric moved.
    const verdict = compareTierVocabularyCorpus(sample(), sample({ falseAlarmsAsMalware: 2 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toBe('refused: 2 clean domain(s) called malicious');
  });

  test('refuses each metric that regresses, and only in the direction that is a regression', () => {
    const base = sample();
    expect(compareTierVocabularyCorpus(base, sample({ accuracy: base.accuracy - 0.001 })).ok).toBe(false);
    expect(compareTierVocabularyCorpus(base, sample({ macroF1: base.macroF1 - 0.001 })).ok).toBe(false);
    expect(compareTierVocabularyCorpus(base, sample({ coverageGaps: base.coverageGaps + 1 })).ok).toBe(false);

    // And the other direction is improvement, not a regression.
    expect(compareTierVocabularyCorpus(base, sample({ accuracy: base.accuracy + 0.001 })).ok).toBe(true);
    expect(compareTierVocabularyCorpus(base, sample({ macroF1: base.macroF1 + 0.001 })).ok).toBe(true);
    expect(compareTierVocabularyCorpus(base, sample({ coverageGaps: base.coverageGaps - 1 })).ok).toBe(true);
  });

  test('reports the false positive before the metric it also caused', () => {
    // Both are true of the same candidate, and the domain is the actionable half: the reason a
    // candidate was refused has to be the reason a reader can act on.
    const verdict = compareTierVocabularyCorpus(
      sample(),
      sample({ falsePositives: [{ domain: 'tiktok.com', called: 'Advertising' }], accuracy: 0.5 }),
    );
    expect(verdict.detail).toContain('tiktok.com');
    expect(verdict.detail).not.toContain('metric regressed');
  });

  test('does not care which corpus it is told about, only what the two samples say', () => {
    // No tiers, no host names, no classifier: the gate is a pure function of two measurements, which
    // is what lets the suite that re-derives the shipped file ask the same question of it.
    const verdict = compareTierVocabularyCorpus(sample(), sample({ accuracy: 0.9904 }));
    expect(verdict.ok).toBe(true);
  });
});

// ── The derivation ────────────────────────────────────────────────────────────────────────────

/** A stand-in for the live lists, with the accumulation semantics the real install has. */
function harness(options: {
  classify: (host: string, vocabulary: { adTokens: string[]; trackerTokens: string[] }) => ThreatCategory;
  gate?: (vocabulary: { adTokens: string[]; trackerTokens: string[] }) => { ok: boolean; detail: string };
}) {
  let installed: { adTokens: string[]; trackerTokens: string[] } = { adTokens: [], trackerTokens: [] };
  const installs: Array<{ adTokens: string[]; trackerTokens: string[] }> = [];

  return {
    installs,
    withVocabulary: <T,>(
      tokens: { adTokens?: readonly string[]; trackerTokens?: readonly string[] },
      fn: () => T,
    ): T => {
      const previous = installed;
      installed = {
        adTokens: [...(tokens.adTokens ?? [])],
        trackerTokens: [...(tokens.trackerTokens ?? [])],
      };
      installs.push(installed);
      try {
        return fn();
      } finally {
        installed = previous;
      }
    },
    classifyHost: (host: string) => options.classify(host, installed),
    ...(options.gate ? { corpusGate: options.gate } : {}),
  };
}

const seed = (tier: TierVocabularySeed['tier'], host: string, families?: readonly ThreatCategory[]) =>
  ({ tier, host, families }) as TierVocabularySeed;

describe('deriveTierVocabulary', () => {
  test('admits a token that moves its host into a family the tier may be called', () => {
    const h = harness({
      classify: (host, vocabulary) =>
        vocabulary.adTokens.includes('ordinary-vendor') ? 'Advertising' : 'Clean',
    });

    const result = deriveTierVocabulary({
      seeds: [seed('tier_ads', 'ordinary-vendor.com')],
      knownTokens: { adTokens: [], trackerTokens: [] },
      ...h,
    });

    expect(result.adTokens).toEqual(['ordinary-vendor']);
    expect(result.trackerTokens).toEqual([]);
    expect(result.evidence).toEqual([
      {
        token: 'ordinary-vendor',
        vocabulary: 'ad',
        tier: 'tier_ads',
        hosts: ['ordinary-vendor.com'],
        family: 'Advertising',
      },
    ]);
  });

  test('refuses a token that moves nothing, and says what it tried', () => {
    const h = harness({ classify: () => 'Clean' });
    const result = deriveTierVocabulary({
      seeds: [seed('tier_ads', 'ordinary-vendor.com')],
      knownTokens: { adTokens: [], trackerTokens: [] },
      ...h,
    });

    expect(result.adTokens).toEqual([]);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0].reason).toBe(
      'no candidate token moved this host into a family the tier may be called',
    );
    // The attempt is recorded even though it failed, so the pin can explain itself without anybody
    // re-running the derivation by hand.
    expect(result.rejections[0].attempts).toEqual([
      { token: 'ordinary-vendor', vocabulary: 'ad', present: false, family: 'Clean' },
    ]);
  });

  test('refuses a token that moves the host into a family the tier may not be called', () => {
    // The model offering *a* blocking family is not enough. Here both candidate tokens move the
    // host, and both are refused: the tracker form calls it malware and the ad form leaves it clean,
    // and neither is a family this seed's contract allows. Admitting either would put a
    // contradiction inside the agreement suite's own contract, so the derivation has to ask the same
    // question the suite does rather than merely "did the verdict change".
    const h = harness({
      classify: (host, vocabulary) => {
        if (vocabulary.trackerTokens.includes('ordinary-vendor')) return 'Malware/Phishing';
        return 'Clean';
      },
    });
    const result = deriveTierVocabulary({
      seeds: [seed('tier_privacy', 'ordinary-vendor.com', ['CNAME Cloaking'])],
      knownTokens: { adTokens: [], trackerTokens: [] },
      ...h,
    });

    expect(result.adTokens).toEqual([]);
    expect(result.trackerTokens).toEqual([]);
    // Both families were tried, in the documented order, and both are on the record.
    expect(result.rejections[0].attempts.map((attempt) => [attempt.vocabulary, attempt.family])).toEqual([
      ['tracker', 'Malware/Phishing'],
      ['ad', 'Clean'],
    ]);
  });

  test('tries the tracker list first everywhere but the ad tier', () => {
    // Both families would place this host. The one that describes data collection is the truthful
    // one, so a privacy host becomes a tracker token rather than an ad token — and the ad tier is
    // the exception, because its contents are ad infrastructure by definition.
    const classify = (host: string, vocabulary: { adTokens: string[]; trackerTokens: string[] }) =>
      vocabulary.trackerTokens.includes('ordinary-vendor') || vocabulary.adTokens.includes('ordinary-vendor')
        ? ('Telemetry/Analytics' as ThreatCategory)
        : ('Clean' as ThreatCategory);

    const privacy = deriveTierVocabulary({
      seeds: [seed('tier_privacy', 'ordinary-vendor.com')],
      knownTokens: { adTokens: [], trackerTokens: [] },
      ...harness({ classify }),
    });
    expect(privacy.trackerTokens).toEqual(['ordinary-vendor']);
    expect(privacy.adTokens).toEqual([]);
    // The ad attempt is not even tried: the first accepted candidate wins.
    expect(privacy.evidence[0].vocabulary).toBe('tracker');
  });

  test('records a token the hand-written list already carries as present', () => {
    // `present` means "hand-written", not "shipped": the derivation is seeded with the hand-written
    // lists alone, so a derived token re-derived by a later run is not reported as a human's choice.
    const h = harness({
      classify: (host, vocabulary) =>
        vocabulary.adTokens.includes('ordinary-vendor') ? 'Advertising' : 'Clean',
    });
    const result = deriveTierVocabulary({
      seeds: [seed('tier_ads', 'ordinary-vendor.com')],
      knownTokens: { adTokens: ['ordinary-vendor'], trackerTokens: [] },
      ...h,
    });

    expect(result.adTokens).toEqual(['ordinary-vendor']);
    expect(result.rejections).toEqual([]);
  });

  test('refuses a candidate the corpus refuses, and keeps deriving the rest', () => {
    // The per-candidate shape is the point: one wrong token costs itself and nothing else. Without
    // that, a single vendor whose name collides with a consumer site would take every other token in
    // the run down with it.
    const h = harness({
      classify: (host, vocabulary) =>
        vocabulary.adTokens.includes('collides') || vocabulary.adTokens.includes('ordinary-vendor')
          ? 'Advertising'
          : 'Clean',
      gate: ({ adTokens }) => {
        const ok = !adTokens.includes('collides');
        return { ok, detail: ok ? 'passed' : 'refused: 1 new false positive(s) — collides.com called Advertising' };
      },
    });

    const result = deriveTierVocabulary({
      seeds: [seed('tier_ads', 'collides.com'), seed('tier_ads', 'ordinary-vendor.com')],
      knownTokens: { adTokens: [], trackerTokens: [] },
      ...h,
    });

    expect(result.adTokens).toEqual(['ordinary-vendor']);
    expect(result.corpusRefusals).toBe(1);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0].host).toBe('collides.com');
    expect(result.rejections[0].reason).toBe(
      'the only candidates that moved this host were refused by the independent corpus',
    );
    expect(result.rejections[0].attempts[0].gate).toContain('collides.com called Advertising');
    // And the corpus is asked *with the accumulated vocabulary*, so a candidate is judged on the
    // vocabulary it would actually ship with rather than on its own token in isolation.
    expect(h.installs.at(-1)).toEqual({ adTokens: ['ordinary-vendor'], trackerTokens: [] });
  });

  test('reports a host with no usable label without asking the model anything', () => {
    const h = harness({ classify: () => 'Clean' });
    const result = deriveTierVocabulary({
      seeds: [seed('tier_annoyances', 'privy.com')],
      knownTokens: { adTokens: [], trackerTokens: [] },
      ...h,
    });

    expect(result.rejections[0].reason).toBe(
      'no candidate label survived the vocabulary rules (too short, generic, or a function word)',
    );
    expect(result.rejections[0].attempts).toEqual([]);
    expect(h.installs).toEqual([]);
  });

  test('groups two hosts placed by one token under that token', () => {
    const h = harness({
      classify: (host, vocabulary) => (vocabulary.adTokens.includes('vendor') ? 'Advertising' : 'Clean'),
    });
    const result = deriveTierVocabulary({
      seeds: [seed('tier_ads', 'vendor.com'), seed('tier_ads', 'support.vendor.com')],
      knownTokens: { adTokens: [], trackerTokens: [] },
      ...h,
    });

    expect(result.adTokens).toEqual(['vendor']);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].hosts).toEqual(['vendor.com', 'support.vendor.com']);
  });

  test('is deterministic and idempotent: the same seeds produce the same tokens and evidence', () => {
    // The property that makes a generated file checkable. Seeds are walked in the order given and
    // candidates in a stated order, so a re-derivation cannot disagree with the file for an
    // interesting reason — only because a tier or a rule changed.
    const classify = (host: string, vocabulary: { adTokens: string[]; trackerTokens: string[] }) =>
      vocabulary.trackerTokens.includes('acme') || vocabulary.adTokens.includes('acme')
        ? ('Telemetry/Analytics' as ThreatCategory)
        : ('Clean' as ThreatCategory);

    const input = {
      seeds: [
        seed('tier_privacy', 'acme.com'),
        seed('tier_privacy', 'other.example'),
        seed('tier_ads', 'unplaceable.example'),
      ],
      knownTokens: { adTokens: [], trackerTokens: [] },
    };

    const first = deriveTierVocabulary({ ...input, ...harness({ classify }) });
    const second = deriveTierVocabulary({ ...input, ...harness({ classify }) });
    expect(second).toEqual(first);

    // Sorted rather than in discovery order, so a re-derivation that finds the same tokens in a
    // different order still renders the same file.
    const reversed = deriveTierVocabulary({
      seeds: [...input.seeds].reverse(),
      knownTokens: { adTokens: [], trackerTokens: [] },
      ...harness({ classify }),
    });
    expect(reversed.trackerTokens).toEqual(first.trackerTokens);
    expect(reversed.evidence).toEqual(first.evidence);
    // The rejections are not sorted: they read in the order the seeds were considered, which is a
    // property of the walk rather than of the vocabulary. The driver walks the tiers in a fixed
    // order and the hosts within a tier sorted, so a run always produces this list the same way —
    // what is asserted here is that the *set* is the same however the walk is ordered.
    expect([...reversed.rejections.map((rejection) => rejection.host)].sort()).toEqual(
      [...first.rejections.map((rejection) => rejection.host)].sort(),
    );
  });

  test('counts the seeds it was given, not the ones it placed', () => {
    const h = harness({ classify: () => 'Clean' });
    const result = deriveTierVocabulary({
      seeds: [seed('tier_ads', 'one.example'), seed('tier_ads', 'two.example')],
      knownTokens: { adTokens: [], trackerTokens: [] },
      ...h,
    });
    expect(result.seedsConsidered).toBe(2);
    expect(result.corpusRefusals).toBe(0);
    expect(result.rejections).toHaveLength(2);
  });
});

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

describe('the generated module', () => {
  const empty = {
    adTokens: [] as string[],
    trackerTokens: [] as string[],
    evidence: [],
    rejections: [],
    seedsConsidered: 0,
    corpusRefusals: 0,
  };
  const provenance = {
    tiers: [{ tier: 'tier_ads', hosts: 1, unplaceable: 1 }],
    hostsRead: 1,
    seedVocabulary: { adTokens: 112, trackerTokens: 97 },
    seedsConsidered: 1,
    acceptedTokens: 1,
    rejectedHosts: 0,
    corpusRefusals: 0,
    corpus: null,
    gate: 'not run',
  };

  test('writes an empty list as an empty list rather than as a blank', () => {
    const rendered = renderTierVocabularyModule(empty, provenance);
    // Not `= ;` and not a stray newline: an empty derivation is a valid, readable module, which is
    // what lets the placeholder file live in the repository before the first run.
    expect(rendered).toContain('export const TIER_DERIVED_AD_TOKENS: readonly string[] = \n[]\n;');
    expect(rendered).toContain('export const TIER_DERIVED_TRACKER_TOKENS: readonly string[] = \n[]\n;');
  });

  test('says in the file itself that it is generated and how to regenerate it', () => {
    const rendered = renderTierVocabularyModule(empty, provenance);
    expect(rendered).toContain('GENERATED FILE — do not edit by hand.');
    expect(rendered).toContain('node scripts/derive-tier-vocabulary.mjs --write');
    // The provenance travels with the tokens, so a reader can tell a gated run from an ungated one.
    expect(rendered).toContain('"gate": "not run"');
    expect(rendered).toContain('TIER_VOCABULARY_PROVENANCE: TierVocabularyProvenance');
  });

  test('renders the tokens and the evidence that justified them', () => {
    const rendered = renderTierVocabularyModule(
      {
        ...empty,
        adTokens: ['magnite'],
        evidence: [
          { token: 'magnite', vocabulary: 'ad', tier: 'tier_ads', hosts: ['magnite.com'], family: 'Advertising' },
        ],
      },
      provenance,
    );
    expect(rendered).toContain("  'magnite',");
    expect(rendered).toContain('"hosts": [');
    expect(rendered).toContain('"magnite.com"');
  });
});

// ── The shipped merge ─────────────────────────────────────────────────────────────────────────

describe('the shipped vocabulary', () => {
  test('is the hand-written list with the derived tokens appended, deduplicated', () => {
    // The order is the contract that makes the derivation checkable: hand-written first, so the
    // derived half is additive and a re-derivation is compared against a stable prefix.
    for (const [hand, shipped, derived] of [
      [HAND_WRITTEN_AD_TOKENS, SUSPICIOUS_AD_TOKENS, TIER_DERIVED_AD_TOKENS],
      [HAND_WRITTEN_TRACKER_TOKENS, SUSPICIOUS_TRACKER_TOKENS, TIER_DERIVED_TRACKER_TOKENS],
    ] as const) {
      expect(shipped.slice(0, hand.length)).toEqual([...hand]);
      expect(new Set(shipped).size).toBe(shipped.length);
      for (const token of derived) expect(shipped).toContain(token);
    }
  });

  test('does not carry a derived token by hand as well', () => {
    // A vendor that later gets a hand-written entry would otherwise ship twice, and the derivation
    // would keep reporting it as a human's choice. The derivation's own output is the check: every
    // derived token has to be absent from the hand-written half, which is what makes the hand-written
    // half the *input* rather than a duplicate.
    expect(TIER_DERIVED_AD_TOKENS.filter((token) => HAND_WRITTEN_AD_TOKENS.includes(token))).toEqual([]);
    expect(TIER_DERIVED_TRACKER_TOKENS.filter((token) => HAND_WRITTEN_TRACKER_TOKENS.includes(token))).toEqual([]);
  });

  test('keeps the tokens a machine cannot honestly derive', () => {
    // `fpjs` is four characters and `business-api.tiktok` is an endpoint on a platform the model is
    // told to trust; both are hand-written because the choice needs a person, and both are worth
    // pinning so a future tidy-up does not delete them for looking redundant.
    expect(HAND_WRITTEN_TRACKER_TOKENS).toContain('fpjs');
    expect(HAND_WRITTEN_TRACKER_TOKENS).toContain('business-api.tiktok');
    expect(HAND_WRITTEN_TRACKER_TOKENS).toContain('ct.pinterest');
  });

  test('installs exactly the given vocabulary when asked to replace it', () => {
    // What the derivation seeds with. Additive installation would make the seed pass read the
    // shipped lists, which is the bug that made each run depend on the last one.
    const before = getDbLists().suspiciousAdTokens.length;
    expect(before).toBeGreaterThan(HAND_WRITTEN_AD_TOKENS.length);

    const seen = withTemporaryVocabulary(
      { adTokens: HAND_WRITTEN_AD_TOKENS, trackerTokens: HAND_WRITTEN_TRACKER_TOKENS, replace: true },
      () => ({ ad: [...getDbLists().suspiciousAdTokens], tracker: [...getDbLists().suspiciousTrackerTokens] }),
    );

    expect(seen.ad).toEqual([...HAND_WRITTEN_AD_TOKENS]);
    expect(seen.tracker).toEqual([...HAND_WRITTEN_TRACKER_TOKENS]);
    // And the derived tokens really were absent, so a derivation run this way cannot see them.
    expect(seen.ad).not.toContain(TIER_DERIVED_AD_TOKENS[0]);
    // Restored in a `finally`, including on a throw, so a failing derivation cannot leave the
    // process on the hand-written vocabulary.
    expect(getDbLists().suspiciousAdTokens.length).toBe(before);
    expect(() =>
      withTemporaryVocabulary({ adTokens: ['x'], replace: true }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getDbLists().suspiciousAdTokens.length).toBe(before);
  });

  test('adds to the live vocabulary when not asked to replace it', () => {
    // The per-candidate question — "would this token change the verdict?" — has to be asked of the
    // vocabulary the candidate would actually ship with, which is the shipped lists plus the token.
    const seen = withTemporaryVocabulary({ adTokens: ['a-candidate'], trackerTokens: ['another'] }, () => ({
      ad: [...getDbLists().suspiciousAdTokens],
      tracker: [...getDbLists().suspiciousTrackerTokens],
    }));

    expect(seen.ad).toEqual([...SUSPICIOUS_AD_TOKENS, 'a-candidate']);
    expect(seen.tracker).toEqual([...SUSPICIOUS_TRACKER_TOKENS, 'another']);
  });
});
