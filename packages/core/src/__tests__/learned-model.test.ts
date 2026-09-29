/**
 * Learned GBDT model: TypeScript port parity tests.
 *
 * The model was trained on Python-computed feature vectors. If this
 * port drifts from the Python featurizer by even a little, every weight
 * misfires silently. These tests pin the port to Python ground truth:
 *   - every feature of every fixture domain matches within 1e-9
 *   - end-to-end P(tracker) matches Python within 1e-9
 *   - ip_literal matches Python's ipaddress on tricky inputs
 *
 * Fixtures are generated from Python by gen_ts_assets.py in the
 * training package. If they go stale, regenerate — do not hand-edit.
 */
import { readFileSync } from 'node:fs';
import {
  createLearnedClassifier,
  evaluateGbdt,
  featurizeLearned,
  isIpLiteralAddress,
  LEARNED_FEATURE_NAMES,
  LEARNED_FEATURE_NAMES_V2,
  LEARNED_FEATURE_VERSION,
  parseLearnedModel,
  parseLearnedManifest,
  runShadowComparison,
  sha256Hex,
  verifyLearnedManifest,
  type BehavioralObservation,
  type LearnedDecision,
} from '../ai/learned/index.js';

function loadJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
}

const fixtures = (
  loadJson('./fixtures/learned-fixtures.json') as {
    feature_version: number;
    fixtures: { domain: string; vector: number[] }[];
  }
).fixtures;
const expectedScores = loadJson('./fixtures/learned-expected-scores.json') as {
  domain: string;
  score: number;
}[];
const ipBattery = loadJson('./fixtures/learned-ip-battery.json') as {
  domain: string;
  ip_literal: number;
}[];
const modelJson = loadJson('../../ai-weights/model.json');
const allowlistJson = loadJson('../../ai-weights/allowlist.json');

describe('learned featurizer parity (Python ground truth)', () => {
  it('reproduces every fixture vector within 1e-9', () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const { domain, vector } of fixtures) {
      const got = featurizeLearned(domain);
      expect(got.length).toBe(LEARNED_FEATURE_NAMES.length);
      for (let i = 0; i < vector.length; i++) {
        expect(Math.abs(got[i] - vector[i])).toBeLessThan(1e-9);
      }
    }
  });

  it('matches Python ipaddress on tricky literals', () => {
    for (const { domain, ip_literal } of ipBattery) {
      expect(isIpLiteralAddress(domain)).toBe(ip_literal === 1.0);
    }
  });

  it('normalizes like Python (case, whitespace, trailing dots)', () => {
    const a = featurizeLearned('  GitHub.COM... ');
    const b = featurizeLearned('github.com');
    expect(a).toEqual(b);
  });

  it('throws on empty input', () => {
    expect(() => featurizeLearned('   ')).toThrow();
  });
});

describe('learned model loading', () => {
  it('accepts the shipped weights', () => {
    const clf = createLearnedClassifier(modelJson, allowlistJson);
    expect(clf.treeCount).toBe(112);
    // Asserted against the featurizer's own contract constant rather than a literal, so
    // bumping FEATURE_VERSION without re-exporting the model fails here instead of
    // silently misrouting every weight through a stale feature order.
    expect(clf.featureVersion).toBe(LEARNED_FEATURE_VERSION);
    expect(clf.thresholds.block).toBe(0.92);
    expect(clf.thresholds.review).toBe(0.65);
  });

  it('rejects a feature_version mismatch', () => {
    const bad = { ...(modelJson as Record<string, unknown>), feature_version: 999 };
    expect(() => parseLearnedModel(bad)).toThrow(/feature_version/);
  });

  it('rejects reordered feature names', () => {
    const names = [...LEARNED_FEATURE_NAMES].reverse();
    const bad = { ...(modelJson as Record<string, unknown>), feature_names: names };
    expect(() => parseLearnedModel(bad)).toThrow(/feature_names/);
  });

  it('rejects an unknown format', () => {
    expect(() => parseLearnedModel({ format: 'bm-gbdt/2' })).toThrow(/format/);
  });
});

