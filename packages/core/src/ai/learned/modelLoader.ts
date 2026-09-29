/**
 * Loader + classifier for the learned GBDT weights.
 *
 * Takes PARSED JSON (dependency-injected) so the caller decides where
 * the bytes come from: ai-weights/ on disk in Electron/Node, a bundled
 * import in the browser extension later. Validates the artifact before
 * any weight is trusted:
 *   - format must be "bm-gbdt/1"
 *   - feature_version must equal the featurizer's LEARNED_FEATURE_VERSION
 *   - feature_names must equal LEARNED_FEATURE_NAMES in order
 *     (a reordered list would silently misroute every weight)
 *
 * Decision semantics: the allowlist is checked BEFORE scoring — the
 * model never overrules a curated allow entry (same philosophy as the
 * @@ whitelist rules). Thresholds come from the artifact but are
 * initial values; shadow-mode data tunes them.
 *
 * Feature versions: the loader accepts feature_version 1 (lexical only)
 * or 2 (lexical + behavioral observations) and validates feature_names
 * against the matching contract list. A v2 model scored without
 * observations gets all-NaN behavioral features — LightGBM's missing
 * direction handles that, exactly like the Python v2 featurizer.
 */
import { evaluateGbdt, type GbdtModelFile } from './gbdt.js';
import {
  LEARNED_FEATURE_NAMES,
  LEARNED_FEATURE_NAMES_V2,
} from './featureSpec.js';
import {
  featurizeLearned,
  normalizeLearnedDomain,
  type BehavioralObservation,
} from './featurizer.js';

export type LearnedDecision = 'allow' | 'review' | 'block';

export interface LearnedVerdict {
  domain: string;
  /** P(tracker) in [0, 1]. */
  score: number;
  decision: LearnedDecision;
  /** True when the allowlist decided, regardless of score. */
  allowlisted: boolean;
  /** Set when featurization failed; decision falls back to allow. */
  error?: string;
}

export interface LearnedThresholds {
  block: number;
  review: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate a parsed model.json. Throws a descriptive error. */
export function parseLearnedModel(json: unknown): GbdtModelFile {
  if (!isRecord(json)) throw new Error('learned model: not a JSON object');
  if (json['format'] !== 'bm-gbdt/1') {
    throw new Error(`learned model: unsupported format ${JSON.stringify(json['format'])}`);
  }
  const version = json['feature_version'];
  const expectedNames =
    version === 1 ? LEARNED_FEATURE_NAMES
    : version === 2 ? LEARNED_FEATURE_NAMES_V2
    : null;
  if (expectedNames === null) {
    throw new Error(
      `learned model: unsupported feature_version ${JSON.stringify(version)}; ` +
        'regenerate the port',
    );
  }
  const names = json['feature_names'];
  if (
    !Array.isArray(names) ||
    names.length !== expectedNames.length ||
    !names.every((n, i) => n === expectedNames[i])
  ) {
    throw new Error(
      `learned model: feature_names do not match the v${version} featurizer contract`,
    );
  }
  const trees = json['trees'];
  if (!Array.isArray(trees) || trees.length === 0) {
    throw new Error('learned model: no trees');
  }
  const thresholds = json['thresholds'];
  if (
    !isRecord(thresholds) ||
    typeof thresholds['block'] !== 'number' ||
    typeof thresholds['review'] !== 'number' ||
    !(thresholds['review'] < thresholds['block'])
  ) {
    throw new Error('learned model: invalid thresholds');
  }
  return json as unknown as GbdtModelFile;
}

export interface LearnedAllowlistFile {
  format: 'bm-allowlist/1';
  domains: string[];
}

/** Parse a parsed allowlist.json into a lookup set. Throws on bad input. */
export function parseLearnedAllowlist(json: unknown): Set<string> {
  if (!isRecord(json)) throw new Error('learned allowlist: not a JSON object');
  if (json['format'] !== 'bm-allowlist/1') {
    throw new Error(`learned allowlist: unsupported format ${JSON.stringify(json['format'])}`);
  }
  if (!Array.isArray(json['domains'])) {
    throw new Error('learned allowlist: domains is not an array');
  }
  const set = new Set<string>();
  for (const d of json['domains'] as unknown[]) {
    if (typeof d !== 'string') throw new Error('learned allowlist: non-string domain');
    set.add(d.toLowerCase());
  }
  return set;
}

export interface LearnedClassifier {
  readonly treeCount: number;
  readonly featureVersion: number;
  readonly thresholds: LearnedThresholds;
  classify(domain: string, obs?: BehavioralObservation): LearnedVerdict;
}

/**
 * Build a classifier from parsed artifacts. The allowlist is optional;
 * without it the model scores everything (useful for evaluation).
 */
export function createLearnedClassifier(
  modelJson: unknown,
  allowlistJson?: unknown,
): LearnedClassifier {
  const model = parseLearnedModel(modelJson);
  const allowlist = allowlistJson === undefined ? new Set<string>() : parseLearnedAllowlist(allowlistJson);
  const thresholds: LearnedThresholds = {
    block: model.thresholds.block,
    review: model.thresholds.review,
  };

  return {
    treeCount: model.trees.length,
    featureVersion: model.feature_version,
    thresholds,
    classify(domain: string, obs?: BehavioralObservation): LearnedVerdict {
      let normalized: string;
      try {
        normalized = normalizeLearnedDomain(domain);
      } catch (err) {
        return {
          domain,
          score: 0,
          decision: 'allow',
          allowlisted: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      // v1 model + obs, or v2 model without obs: featurizeLearned adapts.
      // A v1 model ignores obs; a v2 model without obs gets an empty
      // observation -> all-NaN behaviorals -> LightGBM missing direction.
      // (Passing undefined would return the 15-vector, misrouting v2 trees.)
      const useObs = model.feature_version === 2 ? (obs ?? {}) : undefined;
      if (allowlist.has(normalized)) {
        // Allowlist decides before the model scores. The score is still
        // computed for shadow-mode logging (it shows what the model
        // WOULD have said).
        const score = evaluateGbdt(model.trees, featurizeLearned(normalized, useObs));
        return { domain, score, decision: 'allow', allowlisted: true };
      }
      const score = evaluateGbdt(model.trees, featurizeLearned(normalized, useObs));
      const decision: LearnedDecision =
        score >= thresholds.block ? 'block' : score >= thresholds.review ? 'review' : 'allow';
      return { domain, score, decision, allowlisted: false };
    },
  };
}
