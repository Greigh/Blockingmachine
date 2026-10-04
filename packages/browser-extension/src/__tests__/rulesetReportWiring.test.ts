/**
 * The popup's tier card is only as honest as the payload `GET_RULESET_TIERS` serves it: a handler
 * that returned the saved selection alone — without the browser's `drift` — would describe state
 * the browser may not be enforcing, and nothing downstream could notice. `background/index.ts`
 * starts the service worker on import, so the handler cannot be exercised directly; this pins the
 * call site by reading it, the way `compilationAttribution.test.ts` does on the hub side.
 *
 * The behavioural half — that the status actually agrees with the browser's grant after the
 * lifecycle reconcile — lives in `rulesetManager.test.ts` ("reported vs enforced").
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'background', 'index.ts'),
  'utf8',
);

describe('the popup\u2019s tier read carries the browser\u2019s answer', () => {
  test('GET_RULESET_TIERS serves rulesets.status() — the drift-carrying shape, not saved-only', () => {
    // A response built without `drift` would let the popup render the saved selection as if it
    // were enforced. The handler must serve the status object whole.
    expect(src).toContain(
      "case 'GET_RULESET_TIERS':\n      rulesets.status().then((status) => sendResponse({ success: true, status }))",
    );
  });

  test('the reconcile path answers with a post-repair status, not a pre-repair one', () => {
    // The drift notice's button must report what the repair left behind: setSuspended runs the
    // reconcile and the status is only read after it — a status read first would still show the
    // drift it just fixed, or promise a fix it never ran.
    const handler = src.indexOf("case 'RECONCILE_RULESET_TIERS'");
    expect(handler).toBeGreaterThan(-1);
    const block = src.slice(handler, src.indexOf('return true;', handler));
    const repairAt = block.indexOf('rulesets.setSuspended');
    const statusAt = block.indexOf('rulesets.status()');
    expect(repairAt).toBeGreaterThan(-1);
    expect(statusAt).toBeGreaterThan(repairAt);
  });

  test('the worker-start sequence runs the reconcile, so an update is repaired before it is seen', () => {
    // An extension update resets the browser's ruleset grant to the manifest defaults while the
    // worker is dead. If the startup block ever stopped applying the pause-state reconcile — the
    // call that syncs the browser back to the saved selection — the popup would open on storage
    // that says on and a browser that is off, and only the drift notice would know.
    const startupBlock = src.slice(src.indexOf('void (async () =>'));
    expect(startupBlock).toContain('await rulesets.load()');
    expect(startupBlock).toContain('await rulesets.setSuspended(siteControl.globalPaused)');
  });
});
