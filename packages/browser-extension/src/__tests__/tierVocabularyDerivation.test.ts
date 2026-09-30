/**
 * The vocabulary the tiers teach the classifier must be the vocabulary the tiers justify.
 *
 * `scripts/derive-tier-vocabulary.mjs` reads the shipped tier files, works out which hosts the
 * embedded model cannot place, and derives a token for each one — then writes the result to
 * `packages/core/src/ai/tierVocabulary.generated.ts`, where the classifier ships it. That is a
 * generated file in a hand-maintained repository, which is the shape that goes stale: somebody adds
 * a vendor to a tier, the derivation would produce a token for it, and nothing in the build notices
 * because the file on disk still parses and the model still works.
 *
 * So this suite re-derives the file, in-process, from the tier files as they are on disk, and
 * compares. It is the same walk the driver makes — the seed pass, the per-candidate corpus gate and
 * the derivation itself are all core functions the driver calls — so what is compared is a real
 * re-run rather than a summary of one.
 *
 * Three claims, and the middle one is why `tierModelAgreement.test.ts` no longer has to hand-type
 * the hosts the model cannot place:
 *
 *  1. **The file is not stale.** A fresh derivation renders byte for byte what is checked in.
 *  2. **The disagreement pin is the derivation's own output.** Every host a tier ships that the
 *     model cannot place is either placed by a derived token or recorded in
 *     `TIER_VOCABULARY_REJECTIONS` — with the reason and every attempt that failed. A host that is
 *     neither is a host nobody has explained.
 *  3. **Every token is a receipt.** Each evidence entry's token, installed over the hand-written
 *     vocabulary alone, really does move the host it claims to move into the family it claims. The
 *     generated file therefore cannot contain a token that was not earned.
 *
 * The derivation is deliberately *not* graded against the tiers. The corpus gate inside it is the
 * independent instrument, and it is what makes a token admitted rather than a token plausible; this
 * suite checks that the gate ran and passed, not that the tiers agree with themselves.
 */

