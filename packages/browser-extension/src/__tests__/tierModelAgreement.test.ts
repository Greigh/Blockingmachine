/**
 * The shipped static tiers must be things the embedded classifier can account for.
 *
 * The Mini-AI classifier is what the AI Radar reports to the user, what the triage cascade screens
 * with, and what the element picker corroborates with. The static tiers are a *separate* body of
 * knowledge — a hand-curated blocklist — and the two can drift apart in silence. When they do, the
 * extension blocks a host while the model it also ships calls that host clean, and nothing in the
 * build notices. This suite is that notice.
 *
 * It walks every domain the shipped tier files contain and fails on any disagreement with the tier
 * that ships it. What is tolerated is *measured*, never assumed, and the shape of the tolerance is
 * the finding:
 *
 *   - **The model never contradicts a tier.** Across all 118 curated hosts, not one is classified
 *     into a different blocking family — no ad host called a tracker, no tracker called malware.
 *     Every disagreement is instead the model failing to place a host at all (`Clean`).
 *   - **It fails to place 22 of them** — 1 privacy and 21 annoyance host — always as `Clean` and
 *     always at 74–88%, under the 90% mark past which a clean verdict is an assertion rather than a
 *     shrug. That is the same weak band the triage cascade escalates, so these hosts are that
 *     cascade's documented reason for existing rather than a bug in the list. The count was 46
 *     until the classifier's token lists gained the vendors these tiers carry; 24 hosts moved out
 *     of the pin because of it, and the two that did not are the two different kinds of remaining
 *     gap — see `TOLERATED_MISSES`.
 *   - **The always-on Core shield tier gets no such latitude**: every host it ships is recognised.
 *     That tier is enabled on a fresh install, so it does not get the benefit of the doubt.
 *   - **`tier_annoyances` is the vocabulary gap in its purest form**: 21 of its 22 hosts have no
 *     word in the classifier's category set at all, because there is no "annoyance" category to
 *     have. Which is exactly why that tier ships disabled. This is the larger half of what remains
 *     and the half that is *not* fixable by teaching the model names.
 *
 * The disagreement set is *pinned* rather than the assertion being loosened, and it has to hold its
 * own weight: 24 of the 46 original entries are gone, and every one of them left because the
 * classifier learned the vendor rather than because the pin was relaxed. What is left is pinned for
 * two different reasons and the list says which is which. A host added to a tier the model cannot
 * account for fails this suite, and so does a model that learns a host it used to miss — until the
 * pin is updated. A bug list that cannot go stale is a bug list nobody trusts.
 *
 * ## Why a packaged build is graded differently
 *
 * `npm run package:extension` replaces these files with 30,000 hosts compiled from the desktop
 * hub's own blocklist. The model's blind spot is documented to cover roughly a third of a real
 * list, so demanding agreement with an arbitrary slice of someone's blocklist would fail for a
 * reason nobody can act on. In that state the size-independent guarantees are asserted instead —
 * they are not skipped, and the curated-baseline suite is reported as skipped rather than passing
 * without having checked anything.
 */

