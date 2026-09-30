/**
 * Derives the classifier's vendor vocabulary from the shipped static tiers.
 *
 * ## Why this exists
 *
 * The extension ships two bodies of knowledge about what is worth blocking — a curated blocklist
 * split into static tiers, and the embedded Mini-AI classifier that scores names — and the two
 * drift apart in a way that is invisible until you look: a host sits in a tier because a human
 * decided it belongs there, while the classifier calls it `Clean`, because a company whose name is
 * an ordinary word looks like nothing to a lexical model. That disagreement is recorded, host by
 * host, by the tier/model agreement suite, and the way it used to be resolved was by hand: someone
 * read the pin, worked out which vendor each host was, and typed a token into `reputation.ts`.
 *
 * That loop does not scale and it is not auditable. This module is the mechanical version of it.
 * The disagreement set is the **seed corpus**: the tiers say which hosts a human decided to block,
 * the model says which of them it cannot place, and the gap between the two lists is exactly the
 * set of names the vocabulary is missing. Every token here is derived from a host that is *already
 * shipped* — the derivation cannot invent coverage, it can only name what the tiers already
 * contain.
 *
 * ## Why the derivation is not allowed to be the judge
 *
 * A vocabulary derived from the tier files and then graded against the tier files would prove
 * nothing: the model would agree with the list because it was taught the list. So this module only
 * produces *candidates*, and three separate things decide whether one is admitted:
 *
 *  1. **The model has to move.** Each candidate is installed into the live lists and the host is
 *     classified again. A token that does not change the verdict is refused, which is how a token
 *     that looks like a name but is not the signal gets caught.
 *  2. **The tier has to accept the family.** {@link TIER_MODEL_FAMILIES} is the same contract the
 *     agreement suite grades with, and it is enforced here rather than asserted afterwards.
 *  3. **The corpus has to hold.** An independent, hand-labelled corpus of clean, ad, measurement
 *     and malicious domains is evaluated before and after; the driver refuses to write a
 *     vocabulary that costs a false positive on any of them. This is the part that keeps
 *     derivation honest, because it is the one instrument that was not built out of the tiers.
 *
 * `tier_security` is deliberately not a source. Its contents are the model's own verdicts, so
 * learning vocabulary from it would teach the classifier the answers it is graded on — the one
 * circularity that would make the tier/model agreement suite meaningless rather than merely weak.
 *
 * @see scripts/derive-tier-vocabulary.mjs
 * @see packages/browser-extension/src/__tests__/tierModelAgreement.test.ts
 * @beta
 */

import { normalizeHostname } from './hostname.js';
import type { ThreatCategory } from './types.js';
import type { StaticTierId } from '../tiers.js';

/**
 * The families each tier may legitimately be called.
 *
 * `tier_core` is described as "the highest-confidence ad and tracker hosts", so either family is
 * the point of it. `tier_privacy` also accepts `Advertising` because ad-verification vendors
 * (`adsafeprotected.com`, `doubleverify.com`) are filed there but are programmatic ad
 * infrastructure — the model calling them what they are is a filing choice, not a contradiction.
 * `tier_annoyances` accepts both blocking families rather than requiring none: the classifier has
 * no annoyance category at all, so a consent platform it *can* place has to be placed as the
 * third-party data processor it is, and the tier's contract says which labels that may be.
 *
 * `tier_security` is the inverted tier and is not a vocabulary source — see the module header.
 */
export const TIER_MODEL_FAMILIES: Partial<Record<StaticTierId, readonly ThreatCategory[]>> = {
  tier_core: ['Advertising', 'Telemetry/Analytics', 'CNAME Cloaking'],
  tier_ads: ['Advertising'],
  tier_privacy: ['Advertising', 'Telemetry/Analytics', 'CNAME Cloaking'],
  tier_annoyances: ['Telemetry/Analytics', 'Advertising'],
  tier_security: ['Malware/Phishing'],
};

