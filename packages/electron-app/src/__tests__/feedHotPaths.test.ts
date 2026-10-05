/**
 * Wiring pins for the performance/resilience findings (H2, L9, L10).
 *
 * `/v1/check` recompiled a ~361k-rule index per request (~150ms synchronous on the main
 * thread) on an unauthenticated wildcard-CORS GET — a sustained remote stall. Feed files
 * were written non-atomically, so a fetch during the write window served a torn list.
 * And `start-feed-server` took the renderer's port unchecked — garbage in, listen error out.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const main = readFileSync(join(appRoot, 'src/index.ts'), 'utf8');

function blockFrom(anchor: string, length = 2500): string {
  const start = main.indexOf(anchor);
  if (start < 0) throw new Error(`anchor not found in index.ts: ${anchor}`);
  return main.slice(start, start + length);
}

describe('the compiled-evaluator cache', () => {
  test('a WeakMap keyed on the rules array caches the compiled index', () => {
    const cache = blockFrom('compiledEvaluatorCache', 900);
    expect(cache).toContain('WeakMap');
    expect(cache).toContain('compileRuleSet(rules)');
  });

  test('/v1/check evaluates through the cache, not a per-request compile', () => {
    const check = blockFrom("lowerPath === '/v1/check'", 2000);
    expect(check).toContain('getCompiledEvaluator(checkRules).evaluate(');
    expect(check).not.toContain('checkRules.map((r) => r.raw)');
    expect(check).not.toContain('isDomainCoveredByRules(');
  });

  test('/v1/check answers the flat blocked boolean the clients read', () => {
    const check = blockFrom("lowerPath === '/v1/check'", 2200);
    expect(check).toContain("blocked: evaluation?.verdict === 'blocked'");
    expect(check).toContain('coveringRule');
  });

  test('inspect-domain evaluates through the same cache', () => {
    const inspect = blockFrom('const rulesToSearch = await getOrLoadCompiledRules', 400);
    expect(inspect).toContain('getCompiledEvaluator(rulesToSearch).evaluate(');
    expect(inspect).not.toContain('evaluateDomainRules(');
  });
});

describe('atomic feed writes', () => {
  test('feed files write via tmp+rename, never direct writeFile', () => {
    const compile = blockFrom("'Saving to disk...'", 3500);
    expect(compile).toContain('writeFileAtomic(savePath');
    expect(compile).toContain("writeFileAtomic(join(outputDir, 'dns.txt')");
    expect(compile).toContain("writeFileAtomic(join(outputDir, 'browser.txt')");
    expect(compile).toContain('writeFileAtomic(hotlistPath');
    expect(compile).not.toContain('fs.writeFile(');
  });

  test('the helper writes a sibling temp file then renames', () => {
    const helper = blockFrom('async function writeFileAtomic', 900);
    expect(helper).toContain('fs.rename(tmpPath, filePath)');
    expect(helper).toContain('fs.unlink(tmpPath)');
  });
});

describe('feed-server port validation', () => {
  test('start-feed-server rejects malformed and privileged ports', () => {
    const handler = blockFrom("ipcMain.handle('start-feed-server'", 1400);
    expect(handler).toContain('Number.isInteger(port)');
    expect(handler).toContain('port < 1024');
    expect(handler).toContain('port ?? 9191');
    // `port || 9191` would silently swallow 0/NaN — the explicit ?? must remain.
    expect(handler).not.toContain('port || 9191');
  });
});

describe('extension archive integrity', () => {
  test('download-extension verifies SHA256SUMS.txt entries before replacing files', () => {
    const dl = blockFrom("ipcMain.handle('download-extension'", 5500);
    expect(dl).toContain('SHA256SUMS.txt');
    expect(dl).toContain("createHash('sha256')");
    expect(dl).toContain('checksum mismatch');
    // Extraction must land in staging and swap — a direct write into `destination`
    // mid-extract is the torn-install path.
    expect(dl).toContain('.staging-');
    expect(dl).toContain('fs.rename(staging, destination)');
  });

  test('the result reports whether verification actually happened', () => {
    const dl = blockFrom("ipcMain.handle('download-extension'", 6500);
    expect(dl).toContain('integrityVerified');
  });
});
