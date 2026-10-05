import { join } from "path";
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { existsSync } from "fs";
import {
  buildTrayMenu,
  buildTrayTooltip,
  TrayEpoch,
  type TrayActionRow,
  type TraySharedState,
} from "./trayMenu";

// Re-exported so callers that already import the tray surface keep working.
export type { TraySharedState };

/**
 * Resilient menu-bar (Tray) controller for Blockingmachine.
 *
 * Stability guarantees the old inline implementation lacked:
 *  - All window access is guarded against destroyed/missing windows.
 *  - Menu rebuilds are serialized + coalesced so a rapid event storm (progress
 *    ticks, SSE pings, protection toggles) can never stack rebuilds or crash
 *    the main process.
 *  - The tray is idempotent: ensureTray() may be called any number of times
 *    without creating duplicate menu-bar icons (a real Electron failure mode
 *    after theme restarts).
 *  - The icon pipeline never throws and never blurs a Retina asset by resizing
 *    a @2x image down to 18pt.
 *  - Every menu item performs a real action and reflects live app state.
 */

export interface TrayManagerOptions {
  getMainWindow: () => BrowserWindow | null;
  /** Absolute path of the compiled rules file, or null. */
  getSavePath: () => string | null;
  /** Kick off a background compilation (main-process pipeline). */
  triggerCompile: () => void;
  /** Whether a compilation is currently in flight. */
  isCompiling: () => boolean;
  /** Pause/resume system DNS daemon protection. */
  setProtection: (enabled: boolean) => Promise<boolean>;
  /** Spawn the managed local DNS daemon (the :5353 resolver). */
  startDaemon: () => Promise<boolean>;
  /** Flush the OS DNS cache. */
  flushDnsCache: () => Promise<boolean>;
  /** Live state provider, called on every menu open + rebuild. */
  getState: () => TraySharedState;
}

function safeShowWindow(win: BrowserWindow | null): void {
  try {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  } catch {
    // window died between check and call
  }
}

export class TrayManager {
  private tray: Tray | null = null;
  private options: TrayManagerOptions;
  private rebuildQueued = false;
  private rebuilding = false;
  private templateIconCache:
    | { image: Electron.NativeImage; path: string }
    | null = null;
  /** Bumped on every rebuild; stale clicks no-op safely. */
  private epoch = new TrayEpoch();

  constructor(options: TrayManagerOptions) {
    this.options = options;
  }

  // --------------------------------------------------------------------------
  // Icon pipeline (null-safe, Retina-correct)
  // --------------------------------------------------------------------------

