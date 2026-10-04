#!/usr/bin/env node
/**
 * Derives the classifier's vendor vocabulary from the shipped static tiers.
 *
 *   npm run build --workspace=@blockingmachine/core
 *   node scripts/derive-tier-vocabulary.mjs            # print the run report
 *   node scripts/derive-tier-vocabulary.mjs --write    # rewrite the generated vocabulary
 *   node scripts/derive-tier-vocabulary.mjs --check    # fail if the file on disk is stale
 *
 * The reasoning lives in `packages/core/src/ai/tierVocabularyDerivation.ts`; this script reads the
 * tier files, drives the derivation through the compiled classifier, prints what it did and
 * transcribes the result. The seed corpus is the **tier/model disagreement set**: every host a
 * tier ships that the classifier cannot place. A token is derived only from a host that is already
 * shipped, so this can name what the tiers contain and can never invent coverage they do not.
 *
 * Three things decide admission, and only the first is about the tiers:
 *
 *   1. the classifier has to move the host into a family the tier may be called, with the
 *      candidate token installed — asked of the model itself, via `withTemporaryVocabulary`;
 *   2. the token's label has to survive the vocabulary rules (length, no function words);
 *   3. the independent labelled corpus has to hold — no new false positive on a clean domain, no
 *      metric regression, no critical negative flagged.
 *
 * A vocabulary derived from the tiers and graded against the tiers would prove nothing, which is
 * why the third gate exists and why `--write` refuses to write when it fails.
 *
 * **The seed pass runs on the hand-written vocabulary alone**, installed by replacement, never on
 * the shipped lists. That is what makes the run a fixed point: the derived tokens are this run's
 * output, so a run that could read them back would find its own hosts already placed, seed a smaller
 * set and render a different file every time it was asked. Seeding from the hand-written half means
 * `--check` passes immediately after `--write`, including after a core rebuild puts the derived
 * tokens live.
 *
 * The seed pass, the corpus gate and the provenance record are core functions, not local ones, so
 * the suite that re-derives the generated file walks the tiers and judges the candidates exactly the
 * way this script does.
 *
 * Reads the compiled output, so it needs a build first — same contract as the element-weight fit.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgvOrExit } from './argv.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'packages', 'core', 'dist', 'ai');
const tierDirectory = join(root, 'packages', 'browser-extension', 'rules');
const target = join(root, 'packages', 'core', 'src', 'ai', 'tierVocabulary.generated.ts');

// Parsed through the shared refusing parser: `--rules-dir` with no directory used to fall back
// to the extension's own rules as if that were the directory named — the same silent-answer class
// as a tier name the compiler cannot honour — and a flag nobody knows (`--wirte`) did nothing.
const { flags, values } = parseArgvOrExit(process.argv.slice(2), {
  values: ['--rules-dir'],
  flags: ['--write', '--check'],
});
const rulesDir = values.has('--rules-dir')
  ? resolve(values.get('--rules-dir').at(-1))
  : tierDirectory;

async function load(module) {
  const path = join(dist, module);
  try {
    return await import(pathToFileURL(path).href);
  } catch (error) {
    console.error(`\nCould not load ${path}\n`);
    console.error('The derivation reads the compiled core package. Build it first:\n');
    console.error('  npm run build --workspace=@blockingmachine/core\n');
    console.error(`(${error instanceof Error ? error.message : String(error)})`);
    process.exit(2);
  }
}

const derivation = await load('tierVocabularyDerivation.js');
const reputation = await load('reputation.js');
const classifierModule = await load('MiniAiClassifier.js');
const evaluation = await load('evaluation.js');
const corpusModule = await load('evalCorpus.js');

const {
  TIER_VOCABULARY_SOURCES,
  compareTierVocabularyCorpus,
  deriveTierVocabulary,
  renderTierVocabularyModule,
  tierVocabularyProvenance,
  tierVocabularySeeds,
} = derivation;

/** Extracts the blocked host from `||host^` / `||host/path`, the shapes a tier may ship. */
function hostsIn(file) {
  const rules = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(rules)) throw new Error(`${file} is not a rule array`);
  const hosts = new Set();
  for (const rule of rules) {
    const filter = rule?.condition?.urlFilter;
    if (typeof filter !== 'string' || !filter.startsWith('||')) continue;
    const host = filter.slice(2).split(/[/^$]/)[0].toLowerCase();
    if (host.includes('.')) hosts.add(host);
  }
  return [...hosts].sort();
}

/** A private classifier per phase, so no prediction cache crosses a vocabulary change. */
const freshClassifier = () => new classifierModule.MiniAiClassifier();

let classifier = freshClassifier();

