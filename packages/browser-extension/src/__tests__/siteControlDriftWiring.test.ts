/**
 * The popup's site-control view is only as honest as the payload `GET_SITE_CONTROL` serves it: a
 * response built from storage alone — without the browser's `drift` — would describe a pause or
 * an allowance the browser may not be enforcing, and nothing downstream could notice. That is the
 * exact defect open flag 1 recorded, and the fix is the same shape the tiers already keep: the
 * view composes the browser's own reading, and the reconcile is a button rather than a side
 * effect of opening the popup.
 *
 * `background/index.ts` starts the service worker on import, so the handlers cannot be exercised
 * directly; this pins the call sites by reading them, the way `rulesetReportWiring.test.ts` does.
 * The behavioural half — that the computed drift actually matches what the browser holds — lives
 * in `siteControlDrift.test.ts`.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'background', 'index.ts'),
  'utf8',
);
const types = readFileSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'shared', 'types.ts'),
  'utf8',
);

describe('the popup\u2019s site-control read carries the browser\u2019s answer', () => {
  test('the view composes its drift from the browser read, not from storage alone', () => {
    // The view is the thing every response hands the popup; the drift has to be computed inside
    // it from `installedFamilies()` or a response could skip the read and render storage's claim.
    const viewAt = src.indexOf('async function siteControlView');
    expect(viewAt).toBeGreaterThan(-1);
    const body = src.slice(viewAt, src.indexOf('\n}', viewAt));
    expect(body).toContain('dnr.installedFamilies()');
    expect(body).toContain('computeSiteControlDrift(');
    expect(body).toContain('drift:');
  });

  test('every handler that serves a view awaits the drift-carrying shape', () => {
    // An unawaited call resolves a Promise into the response — a view the popup could not read.
    // Direct awaits and a `.then(() => siteControlView(...))` the chain flattens both deliver the
    // value; what must never appear is a bare call handed to sendResponse.
    expect(src).not.toContain('view: siteControlView(');
    expect(src.match(/await siteControlView\(/g)?.length).toBe(4);
  });

  test('the reconcile path repairs before it reads the view', () => {
    // The drift notice's button must report what the repair left behind: reconcileDynamicRules
    // runs and the view is only read after it — a view read first would still show the drift it
    // just fixed, or promise a fix that never ran.
    const handler = src.indexOf("case 'RECONCILE_SITE_CONTROL'");
    expect(handler).toBeGreaterThan(-1);
    const block = src.slice(handler, src.indexOf('return true;', handler));
    const repairAt = block.indexOf('reconcileDynamicRules()');
    const viewAt = block.indexOf('siteControlView(');
    expect(repairAt).toBeGreaterThan(-1);
    expect(viewAt).toBeGreaterThan(repairAt);
  });

  test('the message type is declared so the popup cannot ask for a handler that does not exist', () => {
    expect(types).toContain("'RECONCILE_SITE_CONTROL'");
  });

  test('a refused apply is carried to the view, so the notice can name the cause', () => {
    // The catch in `applyCurrentRules` used to only console.warn: the drift could say *that*
    // the browser disagreed but never *why*. The refusal is now recorded on success-clearable
    // state and the view hands it to the popup beside the drift.
    const applyAt = src.indexOf('async function applyCurrentRules');
    expect(applyAt).toBeGreaterThan(-1);
    const catchAt = src.indexOf('catch', applyAt);
    const body = src.slice(applyAt, src.indexOf('\n}', catchAt));
    expect(body).toContain('lastApplyError =');
    const viewAt = src.indexOf('async function siteControlView');
    const viewBody = src.slice(viewAt, src.indexOf('\n}', viewAt));
    expect(viewBody).toContain('applyError');
    expect(types).toContain('applyError');
  });
});
