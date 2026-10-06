import { spawn, execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

export function isValidServiceName(name: string): boolean {
  return typeof name === 'string' && name.trim().length > 0 && /^[a-zA-Z0-9_\- ]+$/.test(name);
}

export interface DaemonStatus {
  status: 'running' | 'paused' | 'stopped';
  port: number;
  controlPort: number;
  upstream: string;
  rulesLoaded: number;
  protectionEnabled: boolean;
  uptimeSeconds: number;
  managedByApp: boolean;
  stats?: {
    totalQueries: number;
    blockedQueries: number;
    allowedQueries: number;
    blockRatePercent: number;
  };
}

export class DaemonManager {
  private childProcess: ChildProcess | null = null;
  private controlPort = 9292;
  private dnsPort = 5353; // default user-space loopback port; port 53 if running via launchd/systemd
  private bindHost = '127.0.0.1';

  constructor(options?: { controlPort?: number; dnsPort?: number }) {
    if (options?.controlPort) this.controlPort = options.controlPort;
    if (options?.dnsPort) this.dnsPort = options.dnsPort;
  }

  /**
   * Probes the HTTP Control API on port 9292 to determine if the daemon is running.
   */
  async getStatus(): Promise<DaemonStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    try {
      const res = await fetch(`http://${this.bindHost}:${this.controlPort}/v1/status`, {
        signal: controller.signal,
      });

      if (res.ok) {
        const data = await res.json();
        return {
          status: data.status || 'running',
          port: data.port || this.dnsPort,
          controlPort: this.controlPort,
          upstream: data.upstream || 'https://dns.quad9.net/dns-query',
          rulesLoaded: data.rulesLoaded || 0,
          protectionEnabled: data.protectionEnabled ?? true,
          uptimeSeconds: data.uptimeSeconds || 0,
          managedByApp: this.childProcess !== null,
          stats: data.stats,
        };
      }
    } catch {
      // Control API is unreachable
    } finally {
      clearTimeout(timeout);
    }

    return {
      status: 'stopped',
      port: this.dnsPort,
      controlPort: this.controlPort,
      upstream: 'https://dns.quad9.net/dns-query',
      rulesLoaded: 0,
      protectionEnabled: false,
      uptimeSeconds: 0,
      managedByApp: false,
    };
  }

  /**
   * Spawns a background process running the system-daemon if not already active.
   * `feedFilePath`/`threatsFilePath` point at the persisted copies of the artifacts the
   * feed server publishes — the daemon keeps them as its reload fallback, so a daemon
   * that outlives the app (it is spawned detached deliberately) can still refresh from
   * the last compiled snapshot on disk instead of degrading to the baseline.
   */
  async start(options?: { feedFilePath?: string; threatsFilePath?: string }): Promise<{ success: boolean; message: string }> {
    const current = await this.getStatus();
    if (current.status !== 'stopped') {
      return { success: true, message: `System daemon is already active on port ${current.port}` };
    }

    // Resolve script path. Packaged builds ship the daemon as the
    // `systemDaemon.cjs` webpack bundle — `asarUnpack`'d beside the workers,
    // so the spawn target is a real file, not an asar virtual path. The
    // `packages/...` entries stay for the dev monorepo.
    const candidatePaths = [
      ...(process.resourcesPath
        ? [path.join(process.resourcesPath, 'app.asar.unpacked', '.webpack', 'main', 'systemDaemon.cjs')]
        : []),
      path.resolve(__dirname, '../../system-daemon/dist/index.js'),
      // Forge dev: __dirname lands in packages/electron-app/.webpack/main and the
      // cwd is the package dir, so repo-root joins miss the workspace build.
      path.resolve(__dirname, '../../../system-daemon/dist/index.js'),
      path.resolve(process.cwd(), '../system-daemon/dist/index.js'),
      path.resolve(__dirname, '../packages/system-daemon/dist/index.js'),
      path.resolve(process.cwd(), 'packages/system-daemon/dist/index.js'),
      path.resolve(process.cwd(), 'node_modules/@blockingmachine/system-daemon/dist/index.js'),
    ];

    const entryPath = candidatePaths.find((p) => existsSync(p));

    if (!entryPath || !existsSync(entryPath)) {
      return {
        success: false,
        message: 'Could not find built @blockingmachine/system-daemon bundle. Please run npm run build.',
      };
    }

    const env = {
      ...process.env,
      // The spawn target is the Electron binary — run the daemon's Node entry as plain
      // Node rather than booting a second app instance for it.
      ELECTRON_RUN_AS_NODE: '1',
      DNS_PORT: String(this.dnsPort),
      CONTROL_PORT: String(this.controlPort),
      FEED_URL: 'http://127.0.0.1:9191/dns.txt',
      ...(options?.feedFilePath ? { FEED_FILE: options.feedFilePath } : {}),
      ...(options?.threatsFilePath ? { THREATS_FILE: options.threatsFilePath } : {}),
    };

    try {
      this.childProcess = spawn(process.execPath, [entryPath], {
        env,
        // stderr is piped so a bind failure or startup crash reaches the app
        // log — 'ignore' hid exactly those, and the caller then read a dead
        // spawn as success.
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
      });

      const child = this.childProcess;
      let childExit: number | null = null;
      child.once('exit', (code) => {
        childExit = code;
        if (this.childProcess === child) this.childProcess = null;
      });
      child.stderr?.on('data', (chunk) => {
        console.error(`[Daemon] ${String(chunk).trimEnd()}`);
      });
      child.unref();
      (child.stderr as { unref?: () => void } | null)?.unref?.();

      // Poll the control API — the daemon is only "started" once it answers,
      // not when spawn() returned. A port taken by something else (mDNS/adb on
      // 5353 is a real-world collision) reads as the honest failure it is.
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (childExit !== null) {
          return {
            success: false,
            message: `Daemon exited during startup (code ${childExit}) — check for a port conflict on ${this.dnsPort}/${this.controlPort}.`,
          };
        }
        const status = await this.getStatus();
        if (status.status !== 'stopped') {
          return { success: true, message: `System daemon started successfully on port ${status.port}` };
        }
      }

      return {
        success: false,
        message: `Daemon spawned but its control API never answered — something else may hold port ${this.dnsPort} or ${this.controlPort}.`,
      };
    } catch (err: any) {
      return { success: false, message: `Failed to spawn daemon: ${err?.message || err}` };
    }
  }

  /**
   * Stops the daemon process if managed by the application.
   */
  async stop(): Promise<{ success: boolean; message: string }> {
    if (this.childProcess) {
      try {
        this.childProcess.kill('SIGTERM');
        this.childProcess = null;
        return { success: true, message: 'Daemon process stopped.' };
      } catch (err: any) {
        return { success: false, message: `Failed to terminate daemon: ${err?.message || err}` };
      }
    }

    return {
      success: false,
      message: 'Daemon is running externally (system service). Use launchctl or systemctl to stop it.',
    };
  }

  /**
   * Hot-reloads filtering rules without dropping active DNS sockets.
   */
  async reloadRules(): Promise<{ success: boolean; rulesLoaded: number; message: string }> {
    try {
      const res = await fetch(`http://${this.bindHost}:${this.controlPort}/v1/reload`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        return {
          success: true,
          rulesLoaded: data.rulesLoaded || 0,
          message: data.message || `Successfully reloaded ${data.rulesLoaded || 0} rules`,
        };
      }
      return { success: false, rulesLoaded: 0, message: `Daemon responded with HTTP ${res.status}` };
    } catch (err: any) {
      return { success: false, rulesLoaded: 0, message: `Failed to reach daemon control API: ${err?.message || err}` };
    }
  }

  /**
   * Toggles protection on or off.
   */
  async toggleProtection(enabled?: boolean): Promise<{ success: boolean; protectionEnabled: boolean }> {
    try {
      const res = await fetch(`http://${this.bindHost}:${this.controlPort}/v1/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(typeof enabled === 'boolean' ? { enabled } : {}),
      });
      if (res.ok) {
        const data = await res.json();
        return { success: true, protectionEnabled: data.protectionEnabled };
      }
    } catch {
      // ignore
    }
    return { success: false, protectionEnabled: false };
  }

  /**
   * Retrieves active network services (macOS Wi-Fi, Ethernet, etc.)
   */
  async getNetworkServices(): Promise<string[]> {
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execFileAsync('networksetup', ['-listallnetworkservices']);
        const lines = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.includes('*') && !l.startsWith('An asterisk'));
        return lines.length > 0 ? lines : ['Wi-Fi'];
      } catch {
        return ['Wi-Fi'];
      }
    }
    return ['Default Interface'];
  }

  /**
   * Points the OS resolver to loopback (127.0.0.1)
   */
  async setSystemDns(serviceName = 'Wi-Fi'): Promise<{ success: boolean; message: string }> {
    if (!isValidServiceName(serviceName)) {
      return { success: false, message: `Invalid network service name: "${serviceName}"` };
    }
    if (process.platform === 'darwin') {
      try {
        await execFileAsync('networksetup', ['-setdnsservers', serviceName.trim(), '127.0.0.1']);
        await this.flushCache();
        return { success: true, message: `System DNS on "${serviceName}" set to 127.0.0.1.` };
      } catch (err: any) {
        return {
          success: false,
          message: `Unable to set DNS (may require admin privileges): ${err?.message || err}`,
        };
      }
    }
    return { success: false, message: `Automated DNS switching is supported on macOS. Manual setup required on this OS.` };
  }

  /**
   * Reverts the OS resolver to DHCP
   */
  async restoreSystemDns(serviceName = 'Wi-Fi'): Promise<{ success: boolean; message: string }> {
    if (!isValidServiceName(serviceName)) {
      return { success: false, message: `Invalid network service name: "${serviceName}"` };
    }
    if (process.platform === 'darwin') {
      try {
        await execFileAsync('networksetup', ['-setdnsservers', serviceName.trim(), 'Empty']);
        await this.flushCache();
        return { success: true, message: `System DNS on "${serviceName}" restored to DHCP default.` };
      } catch (err: any) {
        return { success: false, message: `Failed to restore DNS: ${err?.message || err}` };
      }
    }
    return { success: false, message: `Manual setup required on this OS.` };
  }

  /**
   * Flushes local operating system DNS cache
   */
  async flushCache(): Promise<{ success: boolean; message: string }> {
    if (process.platform === 'darwin') {
      try {
        await execFileAsync('dscacheutil', ['-flushcache']);
        return { success: true, message: 'macOS DNS resolver cache flushed successfully.' };
      } catch (err: any) {
        return { success: false, message: `Cache flush failed: ${err?.message || err}` };
      }
    } else if (process.platform === 'win32') {
      try {
        await execFileAsync('ipconfig', ['/flushdns']);
        return { success: true, message: 'Windows DNS resolver cache flushed.' };
      } catch (err: any) {
        return { success: false, message: `Cache flush failed: ${err?.message || err}` };
      }
    }
    return { success: true, message: 'DNS cache flush triggered.' };
  }

  /**
   * Injects one or more quarantined domains directly into the running DNS memory trie
   */
  async quarantineDomain(domainOrDomains: string | string[]): Promise<{ success: boolean; injected?: number; message?: string }> {
    const domains = Array.isArray(domainOrDomains) ? domainOrDomains : [domainOrDomains];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`http://${this.bindHost}:${this.controlPort}/v1/quarantine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domains }),
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        return { success: true, injected: data.injected || domains.length, message: `Injected ${domains.length} domain(s) into DNS memory trie` };
      }
      return { success: false, message: `Daemon returned status ${res.status}` };
    } catch (err: any) {
      return { success: false, message: `Could not inject into daemon: ${err?.message || err}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Generates formatted installation commands and scripts for macOS launchd and Linux systemd.
   * `feedFiles` are the persisted snapshots beside the compiled list — a service-installed
   * daemon runs without the app entirely, so the file fallback is what keeps its reloads on
   * real rules rather than the baseline. Optional so tests can render the stock shape.
   */
  getServiceInstallInstructions(feedFiles?: { feedFilePath?: string; threatsFilePath?: string }): { mac: string; linux: string } {
    // Plist values are XML text — an '&' or '<' in a save path would corrupt the document.
    const xml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const macFeedFileEnv = feedFiles?.feedFilePath
      ? `        <key>FEED_FILE</key>\n        <string>${xml(feedFiles.feedFilePath)}</string>\n`
      : '';
    const macThreatsEnv = feedFiles?.threatsFilePath
      ? `        <key>THREATS_FILE</key>\n        <string>${xml(feedFiles.threatsFilePath)}</string>\n`
      : '';
    const linuxFeedFileEnv = feedFiles?.feedFilePath
      ? `Environment="FEED_FILE=${feedFiles.feedFilePath}"\n`
      : '';
    const linuxThreatsEnv = feedFiles?.threatsFilePath
      ? `Environment="THREATS_FILE=${feedFiles.threatsFilePath}"\n`
      : '';
    const macPlist = `sudo tee /Library/LaunchDaemons/com.blockingmachine.daemon.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.blockingmachine.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${path.resolve(process.cwd(), 'packages/system-daemon/dist/index.js')}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <!-- The program above is the Electron binary; run the daemon's Node entry as Node. -->
        <key>ELECTRON_RUN_AS_NODE</key>
        <string>1</string>
        <key>DNS_PORT</key>
        <string>53</string>
        <key>CONTROL_PORT</key>
        <string>9292</string>
        <key>FEED_URL</key>
        <string>http://127.0.0.1:9191/dns.txt</string>
${macFeedFileEnv}${macThreatsEnv}    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF
sudo chown root:wheel /Library/LaunchDaemons/com.blockingmachine.daemon.plist
sudo chmod 644 /Library/LaunchDaemons/com.blockingmachine.daemon.plist
sudo launchctl load -w /Library/LaunchDaemons/com.blockingmachine.daemon.plist`;

    const linuxService = `sudo tee /etc/systemd/system/blockingmachine.service << 'EOF'
[Unit]
Description=Blockingmachine Loopback DNS Filtering Proxy
After=network.target

[Service]
Type=simple
User=root
ExecStart=${process.execPath} ${path.resolve(process.cwd(), 'packages/system-daemon/dist/index.js')}
Restart=always
Environment="ELECTRON_RUN_AS_NODE=1"
Environment="DNS_PORT=53"
Environment="CONTROL_PORT=9292"
Environment="FEED_URL=http://127.0.0.1:9191/dns.txt"
${linuxFeedFileEnv}${linuxThreatsEnv}
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now blockingmachine`;

    return { mac: macPlist, linux: linuxService };
  }
}
