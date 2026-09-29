#!/usr/bin/env node
/**
 * Regenerates the element classifier's fitted weight table.
 *
 *   npm run build --workspace=@blockingmachine/core
 *   node scripts/fit-element-weights.mjs            # print the run report
 *   node scripts/fit-element-weights.mjs --write    # rewrite the generated table
 *   node scripts/fit-element-weights.mjs --check    # fail if the file on disk is stale
 *
 * The fit itself lives in `packages/core/src/ai/elementWeightFitting.ts` — this script
 * only drives it, prints what it did, and transcribes the result. Keeping the numbers
 * machine-written is the point: a table retyped by hand drifts from the corpus that
 * supposedly produced it, and nothing notices.
 *
 * Reads the compiled output, so it needs a build first. `--check` and `--write` compare
 * the freshly fit table against what is committed, which is what makes the checked-in
 * numbers a build artifact rather than a snapshot.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'packages', 'core', 'dist', 'ai');
const target = join(root, 'packages', 'core', 'src', 'ai', 'elementWeights.generated.ts');

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));

/** Full-batch Adam steps. Matches the value the test suite re-fits with. */
const EPOCHS = 1500;

async function load(module) {
  const path = join(dist, module);
  try {
    return await import(pathToFileURL(path).href);
  } catch (error) {
    console.error(`\nCould not load ${path}\n`);
    console.error('The fitting script reads the compiled core package. Build it first:\n');
    console.error('  npm run build --workspace=@blockingmachine/core\n');
    console.error(`(${error instanceof Error ? error.message : String(error)})`);
    process.exit(2);
  }
}

const fitting = await load('elementWeightFitting.js');
const classifier = await load('elementClassifier.js');
const corpus = await load('elementEvalCorpus.js');
const evaluation = await load('elementEvaluation.js');

const cases = [...corpus.ELEMENT_EVAL_CORPUS];
const { train, holdout } = fitting.splitElementCorpus(cases);

// Select the prior strength by cross-validating over the training cases only. Choosing it
// against the held-out cases would make the held-out result partly a fitted quantity,
// which is exactly the dishonesty this exercise is meant to remove.
const selection = fitting.selectPriorStrength({ cases: train, epochs: EPOCHS });

const fit = fitting.fitElementWeights({ cases: train, priorStrength: selection.priorStrength, epochs: EPOCHS });

const comparison = fitting.compareWeightSets(classifier.ELEMENT_HAND_TUNED_WEIGHTS, fit.weights, holdout);
const baselineEval = evaluation.evaluateElementClassifier(
  new classifier.MiniAiElementClassifier({ weights: classifier.ELEMENT_HAND_TUNED_WEIGHTS }),
  cases,
);
const fittedEval = evaluation.evaluateElementClassifier(
  new classifier.MiniAiElementClassifier({ weights: fit.weights }),
  cases,
);
const baselineCalibration = fitting.weightSetActionCalibration(classifier.ELEMENT_HAND_TUNED_WEIGHTS, cases);
const fittedCalibration = fitting.weightSetActionCalibration(fit.weights, cases);

const provenance = {
  corpusCases: cases.length,
  trainingCases: train.length,
  holdoutCases: holdout.length,
  priorStrength: selection.priorStrength,
  epochs: EPOCHS,
  holdout: {
    baselineAccuracy: comparison.baseline.accuracy,
    fittedAccuracy: comparison.fitted.accuracy,
    baselineLogLoss: comparison.baseline.logLoss,
    fittedLogLoss: comparison.fitted.logLoss,
  },
  endToEnd: {
    total: baselineEval.total,
    baselineCorrect: baselineEval.correct,
    fittedCorrect: fittedEval.correct,
  },
  actionCalibration: {
    baselineEce: baselineCalibration.ece,
    fittedEce: fittedCalibration.ece,
    baselineBrier: baselineCalibration.brier,
    fittedBrier: fittedCalibration.brier,
  },
  largestWeightChange: fitting.largestWeightChange(classifier.ELEMENT_HAND_TUNED_WEIGHTS, fit.weights),
};

