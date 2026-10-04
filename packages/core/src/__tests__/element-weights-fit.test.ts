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

import { describe, expect, it } from '@jest/globals';
import {
  ELEMENT_CLASSES,
  ELEMENT_HAND_TUNED_WEIGHTS,
  ELEMENT_MODEL_WEIGHTS,
  MiniAiElementClassifier,
  extractElementFeatures,
  softmaxFor,
  type ElementClass,
} from '../ai/elementClassifier.js';
import { ELEMENT_EVAL_CORPUS } from '../ai/elementEvalCorpus.js';
import { evaluateElementClassifier } from '../ai/elementEvaluation.js';
import type { ElementMisclassifiedCase } from '../ai/elementEvaluation.js';
import { ELEMENT_FITTED_PROVENANCE, ELEMENT_FITTED_WEIGHTS } from '../ai/elementWeights.generated.js';
import {
  ELEMENT_FEATURE_ORDER,
  ELEMENT_REGULARISATION_GRID,
  compareWeightSets,
  elementTargets,
  fitElementWeights,
  formatRegularisation,
  largestWeightChange,
  selectRegularisation,
  splitElementCorpus,
  weightSetActionCalibration,
  weightSetMetrics,
} from '../ai/elementWeightFitting.js';
import type { ElementRegularisation, ElementWeightFitOptions } from '../ai/elementWeightFitting.js';

const EPOCHS = ELEMENT_FITTED_PROVENANCE.epochs;
const { train, holdout } = splitElementCorpus();

/** The fit options a provenance record describes — how the shipped table was regularised. */
function fitOptionsFromProvenance(): Pick<ElementWeightFitOptions, 'priorStrength' | 'earlyStop'> {
  const reg = ELEMENT_FITTED_PROVENANCE.regularisation;
  if (reg.kind === 'prior') return { priorStrength: reg.strength };
  if (reg.kind === 'early-stop') return { priorStrength: 0, earlyStop: {} };
  return { priorStrength: 0 };
}

/**
 * `weightSetMetrics` reports to four decimals, so two accuracies that are the same count
 * out of the same total can still differ in the printed number (70/76 is 0.921052... and
 * prints as 0.9211). Anything that reasons about a metric as a fraction therefore has to
 * carry a tolerance. Half a unit in the last place is the tightest honest one, and it is
 * still three orders of magnitude below one case's worth of accuracy on 76 cases.
 */
const REPORTED_PRECISION = 1e-4;

/**
 * The head's own top class for one case — which is what the A/B compares, and deliberately
 * not the classifier's verdict. The head is the fitted object; the full path gates on
 * evidence first, so a case can be a head-level disagreement and a shipping-level
 * agreement at once, and conflating the two would make the fit look better than it is.
 */