/** The tiers a derivation may learn from, in the order candidates are resolved. */
export const TIER_VOCABULARY_SOURCES: readonly StaticTierId[] = [
  'tier_core',
  'tier_ads',
  'tier_privacy',
  'tier_annoyances',
];

/**
 * Labels that must never become tokens, whatever host they came from.
 *
 * A stop-list is the safe direction to be wrong in: refusing a token leaves a host in the
 * disagreement pin, visible and explained, while admitting one turns a word that appears all over
 * the web into a block signal. Entries are here for one of two reasons — the label names a
 * function rather than a company (`analytics`, `static`, `api`), or it is an ordinary English word
 * that legitimate hosts carry (`privy`, `pulse`), which is how a token match becomes a false
 * positive on someone's own site.
 */
export const GENERIC_VOCABULARY_LABELS: ReadonlySet<string> = new Set([
  // Function words: what the host is for, not who runs it.
  'ads', 'ad', 'adserv', 'adserver', 'adservice', 'adserving', 'advert', 'adverts',
  'banner', 'banners', 'beacon', 'beacons', 'bid', 'bids', 'click', 'clicks', 'counter',
  'counters', 'metric', 'metrics', 'pixel', 'pixels', 'stat', 'stats', 'tag', 'tags',
  'track', 'tracker', 'trackers', 'tracking', 'telemetry', 'analytics',
  // Operations and infrastructure labels.
  'api', 'apis', 'app', 'apps', 'assets', 'asset', 'cdn', 'cdn1', 'cdn2', 'cloud', 'css',
  'data', 'download', 'downloads', 'edge', 'file', 'files', 'gateway', 'host', 'hosts',
  'img', 'image', 'images', 'js', 'static', 'static1', 'upload', 'uploads', 'www', 'www2',
  // Registrable-name-adjacent words that a host may legitimately be.
  'content', 'media', 'news', 'shop', 'store', 'support', 'server', 'servers', 'services',
  'service', 'network', 'networks', 'group', 'global', 'digital', 'online', 'web',
  // Ordinary English words the shipped tiers contain as vendor names.
  'privy',
]);

/**
 * Whether a label is usable as a token at all.
 *
 * Five characters is the floor: shorter labels collide with unrelated hosts across the whole web
 * (`ad`, `ct`, `tr`, `vwo`), and the tokens that are deliberately short are hand-written where a
 * human can defend them.
 */
export function isUsableVocabularyToken(token: string): boolean {
  if (typeof token !== 'string') return false;
  const value = token.trim().toLowerCase();
  if (value.length < 5 || value.length > 63) return false;
  if (!/[a-z]/.test(value)) return false;
  return !value.split(/[.\-]/).some((label) => GENERIC_VOCABULARY_LABELS.has(label));
}

/**
 * The tokens to try for one host, most specific first.
 *
 * The vendored-endpoint form comes first because it is the shape that places a host without
 * claiming the vendor's whole zone: `business-api.tiktok` places TikTok's API zone while a bare
 * `tiktok` token would call the consumer site itself a tracker. The registrable label comes
 * second, and it is the form that works for the ordinary case — `cookiebot.com` is placed by
 * `cookiebot`.
 *
 * Candidates are *not* the vendor's whole name: a label is considered as-is, so `privacy-mgmt`
 * is tried whole rather than split into words that would match unrelated hosts.
 */
export function vocabularyCandidatesFor(host: string): string[] {
  const clean = normalizeHostname(host);
  if (!clean) return [];
  const labels = clean.split('.');
  if (labels.length < 2) return [];

  const candidates: string[] = [];
  const sld = labels[labels.length - 2];
  // A label ahead of the registrable label is a zone the vendor runs (`ct.pinterest.com`,
  // `business-api.tiktok.com`), and taking the pair keeps the token inside that zone.
  if (labels.length >= 3) candidates.push(`${labels[labels.length - 3]}.${sld}`);
  candidates.push(sld);

  const seen = new Set<string>();
  return candidates.filter((token) => {
    if (seen.has(token)) return false;
    seen.add(token);
    return isUsableVocabularyToken(token);
  });
}

