/**
 * Learned-model shadow mode for the Electron app (M3).
 *
 * Runs the trained GBDT classifier alongside the Sentinel watchdog's
 * production verdicts and appends every disagreement to
 * `<userData>/learned-shadow.jsonl` — WITHOUT acting on the model's
 * output. After ~7 days of shadow data, thresholds get tuned on real
 * traffic before the model is ever allowed to block anything.
 *
 * Wiring: call `shadowScoreWatchdogDomains` once per watchdog sweep
 * (see the hook in index.ts `setupAiWatchdogTimer`). The module is
 * lazy and fail-soft: if the weights are missing or corrupt, it logs
 * once and every call becomes a no-op — the watchdog never breaks
 * because of the shadow scorer.
 */
import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import {
  createLearnedClassifier,
  runShadowComparison,
  verifyLearnedManifest,
  type LearnedClassifier,
  type LearnedDecision,
  type LearnedVerdict,
  type ShadowRunResult,
  type ShadowSample,
} from '@blockingmachine/core';

let classifier: LearnedClassifier | null = null;
let initAttempted = false;
/**
 * The verified promotion version of the shipped weights, or null when
 * there is no manifest — a pre-M5 export, which is what ships today.
 * Null is an honest value here rather than a missing one: without a
 * manifest there is no version to claim, and a summary that named a
 * version nothing could check would be worse than one that admits it.
 */
let modelVersion: number | null = null;

function weightsDir(): string | null {
  try {
    // Resolve through Node's module resolution so this works in dev
    // (workspace node_modules) and in the packaged app (asar).
    const req = createRequire(join(app.getAppPath(), 'package.json'));
    const pkgPath = req.resolve('@blockingmachine/core/package.json');
    return join(dirname(pkgPath), 'ai-weights');
  } catch {
    return null;
  }
}

/** Lazily load the learned classifier. Null when unavailable (fail-soft). */
export function getLearnedClassifier(): LearnedClassifier | null {
  if (initAttempted) return classifier;
  initAttempted = true;
  try {
    const dir = weightsDir();
    if (!dir || !existsSync(join(dir, 'model.json'))) {
      console.warn('[Learned Shadow] weights not found; shadow mode disabled');
      return null;
    }
    // M5 promotion ceremony: when promote.py has written a manifest,
    // verify the exact bytes before trusting them. A mismatch fails
    // closed (no shadow scoring) instead of serving suspect weights.
    const modelText = readFileSync(join(dir, 'model.json'), 'utf8');
    const allowText = readFileSync(join(dir, 'allowlist.json'), 'utf8');
    const manifestPath = join(dir, 'manifest.json');
    if (existsSync(manifestPath)) {
      const manifest = verifyLearnedManifest(
        modelText,
        allowText,
        JSON.parse(readFileSync(manifestPath, 'utf8')),
      );
      console.log(`[Learned Shadow] manifest v${manifest.version} verified`);
      modelVersion = manifest.version;
    }
    classifier = createLearnedClassifier(JSON.parse(modelText), JSON.parse(allowText));
    console.log(`[Learned Shadow] loaded model (${classifier.treeCount} trees)`);
  } catch (err) {
    console.error('[Learned Shadow] failed to load weights:', err);
    classifier = null;
  }
  return classifier;
}

/** Score one domain with the learned model. Null when unavailable. */
export function scoreDomainLearned(domain: string): LearnedVerdict | null {
  const clf = getLearnedClassifier();
  if (!clf) return null;
  try {
    return clf.classify(domain);
  } catch (err) {
    console.error('[Learned Shadow] classify failed:', err);
    return null;
  }
}

export interface WatchdogShadowResult extends ShadowRunResult {
  logPath: string;
  /** Promotion version of the weights that scored this sweep; null if unversioned. */
  modelVersion: number | null;
}

/**
 * Shadow-score a watchdog sweep. `referenceDecide` maps each domain to
 * the production verdict ('block' for quarantined threats, 'allow'
 * otherwise). Disagreements append as JSONL. `sampleRate` additionally
 * logs that fraction of ALL scored domains as `sample: true` records —
 * the unbiased slice the M5 drift stage needs, and the only input PSI
 * has, since disagreements alone are a biased population.
 *
 * `sampleRate` is required, with no default, because a default here is
 * how the drift stage ended up with nothing to read: the hook called
 * this with two arguments, the third defaulted to 0, and `drift.py`
 * failed with "no sample records" while the app looked healthy. The
 * caller states the rate it runs at — normally
 * `LEARNED_SHADOW_SAMPLE_RATE` — so the number in the log, the number
 * in the docs and the number the code uses cannot disagree.
 *
 * What a sampled record holds, and what it never holds, is specified in
 * `docs/learned-shadow-privacy.md` and pinned by test.
 *
 * Returns null when the model is unavailable.
 */
export function shadowScoreWatchdogDomains(
  domains: string[],
  referenceDecide: (domain: string) => LearnedDecision,
  sampleRate: number,
): WatchdogShadowResult | null {
  const clf = getLearnedClassifier();
  if (!clf) return null;
  const logPath = join(app.getPath('userData'), 'learned-shadow.jsonl');
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    return null;
  }
  const append = (d: object) => {
    try {
      appendFileSync(logPath, JSON.stringify(d) + '\n');
    } catch (err) {
      console.error('[Learned Shadow] log write failed:', err);
    }
  };
  const result = runShadowComparison({
    classifier: clf,
    reference: referenceDecide,
    domains,
    onDisagreement: append,
    sampleRate,
    onSample: (d: ShadowSample) => append(d),
    onError: (domain, err) => {
      console.error(`[Learned Shadow] error on ${domain}:`, err);
    },
  });
  if (result.disagreements > 0) {
    console.log(
      `[Learned Shadow] ${result.disagreements}/${result.evaluated} disagreements -> ${logPath}`,
    );
  }
  // The per-sweep counters. `shadow.py` derives `scored_domains` from
  // these and from nothing else, so a sweep that scored 30,000 domains
  // and agreed with the reference about all of them left no trace: the
  // log was silent about the case the gate is mostly made of, and
  // `gate.py`'s shadow_scored read 0 forever. A sweep that scored
  // nothing is not written at all — "we ran" is not coverage.
  if (result.evaluated > 0) {
    append({
      type: 'summary',
      at: new Date().toISOString(),
      evaluated: result.evaluated,
      disagreements: result.disagreements,
      modelVersion,
    });
  }
  return { ...result, logPath, modelVersion };
}