import { describe, expect, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { MiniAiClassifier } from '@blockingmachine/core/domain-ai';
import { EVAL_CORPUS } from '../../../core/src/ai/evalCorpus.js';
import { evaluateClassifier } from '../../../core/src/ai/evaluation.js';
import {
  HAND_WRITTEN_AD_TOKENS,
  HAND_WRITTEN_TRACKER_TOKENS,
  withTemporaryVocabulary,
} from '../../../core/src/ai/reputation.js';
import {
  TIER_VOCABULARY_SOURCES,
  compareTierVocabularyCorpus,
  deriveTierVocabulary,
  renderTierVocabularyModule,
  tierVocabularyProvenance,
  tierVocabularySeeds,
  type TierVocabularyCorpusSample,
} from '../../../core/src/ai/tierVocabularyDerivation.js';
import {
  TIER_DERIVED_AD_TOKENS,
  TIER_DERIVED_TRACKER_TOKENS,
  TIER_VOCABULARY_EVIDENCE,
  TIER_VOCABULARY_PROVENANCE,
  TIER_VOCABULARY_REJECTIONS,
} from '../../../core/src/ai/tierVocabulary.generated.js';
import type { StaticTierId } from '../../../core/src/tiers.js';

const GENERATED_FILE = new URL('../../../core/src/ai/tierVocabulary.generated.ts', import.meta.url);

/** Extracts the blocked host from `||host^` / `||host/path`, the only shapes a tier may ship. */
function hostsIn(tier: StaticTierId): string[] {
  const path = new URL(`../../rules/${tier}.json`, import.meta.url);
  if (!existsSync(path)) {
    throw new Error(
      `tier ruleset ${path.pathname} is missing — restore the curated baseline or run ` +
        '`npm run compile:tiers`; the derivation reads the tiers and cannot run without them',
    );
  }

  const rules = JSON.parse(readFileSync(path, 'utf8')) as Array<{ condition?: { urlFilter?: string } }>;
  const hosts = new Set<string>();
  for (const rule of rules) {
    const filter = rule?.condition?.urlFilter;
    if (typeof filter !== 'string' || !filter.startsWith('||')) continue;
    const host = filter.slice(2).split(/[/^$]/)[0].toLowerCase();
    if (host.includes('.')) hosts.add(host);
  }
  return [...hosts].sort();
}

const tierHosts = new Map<StaticTierId, string[]>(
  TIER_VOCABULARY_SOURCES.map((tier) => [tier, hostsIn(tier)]),
);

const CLEAN_CASES = EVAL_CORPUS.filter((entry) => entry.expected.includes('Clean')).length;

function corpusSample(report: ReturnType<typeof evaluateClassifier>): TierVocabularyCorpusSample {
  return {
    total: report.total,
    lexicalCases: report.triage.lexicalCases,
    cleanCases: CLEAN_CASES,
    falsePositives: report.triage.falsePositives.map((miss) => ({
      domain: miss.domain,
      called: miss.actual,
    })),
    falseAlarmsAsMalware: report.triage.falseAlarmsAsMalware.length,
    accuracy: report.triage.accuracy,
    macroF1: report.macroF1,
    coverageGaps: report.triage.coverageGaps.length,
  };
}

/**
 * One full derivation, run exactly the way the driver runs it.
 *
 * The vocabulary installed throughout is the hand-written lists *alone*: the derived tokens are
 * this run's output, so a run that could read back the shipped file would find its own hosts
 * already placed, seed nothing, and render a file that differs from the one it just read. That was
 * a real bug in the driver — `--check` failed immediately after `--write` — and it is the reason the
 * seed pass and the gate are stated in core rather than written out twice.
 */
function derive() {
  let classifier = new MiniAiClassifier();

  return withTemporaryVocabulary(
    {
      adTokens: HAND_WRITTEN_AD_TOKENS,
      trackerTokens: HAND_WRITTEN_TRACKER_TOKENS,
      replace: true,
    },
    () => {
      const classifyWith = (host: string) => {
        classifier.clearCache();
        return classifier.classify(host).category;
      };

      const seedSet = tierVocabularySeeds({ tierHosts, classifyHost: classifyWith });

      classifier = new MiniAiClassifier();
      const baseline = corpusSample(
        withTemporaryVocabulary({}, () => evaluateClassifier(classifier, EVAL_CORPUS)),
      );

      const result = deriveTierVocabulary({
        seeds: seedSet.seeds,
        knownTokens: {
          adTokens: HAND_WRITTEN_AD_TOKENS,
          trackerTokens: HAND_WRITTEN_TRACKER_TOKENS,
        },
        withVocabulary: withTemporaryVocabulary,
        classifyHost: classifyWith,
        corpusGate: ({ adTokens, trackerTokens }) => {
          const report = withTemporaryVocabulary({ adTokens, trackerTokens }, () =>
            evaluateClassifier(classifier, EVAL_CORPUS),
          );
          return compareTierVocabularyCorpus(baseline, corpusSample(report));
        },
      });

      // Measured again for the vocabulary as it will actually ship, since the gate above ran per
      // candidate against a moving list.
      const final = corpusSample(
        withTemporaryVocabulary({ adTokens: result.adTokens, trackerTokens: result.trackerTokens }, () =>
          evaluateClassifier(classifier, EVAL_CORPUS),
        ),
      );

      const provenance = tierVocabularyProvenance({
        seedSet,
        seedVocabulary: {
          adTokens: HAND_WRITTEN_AD_TOKENS.length,
          trackerTokens: HAND_WRITTEN_TRACKER_TOKENS.length,
        },
        derivation: result,
        baseline,
        final,
      });

      return {
        result,
        provenance,
        seedSet,
        finalGate: compareTierVocabularyCorpus(baseline, final),
      };
    },
  );
}

/**
 * The derivation, run once and shared.
 *
 * It is deterministic and it is the slow part of this file — every candidate is judged against the
 * whole labelled corpus — so running it per test would multiply the suite's cost by four to measure
 * the same thing four times. Memoised rather than hoisted into a `beforeAll` so a test that only
 * needs the checked-in file never triggers it.
 */
let cached: ReturnType<typeof derive> | null = null;
const derivation = () => (cached ??= derive());

describe('the derived tier vocabulary', () => {
  test(
    'is what a fresh derivation of the shipped tiers produces',
    () => {
      // The whole suite in one assertion, and the one that would notice a vendor added to a tier, a
      // tier file regenerated by the compiler, or a hand edit to the generated module.
      const { result, provenance } = derivation();
      const rendered = renderTierVocabularyModule(result, provenance);
      // Read the file rather than import it: the comparison is byte for byte, which is the only
      // form of the check that also catches a re-ordered key or a re-rendered token list.
      const onDisk = readFileSync(GENERATED_FILE, 'utf8');

      expect(rendered).toBe(onDisk);
    },
    120_000,
  );

  test(
    'is checked in with the provenance of the run that produced it',
    () => {
      // A generated file without its measurement is a hand-written file with extra steps: the reader
      // cannot tell whether the corpus gate passed or was never run.
      const { result, provenance, seedSet, finalGate } = derivation();

      expect(TIER_VOCABULARY_PROVENANCE).toEqual(provenance);
      expect(TIER_VOCABULARY_PROVENANCE.hostsRead).toBe(seedSet.hostsRead);
      expect(TIER_VOCABULARY_PROVENANCE.seedsConsidered).toBe(result.seedsConsidered);
      // The corpus verdict is the reasoning for the whole exercise, so it travels with the tokens.
      expect(finalGate.ok).toBe(true);
      expect(provenance.gate.startsWith('passed:')).toBe(true);
      expect(TIER_VOCABULARY_PROVENANCE.gate).toBe(provenance.gate);
    },
    120_000,
  );

  test('records the seed vocabulary it started from, so the seed count means something', () => {
    // "44 hosts unplaceable" is a statement about a vocabulary. Without this it would be read as a
    // statement about the model, and a run that seeded itself with its own output would look like a
    // strictly better model.
    expect(TIER_VOCABULARY_PROVENANCE.seedVocabulary).toEqual({
      adTokens: HAND_WRITTEN_AD_TOKENS.length,
      trackerTokens: HAND_WRITTEN_TRACKER_TOKENS.length,
    });
  });

  test('places every host it derived a token from, and says so per host', () => {
    // The receipts. A token in the file has to name the hosts that justified it and the family it
    // puts them in — checked by installing the token and asking the model, not by trusting the file.
    const classifier = new MiniAiClassifier();
    const everything = TIER_VOCABULARY_EVIDENCE.flatMap((entry) => entry.hosts);
    expect(everything.length).toBeGreaterThan(0);

    for (const entry of TIER_VOCABULARY_EVIDENCE) {
      expect(entry.hosts.length).toBeGreaterThan(0);
      for (const host of entry.hosts) {
        const verdict = withTemporaryVocabulary(
          { adTokens: HAND_WRITTEN_AD_TOKENS, trackerTokens: HAND_WRITTEN_TRACKER_TOKENS, replace: true },
          () =>
            withTemporaryVocabulary(
              entry.vocabulary === 'ad' ? { adTokens: [entry.token] } : { trackerTokens: [entry.token] },
              () => {
                classifier.clearCache();
                return classifier.classify(host).category;
              },
            ),
        );
        expect([host, verdict]).toEqual([host, entry.family]);
      }
    }
  });

  test('ships every derived token and nothing it did not derive', () => {
    // The two lists are the whole of the generated vocabulary, and the merge in `reputation.ts` is
    // the only thing that turns them into something the classifier reads.
    expect(TIER_VOCABULARY_EVIDENCE.map((entry) => entry.token).sort()).toEqual(
      [...new Set(TIER_VOCABULARY_EVIDENCE.map((entry) => entry.token))].sort(),
    );
    for (const entry of TIER_VOCABULARY_EVIDENCE) {
      const list = entry.vocabulary === 'ad' ? TIER_DERIVED_AD_TOKENS : TIER_DERIVED_TRACKER_TOKENS;
      expect(list).toContain(entry.token);
    }
    expect([...TIER_DERIVED_AD_TOKENS].sort()).toEqual([...TIER_DERIVED_AD_TOKENS]);
    expect([...TIER_DERIVED_TRACKER_TOKENS].sort()).toEqual([...TIER_DERIVED_TRACKER_TOKENS]);
  });

  test('refuses nothing it could have placed, and explains every host it could not', () => {
    // The machine-written form of the pin. Every rejection carries a reason and, where the model was
    // asked at all, the attempts — so a host the tiers ship and the vocabulary cannot fix arrives
    // with its own explanation instead of needing a comment in a test file.
    const classifier = new MiniAiClassifier();
    for (const rejection of TIER_VOCABULARY_REJECTIONS) {
      expect(rejection.reason.length).toBeGreaterThan(0);
      // The host really is a host its tier ships.
      expect(tierHosts.get(rejection.tier)).toContain(rejection.host);
      // And the model really does not place it under the shipped vocabulary — otherwise there is
      // nothing to explain and this entry is stale.
      classifier.clearCache();
      expect(classifier.classify(rejection.host).category).toBe('Clean');
      if (rejection.reason.startsWith('no candidate label survived')) {
        expect(rejection.attempts).toEqual([]);
      } else {
        expect(rejection.attempts.length).toBeGreaterThan(0);
      }
    }
  });

  test('leaves no host in the disagreement set unaccounted for', () => {
    // The claim that lets the agreement suite stop hand-typing the pin: the union of what the
    // derivation placed and what it recorded has to cover the whole disagreement set, and the
    // disagreement set has to be exactly what the tiers and the model disagree about. A host in
    // neither half is a host that was silently dropped.
    const { seedSet } = derivation();
    const placed = new Set(TIER_VOCABULARY_EVIDENCE.flatMap((entry) => entry.hosts));
    const refused = new Set(TIER_VOCABULARY_REJECTIONS.map((rejection) => rejection.host));

    const unexplained = seedSet.seeds
      .map((seed) => seed.host)
      .filter((host) => !placed.has(host) && !refused.has(host));

    expect(unexplained).toEqual([]);
    // And nothing is recorded that is not a seed: a rejection for a host the model places would
    // mean the pin outlived its reason.
    const seeds = new Set(seedSet.seeds.map((seed) => seed.host));
    expect([...refused].filter((host) => !seeds.has(host))).toEqual([]);
    expect(seedSet.seeds.length).toBeGreaterThan(0);
  });

  test('keeps the corpus at zero false positives with the vocabulary installed', () => {
    // The property a user can actually observe. The derivation reports it, and the derivation is
    // fallible, so it is measured here from the shipped file rather than read out of the provenance.
    const classifier = new MiniAiClassifier();
    const report = withTemporaryVocabulary(
      { adTokens: TIER_DERIVED_AD_TOKENS, trackerTokens: TIER_DERIVED_TRACKER_TOKENS },
      () => evaluateClassifier(classifier, EVAL_CORPUS),
    );

    expect(report.triage.falsePositives).toEqual([]);
    expect(report.triage.falseAlarmsAsMalware).toEqual([]);
    expect(report.triage.accuracy).toBeGreaterThanOrEqual(0.98);
    // The vocabulary is not allowed to buy coverage by calling clean domains malicious, and the
    // shipped file's own record has to agree with the measurement.
    expect(report.triage.accuracy).toBe(TIER_VOCABULARY_PROVENANCE.corpus?.accuracy);
  });
});
