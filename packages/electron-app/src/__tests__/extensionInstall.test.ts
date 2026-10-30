/**
 * The guided extension install is the pane's primary path: the app stages the
 * bundled `dist/` it already carries into its own stable directory, puts the
 * path on the clipboard, and opens the browser's load page. `index.ts` cannot
 * be imported, so this pins the contract the same way
 * `extensionDownload.test.ts` pins the download leg:
 *
 *   1. The staged destination never changes — `userData/extension/<flavor>` —
 *      because a stable path is what keeps an unpacked install's extension ID
 *      (and with it chrome.storage, pairing and decisions) stable across app
 *      updates.
 *   2. The Firefox staging applies the same gecko-id manifest patch
 *      `package-extension.mjs` bakes into the release zip.
 *   3. The clipboard carries the path and `open -a` lands the browser on its
 *      own load page — the last click (Developer mode → Load unpacked) stays
 *      the browser's, on purpose.
 *   4. The app ships the source: `extraResource` must carry the webpack dist.
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
const forge = readFileSync(join(appRoot, 'forge.config.cjs'), 'utf8');

/** The `install-browser-extension` IPC handler body. */
function handlerBody(): string {
  const start = main.indexOf("ipcMain.handle('install-browser-extension'");
  if (start < 0) throw new Error('install-browser-extension handler was not found');
  const end = main.indexOf("ipcMain.handle('get-export-format'", start);
  if (end < 0) throw new Error('install-browser-extension handler is unterminated');
  return main.slice(start, end);
}

describe('the guided extension install', () => {
  test('ships the built extension inside the app — no download on the happy path', () => {
    // The packager copies each extraResource preserving its basename, so the
    // webpack dist lands as resources/dist — the handler's first candidate.
    expect(forge).toContain("'../browser-extension/dist'");
    const body = handlerBody();
    expect(body).toContain("join(process.resourcesPath, 'dist')");
    // Dev runs resolve the workspace copy the build writes.
    expect(body).toContain("../browser-extension/dist");
    // A missing bundle fails honestly — it names the fallback (release download).
    expect(body).toContain('No bundled extension build found');
    expect(body).toContain('manifest.json');
  });

  test('stages into the app-owned stable path — that stability IS the feature', () => {
    const body = handlerBody();
    // Same path every install: an unpacked extension's ID derives from the
    // load path, so moving it would mint a new extension with empty storage.
    expect(body).toContain("app.getPath('userData')");
    expect(body).toContain("'extension', flavor");
    // Stage-beside-then-swap: a half-copied tree can never serve as the
    // installed extension, and the staging dir is process-named so two runs
    // cannot collide.
    expect(body).toContain('.staging-${process.pid}');
    expect(body).toContain('fs.cp');
    expect(body).toContain('fs.rename');
    // The choice is validated main-side — unknown values become 'chromium',
    // never an unchecked branch.
    expect(body).toContain("requested === 'firefox' ? 'firefox' : 'chromium'");
  });

  test('patches the Firefox manifest the way the release zip is patched', () => {
    const body = handlerBody();
    // The gecko id is what about:debugging needs for a named temporary
    // install — package-extension.mjs bakes it into the zip; the staged copy
    // gets the same treatment.
    expect(body).toContain('browser_specific_settings');
    expect(body).toContain('blockingmachine@greighstudios.com');
  });

  test('automates everything except the browser’s own last click', () => {
    const body = handlerBody();
    // The path rides the clipboard for the file picker's ⌘⇧G box.
    expect(body).toContain('clipboard.writeText');
    // The browser is launched onto its own load page — `open -a` targets the
    // app by name so the page lands in the right browser, not the default.
    expect(main).toContain("execFileAsync('open', ['-a', browser, url])");
    expect(main).toContain("'chrome://extensions'");
    expect(main).toContain("'about:debugging#/runtime/this-firefox'");
    // The handler reports which browser opened so the pane can name it —
    // and null when nothing could, which the pane surfaces rather than hides.
    expect(body).toContain('opened');
    // No step pretends to press the browser's install button.
    expect(main).not.toContain('autoInstallExtension');
  });

  test('the pane offers guided install as the primary action and names the honest limit', () => {
    expect(pane).toContain('handleInstallExtension');
    // Guided runs one flavor at a time — 'both' disables it with a reason, so
    // the clipboard can never carry the other browser's path by surprise.
    expect(pane).toContain("extensionBrowser === 'both'");
    expect(pane).toContain('Install into browser');
    // The steps now tell the user the path is already on the clipboard.
    expect(pane).toContain('⌘⇧G');
    // The release download remains as the unmanaged-build fallback.
    expect(pane).toContain('Download release package');
    // The pane copy says plainly why the stable path matters.
    expect(pane).toContain('stable');
  });
});