const source = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * The element classifier's fitted weights, produced by \`scripts/fit-element-weights.mjs\`
 * from the labelled corpus in \`elementEvalCorpus.ts\`. Regenerate with:
 *
 *   npm run build --workspace=@blockingmachine/core
 *   node scripts/fit-element-weights.mjs --write
 *
 * The provenance record below is written by the same run as the numbers, so the table
 * cannot be updated without its measurement travelling with it. The suite re-fits the
 * table and fails if the two disagree, which is what stops these values drifting from
 * the corpus that justifies them.
 */

import type { ElementWeightSet } from './elementClassifier.js';
import type { ElementWeightProvenance } from './elementWeightFitting.js';

/** How ${'{@link ELEMENT_FITTED_WEIGHTS}'} was produced, and what it bought and cost. */
export const ELEMENT_FITTED_PROVENANCE: ElementWeightProvenance = ${JSON.stringify(provenance, null, 2)};

/** Weight vectors fit from the corpus; see {@link ELEMENT_FITTED_PROVENANCE}. */
export const ELEMENT_FITTED_WEIGHTS: ElementWeightSet = ${fitting.renderWeightSetSource(fit.weights)};
`;

console.log('\nElement weight fit');
console.log('');
console.log(`  corpus                : ${cases.length} cases (${train.length} train / ${holdout.length} holdout)`);
console.log(`  prior selection       : ${selection.scores.map((s) => `${s.priorStrength}:${s.logLoss.toFixed(4)}`).join('  ')}`);
console.log(`  chosen prior          : ${selection.priorStrength} pseudo-examples, ${EPOCHS} epochs`);
console.log(`  ${fitting.formatWeightFit(fit)}`);
console.log(`  largest move from prior: ${provenance.largestWeightChange.feature} ${provenance.largestWeightChange.from} -> ${provenance.largestWeightChange.to}`);
console.log('');
console.log('  held-out head (higher is better, lower loss)');
console.log(`    accuracy            : ${comparison.baseline.accuracy} -> ${comparison.fitted.accuracy}`);
console.log(`    cross-entropy       : ${comparison.baseline.logLoss} -> ${comparison.fitted.logLoss}`);
console.log(`    brier               : ${comparison.baseline.brier} -> ${comparison.fitted.brier}`);
console.log(`    wins / regressions  : ${comparison.wins.length} / ${comparison.regressions.length}`);
for (const label of comparison.wins) console.log(`      win       ${label}`);
for (const label of comparison.regressions) console.log(`      regression ${label}`);
console.log('');
console.log('  whole-corpus action calibration (the trade)');
console.log(`    ECE                 : ${baselineCalibration.ece} -> ${fittedCalibration.ece}`);
console.log(`    Brier               : ${baselineCalibration.brier} -> ${fittedCalibration.brier}`);
console.log(`    end-to-end correct  : ${baselineEval.correct}/${baselineEval.total} -> ${fittedEval.correct}/${fittedEval.total}`);
console.log('');

if (flags.has('--check')) {
  let existing = '';
  try {
    existing = readFileSync(target, 'utf8');
  } catch {
    console.error(`Missing ${target}. Run with --write.\n`);
    process.exit(1);
  }
  const expectedBlock = source.slice(source.indexOf('export const ELEMENT_FITTED_PROVENANCE'));
  const actualBlock = existing.slice(existing.indexOf('export const ELEMENT_FITTED_PROVENANCE'));
  if (actualBlock !== expectedBlock) {
    console.error('The checked-in weight table does not match a fresh fit.\n');
    console.error('Re-run with --write and commit the result.\n');
    process.exit(1);
  }
  console.log('Weight table matches a fresh fit.\n');
  process.exit(0);
}

if (flags.has('--write')) {
  writeFileSync(target, source, 'utf8');
  console.log(`Wrote ${target}\n`);
  process.exit(0);
}

console.log('Dry run — pass --write to update the table.\n');