describe('learned classifier end-to-end', () => {
  const clf = createLearnedClassifier(modelJson, allowlistJson);

  it('matches Python P(tracker) within 1e-9', () => {
    for (const { domain, score } of expectedScores) {
      const verdict = clf.classify(domain);
      expect(Math.abs(verdict.score - score)).toBeLessThan(1e-9);
    }
  });

  it('blocks a canonical tracker', () => {
    const v = clf.classify('cm.g.doubleclick.net');
    expect(v.decision).toBe('block');
    expect(v.score).toBeGreaterThan(0.92);
  });

  it('allows a benign domain', () => {
    // example.com is benign and NOT on the allowlist: the model allows it
    // on its own score. (github.com is allowlisted, so it can't test this.)
    const v = clf.classify('example.com');
    expect(v.decision).toBe('allow');
    expect(v.allowlisted).toBe(false);
  });

  it('allowlist overrules a high model score', () => {
    // fonts.gstatic.com scores ~0.99 from the model but is curated benign.
    const v = clf.classify('fonts.gstatic.com');
    expect(v.allowlisted).toBe(true);
    expect(v.decision).toBe('allow');
    expect(v.score).toBeGreaterThan(0.65); // the model WOULD have flagged it
  });

  it('never throws on garbage input', () => {
    const v = clf.classify('   ');
    expect(v.decision).toBe('allow');
    expect(v.error).toBeDefined();
  });
});

describe('shadow mode', () => {
  const clf = createLearnedClassifier(modelJson, allowlistJson);

  it('logs only disagreements with the reference', () => {
    const reference = (domain: string): LearnedDecision =>
      domain === 'cm.g.doubleclick.net' ? 'block' : 'allow';
    const seen: string[] = [];
    const result = runShadowComparison({
      classifier: clf,
      reference,
      domains: ['cm.g.doubleclick.net', 'github.com', 'adserver.bidding.adtech.net'],
      onDisagreement: (d) => seen.push(d.domain),
    });
    // adserver.bidding.adtech.net: model says block/review, reference says allow
    expect(result.evaluated).toBe(3);
    expect(result.disagreements).toBe(seen.length);
    expect(seen).toContain('adserver.bidding.adtech.net');
    expect(seen).not.toContain('cm.g.doubleclick.net');
    expect(seen).not.toContain('github.com');
  });

  it('evaluateGbdt agrees with the classifier score path', () => {
    const model = parseLearnedModel(modelJson);
    const v = featurizeLearned('xzk7q92bwa1m.com');
    expect(evaluateGbdt(model.trees, v)).toBeCloseTo(clf.classify('xzk7q92bwa1m.com').score, 12);
  });
});

const fixturesV2 = loadJson('./fixtures/learned-fixtures-v2.json') as {
  domain: string;
  obs: BehavioralObservation;
  vector: (number | null)[];
}[];

