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
   */
  async start(): Promise<{ success: boolean; message: string }> {
    const current = await this.getStatus();
    if (current.status !== 'stopped') {
      return { success: true, message: `System daemon is already active on port ${current.port}` };
    }

    // Resolve script path
    const candidatePaths = [
      path.resolve(__dirname, '../../system-daemon/dist/index.js'),
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
      DNS_PORT: String(this.dnsPort),
      CONTROL_PORT: String(this.controlPort),
      FEED_URL: 'http://127.0.0.1:9191/dns.txt',
    };

    try {
      this.childProcess = spawn(process.execPath, [entryPath], {
        env,
        stdio: 'ignore',
        detached: true,
      });

      this.childProcess.unref();

      // Wait briefly for startup
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const status = await this.getStatus();
        if (status.status !== 'stopped') {
          return { success: true, message: `System daemon started successfully on port ${status.port}` };
        }
      }

      return { success: true, message: 'Daemon process spawned.' };
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
   * Generates formatted installation commands and scripts for macOS launchd and Linux systemd
   */
  getServiceInstallInstructions(): { mac: string; linux: string } {
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
        <key>DNS_PORT</key>
        <string>53</string>
        <key>CONTROL_PORT</key>
        <string>9292</string>
        <key>FEED_URL</key>
        <string>http://127.0.0.1:9191/dns.txt</string>
    </dict>
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
Environment="DNS_PORT=53"
Environment="CONTROL_PORT=9292"
Environment="FEED_URL=http://127.0.0.1:9191/dns.txt"

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now blockingmachine`;

    return { mac: macPlist, linux: linuxService };
  }
}
