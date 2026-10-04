/**
 * Install fires `onInstalled` and the worker-start reconcile inside the same window, and both
 * used to fetch and apply in parallel: two identical lists ingested, and a second apply whose
 * read-the-rules step ran before the first committed — so it planned on top of a full family and
 * the browser refused the whole batch over its dynamic-rule budget. The refusal then logged as
 * "applied 0 dynamic DNR network rules" even though the first apply's rules were still installed.
 *
 * `background/index.ts` starts the service worker on import, so the handlers cannot be exercised
 * directly; this pins the gates by reading them, the way `siteControlDriftWiring.test.ts` does.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'background', 'index.ts'),
  'utf8',
);

describe('concurrent syncs cannot race the browser\u2019s rule budget', () => {
  test('syncs are single-flight — a caller mid-sync joins the in-flight fetch', () => {
    const syncAt = src.indexOf('async function syncAndApplyRules');
    expect(syncAt).toBeGreaterThan(-1);
    const body = src.slice(syncAt, src.indexOf('\n}', syncAt));
    expect(body).toContain('syncInFlight ??=');
    expect(body).toContain('syncAndApplyRulesInner()');
    // The reference must be released when the run settles or no later sync could ever start.
    expect(body).toContain('syncInFlight = null');
  });

  test('applies are serialized — two applies never interleave a read/write pair', () => {
    // `applyCurrentRulesInner` sorts before the wrapper in the file and shares the prefix, so
    // the wrapper is the last match.
    const applyAt = src.lastIndexOf('async function applyCurrentRules');
    expect(applyAt).toBeGreaterThan(-1);
    const body = src.slice(applyAt, src.indexOf('\n}', applyAt));
    expect(body).toContain('applyChain.then(() => applyCurrentRulesInner())');
    expect(body).toContain('applyChain =');
  });

  test('a refused apply does not log a zero-rule success', () => {
    const syncInnerAt = src.indexOf('async function syncAndApplyRulesInner');
    expect(syncInnerAt).toBeGreaterThan(-1);
    const body = src.slice(syncInnerAt, src.indexOf('\n}', syncInnerAt));
    const logAt = body.indexOf('Successfully applied');
    expect(logAt).toBeGreaterThan(-1);
    // The success line only prints when the apply did not record a refusal — `applyCurrentRules`
    // returns 0 both for a refused batch and for a genuine empty install, and only the flag
    // tells them apart.
    const guardAt = body.lastIndexOf('lastApplyError === null', logAt);
    expect(guardAt).toBeGreaterThan(-1);
  });
});
