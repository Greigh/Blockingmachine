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
    // host extraction iterates every unique rule (~360k)
    const extractLoop = body.indexOf('extractHostFromRule');
    expect(body.lastIndexOf('yieldToEventLoop()', extractLoop)).toBeGreaterThanOrEqual(0);
    // the classify pass iterates every candidate host (~190k, ~0.7ms each)
    const classifyLoop = body.indexOf('for (const host of candidates)');
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
});
