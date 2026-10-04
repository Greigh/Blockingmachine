/**
 * The `/v1/deploy-report` endpoint is the half of the refresh ledger that lives in the
 * feed server: the refresh command POSTs `ok`/`fail` from the resolver host, and the hub
 * has to persist it where a *later* reachability check reads it — persisting it in memory
 * would recreate the exact blindness the report exists to fix.
 *
 * `index.ts` cannot be imported — importing it starts the Electron main process — so this
 * pins the wiring the way `verdictCacheWiring.test.ts` does: the endpoint exists, it sits
 * behind the mutation guard (a report is a write, and a write from a foreign origin is
 * CSRF, not telemetry), it records through `recordDeployRefresh`, and it re-publishes the
 * snapshot through the channel the Deploy pane already subscribes to.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const main = readFileSync(join(appRoot, 'src/index.ts'), 'utf8');

/** The endpoint's dispatch block — anchored on the path check so the import line is not found first. */
function endpointBlock(): string {
  const start = main.indexOf("lowerPath === '/v1/deploy-report'");
  if (start < 0) throw new Error('the deploy-report endpoint was not found in index.ts');
  const end = main.indexOf("lowerPath === '/v1/control/cosmetics'", start);
  if (end < 0) throw new Error('the next endpoint was not found after deploy-report');
  return main.slice(start, end);
}

describe('the deploy-report endpoint', () => {
  test('is registered, POST-only, and behind the mutation guard', () => {
    const handler = endpointBlock();
    expect(handler).toContain('rejectUnauthorisedMutation');
    expect(handler).toContain("req.method !== 'POST'");
    expect(handler).toContain('parseDeployRefreshQuery');
  });

  test('persists the report rather than holding it in memory', () => {
    const record = endpointBlock();
    expect(record).toContain("storeRef.set('deployRefreshReports'");
    // A stored snapshot still carries the report it was checked against, so a fresh report
    // is folded in and re-published — the pane sees it now, not at the next scheduled tick.
    expect(record).toContain("storeRef.set('unboundReachability'");
    expect(record).toContain("unbound-reachability-updated");
  });

  test('the reachability check reads the persisted report, not a session variable', () => {
    expect(main).toContain(
      "refreshReport: (store.get('deployRefreshReports') || {})['unbound'] ?? null",
    );
  });
});