export interface TierVocabularySeed {
  tier: StaticTierId;
  host: string;
  /** Families this tier may be called. Defaults to the catalogue's contract. */
  families?: readonly ThreatCategory[];
}

/** What the seed pass read, per tier. */
export interface TierVocabularySeedCoverage {
  tier: StaticTierId;
  hosts: number;
  /** Hosts the model could not place, so they became seeds. */
  unplaceable: number;
}

export interface TierVocabularySeedSet {
  seeds: TierVocabularySeed[];
  coverage: TierVocabularySeedCoverage[];
  /** Hosts read across every tier named in the input. */
  hostsRead: number;
}

/**
 * The seed pass: which hosts a tier ships that the model cannot place.
 *
 * This is the whole input to the derivation, and it is stated as one function because two callers
 * need it to be the same function — the driver that writes the vocabulary and the suite that
 * re-derives it to prove the file is not stale. A seed set built two ways would make that suite
 * grade a derivation nobody ships.
 *
 * Must be called with the hand-written vocabulary installed, not the shipped lists: the derived
 * tokens are the output of this pass, so a run that could see them would find its own hosts already
 * placed and seed nothing.
 */
export function tierVocabularySeeds(input: {
  /** Blocked hosts per tier, as read out of the ruleset files. */
  tierHosts: ReadonlyMap<StaticTierId, readonly string[]>;
  /** Tiers to walk, in the order seeds are produced. Defaults to the vocabulary sources. */
  tiers?: readonly StaticTierId[];
  /** Classifies one host under whatever vocabulary is currently installed. */
  classifyHost: (host: string) => ThreatCategory;
}): TierVocabularySeedSet {
  const tiers = input.tiers ?? TIER_VOCABULARY_SOURCES;
  const seeds: TierVocabularySeed[] = [];
  const coverage: TierVocabularySeedCoverage[] = [];

  for (const tier of tiers) {
    const hosts = input.tierHosts.get(tier) ?? [];
    const families = TIER_MODEL_FAMILIES[tier] ?? [];
    let unplaceable = 0;
    for (const host of hosts) {
      if (families.includes(input.classifyHost(host))) continue;
      unplaceable += 1;
      seeds.push({ tier, host, families });
    }
    coverage.push({ tier, hosts: hosts.length, unplaceable });
  }

  return {
    seeds,
    coverage,
    hostsRead: coverage.reduce((sum, entry) => sum + entry.hosts, 0),
  };
}

/**
 * The independent corpus, reduced to the numbers the vocabulary gate is allowed to look at.
 *
 * A plain data shape rather than the evaluator's report, so the gate below is a pure function of
 * two measurements — testable without a corpus, and impossible to quietly re-derive from the tiers
 * it is supposed to be independent of.
 */
export interface TierVocabularyCorpusSample {
  total: number;
  /** Cases the corpus expects a lexical verdict for, rather than recognising as known infrastructure. */
  lexicalCases: number;
  /** Domains the corpus labels clean — the denominator for a false-positive claim. */
  cleanCases: number;
  /** Domains the corpus labels clean that the model did not, and what it called them instead. */
  falsePositives: ReadonlyArray<{ domain: string; called: string }>;
  /** Clean domains the model called malware. */
  falseAlarmsAsMalware: number;
  accuracy: number;
  macroF1: number;
  coverageGaps: number;
}

/**
 * Whether a candidate vocabulary may ship, judged by the one instrument not built out of the tiers.
 *
 * Deliberately asymmetric: a new false positive on a clean domain, or a clean domain called
 * malware, is a refusal on its own — that is the failure a vocabulary can cause in a user's browser
 * and the failure this whole exercise exists to avoid. The metric regressions are refusals too,
 * because a token that buys coverage by making the head worse on the corpus it is graded against is
 * not a win, but they are measured rather than argued. Matching coverage gaps are *not* a refusal:
 * a candidate that leaves the gap count alone is a candidate the corpus has nothing to say about.
 *
 * Shared with `scripts/derive-tier-vocabulary.mjs` and the suite that re-derives the generated
 * module, so "the corpus passed" means the same thing in the file, the driver and the test.
 */
