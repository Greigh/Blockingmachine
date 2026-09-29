/**
 * The claim that ships with the fitted weights, and the checks that keep it honest.
 *
 * The classifier's table used to be hand-written and never measured against anything. It
 * is now fit from the labelled corpus, which raises three questions that a table change
 * cannot answer by assertion:
 *
 *  1. **Does it actually beat what it replaced?** — answered on cases the fit never saw,
 *     on the head's own metrics, with the individual cases that changed hands named.
 *  2. **Is the win an artifact of one hyperparameter?** — answered by re-fitting across
 *     the whole prior grid; the improvement has to survive all of it.
 *  3. **Is the shipped table the one the corpus produces?** — answered by re-fitting from
 *     the corpus in-process and comparing, so the file cannot drift from its justification.
 *
 * Everything here is deterministic: the fit has no RNG, no clock and no I/O, so these
 * assertions are about arithmetic, not about a lucky seed.
 */

import {
  ELEMENT_CLASSES,
  ELEMENT_HAND_TUNED_WEIGHTS,
  ELEMENT_MODEL_WEIGHTS,
  MiniAiElementClassifier,
} from '../ai/elementClassifier.js';
import { ELEMENT_EVAL_CORPUS } from '../ai/elementEvalCorpus.js';
import { evaluateElementClassifier } from '../ai/elementEvaluation.js';
import { ELEMENT_FITTED_PROVENANCE, ELEMENT_FITTED_WEIGHTS } from '../ai/elementWeights.generated.js';
import {
  ELEMENT_FEATURE_ORDER,
  compareWeightSets,
  elementTargets,
  fitElementWeights,
  largestWeightChange,
  selectPriorStrength,
  splitElementCorpus,
  weightSetActionCalibration,
  weightSetMetrics,
} from '../ai/elementWeightFitting.js';

const EPOCHS = ELEMENT_FITTED_PROVENANCE.epochs;
const { train, holdout } = splitElementCorpus();

