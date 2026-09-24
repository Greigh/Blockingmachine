/**
 * OS System Service & Daemon Configuration Generators
 * Produces native, production-grade service unit definitions for macOS launchd,
 * Linux systemd, and Windows Service wrappers.
 */

export interface ServiceGeneratorOptions {
  nodePath?: string;
  daemonScriptPath?: string;
  dnsPort?: number;
  controlPort?: number;
  feedUrl?: string;
  logPath?: string;
}

/**
 * Generates an Apple launchd Property List (plist) XML string
 * Target destination: /Library/LaunchDaemons/com.blockingmachine.daemon.plist
 */
export function generateMacLaunchdPlist(options: ServiceGeneratorOptions = {}): string {
  const nodePath = options.nodePath || '/usr/local/bin/node';
  const scriptPath = options.daemonScriptPath || '/usr/local/lib/node_modules/@blockingmachine/system-daemon/bin/blockingmachine-daemon.js';
  const dnsPort = options.dnsPort ?? 53;
  const controlPort = options.controlPort ?? 9292;
  const feedUrl = options.feedUrl || 'http://127.0.0.1:9191/dns.txt';
  const stdoutPath = options.logPath || '/var/log/blockingmachine-daemon.log';
  const stderrPath = options.logPath || '/var/log/blockingmachine-daemon.err';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.blockingmachine.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${scriptPath}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>DNS_PORT</key>
        <string>${dnsPort}</string>
        <key>CONTROL_PORT</key>
        <string>${controlPort}</string>
        <key>FEED_URL</key>
        <string>${feedUrl}</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>
</dict>
</plist>
`;
}

/**
 * Generates a systemd service unit file content for Linux
 * Target destination: /etc/systemd/system/blockingmachine.service
 */
export function generateLinuxSystemdUnit(options: ServiceGeneratorOptions = {}): string {
  const nodePath = options.nodePath || '/usr/bin/node';
  const scriptPath = options.daemonScriptPath || '/usr/local/lib/node_modules/@blockingmachine/system-daemon/bin/blockingmachine-daemon.js';
  const dnsPort = options.dnsPort ?? 53;
  const controlPort = options.controlPort ?? 9292;
  const feedUrl = options.feedUrl || 'http://127.0.0.1:9191/dns.txt';

  return `[Unit]
Description=Blockingmachine Loopback DNS Filtering Proxy
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=${nodePath} ${scriptPath}
Restart=always
RestartSec=5s
Environment="DNS_PORT=${dnsPort}"
Environment="CONTROL_PORT=${controlPort}"
Environment="FEED_URL=${feedUrl}"
Environment="NODE_ENV=production"
AmbientCapabilities=CAP_NET_BIND_SERVICE
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Provides shell commands for installing and starting the daemon service on macOS
 */
export function getMacInstallCommands(plistPath = '/Library/LaunchDaemons/com.blockingmachine.daemon.plist'): string[] {
  return [
    `sudo chown root:wheel "${plistPath}"`,
    `sudo chmod 644 "${plistPath}"`,
    `sudo launchctl unload -w "${plistPath}" 2>/dev/null || true`,
    `sudo launchctl load -w "${plistPath}"`,
  ];
}

/**
 * Provides shell commands for installing and starting the daemon service on Linux
 */
export function getLinuxInstallCommands(unitPath = '/etc/systemd/system/blockingmachine.service'): string[] {
  return [
    `sudo chmod 644 "${unitPath}"`,
    'sudo systemctl daemon-reload',
    'sudo systemctl enable blockingmachine',
    'sudo systemctl restart blockingmachine',
  ];
}