export function compareTierVocabularyCorpus(
  baseline: TierVocabularyCorpusSample,
  candidate: TierVocabularyCorpusSample,
): { ok: boolean; detail: string } {
  // Compared by name rather than by count, so a candidate that trades one clean domain for another
  // is refused too — the vocabulary is judged on which hosts it breaks, not on how many.
  const added = candidate.falsePositives.filter(
    (miss) => !baseline.falsePositives.some((seen) => seen.domain === miss.domain),
  );
  if (added.length > 0) {
    return {
      ok: false,
      detail:
        `refused: ${added.length} new false positive(s) — ` +
        added.map((miss) => `${miss.domain} called ${miss.called}`).join(', '),
    };
  }
  if (candidate.falseAlarmsAsMalware > 0) {
    return {
      ok: false,
      detail: `refused: ${candidate.falseAlarmsAsMalware} clean domain(s) called malicious`,
    };
  }
  const worse =
    candidate.accuracy < baseline.accuracy ||
    candidate.macroF1 < baseline.macroF1 ||
    candidate.coverageGaps > baseline.coverageGaps;
  if (worse) {
    return { ok: false, detail: 'refused: a corpus metric regressed (accuracy, macro F1, or list-coverage gaps)' };
  }
  return {
    ok: true,
    detail:
      `passed: ${candidate.falsePositives.length}/${candidate.cleanCases} clean domains flagged, ` +
      `accuracy ${candidate.accuracy.toFixed(4)}, macro F1 ${candidate.macroF1.toFixed(4)}, ` +
      `coverage gaps ${candidate.coverageGaps}`,
  };
}

export interface TierVocabularyEvidence {
  token: string;
  vocabulary: 'ad' | 'tracker';
  /** The tier the token was derived from, and the one the agreement suite will grade it under. */
  tier: StaticTierId;
  /** Hosts from that tier the token places. */
  hosts: string[];
  /** The family it places them in. */
  family: ThreatCategory;
}

export interface TierVocabularyAttempt {
  token: string;
  vocabulary: 'ad' | 'tracker';
  /** True when the hand-written vocabulary already carries this token. */
  present: boolean;
  /** What the host was called with the token installed. */
  family: ThreatCategory;
  /**
   * What the independent corpus said about this candidate, when it got that far.
   *
   * Only present for a candidate that already moved the host into an accepted family, because a
   * candidate that did nothing has nothing for the corpus to object to.
   */
  gate?: string;
}

export interface TierVocabularyRejection {
  tier: StaticTierId;
  host: string;
  reason: string;
  attempts: TierVocabularyAttempt[];
}

export interface TierVocabularyDerivation {
  adTokens: string[];
  trackerTokens: string[];
  evidence: TierVocabularyEvidence[];
  rejections: TierVocabularyRejection[];
  /** Hosts taken from the tiers and asked about, in the order they were considered. */
  seedsConsidered: number;
  /** Candidates that moved a host but were refused by the independent corpus. */
  corpusRefusals: number;
}

/**
 * What one derivation run saw, written into the generated module beside the tokens it produced.
 *
 * The numbers travel with the vocabulary for the same reason the element weight table's do: a
 * generated list without its measurement is a hand-written list with extra steps, and the next
 * person to read it cannot tell whether the corpus gate passed or was never run.
 */
export interface TierVocabularyProvenance {
  /** Hosts read from each tier, and how many of them the model could not place. */
  tiers: Array<{ tier: string; hosts: number; unplaceable: number }>;
  hostsRead: number;
  /**
   * How many tokens the seed pass ran with.
   *
   * Recorded because "unplaceable" is only meaningful next to the vocabulary it was measured
   * against. These are the hand-written counts, never a previous run's: the derived tokens are this
   * derivation's output, and a derivation that seeded itself with its own output would shrink its
   * own seed set on every run and never be reproducible.
   */
  seedVocabulary: { adTokens: number; trackerTokens: number };
  seedsConsidered: number;
  acceptedTokens: number;
  rejectedHosts: number;
  /** Candidates the model accepted that the independent corpus refused. */
  corpusRefusals: number;
  /** The independent corpus, before and after the vocabulary was installed. */
  corpus: {
    total: number;
    lexicalCases: number;
    baselineAccuracy: number;
    accuracy: number;
    baselineMacroF1: number;
    macroF1: number;
    baselineFalsePositives: number;
    falsePositives: number;
    baselineCoverageGaps: number;
    coverageGaps: number;
  } | null;
  /** The gate's own sentence, so a reader knows whether it passed or was not run. */
  gate: string;
}

