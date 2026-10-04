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

/**
 * The fraction of *all* scored domains the shipping app writes as sample records.
 *
 * Disagreements alone are a biased sample of traffic — they are the domains where this
 * model happens to differ from the lists, which is exactly the population the promotion
 * gate is trying to measure thresholds against. The drift stage of that gate (M5) needs
 * the other population: the ordinary traffic too, so a distribution shift in production
 * is visible against the training baseline instead of being invisible inside a set of
 * exceptions.
 *
 * **This number is a privacy decision, not a tuning one.** A sample record is the same
 * shape as a disagreement record: a domain, the model's score and decision, the
 * production decision, whether the allowlist matched, and a timestamp. No URL, no path,
 * no client, no page content. It is appended to `<userData>/learned-shadow.jsonl` and is
 * never transmitted — the file is read by an offline training script on the machine that
 * wrote it. So the cost of the slice is disk and the disclosure is "about 1% of the
 * domains this device resolved, by name, to a local file a person can delete".
 *
 * Why one percent, stated as the arithmetic it is: PSI bins a feature into ten buckets
 * and compares the production proportion in each against the baseline, so the smallest
 * bucket needs enough observations to be worth comparing at all. A 7-day window at this
 * rate over a busy device lands in the thousands of sample records, which is what
 * `gate.py`'s `min_shadow_scored: 1000` and `min_shadow_days: 7` are sized against. A
 * lower rate does not make the app more private — it makes the bin empty and the gate
 * un-runnable — and a higher rate buys nothing the smallest bin cannot already see, so
 * the conservative end of "enough" is the right end to ship.
 *
 * Exported rather than defaulted so that a caller states the rate it runs at. The
 * library's own default stays 0, because a library that logs a slice of everything by
 * default is a library that cannot be used for anything else.
 *
 * @see {@link runShadowComparison}
 */
export const LEARNED_SHADOW_SAMPLE_RATE = 0.01 as const;

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
