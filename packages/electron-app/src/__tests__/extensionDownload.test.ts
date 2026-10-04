/**
 * The packaged app does not ship the extension's webpack sources, so the
 * "Download extension package" button cannot build `dist/` locally — it pulls
 * the zips the matching GitHub release publishes instead. `index.ts` cannot be
 * imported, so this pins the contract the same way `compilePipeline.test.ts`
 * pins the compile body:
 *
 *   1. The release is *chosen* — the tag matching the app's version wins; the
 *      newest release carrying the assets is the fallback for unreleased
 *      builds — never a silent "latest".
 *   2. The package is fetched as bytes and unpacked with `extract-zip`, the
 *      extractor the packaged app already bundles.
 *   3. Chromium and Firefox land as sibling folders named in the pane copy.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const main = readFileSync(join(appRoot, 'src/index.ts'), 'utf8');
const pane = readFileSync(
  join(appRoot, 'src/deploy/panes/BrowserExtensionPane.tsx'),
  'utf8',
);

/** The `download-extension` IPC handler body. */
function handlerBody(): string {
  const start = main.indexOf("ipcMain.handle('download-extension'");
  if (start < 0) throw new Error('download-extension handler was not found');
  const end = main.indexOf("ipcMain.handle('get-export-format'", start);
  if (end < 0) throw new Error('download-extension handler is unterminated');
  return main.slice(start, end);
}

describe('the extension package download', () => {
  test('chooses the release honestly — matching tag first, never a silent latest', () => {
    expect(main).toContain('async function findExtensionRelease');
    const helper = main.slice(
      main.indexOf('async function findExtensionRelease'),
      main.indexOf('// Global cache of latest compiled rules'),
    );
    expect(helper).toContain('/tags/${encodeURIComponent(tag)}');
    expect(helper).toContain('?per_page=10');
    // Drafts and asset-less releases are both ineligible for the fallback.
    expect(helper).toContain('!rel.draft');
    expect(helper).toContain('releaseHasExtensionAssets');
  });

  test('downloads bytes and unpacks them where the user picks', () => {
    const body = handlerBody();
    expect(body).toContain('browser_download_url');
    expect(body).toContain('await res.arrayBuffer()');
    expect(body).toContain('JSZip.loadAsync');
    // Entries whose resolved path escapes the destination are refused.
    expect(body).toContain('zip-slip');
    // The leftover from the old bundled-build path must stay gone.
    expect(body).not.toContain('webpackBin');
    expect(body).not.toContain('not bundled with this install');
  });

  test('lands the two packages as the sibling folders the pane names', () => {
    const body = handlerBody();
    expect(body).toContain("dirName: 'blockingmachine-extension'");
    expect(body).toContain("dirName: 'blockingmachine-extension-firefox'");
    expect(body).toContain('chrome-mv3');
    expect(body).toContain('firefox-mv3');
    // The pane copy names the same folders the handler writes.
    expect(pane).toContain('blockingmachine-extension-firefox');
    expect(pane).toContain('manifest.json');
  });
});
