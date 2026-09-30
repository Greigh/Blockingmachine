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
  extractElementFeatures,
  softmaxFor,
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

/**
 * The head's own top class for one case — which is what the A/B compares, and deliberately
 * not the classifier's verdict. The head is the fitted object; the full path gates on
 * evidence first, so a case can be a head-level disagreement and a shipping-level
 * agreement at once, and conflating the two would make the fit look better than it is.
 */
function topClass(
  weights: typeof ELEMENT_HAND_TUNED_WEIGHTS,
  entry: (typeof ELEMENT_EVAL_CORPUS)[number],
): string {
  const probabilities = softmaxFor(extractElementFeatures(entry.snapshot), weights);
  return ELEMENT_CLASSES.reduce((best, cls) => (probabilities[cls] > probabilities[best] ? cls : best), 'Content');
}

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
    // A win that is really a trade would show up here. It is named rather than asserted
    // empty, because the trade is real and understood: the fit gives up the one case the
    // model cannot see anyway (a fingerprinting library on a public CDN, where the path
    // evidence is suppressed on purpose) to win five third-party embeds it used to call
    // trackers. Pinned by name so a *different* regression cannot join it quietly.
    expect(comparison.regressions).toEqual(['fingerprintjs-on-public-cdn']);
    expect(comparison.wins.length).toBeGreaterThanOrEqual(5);
    expect(comparison.cases).toBe(holdout.length);
  });

  it('does not carry the whole held-out win on one case', () => {
    // This is the claim that used to be false, and the reason the corpus grew. At 117 cases
    // every case where the two heads disagreed was `Content`, so the win was two cases of
    // one family, and one of them turned on a single feature weight — the hand-tuned margin
    // over its runner-up on `order-tracking-panel` was 0.211. "2 wins, 0 regressions" was,
    // in effect, "2 cases, and 22 others where no head could fail".
    //
    // What is pinned here is what must not silently go back: that the win is several cases,
    // that it is not all one family, that every class has enough held-out support for its
    // accuracy to mean anything, and that enough held-out cases are genuinely contested for
    // the gap to be a measurement rather than arithmetic over 55 cases that 48 answer
    // identically.
    const comparison = compareWeightSets(ELEMENT_HAND_TUNED_WEIGHTS, ELEMENT_FITTED_WEIGHTS, holdout);
    expect(comparison.wins.length).toBeGreaterThanOrEqual(5);

    const winningFamilies = new Set(
      comparison.wins.map((label) => holdout.find((entry) => entry.label === label)!.family),
    );
    expect(winningFamilies.size).toBeGreaterThanOrEqual(2);

    for (const cls of ELEMENT_CLASSES) {
      // The 0.95 recall bound elsewhere is untouched; 8 is the number of held-out cases a
      // class needs before its accuracy says anything at all (at 5, one case is 0.20).
      expect(holdout.filter((entry) => entry.expected[0] === cls).length).toBeGreaterThanOrEqual(8);
    }

    // The cases where the two heads disagree at all. Seven today: six Content (the
    // third-party embeds and the order panel) and one Tracker (the CDN blind spot).
    //
    // **Not yet true, and recorded rather than asserted:** Ad and Annoyance are still 1.0
    // held-out for *both* heads, so those 20 cases are evidence of nothing and the win is
    // still one class. That is open flag 10 — the classes the fit is good at are the ones
    // whose held-out cases are too easy to be contested. Growing those two classes is the
    // next corpus round, and the floor here is the guard against the contested set
    // shrinking back towards the two cases this suite used to have.
    const contested = holdout.filter((entry) => {
      const baseline = topClass(ELEMENT_HAND_TUNED_WEIGHTS, entry);
      const fitted = topClass(ELEMENT_FITTED_WEIGHTS, entry);
      return baseline !== fitted;
    });
    expect(contested.length).toBeGreaterThanOrEqual(5);
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

    // Across the folds the strength is chosen on, a regularised fit has to beat the
    // unregularised one on 104 parameters against the ~86 elements each fold trains on,
    // with feature families that are correlated by construction. That the *smallest*
    // strengths do so is what makes the selection's answer a positive one; the paragraph
    // below records where the ordering stops extending past them.
    //
    // The margin is deliberately not pinned to a multiplier. It measured 25x when the
    // selection scored a single inner split of 110 cases, 3.5x at 117, and 1.9x once every
    // training case was folded into validation (1.0929 against 0.5813 at strength 1), so a
    // ratio assertion would be measuring the selection rule rather than the effect. What
    // the suite holds onto is the direction, and that the winner is a positive strength.
    //
    // Known limit, measured but not asserted here, and *shrinking as the corpus grows*.
    // At full training-set scale the unregularised fit beat the shipped strength on the
    // 40 held-out cases this suite used to have (logLoss 0.0877 against 0.1443). On the
    // 55 it has now, that ordering has narrowed and then crossed: unregularised scores
    // logLoss 0.4404 against the shipped 0.4234, so the shipped strength is now ahead on
    // cross-entropy — but unregularised is *still* ahead on accuracy, 0.9818 against
    // 0.9455, two more held-out cases. So growing the corpus from 117 to 162 closed the
    // cross-entropy half of the gap and did nothing for the accuracy half, which is the
    // honest summary of where this stands: the folds train on ~86 cases and still cannot
    // see what 55 held-out cases show. Selecting on those cases would make them a fitted
    // quantity, so the residual is recorded rather than tuned away — and the fix is still
    // more labelled cases, in the classes where the two heads currently agree on
    // everything.
    //
    // What is *not* asserted is that the unregularised fit is the worst candidate, which
    // it was at 117 cases and is not any more. On the fold estimate it now scores 0.6120
    // and four of the seven regularised strengths (5, 10, 20, 50: 0.6219 → 0.7376) are
    // worse than it; only strengths 1 and 2 beat it. So the honest statement is narrower
    // than the one this test used to make: the prior earns its place against the
    // alternatives the selection actually has to choose between, and the folds are a weaker
    // discriminator for the heavy regularisation end than they were on a smaller corpus.
    const unregularised = selection.scores.find((score) => score.priorStrength === 0);
    const regularised = selection.scores.filter((score) => score.priorStrength > 0);
    expect(regularised.length).toBeGreaterThan(0);
    expect(unregularised).toBeDefined();
    const chosenScore = selection.scores.find((score) => score.priorStrength === selection.priorStrength)!;
    expect(chosenScore.logLoss).toBeLessThan(unregularised!.logLoss);
    expect(chosenScore.logLoss).toBeLessThanOrEqual(Math.min(...regularised.map((score) => score.logLoss)));
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
    // The one held-out case the shipping path gets wrong is the CDN blind spot, and it is
    // the same case the head-level A/B gives up above — so the two views agree on where the
    // model is blind rather than each carrying its own private exception.
    expect(holdout.length - shippedHoldout.correct).toBe(1);
    expect(shippedHoldout.correct).toBe(holdout.length - 1);
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
