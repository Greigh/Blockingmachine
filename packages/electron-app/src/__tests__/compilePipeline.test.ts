/**
 * The compile pipeline runs on the main thread, and `index.ts` cannot be
 * imported — importing it starts the Electron main process — so this pins the
 * three properties a real 650k-rule compile depends on, the way
 * `deployReportWiring.test.ts` pins the feed endpoint:
 *
 *   1. The O(n) loops (dedup, host extraction, malware classify) yield to the
 *      event loop on a cadence — the freeze the field report showed was all
 *      three loops holding the loop for minutes at a time.
 *   2. Local sources are fetched app-relatively, so the bundled `./filters/`
 *      inputs exist in the packaged app instead of ENOENTing against whatever
 *      cwd launchd happened to hand it.
 *   3. The auto-schedule timer actually compiles — it previously logged
 *      "triggering" and returned, a dead schedule that never ran.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const main = readFileSync(join(appRoot, 'src/index.ts'), 'utf8');
const forgeConfig = readFileSync(join(appRoot, 'forge.config.cjs'), 'utf8');

/** The compile body — anchored on the function the IPC handler delegates to. */
function compileBody(): string {
  const start = main.indexOf('async function runImportProcess');
  if (start < 0) throw new Error('runImportProcess was not found in index.ts');
  const end = main.indexOf('compileInvoker = runImportProcess', start);
  if (end < 0) throw new Error('runImportProcess is never published to compileInvoker');
  return main.slice(start, end);
}

