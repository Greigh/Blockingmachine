/**
 * Wiring pins for the destroyed-window lifecycle fix (H1).
 *
 * macOS keeps the app alive after the last window closes — the menu and tray are the
 * primary surface — so every `mainWindow.webContents.send` on a closed window threw
 * "Object has been destroyed", silently killing every menu/tray action. The contract now:
 * the global is nulled on 'closed', sends go through a queueing `sendToWindow`, and the
 * renderer announces its subscriptions with 'renderer-ready' so queued messages land.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const main = readFileSync(join(appRoot, 'src/index.ts'), 'utf8');
const preload = readFileSync(join(appRoot, 'src/preload.ts'), 'utf8');
const app = readFileSync(join(appRoot, 'src/App.tsx'), 'utf8');

describe('mainWindow lifecycle', () => {
  test('the global reference is nulled when the window closes', () => {
    expect(main).toContain("thisWindow.on('closed'");
    // Identity-guarded: a stale window's late `closed` must not null its replacement.
    expect(main).toContain('if (mainWindow === thisWindow) mainWindow = null');
  });

  test('menu actions route through the queueing sender, not raw webContents.send', () => {
    const start = main.indexOf('MenuItemConstructorOptions[] = [');
    const menu = main.slice(start, main.indexOf('Menu.setApplicationMenu', start));
    // Every menu click must use sendToWindow — a bare webContents.send on a destroyed
    // window is the crash this fixes.
    const rawSends = menu.match(/mainWindow\??\.webContents\.send/g) ?? [];
    expect(rawSends).toEqual([]);
    expect(menu).toContain("sendToWindow('trigger-compile')");
    expect(menu).toContain("sendToWindow('navigate-view'");
  });

  test('every remaining direct send is destroyed-guarded (broadcasts, not commands)', () => {
    const lines = main.split('\n');
    const offenderLines: number[] = [];
    lines.forEach((line, i) => {
      if (!/mainWindow\??\.webContents\.send/.test(line)) return;
      // sendToWindow is the queueing sender — its own send is guarded inside.
      const context = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
      if (!context.includes('isDestroyed()')) offenderLines.push(i + 1);
    });
    expect(offenderLines).toEqual([]);
  });

  test('sendToWindow recreates the window when none is live and queues the message', () => {
    const helper = main.slice(main.indexOf('async function sendToWindow'), main.indexOf('async function sendToWindow') + 1400);
    expect(helper).toContain('pendingWindowMessages.push');
    expect(helper).toContain('await createWindow()');
    expect(helper).toContain('isDestroyed()');
  });

  test('queued messages flush on renderer-ready', () => {
    const listener = main.slice(main.indexOf("ipcMain.on('renderer-ready'"), main.indexOf("ipcMain.on('renderer-ready'") + 900);
    expect(listener).toContain('pendingWindowMessages.splice');
    expect(listener).toContain('rendererReady = true');
  });

  test('the preload exposes the ready signal and App sends it after subscribing', () => {
    expect(preload).toContain("ipcRenderer.send('renderer-ready')");
    expect(app).toContain('window.electron?.rendererReady?.()');
  });

  test('reload resets readiness so sends during it queue instead of dropping', () => {
    expect(main).toContain("did-start-loading");
    const block = main.slice(main.indexOf("did-start-loading"), main.indexOf("did-start-loading") + 300);
    expect(block).toContain('rendererReady = false');
  });
});
