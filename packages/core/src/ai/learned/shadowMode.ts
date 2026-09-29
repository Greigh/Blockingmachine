/**
 * Shadow mode: run the learned model alongside the current decision
 * logic and log disagreements — without acting on them.
 *
 * Purpose: the model's thresholds were set from offline list data.
 * Shadow mode collects REAL traffic evidence (model vs lists/rules on
 * live DNS queries) so thresholds can be tuned on reality before the
 * model ever blocks anything. Per DESIGN.md M3: disagreements feed the
 * active-learning queue; 7 days of shadow data gates promotion.
 *
 * Runtime-agnostic: the caller injects the disagreement sink (JSONL
 * file in Electron main, in-memory array in tests).
 */
import type { LearnedClassifier, LearnedDecision } from './modelLoader.js';

export interface ShadowDisagreement {
  domain: string;
  learnedScore: number;
  learnedDecision: LearnedDecision;
  referenceDecision: LearnedDecision;
  allowlisted: boolean;
  /** ISO timestamp of the shadow run, shared by the whole batch. */
  at: string;
}

/**
 * A random production-traffic sample: same shape as a disagreement,
 * plus `sample: true`. The drift monitor (M5) needs this unbiased
 * slice — disagreements alone are a biased sample of traffic.
 */
export interface ShadowSample extends ShadowDisagreement {
  sample: true;
}

/** The current production decision for a domain (lists/rules/Mini-AI). */
export type ShadowReference = (domain: string) => LearnedDecision;

export interface ShadowRunOptions {
  classifier: LearnedClassifier;
  reference: ShadowReference;
  domains: Iterable<string>;
  onDisagreement: (d: ShadowDisagreement) => void;
  /**
   * Log ~this fraction of ALL evaluated domains as samples (default 0,
   * disabled). Enable ~0.01 in the app so drift monitoring sees real
   * production distribution, not just disagreements.
   */
  sampleRate?: number;
  onSample?: (d: ShadowSample) => void;
  /** RNG for sampling; defaults to Math.random. Inject for deterministic tests. */
  rng?: () => number;
  onError?: (domain: string, err: unknown) => void;
}

export interface ShadowRunResult {
  evaluated: number;
  disagreements: number;
}

export function runShadowComparison(opts: ShadowRunOptions): ShadowRunResult {
  const at = new Date().toISOString();
  const sampleRate = opts.sampleRate ?? 0;
  const rng = opts.rng ?? Math.random;
  let evaluated = 0;
  let disagreements = 0;
  for (const domain of opts.domains) {
    let verdict;
    try {
      verdict = opts.classifier.classify(domain);
    } catch (err) {
      opts.onError?.(domain, err);
      continue;
    }
    let ref: LearnedDecision;
    try {
      ref = opts.reference(domain);
    } catch (err) {
      opts.onError?.(domain, err);
      continue;
    }
    evaluated++;
    const record: ShadowDisagreement = {
      domain,
      learnedScore: verdict.score,
      learnedDecision: verdict.decision,
      referenceDecision: ref,
      allowlisted: verdict.allowlisted,
      at,
    };
    if (verdict.decision !== ref) {
      disagreements++;
      opts.onDisagreement(record);
    }
    // Sampling is independent of disagreement: a sampled disagreement is
    // logged twice (once per kind), keeping the sample slice unbiased.
    if (sampleRate > 0 && opts.onSample && rng() < sampleRate) {
      opts.onSample({ ...record, sample: true });
    }
  }
  return { evaluated, disagreements };
}
