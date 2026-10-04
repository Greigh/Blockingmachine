/**
 * GENERATED FILE — do not edit by hand.
 *
 * The element classifier's fitted weights, produced by `scripts/fit-element-weights.mjs`
 * from the labelled corpus in `elementEvalCorpus.ts`. Regenerate with:
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

/** How {@link ELEMENT_FITTED_WEIGHTS} was produced, and what it bought and cost. */
export const ELEMENT_FITTED_PROVENANCE: ElementWeightProvenance = {
  "corpusCases": 230,
  "trainingCases": 152,
  "holdoutCases": 78,
  "regularisation": {
    "kind": "none"
  },
  "epochs": 1500,
  "holdout": {
    "baselineAccuracy": 0.8462,
    "fittedAccuracy": 0.9615,
    "baselineLogLoss": 0.6446,
    "fittedLogLoss": 0.254
  },
  "endToEnd": {
    "total": 230,
    "baselineCorrect": 226,
    "fittedCorrect": 226
  },
  "actionCalibration": {
    "baselineEce": 0.0495,
    "fittedEce": 0.065,
    "baselineBrier": 0.0406,
    "fittedBrier": 0.0408
  },
  "largestWeightChange": {
    "feature": "contentText",
    "from": -7,
    "to": -19.8667
  }
};

/** Weight vectors fit from the corpus; see {@link ELEMENT_FITTED_PROVENANCE}. */
export const ELEMENT_FITTED_WEIGHTS: ElementWeightSet = {
  Ad: {
    bias: -1.7331,
    adStrongToken: 2.7455,
    adWeakToken: -0.3119,
    trackerStrongToken: -3,
    trackerWeakToken: -6.978,
    consentStrongMarker: -3.9726,
    consentWeakToken: 4.2364,
    socialStrongMarker: -5.2799,
    socialWeakToken: -7.1388,
    dataAdAttribute: 16.3304,
    dataTrackerAttribute: -1.0047,
    adHostMatch: 11.6916,
    measureHostMatch: -3.8837,
    socialHostMatch: -2,
    urlPathToken: -1.9063,
    thirdPartyFrame: 1.1985,
    cnameCloak: -0.1925,
    passiveSource: 0.1651,
    pixelGeometry: -4.6725,
    adSizeGeometry: 2.0409,
    overlayGeometry: -0.0149,
    lureText: -8.8874,
    antiAdblockText: -2,
    ancestorAd: 4,
    contentText: -19.8667,
    semanticContainer: 2.6753,
    userTuneBias: 5,
  },
  Tracker: {
    bias: -2.0684,
    adStrongToken: -15.3987,
    adWeakToken: -4.1038,
    trackerStrongToken: 13,
    trackerWeakToken: 1.9449,
    consentStrongMarker: -1.0076,
    consentWeakToken: -3.5478,
    socialStrongMarker: -4.6523,
    socialWeakToken: -7.2833,
    dataAdAttribute: -2.9864,
    dataTrackerAttribute: 8.3539,
    adHostMatch: -1.6915,
    measureHostMatch: 14.1047,
    socialHostMatch: -2,
    urlPathToken: 7.645,
    thirdPartyFrame: 0.5049,
    cnameCloak: 7.23,
    passiveSource: 2.0173,
    pixelGeometry: 2.4205,
    adSizeGeometry: -9.4521,
    overlayGeometry: -7.6913,
    lureText: -8.0695,
    antiAdblockText: -2,
    ancestorAd: 3,
    contentText: -10.6722,
    semanticContainer: -15.034,
    userTuneBias: 5,
  },
  Annoyance: {
    bias: -0.8212,
    adStrongToken: -14.3965,
    adWeakToken: 0.8501,
    trackerStrongToken: -3,
    trackerWeakToken: -9.9341,
    consentStrongMarker: 15.8742,
    consentWeakToken: -3.6496,
    socialStrongMarker: 11.8194,
    socialWeakToken: 0.7016,
    dataAdAttribute: -4.4921,
    dataTrackerAttribute: -1.0146,
    adHostMatch: -8.5457,
    measureHostMatch: -3.1902,
    socialHostMatch: 8,
    urlPathToken: -0.3005,
    thirdPartyFrame: 8.0545,
    cnameCloak: -2.9193,
    passiveSource: -7.9073,
    pixelGeometry: 2.451,
    adSizeGeometry: -2.1855,
    overlayGeometry: 3.0701,
    lureText: 5.8764,
    antiAdblockText: 11,
    ancestorAd: 1,
    contentText: 4.8882,
    semanticContainer: -1.1252,
    userTuneBias: 5,
  },
  Content: {
    bias: 0.7607,
    adStrongToken: -0.7452,
    adWeakToken: -1.0948,
    trackerStrongToken: -8,
    trackerWeakToken: 0.1721,
    consentStrongMarker: -9.9487,
    consentWeakToken: 4.4602,
    socialStrongMarker: -8.2852,
    socialWeakToken: -0.1949,
    dataAdAttribute: -10.0292,
    dataTrackerAttribute: -6.3473,
    adHostMatch: -11.5417,
    measureHostMatch: -9.0836,
    socialHostMatch: -6,
    urlPathToken: -8.182,
    thirdPartyFrame: 0.4899,
    cnameCloak: -6.492,
    passiveSource: 0.5529,
    pixelGeometry: -0.7435,
    adSizeGeometry: -0.7587,
    overlayGeometry: 0.366,
    lureText: -3.8646,
    antiAdblockText: -8,
    ancestorAd: -3,
    contentText: 5.1185,
    semanticContainer: -0.6376,
    userTuneBias: -5,
  },
};