function classifyWith(host) {
  classifier.clearCache();
  return classifier.classify(host).category;
}

function corpusReport() {
  return evaluation.evaluateClassifier(classifier, corpusModule.EVAL_CORPUS);
}

const cleanCases = corpusModule.EVAL_CORPUS.filter((entry) => entry.expected.includes('Clean')).length;

/** One evaluation report, reduced to the numbers the gate is allowed to see. */
function corpusSample(report) {
  return {
    total: report.total,
    lexicalCases: report.triage.lexicalCases,
    cleanCases,
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

/** The corpus's verdict on one candidate vocabulary, next to the corpus's verdict without it. */
function corpusGate(adTokens, trackerTokens, consentTokens) {
  classifier = freshClassifier();
  const sample = corpusSample(
    reputation.withTemporaryVocabulary({ adTokens, trackerTokens, consentTokens }, corpusReport),
  );
  // The comparison itself lives in core, where the suite that re-derives the shipped file can ask
  // the same question of the same function instead of reimplementing what "the corpus passed" means.
  return compareTierVocabularyCorpus(baselineSample, sample);
}

// ── Read the tiers ────────────────────────────────────────────────────────────────────────────

const tierHosts = new Map();
for (const tier of TIER_VOCABULARY_SOURCES) {
  const file = join(rulesDir, `${tier}.json`);
  if (!existsSync(file)) {
    console.error(`\nMissing tier ruleset ${file}\n`);
    console.error('Point --rules-dir at the extension rules directory, or compile the tiers first.\n');
    process.exit(2);
  }
  tierHosts.set(tier, hostsIn(file));
}
// Read but never derived from: its contents are the model's own verdicts, so learning vocabulary
// from it would teach the classifier the answers it is graded on.
const securityFile = join(rulesDir, 'tier_security.json');
const securityHosts = existsSync(securityFile) ? hostsIn(securityFile).length : 0;

// ── Baseline: what the model cannot place today ───────────────────────────────────────────────

// Everything below runs with the **hand-written vocabulary alone** installed, replacing whatever
// the shipped lists happen to hold. See the header for why that is what makes the run a fixed
// point; the consequence at this point in the file is that the baseline measured here, the seed
// set built from it and the candidate gates judged against it are all about the same vocabulary.

/** The disagreement set and what the seed pass read, filled in by the block below. */
let seedSet = null;
/** The independent corpus before any candidate token was considered. */
let baselineSample = null;
/** The same corpus with the vocabulary as it will ship. */
let finalSample = null;
/** The derivation itself. */
let result = null;

reputation.withTemporaryVocabulary(
  {
    adTokens: reputation.HAND_WRITTEN_AD_TOKENS,
    trackerTokens: reputation.HAND_WRITTEN_TRACKER_TOKENS,
    consentTokens: reputation.HAND_WRITTEN_CONSENT_TOKENS,
    replace: true,
  },
  () => {
    // The seed pass is core's, not this script's, so the suite that re-derives this file walks the
    // tiers exactly the way the run that wrote it did.
    seedSet = tierVocabularySeeds({
      tierHosts,
      classifyHost: classifyWith,
    });

    classifier = freshClassifier();
    baselineSample = corpusSample(corpusReport());

    // ── Derive ────────────────────────────────────────────────────────────────────────────────

    result = deriveTierVocabulary({
      seeds: seedSet.seeds,
      // The full host sets, not just the seeds: a bare-label candidate is only as honest as
      // the apex listing it can point to, and an apex that is listed *and* placeable is
      // never a seed.
      tierHosts,
      knownTokens: {
        adTokens: reputation.HAND_WRITTEN_AD_TOKENS,
        trackerTokens: reputation.HAND_WRITTEN_TRACKER_TOKENS,
        consentTokens: reputation.HAND_WRITTEN_CONSENT_TOKENS,
      },
      withVocabulary: reputation.withTemporaryVocabulary,
      classifyHost: classifyWith,
      // Per candidate rather than per run, so a single wrong token is refused on its own instead of
      // costing the whole vocabulary — which is what makes "derived from the tiers" safe: the tiers
      // propose, and the corpus disposes.
      corpusGate: ({ adTokens, trackerTokens, consentTokens }) =>
        corpusGate(adTokens, trackerTokens, consentTokens),
    });

    // The gate above ran per candidate against a moving vocabulary, so the corpus is measured again
    // here for the vocabulary as it will actually ship. That is also the run the file's provenance
    // reports, and the one `--write` refuses to write when it fails.
    finalSample = corpusSample(
      reputation.withTemporaryVocabulary(
        {
          adTokens: result.adTokens,
          trackerTokens: result.trackerTokens,
          consentTokens: result.consentTokens,
        },
        corpusReport,
      ),
    );
  },
);

/** The shipped vocabulary's verdict against the baseline, which is what a write is gated on. */
const finalGate = compareTierVocabularyCorpus(baselineSample, finalSample);

// Assembled in core, where the suite that re-derives this file can ask for the same record — a
// provenance block written out twice would disagree over key order, and a byte comparison would
// report the shipped file as stale on every run.
const provenance = tierVocabularyProvenance({
  seedSet,
  seedVocabulary: {
    adTokens: reputation.HAND_WRITTEN_AD_TOKENS.length,
    trackerTokens: reputation.HAND_WRITTEN_TRACKER_TOKENS.length,
    consentTokens: reputation.HAND_WRITTEN_CONSENT_TOKENS.length,
  },
  derivation: result,
  baseline: baselineSample,
  final: finalSample,
});

// ── Report ────────────────────────────────────────────────────────────────────────────────────

const report = [];
const pct = (value) => `${(value * 100).toFixed(1)}%`;
report.push(`\n🎯 [Vocabulary] ${rulesDir}`);
report.push(
  `   tiers    ${provenance.tiers
    .map((entry) => `${entry.tier} ${entry.hosts - entry.unplaceable}/${entry.hosts}`)
    .join(' · ')}`,
);
if (securityHosts > 0) {
  report.push(`   refused  tier_security ${securityHosts} host(s) — the tier holds the model's own verdicts`);
}
report.push(
  `   seeds    ${result.seedsConsidered} host(s) in the disagreement set ` +
    `(seeded from ${provenance.seedVocabulary.adTokens} ad + ` +
    `${provenance.seedVocabulary.trackerTokens} tracker + ` +
    `${provenance.seedVocabulary.consentTokens} consent hand-written token(s), never a previous run)`,
);

for (const entry of result.evidence) {
  report.push(
    `   + ${entry.token.padEnd(22)} ${entry.vocabulary.padEnd(7)} → ${entry.family} ` +
      `(${entry.tier}: ${entry.hosts.join(', ')})`,
  );
}
for (const rejection of result.rejections) {
  report.push(`   · unplaced ${rejection.tier}: ${rejection.host}`);
  report.push(`     reason    ${rejection.reason}`);
  for (const attempt of rejection.attempts) {
    report.push(
      `     tried     ${attempt.token} [${attempt.vocabulary}${attempt.present ? ', already present' : ''}] → ${attempt.family}`,
    );
    if (attempt.gate) report.push(`     corpus    ${attempt.gate}`);
  }
}
if (result.rejections.length === 0 && result.seedsConsidered === 0) {
  report.push('   · nothing to derive — the model places every host the tiers ship');
}

report.push(
  `   corpus   ${baselineSample.total} cases · accuracy ${pct(baselineSample.accuracy)} → ` +
    `${pct(finalSample?.accuracy ?? baselineSample.accuracy)} · macro F1 ` +
    `${baselineSample.macroF1.toFixed(3)} → ${(finalSample?.macroF1 ?? baselineSample.macroF1).toFixed(3)}`,
);
report.push(`   gate     ${provenance.gate}`);
report.push(
  `   tokens   ${result.adTokens.length} ad + ${result.trackerTokens.length} tracker + ` +
    `${result.consentTokens.length} consent derived` +
    `${result.corpusRefusals > 0 ? `, ${result.corpusRefusals} candidate(s) refused by the corpus` : ''}` +
    `${result.apexRefusals > 0 ? `, ${result.apexRefusals} bare label(s) refused by apex attestation` : ''}`,
);
console.log(report.join('\n'));

const rendered = renderTierVocabularyModule(result, provenance);

if (!finalGate.ok && (flags.has('--write') || flags.has('--check'))) {
  console.error('\n🚨 [Vocabulary] Refusing to write: the shipped vocabulary fails the corpus gate.');
  console.error('   A vocabulary that costs a false positive on a clean domain is not worth the');
  console.error('   coverage it buys; fix the candidate rules rather than the gate.\n');
  process.exit(1);
}

if (flags.has('--write')) {
  writeFileSync(target, rendered, 'utf8');
  console.log(`\n✅ [Vocabulary] Wrote ${target}`);
  console.log('   Rebuild core (npm run build --workspace=@blockingmachine/core) before the tests\n');
} else if (flags.has('--check')) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (current !== rendered) {
    console.error(`\n🚨 [Vocabulary] ${target} is stale.`);
    console.error('   Run: node scripts/derive-tier-vocabulary.mjs --write\n');
    process.exit(1);
  }
  console.log('\n✅ [Vocabulary] Generated vocabulary matches a fresh derivation\n');
}