  private resolveAssetPath(filename: string): string {
    const candidates = [
      join(process.resourcesPath ?? "", "assets", filename),
      join(process.resourcesPath ?? "", filename),
      join(app.getAppPath(), "assets", filename),
      join(__dirname, "../assets", filename),
      join(__dirname, "../../assets", filename),
      join(process.cwd(), "packages/electron-app/assets", filename),
      join(process.cwd(), "assets", filename),
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // try next candidate
      }
    }
    return "";
  }

  private getTemplateIcon(): Electron.NativeImage {
    for (const name of ["trayTemplate.png", "trayTemplate@2x.png"]) {
      const p = this.resolveAssetPath(name);
      if (!p) continue;
      const cached = this.templateIconCache;
      if (cached && cached.path === p && !cached.image.isEmpty()) {
        return cached.image;
      }
      try {
        const image = nativeImage.createFromPath(p);
        if (image.isEmpty()) continue;

        if (p.endsWith("@2x.png")) {
          const finalImage = nativeImage.createFromPath(p);
          finalImage.setTemplateImage(true);
          this.templateIconCache = { image: finalImage, path: p };
          return finalImage;
        }

        image.setTemplateImage(true);
        const twoX = this.resolveAssetPath("trayTemplate@2x.png");
        if (twoX) {
          try {
            const rep = nativeImage.createFromPath(twoX);
            if (!rep.isEmpty()) {
              image.addRepresentation({
                scaleFactor: 2.0,
                buffer: rep.toPNG(),
              });
            }
          } catch {
            // 1x alone is fine
          }
        }
        this.templateIconCache = { image, path: p };
        return image;
      } catch {
        continue;
      }
    }

    // Last-resort monochrome 16pt fallback so the menu bar never shows a
    // broken/empty icon slot.
    try {
      const size = 16;
      const canvas = Buffer.alloc(size * size * 4, 0);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const idx = (y * size + x) * 4;
          const inner = x >= 3 && x <= 12 && y >= 2 && y <= 13;
          const hole = x >= 6 && x <= 9 && y >= 5 && y <= 8;
          const alpha = inner && !hole ? 255 : 0;
          canvas[idx + 0] = 0;
          canvas[idx + 1] = 0;
          canvas[idx + 2] = 0;
          canvas[idx + 3] = alpha;
        }
      }
      const img = nativeImage.createFromBitmap(
        canvas,
        { width: size, height: size },
      );
      img.setTemplateImage(true);
      return img;
    } catch {
      return nativeImage.createEmpty();
    }
  }

  // --------------------------------------------------------------------------
  // Menu construction
  // --------------------------------------------------------------------------

  private buildMenu(): void {
    if (!this.tray) return;
    const state = this.safeGetState();
    const compiling = this.safeIsCompiling();
    const epoch = this.epoch.bump();

    // The rows themselves come from the pure, unit-testable model; this method
    // only turns them into Electron menu items and binds real handlers.
    const items: MenuItemConstructorOptions[] = buildTrayMenu(
      state,
      compiling,
    ).map((row) => {
      if (row.type === "separator") return { type: "separator" };
      // `&` is Electron's mnemonic marker and is stripped from the rendered
      // label on every platform — "Compile & Update" renders as
      // "Compile  Update". `&&` is the escape for a literal ampersand.
      const label = row.label.replace(/&/g, "&&");
      if (row.type === "status") return { label, enabled: false };
      const item: MenuItemConstructorOptions = {
        label,
        enabled: row.enabled,
        click: () => {
          void this.runAction(row, epoch);
        },
      };
      if (row.accelerator) {
        item.accelerator = row.accelerator;
      }
      return item;
    });

    try {
      this.tray.setContextMenu(Menu.buildFromTemplate(items));
      this.tray.setToolTip(buildTrayTooltip(state, compiling));
    } catch (err) {
      console.warn("[Tray] Menu rebuild failed:", err);
    }
  }

  /**
   * Perform the action behind a menu row. Any click captured before a rebuild
   * is stale and no-ops; quit is exempt so the app always closes.
   */
  private async runAction(row: TrayActionRow, epoch: number): Promise<void> {
    if (row.id === "quit") {
      app.quit();
      return;
    }
    if (!this.epoch.isCurrent(epoch)) return;

    switch (row.id) {
      case "open":
        safeShowWindow(this.options.getMainWindow());
        return;
      case "compile":
        this.options.triggerCompile();
        this.scheduleRebuild();
        return;
      case "toggle-protection": {
        const next = row.protectionEnabled ?? true;
        const ok = await this.safeSetProtection(next);
        if (ok) {
          this.notify("DNS Protection", next ? "Resumed" : "Paused");
        }
        this.scheduleRebuild();
        return;
      }
      case "start-daemon": {
        const ok = await this.safeStartDaemon();
        this.notify(
          "DNS Protection",
          ok ? "Daemon started." : "Start failed — see logs.",
        );
        this.scheduleRebuild();
        return;
      }
      case "flush-dns": {
        const ok = await this.safeFlushDns();
        this.notify(
          "DNS Cache",
          ok ? "Flushed successfully." : "Flush failed — see logs.",
        );
        return;
      }
      case "open-deploy":
        safeShowWindow(this.options.getMainWindow());
        try {
          this.options.getMainWindow()?.webContents.send(
            "navigate-view",
            "deploy",
          );
        } catch {
          // window destroyed mid-send
        }
        return;
      case "reveal-output":
        this.safeRevealOutput();
        return;
      case "open-settings":
        safeShowWindow(this.options.getMainWindow());
        try {
          this.options.getMainWindow()?.webContents.send("open-settings");
        } catch {
          // ignore
        }
        return;
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  ensureTray(): void {
    try {
      if (!this.tray) {
        this.tray = new Tray(this.getTemplateIcon());
        console.log("[Tray] Menu-bar icon created.");
        if (process.platform === "darwin") {
          const tray = this.tray as unknown as {
            onClickMenu?: () => void;
          } | null;
          // On macOS, left-click also opens the context menu so the functional
          // actions (compile, protection, flush, deploy) are immediately
          // reachable without hunting for the right-click spot.
          try {
            if (tray && typeof (tray as any).onClick === "function") {
              (tray as any).on("click", () => {
                try {
                  this.tray?.popUpContextMenu();
                } catch {
                  // popUpContextMenu may be unavailable in some Electron
                  // versions; best-effort only.
                }
              });
            } else if (typeof (this.tray as any).popUpContextMenu === "function") {
              // Prefer the documented API when available.
              this.tray.on("click", () => {
                try {
                  this.tray?.popUpContextMenu();
                } catch {
                  // ignore
                }
              });
            }
          } catch {
            // best-effort only
          }
        }
      }
      this.buildMenu();
    } catch (err) {
      console.warn("[Tray] ensureTray failed:", err);
      this.tray = null;
    }
  }

  /**
   * Rebuild the menu with fresh state. Concurrent calls are coalesced and
   * serialized so rapid events (progress ticks, SSE pings) can't stack rebuilds
   * — one of the main sources of menu-bar jank/crashes.
   */
  scheduleRebuild(): void {
    if (this.rebuilding) {
      this.rebuildQueued = true;
      return;
    }
    this.rebuilding = true;
    try {
      this.buildMenu();
    } finally {
      this.rebuilding = false;
      if (this.rebuildQueued) {
        this.rebuildQueued = false;
        setImmediate(() => this.scheduleRebuild());
      }
    }
  }

  /** Called when a compilation finishes; refresh menu + notify. */
  onCompileCompleted(summary: {
    ruleCount: number;
    success: boolean;
    error?: string;
  }): void {
    if (!summary.success) {
      this.notify("Compilation Failed", summary.error || "Unknown error");
    }
    this.scheduleRebuild();
  }

  /** Called from the compile pipeline on every progress tick. */
  onCompileProgress(progress: { status: string; percent: number }): void {
    void progress;
    this.scheduleRebuild();
  }

  destroy(): void {
    try {
      this.tray?.destroy();
    } catch {
      // ignore
    }
    this.tray = null;
    this.templateIconCache = null;
  }

  isAlive(): boolean {
    return this.tray !== null;
  }

  // --------------------------------------------------------------------------
  // Safety wrappers
  // --------------------------------------------------------------------------

  private safeGetState(): TraySharedState {
    try {
      const s = this.options.getState();
      return {
        lastProcessTime: s?.lastProcessTime ?? null,
        lastRuleCount:
          typeof s?.lastRuleCount === "number" ? s.lastRuleCount : null,
        compileProgress: s?.compileProgress ?? null,
        feedServer: s?.feedServer ?? null,
        protection: s?.protection ?? null,
      };
    } catch {
      return {
        lastProcessTime: null,
        lastRuleCount: null,
        compileProgress: null,
        feedServer: null,
        protection: null,
      };
    }
  }

  private safeIsCompiling(): boolean {
    try {
      return Boolean(this.options.isCompiling());
    } catch {
      return false;
    }
  }

  private async safeSetProtection(enabled: boolean): Promise<boolean> {
    try {
      return await this.options.setProtection(enabled);
    } catch {
      return false;
    }
  }

  private async safeStartDaemon(): Promise<boolean> {
    try {
      return await this.options.startDaemon();
    } catch {
      return false;
    }
  }

  private async safeFlushDns(): Promise<boolean> {
    try {
      return await this.options.flushDnsCache();
    } catch {
      return false;
    }
  }

  private safeRevealOutput(): void {
    try {
      const p = this.options.getSavePath();
      if (p) {
        shell.showItemInFolder(p);
      } else {
        shell.openPath(
          join(app.getPath("documents"), "Blockingmachine"),
        );
      }
    } catch (err) {
      console.warn("[Tray] Reveal output failed:", err);
    }
  }

  private notify(title: string, body: string): void {
    try {
      if (Notification.isSupported()) {
        new Notification({ title, body }).show();
      }
    } catch {
      // notifications are best-effort
    }
  }
}
