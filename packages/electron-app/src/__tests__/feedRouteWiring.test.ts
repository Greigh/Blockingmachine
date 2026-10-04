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

describe('the hotlist.txt write inside the compile handler', () => {
  // The extension's sync client fetches `hotlist.txt` so a browser can install the rules its
  // own ledger says fire first — the file must come from the picked ledger, never from rule
  // counts, and must disappear when the measurement does rather than serving a stale set.
  const hotlist = blockFrom("join(outputDir, 'hotlist.txt')");

  test('derives the set from the picked ledger through the core hot-list pipeline', () => {
    expect(hotlist).toContain('parseHitLedgerText');
    expect(hotlist).toContain('selectHotList');
    expect(hotlist).toContain('formatHotList');
    expect(hotlist).toContain('tierLedgerPath');
  });

  test('removes the file when the measurement is absent or unreadable', () => {
    // Three honest absences: no ledger picked, a ledger with no hits, and a ledger that no
    // longer parses — each must unlink rather than keep serving what a dead ledger measured.
    expect(hotlist.match(/fs\.unlink\(hotlistPath\)/g)?.length).toBe(3);
  });
});