describe('the compile pipeline', () => {
  test('yields inside every O(n) loop so the event loop keeps answering', () => {
    const body = compileBody();
    // dedup iterates every fetched rule (~650k on the real list)
    const dedupLoop = body.indexOf('for (let i = 0; i < rulesLen; i++)');
    expect(dedupLoop).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('yieldToEventLoop()', dedupLoop)).toBeLessThan(
      body.indexOf('Deduplication complete', dedupLoop),
    );
    // host extraction (~360k) moved into the output worker, with the same yielded
    // walk kept in the inline fallback for when the worker cannot start
    expect(body).toContain('outputs.candidates');
    const fallback = main.slice(
      main.indexOf('async function generateOutputsInline'),
      main.indexOf('// Browser extension package download'),
    );
    expect(fallback).toContain('extractHostFromRule');
    expect(fallback).toContain('yieldToEventLoop()');
    // the classify pass iterates every candidate host (~190k, ~0.7ms each)
    const classifyLoop = body.indexOf('for (const host of candidateList)');
    expect(classifyLoop).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('yieldToEventLoop()', classifyLoop)).toBeLessThan(
      body.indexOf('Malware verdicts saved', classifyLoop),
    );
  });

  test('fetches sources through the chunked stream parser, not the one-shot parser', () => {
    const body = compileBody();
    const fetchLoop = body.slice(0, body.indexOf('Deduplication complete'));
    expect(fetchLoop).toContain('fetchAndParseSource(source.url)');
    expect(fetchLoop).not.toContain('downloadAndParseSource(source.url)');
  });

  test('resolves relative source paths against the app, not the process cwd', () => {
    const helper = main.slice(
      main.indexOf('function resolveSourcePath'),
      main.indexOf('async function fetchAndParseSource'),
    );
    expect(helper).toContain('app.isPackaged');
    expect(helper).toContain('process.resourcesPath');
    expect(helper).toContain('app.getAppPath()');
    expect(helper).toContain('isAbsolute(trimmed)');
    // and the fetch path runs through the same resolution
    const fetchHelper = main.slice(
      main.indexOf('async function fetchAndParseSource'),
      main.indexOf('// Global cache of latest compiled rules'),
    );
    expect(fetchHelper).toContain('resolveSourcePath(url)');
    expect(fetchHelper).toContain('parseFilterListStream');
    expect(fetchHelper).toContain('fetchContent(resolved)');
  });

  test('the auto-schedule timer invokes the compile pipeline rather than only logging', () => {
    const timer = main.slice(
      main.indexOf('function setupAutoScheduleTimer'),
      main.indexOf('function getSharedAiDetectorService'),
    );
    expect(timer).toContain('compileInvoker');
    expect(timer).toContain('await compileInvoker(null)');
    expect(timer).not.toContain('// Internal trigger can use existing sources');
    // and the IPC path still reaches the same pipeline
    expect(main).toContain("ipcMain.handle('run-import-process'");
    expect(main).toContain('runImportProcess(_event.sender)');
  });

  test('the packaged app ships the bundled filters as a resource', () => {
    expect(forgeConfig).toContain("'./filters'");
    expect(forgeConfig).toContain('extraResource');
  });

  test('progress keeps moving between 95% and complete — no silent stage reads as a hang', () => {
    const body = compileBody();
    const saveMark = body.indexOf("status: 'Saving to disk...'");
    const doneMark = body.indexOf("status: 'Complete!'");
    expect(saveMark).toBeGreaterThanOrEqual(0);
    expect(doneMark).toBeGreaterThan(saveMark);
    const tail = body.slice(saveMark, doneMark);
    // Every long stage after the main save reports itself — a compile that spent
    // 95→100% silent is exactly what looked frozen in the field report.
    expect(tail).toContain('Writing segregated endpoint lists');
    expect(tail).toContain('Building category attribution');
    // Both classify paths feed progress: the worker through its tick callback,
    // the inline fallback through its own cadence (a silent fallback was the
    // worst case — ~137s at a frozen percent).
    expect(tail).toContain('const classifyProgress');
    expect(tail).toContain('runClassifyWorker(candidateList, priorVerdicts, classifyProgress)');
    expect(tail).toContain('classifyProgress(classifiedCount)');
  });

  test('the generation pass runs in the output worker with an inline fallback', () => {
    const body = compileBody();
    // The worker carries the ~3s of synchronous generation that used to spin at
    // 90% — spawned on the joined raws, never the ~160MB rule-object clone.
    expect(body).toContain('runOutputWorker(workerInput, onOutputStage)');
    expect(body.indexOf('runOutputWorker(workerInput, onOutputStage)')).toBeLessThan(
      body.indexOf("status: 'Saving to disk...'"),
    );
    expect(body).toContain("map((rule) => rule.raw).join('\\n')");
    // The same pass inline is the resilience path when the worker cannot start.
    expect(body).toContain('generateOutputsInline(workerInput, onOutputStage)');
    expect(body).toContain('Output worker unavailable');
    // Worker progress stages reach the tray so the 90–95% window keeps naming
    // what is running instead of sitting on one label.
    expect(body).toContain('outputStagePercent');
    expect(main).toContain("new Worker(join(__dirname, 'outputWorker.cjs')");
  });

  test('the packaged app unpacks both worker bundles from the asar', () => {
    const webpackMain = readFileSync(join(appRoot, 'webpack.main.config.cjs'), 'utf8');
    expect(webpackMain).toContain("outputWorker: './src/outputWorker.ts'");
    expect(webpackMain).toContain("classifierWorker: './src/classifyWorker.ts'");
    expect(forgeConfig).toContain('classifierWorker.cjs');
    expect(forgeConfig).toContain('outputWorker.cjs');
  });

  test("the tray's updated stamp lands at completion, not mid-run", () => {
    const body = compileBody();
    const stamp = body.indexOf("store.set('lastProcessTime'");
    const doneMark = body.indexOf("status: 'Complete!'");
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(doneMark).toBeGreaterThanOrEqual(0);
    // The stamp sits next to the completion event — earlier it fired right after
    // the save, so the tray showed "updated" while a compile was still running.
    expect(Math.abs(doneMark - stamp)).toBeLessThan(400);
  });
});