function topClass(
  weights: typeof ELEMENT_HAND_TUNED_WEIGHTS,
  entry: (typeof ELEMENT_EVAL_CORPUS)[number],
): ElementClass {
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
      ...fitOptionsFromProvenance(),
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
    // There is one trade left. On 55 held-out cases this suite used to pin exactly one
    // regression — `fingerprintjs-on-public-cdn`, where the path evidence is suppressed on
    // purpose — in exchange for five wins. Flag 10 then wrote two held-out cases that sit
    // between classes precisely so the classes the fit is best at stop being unmeasurable,
    // and both landed here as named regressions. Flag 9's fit resolved one of them: the
    // head now reads `hidden-third-party-frame` as Tracker like the hand-tuned table does
    // — its remaining blindness is in the evidence gate above the head, pinned in the
    // evaluation suite as a missed hide. `offsite-creative-img` is the named regression
    // that is left. The name is pinned rather than the count, so a *second* regression
    // cannot arrive quietly inside an allowlist that only checks size.
    expect(comparison.regressions.slice().sort()).toEqual(['offsite-creative-img']);
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

    // The cases where the two heads disagree at all: eleven today — the ten wins above
    // plus the one remaining flag-10 regression. The families are wider than one
    // (`media`, `content`, `pixel`, `ad-container`), and the embeds are still the reason
    // the fit is not merely "prefer Content harder".
    const contested = holdout.filter((entry) => {
      const baseline = topClass(ELEMENT_HAND_TUNED_WEIGHTS, entry);
      const fitted = topClass(ELEMENT_FITTED_WEIGHTS, entry);
      return baseline !== fitted;
    });
    expect(contested.length).toBeGreaterThanOrEqual(7);
    expect(new Set(contested.map((entry) => entry.family)).size).toBeGreaterThanOrEqual(3);

    // **Flag 10, landed; flag 9, half-landed:** Ad contributes its contested case and it
    // still goes the hand-tuned table's way — `offsite-creative-img` is the named
    // regression above. Tracker now has *no* held-out head-level miss: flag 9's fit reads
    // `hidden-third-party-frame` as Tracker. Its residual blindness lives in the evidence
    // gate the head never reaches — the classifier still cannot act on it — and that is
    // pinned in the evaluation suite's missed-hide list, not here. What is pinned is not
    // "the classes are contested" but *which cases* contest them: a contested case
    // arriving in either class — or `offsite-creative-img` silently resolving — fails here
    // and forces the comparison to be re-read.
    const missedAd = holdout.filter(
      (entry) => entry.expected[0] === 'Ad' && !entry.expected.includes(topClass(ELEMENT_FITTED_WEIGHTS, entry)),
    ).map((entry) => entry.label);
    const missedTracker = holdout.filter(
      (entry) => entry.expected[0] === 'Tracker' && !entry.expected.includes(topClass(ELEMENT_FITTED_WEIGHTS, entry)),
    ).map((entry) => entry.label);
    expect(missedAd).toEqual(['offsite-creative-img']);
    expect(missedTracker).toEqual([]);
  });

  it('does not depend on the one prior strength that was selected', () => {
    // The sweep that chose the prior could be doing the work. Re-fit across the whole grid
    // and require the improvement to survive all of it — including the strongest prior,
    // where the fit is closest to the baseline it has to beat.
    const baseline = weightSetMetrics(ELEMENT_HAND_TUNED_WEIGHTS, holdout, 'hand-tuned');
    const grid = [1, 2, 3, 5, 8, 10, 20, 50];

    // The response surface is not monotone in prior strength, and where it bends has moved
    // again. Every grid point still beats the hand-tuned baseline on *both* proper scoring
    // rules, so cross-entropy needs no exception at all. What is left is accuracy: flag 9's
    // corpus moved the baseline to 66 of 78 (0.8462), and the middle of the grid dips below
    // it by named amounts while still beating it on cross-entropy and Brier. Strengths 1
    // and 2 are *ahead* outright (72 of 78), 3 and 5 stay ahead (68 and 67), 8 and 20
    // recover to a tie, and 50 comes back ahead — the surface dips hardest at strength 10,
    // which is the only grid point that now loses a held-out case net, which is why the
    // claim is written as a named set rather than a range.
    //
    // Named by strength *and* by the exact case shortfall, so a case deeper at any of them,
    // a shortfall at a strength not listed, or a listed strength silently recovering all
    // fail here. A sweep reported as uniform would be hiding this; the floor that carries
    // the claim is that no grid point may lose more held-out cases than listed.
    const accuracyShortfalls = new Map([[10, 1]]);

    let shortfallStrengths = 0;
    for (const priorStrength of grid) {
      const fit = fitElementWeights({ cases: train, priorStrength, epochs: EPOCHS });
      const metrics = weightSetMetrics(fit.weights, holdout, `prior=${priorStrength}`);
      expect(metrics.logLoss).toBeLessThan(baseline.logLoss);
      expect(metrics.brier).toBeLessThan(baseline.brier);

      const shortfall = baseline.accuracy - metrics.accuracy;
      if (shortfall > 0) {
        shortfallStrengths += 1;
        // Expressed in cases, not in accuracy: held-out accuracy is a multiple of 1/76, and
        // a shortfall that is not would mean the comparison was measuring something else.
        // The tolerance absorbs the four decimals the metrics are reported to.
        expect(Math.abs(shortfall - (accuracyShortfalls.get(priorStrength) ?? 0) / holdout.length)).toBeLessThan(
          REPORTED_PRECISION,
        );
      } else {
        expect(shortfall).toBeLessThanOrEqual(0);
      }
    }
    // Both directions of drift: a strength that starts failing cannot join quietly, and a
    // listed one that starts passing cannot quietly stop being the exception it is named as.
    expect(shortfallStrengths).toBe(accuracyShortfalls.size);
  });

  it('selects the regularisation on the training split, against a challenger kind', () => {
    const selection = selectRegularisation({ cases: train, epochs: EPOCHS });
    const scoreOf = (candidate: ElementRegularisation) =>
      selection.scores.find(
        (score) => formatRegularisation(score.regularisation) === formatRegularisation(candidate),
      );
    expect(selection.regularisation).toEqual(ELEMENT_FITTED_PROVENANCE.regularisation);
    // And the shipped choice is a member of the grid the suite scores — a regularisation
    // the fold machinery never measured cannot quietly be the provenance's answer.
    expect(
      ELEMENT_REGULARISATION_GRID.some(
        (candidate) => formatRegularisation(candidate) === formatRegularisation(selection.regularisation),
      ),
    ).toBe(true);

    // The grid is a kind-level choice, not only a strength-level one: flag 12's charge was
    // that the prior shipped unevidenced because it had never faced a different mechanism.
    // `none` and `early-stop` are pinned present so the grid cannot shrink back to a
    // prior-only sweep without this test noticing.
    expect(scoreOf({ kind: 'none' })).toBeDefined();
    const earlyStop = scoreOf({ kind: 'early-stop' });
    expect(earlyStop).toBeDefined();

    // Flag 9's corpus moved the answer the folds give. Through flag 14 a regularised fit
    // always won this selection — a regulariser had to beat the unregularised head on 104
    // parameters against the ~116 elements each fold trains on, with feature families
    // correlated by construction — and `prior:1` did, by a margin that shrank corpus round
    // over corpus round (25x, 3.5x, 1.9x, 1.11x, 1.09x). At 230 cases the margin inverted:
    // `none` now leads the folds outright (0.7721 against early stopping's 0.8843 and
    // prior:1's 0.9330), which is the measured answer, not the assumed one — the selection
    // machinery did not change, the evidence did. What stays pinned is the ordering itself:
    // the chosen candidate is the fold minimum, early stopping is the strongest regularised
    // challenger, and every prior strength trails it. If a later corpus makes a regulariser
    // win again, the provenance assertion above fails loudly instead of the shipped kind
    // changing quietly.
    const unregularised = scoreOf({ kind: 'none' });
    const chosenScore = scoreOf(selection.regularisation)!;
    expect(chosenScore.regularisation).toEqual({ kind: 'none' });
    expect(chosenScore.logLoss).toBeLessThanOrEqual(Math.min(...selection.scores.map((score) => score.logLoss)));
    // The challenger's half of the pin: early stopping is a real regulariser and the
    // measured runner-up — ahead of every prior strength, behind only the bare fit.
    expect(earlyStop!.logLoss).toBeGreaterThan(unregularised!.logLoss);
    for (const score of selection.scores) {
      if (score.regularisation.kind === 'prior') {
        expect(score.logLoss).toBeGreaterThanOrEqual(earlyStop!.logLoss);
      }
    }
    // What the choice buys and costs, measured in the `what the prior would have bought`
    // block below:
    // the unregularised head is ahead of prior:1 on all three held-out metrics, and the
    // calibration cost of that sharpness is recorded in `actionCalibration` — neither side
    // of the trade is selected on the cases that measure it.
  });

  it('does not change the decision the product makes', () => {
    const shipped = evaluateElementClassifier(new MiniAiElementClassifier(), [...ELEMENT_EVAL_CORPUS]);
    const reference = evaluateElementClassifier(
      new MiniAiElementClassifier({ weights: ELEMENT_HAND_TUNED_WEIGHTS }),
      [...ELEMENT_EVAL_CORPUS],
    );

    expect(shipped.correct).toBe(reference.correct);
    // Flag 9's fit introduced exactly one action-level divergence from the hand-tuned head:
    // `no-ads-subscription-cta` moves leave → suggest. The named-case pin is the claim —
    // a second silent divergence fails here rather than hiding inside an aggregate count.
    const diverged = [...ELEMENT_EVAL_CORPUS]
      .filter((entry) => {
        const ship = new MiniAiElementClassifier().classify(entry.snapshot).action;
        const ref = new MiniAiElementClassifier({ weights: ELEMENT_HAND_TUNED_WEIGHTS }).classify(entry.snapshot).action;
        return ship !== ref;
      })
      .map((entry) => entry.label);
    expect(diverged).toEqual(['no-ads-subscription-cta']);
    expect(shipped.actionMix).toEqual({
      ...reference.actionMix,
      leave: reference.actionMix.leave - 1,
      suggest: reference.actionMix.suggest + 1,
    });

    // The safety lists are compared against the hand-tuned head *and* against empty:
    // flag 14's fix made a disclosure word prove third-party money before it hides, so
    // `sponsored-story-300x250` and `first-party-advert-label` are destroyed content on
    // neither head. What the comparisons own is that the fit introduces no decision the
    // baseline did not already make.
    const labels = (cases: ElementMisclassifiedCase[]) => cases.map((entry) => entry.label).sort();
    expect(labels(shipped.safety.destroyedContent)).toEqual(labels(reference.safety.destroyedContent));
    expect(labels(shipped.safety.missedHides)).toEqual(labels(reference.safety.missedHides));
    expect(labels(shipped.safety.undersoldHides)).toEqual(labels(reference.safety.undersoldHides));
    // These two are absolute rather than comparative: a verdict must always name the class
    // it hides under, and must always have a reason.
    expect(shipped.safety.mislabelledHides).toEqual([]);
    expect(shipped.safety.unexplainedHides).toEqual([]);

    // ...and the named state of the comparative three, so the equality above cannot be
    // satisfied by both heads degrading in step. `destroyedContent` is empty for both.
    expect(labels(shipped.safety.destroyedContent)).toEqual([]);
    // Flag 9's CNAME and resource-path evidence resolved `heatmap-cursor-tracker` and
    // `own-error-tracking-beacon` as missed hides; the three that remain are the same on
    // both heads.
    expect(labels(shipped.safety.missedHides)).toEqual([
      'hidden-third-party-frame',
      'offsite-creative-img',
      'outstream-video-ad',
    ]);
    expect(labels(shipped.safety.undersoldHides)).toEqual(['newsletter-slidein-edge', 'push-notification-optin']);

    // Held-out end to end, not just on the head: the cases the fit never saw are still
    // decided the same way through the full evidence path.
    const shippedHoldout = evaluateElementClassifier(new MiniAiElementClassifier(), holdout);
    const referenceHoldout = evaluateElementClassifier(
      new MiniAiElementClassifier({ weights: ELEMENT_HAND_TUNED_WEIGHTS }),
      holdout,
    );
    expect(shippedHoldout.correct).toBe(referenceHoldout.correct);
    // One held-out case the shipping path gets wrong, and it is the same one for the
    // hand-tuned table — so the two views agree on where the model is blind rather than
    // each carrying its own private exception. Flag 9's evidence families resolved the
    // first-party-measurement trio (`ad-server-cookie-sync`, `fingerprint-vendor-on-own-cdn`,
    // `own-error-tracking-beacon`), `first-party-ad-break`, and the *class* of
    // `hidden-third-party-frame` — it is still a missed hide in the action mix, pinned in
    // the list above. `offsite-creative-img` alone goes unread end to end.
    expect(holdout.length - shippedHoldout.correct).toBe(1);
    expect(holdout.length - referenceHoldout.correct).toBe(1);
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

    // Flag 9's corpus made the trade legible rather than rounding-scale: the nine new
    // suggest-banded tracker cases sit in the mid-confidence bins where ECE is most
    // sensitive, and the measured cost is +0.0155 (recorded in the provenance and mirrored
    // in the evaluation suite's regression margin). The bound stays above that measurement
    // so the trade is asserted rather than assumed — a re-fit that costs still more fails.
    expect(provenance.actionCalibration.fittedEce - provenance.actionCalibration.baselineEce).toBeLessThan(0.02);
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

describe('early stopping, the regulariser the prior had to beat', () => {
  it('halts on a validation stall and ships the best checkpoint it saw', () => {
    const fit = fitElementWeights({ cases: train, priorStrength: 0, earlyStop: {}, epochs: EPOCHS });
    const fullRun = fitElementWeights({ cases: train, priorStrength: 0, epochs: EPOCHS });

    // The stopping point is a checkpoint index, not just "somewhere before the end":
    // every check happens at a multiple of `every` epochs (or the un-stepped start), so
    // the shipped weights can only ever come from a point the validation slice actually
    // scored — never from mid-stall drift.
    expect(fit.stoppedAtEpoch).toBeDefined();
    expect(fit.stoppedAtEpoch! % 25).toBe(0);
    expect(fit.stoppedAtEpoch).toBeLessThanOrEqual(EPOCHS);
    // A checkpoint that halts early ships different weights than letting the unregularised
    // fit run to completion — that is the entire regularisation claim, so it is asserted
    // rather than implied.
    expect(fit.weights).not.toEqual(fullRun.weights);
  });

  it('is deterministic — the split, the cadence and the checkpoint are all fixed', () => {
    const options = { cases: train, priorStrength: 0, earlyStop: {}, epochs: 200 } as const;
    const first = fitElementWeights(options);
    const second = fitElementWeights(options);
    expect(first.weights).toEqual(second.weights);
    expect(first.stoppedAtEpoch).toBe(second.stoppedAtEpoch);
  });

  it('never trains on the cases that decide when to stop', () => {
    const fit = fitElementWeights({ cases: train, priorStrength: 0, earlyStop: {}, epochs: 50 });
    // The default carve is the corpus's own stride split: ~a fifth stratified by class,
    // removed from `examples` before fitting. If the monitored slice leaked into training
    // the counts would not add up — this is the pin that makes the nesting a fact rather
    // than a comment.
    expect(fit.validationCases).toBeGreaterThan(0);
    expect(fit.examples).toBe(train.length - fit.validationCases!);

    // An explicit validation set is filtered out of the fitted cases the same way, so a
    // caller cannot hand it cases it also trains on.
    const explicit = train.slice(0, 10);
    const withExplicit = fitElementWeights({
      cases: train,
      priorStrength: 0,
      earlyStop: { validation: explicit },
      epochs: 50,
    });
    expect(withExplicit.validationCases).toBe(explicit.length);
    expect(withExplicit.examples).toBe(train.length - explicit.length);
  });
});

/**
 * What the prior would have bought, measured rather than asserted in a comment.
 *
 * Flag 9's corpus ended the prior's tenure: the fold selection now hands the table to the
 * unregularised fit outright, so the shipped head *is* the bare fit and the meaningful
 * comparison is against the strongest shrinkage candidate the grid offers — `prior:1`,
 * the strength that shipped for three corpus rounds.
 *
 * On 78 held-out cases the measurement comes out against the prior on every axis it was
 * introduced to move:
 *
 *  - **Accuracy** — 75 of 78 unregularised against 72 of 78 with prior:1; all three of the
 *    cases that separate them go the bare head's way.
 *  - **Cross-entropy** — 0.2623 against 0.2905.
 *  - **Brier** — 0.1085 against 0.1138.
 *  - **The tail** — the prior was introduced to stop the head falling to the probability
 *    floor on a case it had not seen. On this holdout the unregularised head's deepest
 *    accepted-probability case is 0.1605 — nothing reaches the floor — while the prior:1
 *    fit itself puts `app-install-banner` at 0.0488.
 *
 * What the prior does still buy, recorded so the block is not only negative: it puts more
 * probability on the accepted labels on average (0.8615 against 0.8209), which is the
 * conservative behaviour a prior is for. It pays for that with three held-out Content
 * cases read as threats.
 *
 * The motivation for measuring the tail at all is that a model gating blocking cannot
 * afford a confident mistake. If the head says "Ad, 99% sure" about a 300×250 hero image,
 * something the user is looking at disappears because a table memorised a feature
 * combination, and the corpus cannot catch that, because the mistake is only visible on
 * the case the fit never saw.
 */
describe('what the prior would have bought, had the folds chosen it', () => {
  const strongestPrior = () =>
    fitElementWeights({ cases: train, priorStrength: 1, epochs: EPOCHS }).weights;

  /** Probability the head puts on the classes the case accepts. */
  function acceptedProbability(
    weights: typeof ELEMENT_HAND_TUNED_WEIGHTS,
    entry: (typeof ELEMENT_EVAL_CORPUS)[number],
  ): number {
    const probabilities = softmaxFor(extractElementFeatures(entry.snapshot), weights);
    return entry.expected.reduce((sum, cls) => sum + (probabilities[cls] ?? 0), 0) / entry.expected.length;
  }

  it('does not reach the probability floor — and the prior fit does', () => {
    // One fit, hoisted: `strongestPrior()` is a full 1500-epoch fit, and calling it per
    // case turned this assertion into ten seconds of test time.
    const priorWeights = strongestPrior();
    const shipped = holdout.map((entry) => acceptedProbability(ELEMENT_FITTED_WEIGHTS, entry));
    const prior = holdout.map((entry) => acceptedProbability(priorWeights, entry));

    // The failure mode the prior existed to prevent did not occur in the unregularised
    // fit on this corpus: its deepest held-out accepted-probability case is 0.1605, and
    // no case falls below a tenth of the accepted mass. The prior:1 fit, meanwhile, puts
    // `app-install-banner` at 0.0488 — the shrinkage that was supposed to protect the tail
    // manufactures the nearest thing to a floor case either head has.
    const below = (values: number[]) =>
      holdout.filter((_, index) => values[index] < 0.1).map((entry) => entry.label).sort();
    expect(Math.min(...shipped)).toBeGreaterThan(0.1);
    expect(below(shipped)).toEqual([]);
    expect(below(prior)).toEqual(['app-install-banner']);

    // The prior's honest half: it puts more of its probability on the accepted labels on
    // average (0.8615 against 0.8209) — the conservative behaviour a prior is for. What it
    // costs is the next test.
    expect(weightSetMetrics(priorWeights, holdout, 'prior:1').acceptedProbability).toBeGreaterThan(
      weightSetMetrics(ELEMENT_FITTED_WEIGHTS, holdout, 'shipped').acceptedProbability,
    );
  });

  it('is behind the unregularised head on all three metrics', () => {
    const prior = strongestPrior();
    const shippedMetrics = weightSetMetrics(ELEMENT_FITTED_WEIGHTS, holdout, 'shipped');
    const priorMetrics = weightSetMetrics(prior, holdout, 'prior:1');

    // 75 of 78 against 72 of 78: the tie the previous corpus produced is broken, and in
    // the direction the folds called it.
    expect(shippedMetrics.accuracy).toBeGreaterThan(priorMetrics.accuracy);
    expect(Math.abs(shippedMetrics.accuracy - 75 / 78)).toBeLessThan(REPORTED_PRECISION);
    // Cross-entropy and Brier agree rather than splitting the decision.
    expect(shippedMetrics.logLoss).toBeLessThan(priorMetrics.logLoss);
    expect(shippedMetrics.brier).toBeLessThan(priorMetrics.brier);
  });

  it('separates the two heads on three content cases, all going to the unregularised head', () => {
    const prior = strongestPrior();
    const contested = (weights: typeof ELEMENT_HAND_TUNED_WEIGHTS, against: typeof ELEMENT_HAND_TUNED_WEIGHTS) =>
      holdout
        .filter((entry) => {
          const theirs = topClass(weights, entry);
          const ours = topClass(against, entry);
          return entry.expected.includes(theirs) && !entry.expected.includes(ours);
        })
        .map((entry) => entry.label)
        .sort();

    // 3.8% of the held-out set, one family — `content` — and the prior:1 head calls all
    // three of them threats (Annoyance, Tracker, Ad). The shrinkage that was meant to make
    // borderline calls safer is what misreads them here.
    expect(contested(ELEMENT_FITTED_WEIGHTS, prior)).toEqual([
      'cookie-settings-button-footer',
      'order-tracking-panel',
      'video-poster-300x250',
    ]);
    expect(contested(prior, ELEMENT_FITTED_WEIGHTS)).toEqual([]);
    expect(
      holdout.filter((entry) => topClass(prior, entry) !== topClass(ELEMENT_FITTED_WEIGHTS, entry)).map((e) => e.family),
    ).toEqual(['content', 'content', 'content']);
    // 75 of the 78 held-out cases cannot tell the two tables apart at all. That is the
    // number to keep in mind when reading the metrics above: the holdout is large enough
    // to make them stable and still too small to make them decisive.
    expect(holdout.length - 3).toBe(75);
  });
});
