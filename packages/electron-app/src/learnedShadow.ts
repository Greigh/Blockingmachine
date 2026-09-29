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
}

/**
 * Shadow-score a watchdog sweep. `referenceDecide` maps each domain to
 * the production verdict ('block' for quarantined threats, 'allow'
 * otherwise). Disagreements append as JSONL. `sampleRate` (default 0)
 * additionally logs that fraction of ALL scored domains as
 * `sample: true` records — the unbiased slice the drift monitor needs.
 * Returns null when the model is unavailable.
 */
export function shadowScoreWatchdogDomains(
  domains: string[],
  referenceDecide: (domain: string) => LearnedDecision,
  sampleRate = 0,
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
  return { ...result, logPath };
}
