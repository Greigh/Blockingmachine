import {
  generateMacLaunchdPlist,
  generateLinuxSystemdUnit,
  getMacInstallCommands,
  getLinuxInstallCommands,
} from '../service/serviceConfig.js';
import { MacDnsCommands, LinuxDnsCommands, WindowsDnsCommands } from '../service/networkDns.js';

describe('Service Configuration Generators', () => {
  test('generates valid launchd plist XML for macOS with default port 53', () => {
    const plist = generateMacLaunchdPlist({
      nodePath: '/usr/local/bin/node',
      daemonScriptPath: '/opt/blockingmachine/daemon.js',
    });

    expect(plist).toContain('<string>com.blockingmachine.daemon</string>');
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>/opt/blockingmachine/daemon.js</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<string>53</string>');
    expect(plist).toContain('<string>9292</string>');
  });

  test('generates valid systemd unit file for Linux', () => {
    const unit = generateLinuxSystemdUnit({
      nodePath: '/usr/bin/node',
      daemonScriptPath: '/usr/lib/blockingmachine/daemon.js',
      dnsPort: 5353,
    });

    expect(unit).toContain('Description=Blockingmachine Loopback DNS Filtering Proxy');
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/blockingmachine/daemon.js');
    expect(unit).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE');
    expect(unit).toContain('Environment="DNS_PORT=5353"');
    expect(unit).toContain('Restart=always');
  });

  test('produces correct shell install command lists', () => {
    const macCmds = getMacInstallCommands();
    expect(macCmds.length).toBeGreaterThanOrEqual(3);
    expect(macCmds[0]).toContain('chown root:wheel');
    expect(macCmds[3]).toContain('launchctl load');

    const linuxCmds = getLinuxInstallCommands();
    expect(linuxCmds.length).toBeGreaterThanOrEqual(3);
    expect(linuxCmds[1]).toContain('systemctl daemon-reload');
    expect(linuxCmds[2]).toContain('systemctl enable blockingmachine');
  });

  test('formats OS DNS helper commands correctly', () => {
    expect(MacDnsCommands.setLoopbackDns('Wi-Fi')).toBe('networksetup -setdnsservers "Wi-Fi" 127.0.0.1');
    expect(MacDnsCommands.restoreDhcpDns('Wi-Fi')).toBe('networksetup -setdnsservers "Wi-Fi" "Empty"');
    expect(MacDnsCommands.flushCache).toContain('dscacheutil -flushcache');

    expect(LinuxDnsCommands.setDns('eth0')).toBe('resolvectl dns eth0 127.0.0.1');
    expect(WindowsDnsCommands.setDns('Wi-Fi')).toContain('netsh interface ip set dns');
  });
});