/**
 * The provenance record for one derivation, assembled from the measurements that produced it.
 *
 * Stated here rather than in the driver because two callers need the *same* record: the run that
 * writes the file and the suite that re-derives it and compares byte for byte. A provenance block
 * assembled twice would either disagree over key order — and so report a stale file on every run —
 * or be quietly relaxed until it agreed, which is worse than no record at all.
 *
 * The gate's sentence is computed here too, from the same two samples the gate itself was given, so
 * the file cannot claim a verdict that the measurement does not support.
 */
export function tierVocabularyProvenance(input: {
  /** What the seed pass read, per tier. */
  seedSet: TierVocabularySeedSet;
  /** The hand-written tokens the seed pass ran with. */
  seedVocabulary: { adTokens: number; trackerTokens: number };
  derivation: TierVocabularyDerivation;
  /** The independent corpus before any candidate was considered. */
  baseline: TierVocabularyCorpusSample;
  /** The same corpus with the vocabulary as it will ship. Null when the gate was never run. */
  final: TierVocabularyCorpusSample | null;
}): TierVocabularyProvenance {
  const { seedSet, derivation, baseline, final } = input;
  return {
    tiers: seedSet.coverage.map((entry) => ({
      tier: entry.tier,
      hosts: entry.hosts,
      unplaceable: entry.unplaceable,
    })),
    hostsRead: seedSet.hostsRead,
    seedVocabulary: input.seedVocabulary,
    seedsConsidered: derivation.seedsConsidered,
    acceptedTokens: derivation.adTokens.length + derivation.trackerTokens.length,
    rejectedHosts: derivation.rejections.length,
    corpusRefusals: derivation.corpusRefusals,
    corpus: final
      ? {
          total: final.total,
          lexicalCases: final.lexicalCases,
          accuracy: final.accuracy,
          macroF1: final.macroF1,
          falsePositives: final.falsePositives.length,
          coverageGaps: final.coverageGaps,
          baselineAccuracy: baseline.accuracy,
          baselineMacroF1: baseline.macroF1,
          baselineFalsePositives: baseline.falsePositives.length,
          baselineCoverageGaps: baseline.coverageGaps,
        }
      : null,
    gate: final
      ? compareTierVocabularyCorpus(baseline, final).detail
      : 'not run',
  };
}

/**
 * Renders the generated vocabulary module.
 *
 * Lives here rather than in the driver script so the test suite can regenerate the file and
 * compare byte for byte — the same reason the element weights are rendered from a core module.
 */
