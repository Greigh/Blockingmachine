import { describe, test, expect } from '@jest/globals';
import { DaemonManager } from '../daemonManager';

describe('DaemonManager', () => {
  test('initializes with default ports and stopped state', async () => {
    const manager = new DaemonManager({ controlPort: 65432, dnsPort: 5353 });
    const status = await manager.getStatus();

    expect(status.status).toBe('stopped');
    expect(status.port).toBe(5353);
    expect(status.controlPort).toBe(65432);
    expect(status.rulesLoaded).toBe(0);
    expect(status.managedByApp).toBe(false);
  });

  test('generates valid launchd and systemd install instructions', () => {
    const manager = new DaemonManager();
    const scripts = manager.getServiceInstallInstructions();

    expect(scripts.mac).toContain('com.blockingmachine.daemon');
    expect(scripts.mac).toContain('DNS_PORT');
    expect(scripts.mac).toContain('launchctl load');

    expect(scripts.linux).toContain('blockingmachine.service');
    expect(scripts.linux).toContain('systemctl enable --now blockingmachine');
  });

  test('retrieves local network services', async () => {
    const manager = new DaemonManager();
    const services = await manager.getNetworkServices();

    expect(Array.isArray(services)).toBe(true);
    expect(services.length).toBeGreaterThan(0);
  });

  /**
   * The install instructions interpolate the user's chosen save path into a root-installed
   * systemd unit and a launchd plist. `Environment="…"` quotes+unescapes, `%` expands as a
   * specifier, and a newline injects a directive; the plist needs the same path XML-escaped.
   */
  test('escapes feed paths inside the generated systemd unit', () => {
    const manager = new DaemonManager();
    const scripts = manager.getServiceInstallInstructions({
      feedFilePath: '/opt/my "feeds"/dns%d.txt',
      threatsFilePath: '/opt/back\\slash/threats.txt',
      observationsFilePath: '/opt/evil\nExecStartPost=/bin/sh -c id/obs.jsonl',
    });

    expect(scripts.linux).toContain('Environment="FEED_FILE=/opt/my \\"feeds\\"/dns%%d.txt"');
    expect(scripts.linux).toContain('Environment="THREATS_FILE=/opt/back\\\\slash/threats.txt"');
    expect(scripts.linux).toContain('Environment="OBSERVATIONS_FILE=/opt/evil\\nExecStartPost=');
    // The injected directive must exist only as escaped text, never as a real unit line.
    expect(scripts.linux.split('\n').some((l) => l.startsWith('ExecStartPost='))).toBe(false);
  });

  test('xml-escapes feed paths inside the generated launchd plist', () => {
    const manager = new DaemonManager();
    const scripts = manager.getServiceInstallInstructions({
      feedFilePath: '/Users/A & B/dns.txt',
      threatsFilePath: '/tmp/<script>/threats.txt',
    });
    expect(scripts.mac).toContain('<string>/Users/A &amp; B/dns.txt</string>');
    expect(scripts.mac).toContain('<string>/tmp/&lt;script&gt;/threats.txt</string>');
  });

  /**
   * The plist travels inside a `sudo tee << 'EOF'` heredoc: a newline-bearing path
   * would print a bare `EOF` line and everything after it runs as root shell.
   * Newlines must be character-references — one physical line, decoded by the plist
   * parser back to the real byte.
   */
  test('newline-bearing feed paths cannot break the launchd heredoc', () => {
    const manager = new DaemonManager();
    const scripts = manager.getServiceInstallInstructions({
      feedFilePath: '/tmp/feed\nEOF\nsudo sh -c "echo pwned"\nEOF/x.txt',
    });
    // No bare EOF before the real terminator — the injected payload survives only as
    // inert single-line plist character data, never as a shell line of its own.
    const eofLines = scripts.mac.split('\n').filter((l) => l === 'EOF');
    expect(eofLines).toHaveLength(1);
    expect(scripts.mac).toContain('&#10;EOF&#10;');
    const injectedLine = scripts.mac.split('\n').find((l) => l.includes('sudo sh'));
    expect(injectedLine).toContain('&#10;'); // it is the escaped <string> line itself
  });

  test('quotes the ExecStart path pair so spaces stay a single argv item', () => {
    const manager = new DaemonManager();
    const scripts = manager.getServiceInstallInstructions();
    expect(scripts.linux).toMatch(/ExecStart="[^"\n]*" "[^"\n]*system-daemon\/dist\/index\.js"/);
  });

  test('rejects command injection attempts in service names for setSystemDns', async () => {
    const manager = new DaemonManager();
    const maliciousNames = [
      'Wi-Fi; rm -rf /',
      'Wi-Fi && cat /etc/passwd',
      'Wi-Fi | whoami',
      'Wi-Fi`touch /tmp/pwned`',
      'Wi-Fi$(id)',
    ];

    for (const name of maliciousNames) {
      const setResult = await manager.setSystemDns(name);
      expect(setResult.success).toBe(false);
      expect(setResult.message).toContain('Invalid network service name');

      const restoreResult = await manager.restoreSystemDns(name);
      expect(restoreResult.success).toBe(false);
      expect(restoreResult.message).toContain('Invalid network service name');
    }
  });
});
