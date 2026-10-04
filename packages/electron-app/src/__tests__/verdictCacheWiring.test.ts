/**
 * The hub's malware-verdict pass is incremental: a host the same classifier already answered
 * for is served from `mini-ai-verdicts.json` rather than re-scored.
 *
 * What makes that safe is the fingerprint gate — a cached verdict is only reused when the
 * classifier that would answer today is the one that answered then — so the pin here is on the
 * ordering, not the speedup: read the record, gate on the fingerprint, classify only the misses,
 * write back. `index.ts` cannot be imported — importing it starts the Electron main process —
 * so this reads the call site the way `compilationAttribution.test.ts` does.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));

/** The slice of the compile handler that runs the classifier pass. */
function readVerdictPass(): string {
  const main = readFileSync(join(appRoot, 'src/index.ts'), 'utf8');
  const start = main.indexOf('const classifyStartedAt');
  if (start < 0) throw new Error('the classifier pass was not found in index.ts');
  const end = main.indexOf('serializeVerdictCache', start);
  if (end < 0) throw new Error('the verdict-cache write was not found in index.ts');
  return main.slice(start, end);
}

describe('the incremental classifier pass', () => {
  test('keys the cache on the classifier that produced it', () => {
    const pass = readVerdictPass();
    // The fingerprint has to cover the things that can change an answer between runs — model
    // weights and live vocabulary inside `classifierInputFingerprint`, the user's feedback
    // tunings passed into it here, and the build stamp so a changed classifier binary cannot
    // inherit the verdicts its predecessor produced.
    expect(pass).toContain(
      'classifierInputFingerprint(globalMiniAiClassifier.exportFeedback(), BM_BUILD_ID)',
    );
    // A record from another model or vocabulary is declined, not partially trusted.
    expect(pass).toContain('parsed.fingerprint === fingerprint');
  });

  test('classifies only the hosts the cache does not answer for', () => {
    const pass = readVerdictPass();
    // Presence, not truthiness — and the classify call lives on the miss side of it.
    expect(pass).toContain('Object.hasOwn(priorVerdicts, host)');
    expect(pass.indexOf('Object.hasOwn(priorVerdicts, host)')).toBeLessThan(
      pass.indexOf('globalMiniAiClassifier.classify(host)'),
    );
    // The record persists what this compilation measured — no more, no less — so hosts that fell
    // off the list do not accumulate, and a fingerprint mismatch can never smuggle a verdict in.
    expect(pass).toContain('measured[host] = category');
  });

  test('reads the record before the pass and writes it after the verdict file', () => {
    const main = readFileSync(join(appRoot, 'src/index.ts'), 'utf8');
    const readAt = main.indexOf("fs.readFile(cachePath");
    const loopAt = main.indexOf('for (const host of candidates)');
    const verdictWrite = main.indexOf("fs.writeFile(\n            malwarePath");
    const cacheWrite = main.indexOf('serializeVerdictCache(fingerprint, measured)');

    expect(readAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(-1);
    expect(cacheWrite).toBeGreaterThan(-1);
    // The read precedes the classify loop — a cache consulted afterwards is a write-only file —
    // and the write follows the verdict output, because the artifact that matters is
    // `malware.txt` and a failed cache write must not take it down.
    expect(readAt).toBeLessThan(loopAt);
    expect(verdictWrite).toBeGreaterThan(-1);
    expect(cacheWrite).toBeGreaterThan(verdictWrite);
    // State lives in userData — internal bookkeeping, not an output a subscriber picks up.
    expect(main).toContain("join(app.getPath('userData'), 'mini-ai-verdicts.json')");
  });
});