export function renderTierVocabularyModule(
  derivation: TierVocabularyDerivation,
  provenance: TierVocabularyProvenance,
): string {
  const lines: string[] = [];
  const tokenList = (tokens: readonly string[]): string =>
    tokens.length === 0 ? '[]' : `[
${tokens.map((token) => `  '${token}',`).join('\n')}
]`;

  lines.push('/**');
  lines.push(' * GENERATED FILE — do not edit by hand.');
  lines.push(' *');
  lines.push(' * The classifier vocabulary derived from the shipped static tiers, produced by');
  lines.push(' * `scripts/derive-tier-vocabulary.mjs`. Regenerate with:');
  lines.push(' *');
  lines.push(' *   npm run build --workspace=@blockingmachine/core');
  lines.push(' *   node scripts/derive-tier-vocabulary.mjs --write');
  lines.push(' *');
  lines.push(' * Every token here names a host the tiers already ship and the model could not place, and');
  lines.push(' * the evidence record below says which host justified which token. `tier_security` is');
  lines.push(' * deliberately absent as a source: its contents are the model\'s own verdicts, so learning');
  lines.push(' * from it would teach the classifier the answers it is graded on.');
  lines.push(' *');
  lines.push(' * The suite re-derives this file and fails if the two disagree, which is what keeps a');
  lines.push(' * generated vocabulary from quietly becoming a hand-maintained one.');
  lines.push(' */');
  lines.push('');
  lines.push("import type {");
  lines.push('  TierVocabularyEvidence,');
  lines.push('  TierVocabularyProvenance,');
  lines.push('  TierVocabularyRejection,');
  lines.push("} from './tierVocabularyDerivation.js';");
  lines.push('');
  lines.push('/** How this vocabulary was derived, and what the independent corpus said about it. */');
  lines.push('export const TIER_VOCABULARY_PROVENANCE: TierVocabularyProvenance =');
  lines.push(JSON.stringify(provenance, null, 2));
  lines.push(';');
  lines.push('');
  lines.push('/** Vendors the tiers carry whose names read as advertising to the classifier. */');
  lines.push('export const TIER_DERIVED_AD_TOKENS: readonly string[] = ');
  lines.push(tokenList(derivation.adTokens));
  lines.push(';');
  lines.push('');
  lines.push('/** Vendors the tiers carry whose names read as measurement to the classifier. */');
  lines.push('export const TIER_DERIVED_TRACKER_TOKENS: readonly string[] = ');
  lines.push(tokenList(derivation.trackerTokens));
  lines.push(';');
  lines.push('');
  lines.push('/** Which host justified which token, and the family it places that host in. */');
  lines.push('export const TIER_VOCABULARY_EVIDENCE: readonly TierVocabularyEvidence[] =');
  lines.push(JSON.stringify(derivation.evidence, null, 2));
  lines.push(';');
  lines.push('');
  lines.push('/**');
  lines.push(' * Hosts in the disagreement set that no token could place, with every attempt recorded.');
  lines.push(' *');
  lines.push(' * This is the machine-written form of the pin the agreement suite used to document in prose:');
  lines.push(' * a host listed here is one the tiers ship, the model does not recognise, and the vocabulary');
  lines.push(' * cannot honestly fix — because the model is configured to trust it, or because no label of');
  lines.push(' * its name survives the vocabulary rules.');
  lines.push(' */');
  lines.push('export const TIER_VOCABULARY_REJECTIONS: readonly TierVocabularyRejection[] =');
  lines.push(JSON.stringify(derivation.rejections, null, 2));
  lines.push(';');
  lines.push('');
  return lines.join('\n');
}

export interface DeriveTierVocabularyInput {
  /** The hosts the model cannot place, with the tier that ships them. */
  seeds: readonly TierVocabularySeed[];
  /** The vocabulary in the hand-written lists, so an already-carried token is reported as such. */
  knownTokens?: { adTokens?: readonly string[]; trackerTokens?: readonly string[] };
  /** Runs `fn` with extra tokens installed in the live lists, then restores them. */
  withVocabulary: <T>(
    tokens: { adTokens?: readonly string[]; trackerTokens?: readonly string[] },
    fn: () => T,
  ) => T;
  /** Classifies one host. Called with the accumulated vocabulary installed. */
  classifyHost: (host: string) => ThreatCategory;
  /**
   * Judges a candidate against the independent corpus, with the tokens accepted so far installed.
   *
   * Called per candidate rather than once at the end, so one bad token does not cost the whole
   * derivation: the corpus says *which* token is wrong, and that token is refused on its own while
   * the rest are admitted.
   */
  corpusGate?: (tokens: {
    adTokens: readonly string[];
    trackerTokens: readonly string[];
  }) => { ok: boolean; detail: string };
}

