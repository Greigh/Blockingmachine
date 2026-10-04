/**
 * "Forget Learned" deletes what Mini-AI learned for one domain. The button can only help the
 * user if it lives where inspect results actually render — and `App.tsx` hands `AIRadarView`
 * an `onNavigateInspector` callback, so every inspect action in the Radar leaves that view for
 * `RuleInspectorView`. Any affordance wired only into the Radar's local inspector panel is on
 * a path the app never takes.
 *
 * `RuleInspectorView` cannot be rendered here — it needs `window.electron` — so this reads the
 * wiring the way `verdictCacheWiring.test.ts` does: the view calls the preload method, the
 * preload method reaches the IPC channel, and the main handler reports `removed` as `success`
 * so the button can honestly say whether anything was stored.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(join(appRoot, rel), 'utf8');

describe('the Mini-AI feedback reset', () => {
  test('is reachable from the view inspect results render in', () => {
    // App delegates Radar inspections to the unified inspector; the reset must live there.
    expect(read('src/App.tsx')).toContain('onNavigateInspector');
    const view = read('src/views/RuleInspectorView.tsx');
    expect(view).toContain('window.electron?.resetMiniAiFeedback');
    expect(view).toContain('handleForgetMiniAi');
    expect(view).toContain('Forget Learned');
  });

  test('crosses the preload bridge on its own channel', () => {
    expect(read('src/preload.ts')).toContain(
      "resetMiniAiFeedback: (domain: string) => ipcRenderer.invoke('reset-mini-ai-feedback', domain)",
    );
  });

  test('reports removed, not attempted — the button distinguishes stored from absent', () => {
    const main = read('src/index.ts');
    const start = main.indexOf("ipcMain.handle('reset-mini-ai-feedback'");
    expect(start).toBeGreaterThan(-1);
    const handler = main.slice(start, start + 600);
    expect(handler).toContain('deleteDomainFeedback(domain)');
    expect(handler).toContain('success: removed');
  });
});