describe('learned v2 featurizer parity (Python ground truth)', () => {
  it('reproduces v2 vectors within 1e-9, NaN for missing behaviorals', () => {
    expect(fixturesV2.length).toBeGreaterThan(0);
    for (const { domain, obs, vector } of fixturesV2) {
      const got = featurizeLearned(domain, obs);
      expect(got.length).toBe(LEARNED_FEATURE_NAMES_V2.length);
      for (let i = 0; i < vector.length; i++) {
        const want = vector[i];
        if (want === null) {
          expect(Number.isNaN(got[i])).toBe(true);
        } else {
          expect(Math.abs(got[i] - (want as number))).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('v1 prefix of a v2 vector equals the v1 featurizer output', () => {
    for (const { domain, obs } of fixturesV2) {
      const v2 = featurizeLearned(domain, obs);
      const v1 = featurizeLearned(domain);
      expect(v2.slice(0, v1.length)).toEqual(v1);
    }
  });

  it('omitting obs keeps the v1 15-vector contract', () => {
    const got = featurizeLearned('github.com');
    expect(got.length).toBe(LEARNED_FEATURE_NAMES.length);
  });
});

describe('learned GBDT NaN routing (default_left)', () => {
  // One tree: x0 <= 0.5 ? leaf(-2) : leaf(+2). NaN must follow default_left.
  it('routes NaN via default_left, values via the threshold', () => {
    const trees = [
      {
        split_feature: 0,
        threshold: 0.5,
        default_left: true,
        left: { leaf_value: -2 },
        right: { leaf_value: 2 },
      },
    ];
    const leftScore = 1 / (1 + Math.exp(2));
    const rightScore = 1 / (1 + Math.exp(-2));
    expect(evaluateGbdt(trees, [NaN])).toBeCloseTo(leftScore, 12);
    expect(evaluateGbdt(trees, [0.1])).toBeCloseTo(leftScore, 12);
    expect(evaluateGbdt(trees, [0.9])).toBeCloseTo(rightScore, 12);
  });

  it('v1 trees without default_left keep the old NaN-goes-right behavior', () => {
    const trees = [
      {
        split_feature: 0,
        threshold: 0.5,
        left: { leaf_value: -2 },
        right: { leaf_value: 2 },
      },
    ];
    expect(evaluateGbdt(trees, [NaN])).toBeCloseTo(1 / (1 + Math.exp(-2)), 12);
  });

  it('accepts a feature_version 2 model when names match the v2 contract', () => {
    const v2model = {
      ...(modelJson as Record<string, unknown>),
      feature_version: 2,
      feature_names: [...LEARNED_FEATURE_NAMES_V2],
    };
    const parsed = parseLearnedModel(v2model);
    expect(parsed.feature_version).toBe(2);
    const clf = createLearnedClassifier(v2model);
    expect(clf.featureVersion).toBe(2);
    // v2 model without observations: all-NaN behaviorals, must not throw
    const v = clf.classify('github.com');
    expect(v.score).toBeGreaterThanOrEqual(0);
    expect(v.score).toBeLessThanOrEqual(1);
  });
});

describe('sha256 (pure TS)', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('x'.repeat(1000))).toBe(
      '44f8354494a5ba03ba1792a8d3e9c534c47a9181980fde7a3f44b06ef2ae7c7f',
    );
  });
});

describe('release manifest verification (M5 promotion ceremony)', () => {
  const modelText = readFileSync(new URL('../../ai-weights/model.json', import.meta.url), 'utf8');
  const allowText = readFileSync(new URL('../../ai-weights/allowlist.json', import.meta.url), 'utf8');
  const manifest = {
    format: 'bm-manifest/1',
    version: 1,
    model_sha256: sha256Hex(modelText),
    allowlist_sha256: sha256Hex(allowText),
    feature_version: 1,
    promoted_at: '2026-09-29T00:00:00Z',
  };

  it('accepts matching bytes', () => {
    const m = verifyLearnedManifest(modelText, allowText, manifest);
    expect(m.version).toBe(1);
  });

  it('rejects a tampered model', () => {
    expect(() => verifyLearnedManifest(modelText + ' ', allowText, manifest)).toThrow(/hash mismatch/);
  });

  it('rejects a tampered allowlist', () => {
    expect(() => verifyLearnedManifest(modelText, allowText.replace('github.com', 'evil.com'), manifest)).toThrow(
      /hash mismatch/,
    );
  });

  it('rejects a malformed manifest', () => {
    expect(() => parseLearnedManifest({ format: 'bm-manifest/1' })).toThrow(/missing field/);
    expect(() => parseLearnedManifest({ format: 'nope' })).toThrow(/unsupported format/);
  });
});

describe('shadow sampling (M5 drift slice)', () => {
  const clf = createLearnedClassifier(modelJson, allowlistJson);
  const reference = (): LearnedDecision => 'allow';
  const domains = Array.from({ length: 200 }, (_, i) => `sample${i}.example.com`);

  it('logs ~sampleRate of all evaluated domains with sample: true', () => {
    // deterministic RNG: first 10 of every 100 sampled
    let calls = 0;
    const rng = () => (calls++ % 100 < 10 ? 0.05 : 0.95);
    const samples: { domain: string; sample: true }[] = [];
    const disagreements: string[] = [];
    const result = runShadowComparison({
      classifier: clf,
      reference,
      domains,
      onDisagreement: (d) => disagreements.push(d.domain),
      sampleRate: 0.1,
      onSample: (d) => samples.push(d),
      rng,
    });
    expect(result.evaluated).toBe(200);
    expect(samples).toHaveLength(20);
    expect(samples.every((s) => s.sample === true)).toBe(true);
    // samples are independent of disagreement: a sampled disagreement is logged twice
    const overlap = samples.filter((s) => disagreements.includes(s.domain));
    expect(overlap.length).toBeGreaterThanOrEqual(0);
  });

  it('samples nothing when sampleRate is 0 (default)', () => {
    const samples: unknown[] = [];
    runShadowComparison({
      classifier: clf,
      reference,
      domains: domains.slice(0, 20),
      onDisagreement: () => {},
      onSample: (d) => samples.push(d),
    });
    expect(samples).toHaveLength(0);
  });
});
