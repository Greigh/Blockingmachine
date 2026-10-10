/**
 * Wiring pins for the renderer→main trust boundary (audit F-01/F-02/F-03).
 *
 * `index.ts` cannot be imported under jest (it boots Electron on require), so the handlers
 * are pinned structurally — the same convention `feedRouteWiring.test.ts` uses for the feed
 * server routes.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const main = readFileSync(join(appRoot, 'src/index.ts'), 'utf8');
const preload = readFileSync(join(appRoot, 'src/preload.ts'), 'utf8');

function blockFrom(anchor: string, span = 3000): string {
  const start = main.indexOf(anchor);
  if (start < 0) throw new Error(`anchor not found in index.ts: ${anchor}`);
  return main.slice(start, start + span);
}

describe('add-threat-quarantine screens renderer items before they reach the ledger', () => {
  const handler = blockFrom("'add-threat-quarantine'");

  test('sanitizes before the store write, the daemon push, and the SSE broadcast', () => {
    const sanitizeAt = handler.indexOf('sanitizeQuarantineItems(items)');
    expect(sanitizeAt).toBeGreaterThan(-1);
    // Only the sanitized `accepted` list may flow downstream — a raw `items.map` domain
    // reaching the daemon or the broadcast is the feed-injection the gate exists to stop.
    for (const anchor of ["store.set('aiThreatQuarantine'", 'quarantineDomain(', "broadcastSseEvent('quarantine_added'"]) {
      const at = handler.indexOf(anchor);
      expect(at).toBeGreaterThan(sanitizeAt);
    }
    expect(handler).not.toContain('items.map((i) => i.domain)');
  });
});

describe('get-extension-tier-plan reads only the remembered ledger path', () => {
  // `hitsPath` let the renderer name any file for fs.readFile — the contents were never
  // returned, but the read itself was an oracle. Nothing called it; the surface is gone.
  const handler = blockFrom("'get-extension-tier-plan'");

  test('the handler never reads a renderer-supplied hitsPath', () => {
    expect(handler).not.toContain('request.hitsPath');
    expect(handler).not.toContain('request?.hitsPath');
    expect(handler).not.toContain('hitsPath?:');
    expect(handler).toContain("store.get('tierLedgerPath')");
  });

  test('the preload bridge no longer offers the parameter', () => {
    const start = preload.indexOf('getExtensionTierPlan');
    expect(start).toBeGreaterThan(-1);
    expect(preload.slice(start, start + 400)).not.toContain('hitsPath');
  });
});

describe('the learned-shadow scorer interval is owned', () => {
  // A bare `setInterval(scoreObservations, ...)` was dropped on the floor — unreferenced,
  // un-unref'd, it pins the event loop open on every quit path.
  const site = blockFrom('scoreObservations, 30_000', 400);

  test('the interval handle is captured and unref’d', () => {
    expect(site).toContain('observationScoreTimer = setInterval(scoreObservations');
    expect(site).toContain('observationScoreTimer.unref');
  });
});