import { describe, expect, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { MiniAiClassifier } from '@blockingmachine/core/domain-ai';
import {
  STATIC_RULE_TIERS,
  tierById,
  tierCompilationSource,
  type StaticTierId,
} from '../shared/rulesetTiers.js';

type Category = ReturnType<MiniAiClassifier['classify']>['category'];

/** Blocking families: what the model says when it *has* placed a host. */
const BLOCKING_FAMILIES: readonly Category[] = [
  'Advertising',
  'Telemetry/Analytics',
  'CNAME Cloaking',
];

/**
 * The families each tier may legitimately be called.
 *
 * `tier_core` is described as "the highest-confidence ad and tracker hosts", so either family is
 * the point of it. `tier_privacy` also accepts `Advertising` because ad-verification vendors
 * (`adsafeprotected.com`, `doubleverify.com`) are filed there but are programmatic ad
 * infrastructure — the model calling them what they are is a filing choice, not a contradiction.
 * `tier_annoyances` requires nothing, for the reason in the header: the classifier's vocabulary has
 * no annoyance category, so there is no family to require.
 */
const TIER_FAMILIES: Partial<Record<StaticTierId, readonly Category[]>> = {
  tier_core: BLOCKING_FAMILIES,
  tier_ads: ['Advertising'],
  tier_privacy: [...BLOCKING_FAMILIES],
  tier_annoyances: ['Advertising', 'Telemetry/Analytics'],
  /**
   * The inverted tier, and the only one whose allowed family is `Malware/Phishing`.
   *
   * The other four exist to block things the model should *also* recognise as ad or tracking
   * infrastructure, and the suite fails when it does not. This one is the reverse: its contents
   * are the model's own malware verdicts, so a host in it that the model calls `Clean` or
   * `Advertising` is the defect. Being a model's output makes it the one tier this suite cannot
   * independently corroborate — which is why the assertion is inverted rather than dropped, and
   * why `curatedSeed: false` is what lets the empty-baseline case stay honest.
   */
  tier_security: ['Malware/Phishing'],
};

/**
 * Hosts the model does not recognise, pinned with the evidence that it does not.
 *
 * Every entry is a `Clean` verdict, which is the whole point: the model is not disagreeing with the
 * tier, it is declining to have an opinion, and it declines at 74–88% — below the assertion mark.
 * A host whose *family* the model places elsewhere is deliberately not pinnable, because that would
 * be a real contradiction and has to be fixed rather than recorded.
 */
const TOLERATED_MISSES: Partial<Record<StaticTierId, readonly string[]>> = {
  /**
   * `tier_ads` is now empty, and that is the point of the exercise.
   *
   * Twelve SSPs and exchanges — Magnite, MoPub, Sonobi, 33Across and the rest — used to sit here
   * because the classifier had no token for them: a company whose name is an ordinary word looks
   * like nothing to a lexical model, so the tier shipped hosts the model called clean. Each is now
   * a token in `SUSPICIOUS_AD_TOKENS`, and the tier requires agreement with no exceptions.
   *
   * The key is deleted rather than left as an empty array, so a host added to this tier falls
   * through the `?? []` default and fails the pin comparison instead of being silently tolerated.
   */
  // tier_ads: no entries.
  tier_privacy: [
    /**
     * Pinned for a reason that is not a vocabulary gap, and it is the more interesting entry.
     *
     * `business-api.tiktok` *is* now a tracker token, and it does lift the model's telemetry
     * probability on this host (0.04 → 0.12). It does not change the verdict, because the `-api`
     * label makes the infrastructure pass classify the host as a verified endpoint on a readable
     * domain, and `knownSafeInfra` outranks every token in the model by design. That precedence is
     * correct — an API zone on a major platform is exactly the shape a naive token match gets wrong
     * — so the honest record is that this tier ships a host the model is configured to trust, and
     * the suite should keep saying so rather than have the token added until the number goes green.
     */
    'business-api.tiktok.com',
  ],
  tier_annoyances: [
    'cookiebot.com',
    'cookielaw.org',
    'foxpush.com',
    'getsitecontrol.com',
    'hellobar.com',
    'iubenda.com',
    'izooto.com',
    'justuno.com',
    'onetrust.com',
    'optimonk.com',
    'osano.com',
    'popupsmart.com',
    'privacy-mgmt.com',
    'privy.com',
    'pushengage.com',
    'quantcast.com',
    'sendpulse.com',
    'sleeknote.com',
    'termly.io',
    'webpushr.com',
    'wisepops.com',
  ],
};

/**
 * Confidence at or above which a `Clean` verdict stops being a shrug and becomes an assertion.
 *
 * "I cannot place this host" is tolerable in a hand-curated list; "this host is definitively clean"
 * is not, because the extension is blocking it anyway. Measured ceiling across every curated host
 * is 88%.
 */
const MAX_TOLERATED_CLEAN_CONFIDENCE = 90;

interface TierMeasurement {
  tier: StaticTierId;
  label: string;
  hosts: string[];
  /** Hosts whose family is not one the tier may be called. */
  disagreements: string[];
  /** Disagreements where the model placed the host in a *different* family — a contradiction. */
  contradictions: string[];
  /** Disagreements reported as `Clean` at or above the assertion mark. */
  confidentClean: string[];
  /** Hosts the model considers malware or phishing. */
  malicious: string[];
  recognized: number;
  /** Highest confidence the model attached to a `Clean` verdict about a blocked host. */
  maxCleanConfidence: number;
}

/** Extracts the blocked host from `||host^` / `||host/path`, the only shapes a tier may ship. */
function hostsIn(tier: StaticTierId): string[] {
  const path = new URL(`../../rules/${tier}.json`, import.meta.url);
  if (!existsSync(path)) {
    throw new Error(
      `tier ruleset ${path.pathname} is missing — restore the curated baseline or run ` +
        '`npm run compile:tiers`; a manifest pointing at a missing ruleset is a broken build',
    );
  }

  const rules = JSON.parse(readFileSync(path, 'utf8')) as Array<{
    condition?: { urlFilter?: string };
  }>;
  if (!Array.isArray(rules)) throw new Error(`${path.pathname} is not a rule array`);

  const hosts = new Set<string>();
  for (const rule of rules) {
    const filter = rule?.condition?.urlFilter;
    if (typeof filter !== 'string' || !filter.startsWith('||')) continue;
    const host = filter.slice(2).split(/[/^$]/)[0].toLowerCase();
    if (host.includes('.')) hosts.add(host);
  }
  return [...hosts].sort();
}

function measureTier(tier: StaticTierId): TierMeasurement {
  const label = tierById(tier)?.label ?? tier;
  const allowed = TIER_FAMILIES[tier] ?? [];
  // A private instance: no prediction cache shared with, or feedback from, any other test.
  const classifier = new MiniAiClassifier();
  const hosts = hostsIn(tier);

  const disagreements: string[] = [];
  const contradictions: string[] = [];
  const confidentClean: string[] = [];
  const malicious: string[] = [];
  let recognized = 0;
  let maxCleanConfidence = 0;

  for (const host of hosts) {
    const prediction = classifier.classify(host);
    if (prediction.category === 'Malware/Phishing') malicious.push(host);
    if (BLOCKING_FAMILIES.includes(prediction.category)) recognized += 1;
    if (allowed.includes(prediction.category)) continue;

    disagreements.push(host);
    if (prediction.category === 'Clean') {
      maxCleanConfidence = Math.max(maxCleanConfidence, prediction.confidence);
      if (prediction.confidence >= MAX_TOLERATED_CLEAN_CONFIDENCE) confidentClean.push(host);
    } else {
      contradictions.push(host);
    }
  }

  return {
    tier,
    label,
    hosts,
    disagreements,
    contradictions,
    confidentClean,
    malicious,
    recognized,
    maxCleanConfidence,
  };
}

const MEASURED: TierMeasurement[] = STATIC_RULE_TIERS.map((tier) => measureTier(tier.id));

/** True while the tier files are a hub compilation rather than the curated baseline. */
const COMPILED = tierCompilationSource() !== null;

/** Grading that only means something against the curated baseline. Reported as skipped otherwise. */
const baselineOnly = COMPILED ? describe.skip : describe;

const qualified = (tier: TierMeasurement, hosts: readonly string[]): string[] =>
  hosts.map((host) => `${tier.tier}: ${host}`);

describe('shipped tiers vs the Mini-AI classifier', () => {
  test('classifies every domain the shipped tiers contain', () => {
    const total = MEASURED.reduce((sum, tier) => sum + tier.hosts.length, 0);
    console.log(
      `[tiers vs model] ${COMPILED ? 'hub compilation' : 'curated baseline'}: ` +
        MEASURED.map((tier) => `${tier.label} ${tier.recognized}/${tier.hosts.length}`).join(', '),
    );

    // Every tier must contribute hosts, or the loader silently walked an empty file and every
    // assertion below would hold by vacuity — except the one tier that is *supposed* to be empty
    // until a classifier has run somewhere. Asserting non-empty for it would make a fresh
    // checkout fail for being fresh, and skipping the assertion for every tier would let a
    // genuinely lost baseline through.
    for (const tier of MEASURED) {
      if (tierById(tier.tier)?.curatedSeed === false) continue;
      expect(tier.hosts.length).toBeGreaterThan(0);
    }
    expect(total).toBeGreaterThanOrEqual(118);
  });

  test('ships nothing the model considers malware or phishing, except in the tier that is for them', () => {
    // Holds at any size: a tier presenting itself as ads, privacy, or consent must not be where a
    // malicious host lands — and `tier_core` is enabled on a fresh install, so it is held first.
    const core = MEASURED.filter((tier) => tier.tier === 'tier_core');
    expect(core.flatMap((tier) => qualified(tier, tier.malicious))).toEqual([]);
    if (COMPILED) return;

    const others = MEASURED.filter((tier) => tier.tier !== 'tier_security');
    expect(others.flatMap((tier) => qualified(tier, tier.malicious))).toEqual([]);
  });

  test('holds only malware and phishing verdicts in the tier built from them', () => {
    // The inverted invariant. `tier_security` carries the model's own output, so "the model
    // agrees with it" is not a check — but "it contains nothing the model does *not* call
    // malware" is a real one, and it is what stops the tier drifting into a general-purpose
    // blocklist that happens to be assembled by the model. An empty baseline satisfies it, which
    // is the honest state of a checkout where the classifier has never run.
    const security = MEASURED.find((tier) => tier.tier === 'tier_security')!;
    expect(qualified(security, security.disagreements)).toEqual([]);
    expect(tierById('tier_security')?.defaultEnabled).toBe(false);
  });

  test('recognises every host the always-on Core shield tier ships', () => {
    const core = MEASURED.find((tier) => tier.tier === 'tier_core')!;
    // Compiling is additive and never re-tiers a curated host, so the curated core hosts are
    // present and recognised whether these files are the baseline or a hub compilation.
    const curatedCoreHosts = tierById('tier_core')?.ruleCount ?? 0;
    expect(curatedCoreHosts).toBeGreaterThan(0);
    expect(core.recognized).toBeGreaterThanOrEqual(curatedCoreHosts);

    // With the baseline in place the tier is held to the strict version: no gaps at all, because
    // this is the one tier that ships enabled.
    if (COMPILED) return;
    expect(qualified(core, core.disagreements)).toEqual([]);
  });

  baselineOnly('graded against the curated baseline', () => {
    test('never contradicts a tier with a different family', () => {
      // The headline invariant, and the only failure here that is a defect rather than a gap: the
      // model placing a host in a *different* blocking family means the tier and the model disagree
      // about what the thing is, which no amount of extra confidence resolves.
      expect(MEASURED.flatMap((tier) => qualified(tier, tier.contradictions))).toEqual([]);
    });

    test('never asserts a blocked host is clean with high confidence', () => {
      // "I cannot place this" is tolerable in a curated list. "This host is definitively clean" is
      // not, because the extension is blocking it anyway.
      expect(MEASURED.flatMap((tier) => qualified(tier, tier.confidentClean))).toEqual([]);
      for (const tier of MEASURED) {
        expect(tier.maxCleanConfidence).toBeLessThan(MAX_TOLERATED_CLEAN_CONFIDENCE);
      }
    });

    test('records exactly the disagreements it tolerates', () => {
      for (const tier of MEASURED) {
        expect(new Set(tier.disagreements)).toEqual(new Set(TOLERATED_MISSES[tier.tier] ?? []));
      }

      // And the pin is kept honest: an entry that has started agreeing is a stale entry, which
      // means the model learned something and the record must be updated rather than left to rot.
      const measuredByTier = new Map(MEASURED.map((tier) => [tier.tier, tier]));
      const stale = (Object.keys(TOLERATED_MISSES) as StaticTierId[]).flatMap((tier) =>
        (TOLERATED_MISSES[tier] ?? [])
          .filter((host) => !measuredByTier.get(tier)!.disagreements.includes(host))
          .map((host) => `${tier}: ${host}`),
      );
      expect(stale).toEqual([]);
    });

    test('documents that the consent tier is a family the model has no word for', () => {
      // Not a target to raise — there is no annoyance category to raise it to. It is the measurable
      // reason `tier_annoyances` ships disabled: nothing in the model corroborates it, so the tier
      // is opt-in and its real hits are attributed and shown instead of assumed.
      const annoyances = MEASURED.find((tier) => tier.tier === 'tier_annoyances')!;
      expect(annoyances.hosts.length).toBeGreaterThan(20);
      expect(annoyances.recognized).toBeLessThanOrEqual(1);
      expect(tierById('tier_annoyances')?.defaultEnabled).toBe(false);
    });
  });
});
