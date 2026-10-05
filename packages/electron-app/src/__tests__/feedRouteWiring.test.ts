/**
 * Wiring tests for the feed server's file-serving and stream routes in `index.ts`.
 *
 * Two audit findings lived here and both are the kind a refactor can quietly reopen:
 *
 *  - The arbitrary-name branch served *any* non-hidden file in the output directory — a folder
 *    the user also fills with configs, manifests and source trees — because `basename(pathname)`
 *    both strips traversal and says nothing about whether the name is a feed. The allowlist in
 *    `feedServing.ts` is the contract now; these pin that the route consults it and that the 404
 *    listing is filtered through the same predicate (an unfiltered listing would name exactly
 *    what the allowlist withholds).
 *  - `/v1/events` had no guard at all: any web page could open an `EventSource` cross-origin
 *    (the response carries `Access-Control-Allow-Origin: *`) and read `remote_control` and
 *    telemetry events, and a configured feed token gated mutations while leaving the stream —
 *    the data mutations produce — open. The stream now takes the origin guard plus the token
 *    when one is configured.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const main = readFileSync(join(appRoot, 'src/index.ts'), 'utf8');

function blockFrom(anchor: string): string {
  const start = main.indexOf(anchor);
  if (start < 0) throw new Error(`anchor not found in index.ts: ${anchor}`);
  return main.slice(start, start + 4000);
}

describe('the feed file-serving branch', () => {
  const arbitraryFileBranch = blockFrom('isServableFeedFile(cleanName');

  test('consults the feed-file allowlist before touching the filesystem', () => {
    expect(arbitraryFileBranch).toContain('basename(savePath)');
    expect(arbitraryFileBranch).toContain('Not a feed file');
  });

  test('the 404 directory listing is filtered through the same allowlist', () => {
    const listing = blockFrom('Not found response with helpful feed directory listing');
    expect(listing).toContain('isServableFeedFile(f, saveName)');
  });
});

describe('the /v1/events route', () => {
  const events = blockFrom("lowerPath === '/v1/events'");

  test('is behind the cross-origin guard', () => {
    expect(events).toContain('rejectCrossOrigin');
  });

  test('requires the feed token when one is configured', () => {
    expect(events).toContain('configuredToken &&');
    expect(events).toContain('feedTokenAuthorised');
  });
});

describe('the /v1/compile route', () => {
  const compile = blockFrom("lowerPath === '/v1/compile'");

  test('answers already-in-progress instead of re-firing the renderer', () => {
    expect(compile).toContain('compileInFlight');
    expect(compile).toContain('alreadyRunning');
  });
});

describe('the /v1/protection route', () => {
  // The Home Assistant integration's Network Protection switch hangs off this — a
  // route that 404s or lies about the daemon state is a dead switch in HA.
  const protection = blockFrom("lowerPath === '/v1/protection'");

  test('POST is a gated mutation wired to the daemon toggle', () => {
    expect(protection).toContain('rejectUnauthorisedMutation');
    expect(protection).toContain('daemonManager.toggleProtection');
    expect(protection).toContain('refreshTrayProtection');
  });

  test('refuses honestly when no daemon is running', () => {
    expect(protection).toContain("status === 'stopped'");
    expect(protection).toContain('503');
    expect(protection).toContain('DNS daemon is not running');
  });
});

describe('the /v1/check route', () => {
  // It serialized the RuleCoverageResult object under `blocked` — `{"isCovered":false}`
  // — which every consumer reads as truthy. The add-on serves the same endpoint with a
  // flat boolean; the two must agree.
  const check = blockFrom("lowerPath === '/v1/check'");

  test('answers a flat boolean blocked flag, not the coverage object', () => {
    // The evaluator is cached on the rules array's identity (H2) — per-request
    // `compileRuleSet` over ~361k rules held the event loop ~150ms per GET.
    expect(check).toContain("blocked: evaluation?.verdict === 'blocked'");
    expect(check).toContain('getCompiledEvaluator(checkRules)');
    expect(check).not.toContain('blocked: isCovered');
    expect(check).not.toContain('isDomainCoveredByRules');
  });
});

describe('the /v1/status protection block', () => {
  // It hardcoded `enabled: true` — the API claimed protection while the tray said
  // the daemon was not running. The block must come from the daemon's own answer.
  const status = blockFrom("lowerPath === '/v1/status'");

  test('reports the live daemon state rather than a fixed enabled flag', () => {
    expect(status).toContain('daemonManager.getStatus()');
    expect(status).toContain('daemonStatus.status');
  });
});

describe('the hotlist.txt write inside the compile handler', () => {
  // The extension's sync client fetches `hotlist.txt` so a browser can install the rules its
  // own ledger says fire first — the file must come from the picked ledger, never from rule
  // counts, and must disappear when the measurement does rather than serving a stale set.
  const hotlist = blockFrom("join(outputDir, 'hotlist.txt')");

  test('derives the set from the picked ledger through the core hot-list pipeline', () => {
    expect(hotlist).toContain('parseHitLedgerText');
    expect(hotlist).toContain('tierLedgerPath');
    // The ledger data rides into the generation worker as plain data — the
    // select/format pass itself lives in outputWorker.ts (and its twin in
    // generateOutputsInline) so the bytes stay identical to the old inline path.
    expect(main).toContain('hotlist: hotlistInput');
    const workerSrc = readFileSync(join(appRoot, 'src/outputWorker.ts'), 'utf8');
    expect(workerSrc).toContain('selectHotList');
    expect(workerSrc).toContain('formatHotList');
  });

  test('removes the file when the measurement is absent or unreadable', () => {
    // One gate decides "no measurement": the worker only emits content when the
    // ledger parses and carries hits, so no ledger picked, a ledger with no
    // hits, and a ledger that no longer parses all arrive here as `null` — and
    // the single unlink branch covers them rather than serving a stale set.
    const workerSrc = readFileSync(join(appRoot, 'src/outputWorker.ts'), 'utf8');
    expect(workerSrc).toContain('input.hotlist && input.hotlist.hits.length > 0');
    expect(main).toContain('fs.unlink(hotlistPath)');
  });
});