/**
 * Turns the tier/model disagreement set into vocabulary, one token at a time.
 *
 * Deterministic: seeds are considered in the order given, candidates in the order
 * {@link vocabularyCandidatesFor} produces them, and a token considered for a host is kept only if
 * it moves that host into a family the tier accepts. A host no candidate can place is *recorded*
 * with everything that was tried, because that record is what replaces the hand-written comment
 * that used to explain a pin.
 */
export function deriveTierVocabulary(input: DeriveTierVocabularyInput): TierVocabularyDerivation {
  const adTokens: string[] = [];
  const trackerTokens: string[] = [];
  const evidence: TierVocabularyEvidence[] = [];
  const rejections: TierVocabularyRejection[] = [];
  const knownAd = new Set(input.knownTokens?.adTokens ?? []);
  const knownTracker = new Set(input.knownTokens?.trackerTokens ?? []);
  let corpusRefusals = 0;

  for (const seed of input.seeds) {
    const families = seed.families ?? TIER_MODEL_FAMILIES[seed.tier] ?? [];
    const candidates = vocabularyCandidatesFor(seed.host);
    const attempts: TierVocabularyAttempt[] = [];
    let placed: { token: string; vocabulary: 'ad' | 'tracker'; family: ThreatCategory } | null = null;

    for (const token of candidates) {
      // The tracker list is tried first for every tier but the ad tier: if the model has to file a
      // vendor under one of two coarse families, the one that describes data collection is the
      // truthful one, and the ad family is the fallback rather than the default.
      const order: Array<'tracker' | 'ad'> = seed.tier === 'tier_ads' ? ['ad'] : ['tracker', 'ad'];
      for (const vocabulary of order) {
        const isAd = vocabulary === 'ad';
        const present = isAd ? knownAd.has(token) : knownTracker.has(token);
        const nextAd = isAd ? [...adTokens, token] : adTokens;
        const nextTracker = isAd ? trackerTokens : [...trackerTokens, token];
        const attempt: TierVocabularyAttempt = { token, vocabulary, present, family: 'Clean' };
        attempt.family = input.withVocabulary(
          { adTokens: nextAd, trackerTokens: nextTracker },
          () => input.classifyHost(seed.host),
        );
        attempts.push(attempt);
        if (!families.includes(attempt.family)) continue;

        // The model moved, and now the one instrument that was not built out of the tiers decides.
        if (input.corpusGate) {
          const gate = input.corpusGate({ adTokens: nextAd, trackerTokens: nextTracker });
          attempt.gate = gate.detail;
          if (!gate.ok) {
            corpusRefusals += 1;
            continue;
          }
        }

        placed = { token, vocabulary, family: attempt.family };
        break;
      }
      if (placed) break;
    }

    if (!placed) {
      const movedButRefused = attempts.some((attempt) => attempt.gate && !attempt.gate.startsWith('passed'));
      rejections.push({
        tier: seed.tier,
        host: seed.host,
        reason: candidates.length === 0
          ? 'no candidate label survived the vocabulary rules (too short, generic, or a function word)'
          : movedButRefused
          ? 'the only candidates that moved this host were refused by the independent corpus'
          : 'no candidate token moved this host into a family the tier may be called',
        attempts,
      });
      continue;
    }

    const list = placed.vocabulary === 'ad' ? adTokens : trackerTokens;
    if (!list.includes(placed.token)) list.push(placed.token);
    const existing = evidence.find(
      (entry) => entry.token === placed!.token && entry.vocabulary === placed!.vocabulary,
    );
    if (existing) {
      if (!existing.hosts.includes(seed.host)) existing.hosts.push(seed.host);
    } else {
      evidence.push({
        token: placed.token,
        vocabulary: placed.vocabulary,
        tier: seed.tier,
        hosts: [seed.host],
        family: placed.family,
      });
    }
  }

  adTokens.sort();
  trackerTokens.sort();
  evidence.sort((a, b) =>
    a.token === b.token ? a.tier.localeCompare(b.tier) : a.token.localeCompare(b.token),
  );

  return {
    adTokens,
    trackerTokens,
    evidence,
    rejections,
    seedsConsidered: input.seeds.length,
    corpusRefusals,
  };
}
