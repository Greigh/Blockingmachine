/**
 * The malware-verdict classify pass off the main thread.
 *
 * A cold pass over a real compile is ~190k `classify()` calls — about 130s of
 * uninterrupted V8 work. That is too long to keep on the main event loop even
 * with cooperative yields: the window, tray and feed server still starve
 * between batches, which is the "compiles freeze the app" failure this file
 * exists to fix. `index.ts` spawns this as a `worker_threads` worker bundled
 * to `.webpack/main/classifierWorker.cjs`; nothing in it may touch
 * `require('electron')`.
 *
 * The work itself is identical to the inline path it replaces: a verdict is
 * served from the prior cache when the same classifier already produced one,
 * otherwise scored now; user feedback tunings travel with `workerData` so the
 * worker's classifier is the same classifier the main thread would have run.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { globalMiniAiClassifier } from '@blockingmachine/core';
import type { ThreatCategory } from '@blockingmachine/core';

interface ClassifyWorkerInput {
  candidates: string[];
  priorVerdicts: Record<string, ThreatCategory>;
  feedback: Record<string, number>;
  progressEvery?: number;
}

interface ClassifyWorkerResult {
  measured: Record<string, ThreatCategory>;
  servedFromCache: number;
}

const input = workerData as ClassifyWorkerInput;

if (input.feedback) {
  globalMiniAiClassifier.importFeedback(input.feedback);
}

const measured: Record<string, ThreatCategory> = Object.create(null);
let servedFromCache = 0;
const progressEvery =
  typeof input.progressEvery === 'number' && input.progressEvery > 0
    ? input.progressEvery
    : 5000;

for (let i = 0; i < input.candidates.length; i++) {
  const host = input.candidates[i];
  // `hasOwn` rather than truthiness: the record is null-prototype and validated
  // on parse, but a key must be present to mean anything — never inherit a lookup.
  const cached = Object.hasOwn(input.priorVerdicts, host)
    ? input.priorVerdicts[host]
    : undefined;
  const category = cached ?? globalMiniAiClassifier.classify(host).category;
  if (cached !== undefined) servedFromCache += 1;
  measured[host] = category;
  if ((i + 1) % progressEvery === 0) {
    parentPort?.postMessage({ type: 'progress', done: i + 1 });
  }
}

parentPort?.postMessage({
  type: 'result',
  measured,
  servedFromCache,
} satisfies { type: 'result' } & ClassifyWorkerResult);