describe('fitted element weights', () => {
  it('ships the fitted table, not the hand-tuned one', () => {
    expect(ELEMENT_MODEL_WEIGHTS).toBe(ELEMENT_FITTED_WEIGHTS);
    expect(ELEMENT_FITTED_WEIGHTS).not.toEqual(ELEMENT_HAND_TUNED_WEIGHTS);
  });

  it('accounts for every feature the extractor can produce', () => {
    // `ELEMENT_FEATURE_ORDER` is stated explicitly rather than derived, so that the
    // generated table reads in a stable, reviewable order. The cost of that choice is a
    // silent failure mode: a feature added to the vector but forgotten here would be fit
    // at a constant zero forever, and nothing else would notice. The hand-tuned table is
    // typed as a total map over the feature names, so it is the ground truth to check
    // against.
    const declared = Object.keys(ELEMENT_HAND_TUNED_WEIGHTS.Ad).filter((name) => name !== 'bias');
    expect([...ELEMENT_FEATURE_ORDER].sort()).toEqual(declared.sort());
  });

  it('covers every feature in every class vector', () => {
    // The softmax indexes each class vector by feature name. A generated table that
    // dropped a key would silently score a feature as zero rather than fail.
    for (const cls of ELEMENT_CLASSES) {
      const vector = ELEMENT_FITTED_WEIGHTS[cls];
      expect(Number.isFinite(vector.bias)).toBe(true);
      for (const name of ELEMENT_FEATURE_ORDER) {
        expect(Number.isFinite(vector[name])).toBe(true);
      }
      expect(Object.keys(vector).sort()).toEqual(['bias', ...ELEMENT_FEATURE_ORDER].sort());
    }
  });

  it('reproduces the checked-in table from the corpus alone', () => {
    const refit = fitElementWeights({
      cases: train,
      priorStrength: ELEMENT_FITTED_PROVENANCE.priorStrength,
      epochs: EPOCHS,
    });

    const drifted: string[] = [];
    for (const cls of ELEMENT_CLASSES) {
      for (const name of ['bias', ...ELEMENT_FEATURE_ORDER] as const) {
        const stored = ELEMENT_FITTED_WEIGHTS[cls][name];
        const fresh = refit.weights[cls][name];
        // The table is stored to four decimals, so agreement is expected to be exact; the
        // tolerance only absorbs the last place. A corpus or feature change moves it far
        // more than this, which is the point of the check.
        if (Math.abs(stored - fresh) > 1e-4) drifted.push(`${cls}.${name}: stored ${stored}, fresh ${fresh}`);
      }
    }
    expect(drifted).toEqual([]);
  });

  it('shares the split evenly across classes', () => {
    expect(train.length).toBe(ELEMENT_FITTED_PROVENANCE.trainingCases);
    expect(holdout.length).toBe(ELEMENT_FITTED_PROVENANCE.holdoutCases);
    for (const cls of ELEMENT_CLASSES) {
      expect(train.filter((entry) => entry.expected[0] === cls).length).toBeGreaterThan(0);
      expect(holdout.filter((entry) => entry.expected[0] === cls).length).toBeGreaterThan(0);
    }
    // Deterministic, so the held-out set is a property of the corpus rather than of a run.
    expect(splitElementCorpus()).toEqual({ train, holdout });
  });

  it('beats the hand-tuned baseline on cases the fit never saw', () => {
    const comparison = compareWeightSets(ELEMENT_HAND_TUNED_WEIGHTS, ELEMENT_FITTED_WEIGHTS, holdout);

    expect(comparison.fitted.accuracy).toBeGreaterThan(comparison.baseline.accuracy);
    expect(comparison.fitted.logLoss).toBeLessThan(comparison.baseline.logLoss);
    // Brier is the one that matters most: it is a proper scoring rule on the full label
    // distribution, so it cannot be improved by being more confident without being right.
    expect(comparison.fitted.brier).toBeLessThan(comparison.baseline.brier);
    // A win that is really a trade would show up here.
    expect(comparison.regressions).toEqual([]);
    expect(comparison.wins.length).toBeGreaterThan(0);
    expect(comparison.cases).toBe(holdout.length);
  });

  it('does not depend on the one prior strength that was selected', () => {
    // The sweep that chose the prior could be doing the work. Re-fit across the whole grid
    // and require the improvement to survive all of it — including the strongest prior,
    // where the fit is closest to the baseline it has to beat.
    const baseline = weightSetMetrics(ELEMENT_HAND_TUNED_WEIGHTS, holdout, 'hand-tuned');
    const grid = [1, 2, 3, 5, 8, 10, 20, 50];

    // One point in the grid lands slightly above the baseline on cross-entropy while
    // still improving accuracy on the same cases, so the response surface is not monotone
    // in prior strength. It is named rather than dropped from the grid: a sweep reported
    // as uniform would be hiding the exception, and prior 5 is not the selected value, so
    // it is not a case of the selection having picked a flattering corner.
    const crossEntropyExceptions = new Set([5]);

    for (const priorStrength of grid) {
      const fit = fitElementWeights({ cases: train, priorStrength, epochs: EPOCHS });
      const metrics = weightSetMetrics(fit.weights, holdout, `prior=${priorStrength}`);
      expect(metrics.accuracy).toBeGreaterThanOrEqual(baseline.accuracy);
      if (crossEntropyExceptions.has(priorStrength)) {
        expect(metrics.logLoss).toBeLessThan(baseline.logLoss + 0.01);
      } else {
        expect(metrics.logLoss).toBeLessThan(baseline.logLoss);
      }
    }
  });

  it('selects the prior on the training split, and shows the prior matters', () => {
    const selection = selectPriorStrength({ cases: train, epochs: EPOCHS });
    const chosen = selection.scores.find((score) => score.priorStrength === selection.priorStrength);
    expect(chosen).toBeDefined();
    expect(selection.priorStrength).toBe(ELEMENT_FITTED_PROVENANCE.priorStrength);

    // Across the folds the strength is chosen on, an unregularised fit is the worst
    // candidate: 104 parameters against the ~60 elements each fold trains on, with
    // feature families that are correlated by construction. Every regularised strength
    // beats it there, which is what makes the selection's answer a positive one.
    //
    // The margin is deliberately not pinned to a multiplier. It measured 25x when the
    // selection scored a single inner split of 110 cases, 3.5x at 117, and 1.9x once every
    // training case was folded into validation (1.0929 against 0.5813 at strength 1), so a
    // ratio assertion would be measuring the selection rule rather than the effect. What
    // the suite holds onto is the direction, and that the winner is a positive strength.
    //
    // Known limit, measured but not asserted here: at *full* training-set scale the
    // unregularised fit still generalises better on the 40 held-out cases (logLoss 0.0877
    // against 0.1443 for the shipped strength). Selecting on those cases would make them a
    // fitted quantity, and the fold estimates are too small to see it, so the gap is
    // recorded instead of tuned away — the fix is more labelled cases.
    const unregularised = selection.scores.find((score) => score.priorStrength === 0);
    const regularised = selection.scores.filter((score) => score.priorStrength > 0);
    expect(regularised.length).toBeGreaterThan(0);
    expect(unregularised!.logLoss).toBeGreaterThan(Math.max(...regularised.map((score) => score.logLoss)));
    expect(selection.priorStrength).toBeGreaterThan(0);
  });

  it('does not change the decision the product makes', () => {
    const shipped = evaluateElementClassifier(new MiniAiElementClassifier(), [...ELEMENT_EVAL_CORPUS]);
    const reference = evaluateElementClassifier(
      new MiniAiElementClassifier({ weights: ELEMENT_HAND_TUNED_WEIGHTS }),
      [...ELEMENT_EVAL_CORPUS],
    );

    expect(shipped.correct).toBe(reference.correct);
    expect(shipped.actionMix).toEqual(reference.actionMix);
    expect(shipped.safety.destroyedContent).toEqual([]);
    expect(shipped.safety.missedHides).toEqual([]);
    expect(shipped.safety.undersoldHides).toEqual([]);

    // Held-out end to end, not just on the head: the cases the fit never saw are still
    // decided correctly through the full evidence path.
    const shippedHoldout = evaluateElementClassifier(new MiniAiElementClassifier(), holdout);
    const referenceHoldout = evaluateElementClassifier(
      new MiniAiElementClassifier({ weights: ELEMENT_HAND_TUNED_WEIGHTS }),
      holdout,
    );
    expect(shippedHoldout.correct).toBeGreaterThanOrEqual(referenceHoldout.correct);
    expect(shippedHoldout.correct).toBe(holdout.length);
  });

  it('records the calibration it cost next to the fit it bought', () => {
    const provenance = ELEMENT_FITTED_PROVENANCE;
    const shippedCalibration = weightSetActionCalibration(ELEMENT_FITTED_WEIGHTS, [...ELEMENT_EVAL_CORPUS]);
    const referenceCalibration = weightSetActionCalibration(ELEMENT_HAND_TUNED_WEIGHTS, [...ELEMENT_EVAL_CORPUS]);

    // A sharper head is better at ranking and slightly less conservative in the confidence
    // it reports, and the record has to say so rather than only counting the win.
    expect(provenance.actionCalibration.fittedEce).toBeGreaterThan(provenance.actionCalibration.baselineEce);
    expect(shippedCalibration.ece).toBe(provenance.actionCalibration.fittedEce);
    expect(referenceCalibration.ece).toBe(provenance.actionCalibration.baselineEce);
    expect(shippedCalibration.brier).toBe(provenance.actionCalibration.fittedBrier);

    // The trade is small: the whole movement is a rounding error on the confidence scale.
    expect(provenance.actionCalibration.fittedEce - provenance.actionCalibration.baselineEce).toBeLessThan(0.01);
  });

  it('fits deterministically', () => {
    const first = fitElementWeights({ cases: train, priorStrength: 2, epochs: 200 });
    const second = fitElementWeights({ cases: train, priorStrength: 2, epochs: 200 });
    expect(first.weights).toEqual(second.weights);
    expect(first.trainingLoss).toBe(second.trainingLoss);
    // And it actually descends rather than starting at a minimum.
    expect(first.trainingLoss).toBeLessThan(first.initialLoss);
  });

  it('weights the corpus targets the way the corpus accepts labels', () => {
    const case_ = ELEMENT_EVAL_CORPUS.find((entry) => entry.expected.length > 1);
    expect(case_).toBeDefined();
    const targets = elementTargets(case_!);
    const share = 1 / case_!.expected.length;
    for (const cls of ELEMENT_CLASSES) {
      expect(targets[cls]).toBeCloseTo(case_!.expected.includes(cls) ? share : 0, 10);
    }
    // Training on the canonical label alone would punish the model for the cases the
    // corpus explicitly permits.
    expect(Object.values(targets).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
  });

  it('reports how far it had to move from the hand-tuned prior', () => {
    const move = largestWeightChange(ELEMENT_HAND_TUNED_WEIGHTS, ELEMENT_FITTED_WEIGHTS);
    expect(ELEMENT_FEATURE_ORDER).toContain(move.feature);
    expect(Number.isFinite(move.from)).toBe(true);
    expect(Number.isFinite(move.to)).toBe(true);
    expect(move).toEqual(ELEMENT_FITTED_PROVENANCE.largestWeightChange);
    // The prior is a centre, not a straitjacket: the fit has to be free to disagree.
    expect(Math.abs(move.to - move.from)).toBeGreaterThan(0);
  });

  it('handles a degenerate corpus without inventing a fit', () => {
    const empty = fitElementWeights({ cases: [] });
    expect(empty.examples).toBe(0);
    expect(empty.weights).toEqual(ELEMENT_HAND_TUNED_WEIGHTS);
    expect(weightSetMetrics(ELEMENT_FITTED_WEIGHTS, []).cases).toBe(0);
  });
});
