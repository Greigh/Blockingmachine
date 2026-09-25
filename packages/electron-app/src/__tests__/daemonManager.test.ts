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
