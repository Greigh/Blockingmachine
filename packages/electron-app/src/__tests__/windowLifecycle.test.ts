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

  test('the View menu binds the four section accelerators — nothing else may hold a ⌘ digit', () => {
    const start = main.indexOf("label: 'View'");
    const menu = main.slice(start, main.indexOf("label: 'Window'", start));
    // Menu accelerators are matched natively before the renderer sees a keydown:
    // these pairs ARE the section keymap on the shipping platform, so the sidebar's
    // ⌘1–⌘4 hints and the registry order must agree with them exactly.
    const items = [...menu.matchAll(/label: '([^']+)',\s*accelerator: 'Cmd\+(\d)',[\s\S]*?navigate-view', '([^']+)'/g)]
      .map((m) => ({ label: m[1], key: m[2], view: m[3] }));
    expect(items).toEqual([
      { label: 'Home', key: '1', view: 'process' },
      { label: 'Rules', key: '2', view: 'sources' },
      { label: 'Discover', key: '3', view: 'ai-radar' },
      { label: 'Distribute', key: '4', view: 'deploy' },
    ]);
    // The retired per-view digits must not come back — a re-added ⌘5..⌘9 would
    // silently eat the renderer keymap again.
    const digits = [...menu.matchAll(/accelerator: 'Cmd\+(\d)'/g)].map((m) => m[1]);
    expect(digits).toEqual(['1', '2', '3', '4']);
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

describe('menu-bar agent mode', () => {
  test('window close hides to the status bar only when the toggle is on and no quit is underway', () => {
    expect(main).toContain("thisWindow.on('close'");
    const closeHandler = main.slice(
      main.indexOf("thisWindow.on('close'"),
      main.indexOf("thisWindow.on('close'") + 700,
    );
    expect(closeHandler).toContain('isQuitting');
    expect(closeHandler).toContain('menuBarAgentEnabled()');
    expect(closeHandler).toContain('event.preventDefault()');
    expect(closeHandler).toContain('thisWindow.hide()');
    expect(closeHandler).toContain('app.dock?.hide()');
  });

  test('a real quit is flagged so the close interceptor stands down', () => {
    const beforeQuit = main.slice(
      main.indexOf("app.on('before-quit'"),
      main.indexOf("app.on('before-quit'") + 300,
    );
    expect(beforeQuit).toContain('isQuitting = true');
  });

  test('the toggle is persisted in the store and exposed over IPC + preload', () => {
    expect(main).toContain('menuBarAgent: {');
    expect(main).toContain("ipcMain.handle('get-menu-bar-agent'");
    expect(main).toContain("ipcMain.handle('set-menu-bar-agent'");
    expect(preload).toContain("'get-menu-bar-agent'");
    expect(preload).toContain("'set-menu-bar-agent'");
  });

  test('turning the agent off while hidden surfaces the app again', () => {
    const handler = main.slice(
      main.indexOf("ipcMain.handle('set-menu-bar-agent'"),
      main.indexOf("ipcMain.handle('set-menu-bar-agent'") + 1200,
    );
    expect(handler).toContain('app.dock?.show()');
    expect(handler).toContain('win.show()');
  });

  test('a login-item launch starts hidden only when the agent is on', () => {
    const init = main.slice(
      main.indexOf('wasOpenedAtLogin'),
      main.indexOf('wasOpenedAtLogin') + 900,
    );
    expect(init).toContain('startInMenuBar');
    expect(init).toContain('menuBarAgentEnabled()');
    expect(init).toContain('app.dock?.hide()');
    expect(main).toContain('createWindow(!startInMenuBar)');
  });

  test('reopen paths — activate and second-instance — surface the window and the Dock icon', () => {
    expect(main).toContain('function showMainWindow');
    const show = main.slice(
      main.indexOf('function showMainWindow'),
      main.indexOf('function showMainWindow') + 800,
    );
    expect(show).toContain('app.dock?.show()');
    const activate = main.slice(
      main.indexOf("app.on('activate'"),
      main.indexOf("app.on('activate'") + 250,
    );
    expect(activate).toContain('showMainWindow()');
    const second = main.slice(
      main.indexOf("app.on('second-instance'"),
      main.indexOf("app.on('second-instance'") + 250,
    );
    expect(second).toContain('showMainWindow()');
  });

  test('a second instance can never initialize — the lock gates whenReady', () => {
    expect(main).toContain('app.requestSingleInstanceLock()');
    const tail = main.slice(main.indexOf('app.requestSingleInstanceLock()'));
    expect(tail).toContain('app.quit()');
    expect(tail.indexOf('app.quit()')).toBeLessThan(tail.indexOf('.whenReady()'));
  });

  test('tray actions route through showMainWindow/sendToWindow, not a nullable window', () => {
    const tray = readFileSync(join(appRoot, 'src/trayManager.ts'), 'utf8');
    expect(tray).not.toContain('getMainWindow');
    expect(tray).toContain('this.options.showMainWindow()');
    expect(tray).toContain('this.options.sendToWindow("navigate-view", "deploy")');
    expect(tray).toContain('this.options.sendToWindow("open-settings")');
    const wiring = main.slice(
      main.indexOf('new TrayManager'),
      main.indexOf('new TrayManager') + 600,
    );
    expect(wiring).toContain('showMainWindow: () => showMainWindow()');
    expect(wiring).toContain('sendToWindow');
  });
});
