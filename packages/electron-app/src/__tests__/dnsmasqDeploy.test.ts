import { describe, test, expect } from '@jest/globals';
import {
  DNSMASQ_HOSTS_FILE,
  DNSMASQ_OPENWRT_HOSTS_DIR,
  DNSMASQ_STEPS,
  dnsmasqAddnHostsDirective,
  dnsmasqCronLine,
  dnsmasqFormatWarning,
  dnsmasqReloadCommand,
} from '../dnsmasqDeploy';

describe('dnsmasq deploy helpers', () => {
  describe('dnsmasqAddnHostsDirective', () => {
    test('emits the directive a reload actually honours', () => {
      // dnsmasq(8): SIGHUP re-reads --addn-hosts inputs — the one file kind where `reload`
      // is the honest verb rather than a conf-dir drop-in that waits for a restart.
      expect(dnsmasqAddnHostsDirective(DNSMASQ_HOSTS_FILE)).toBe(
        `addn-hosts=${DNSMASQ_HOSTS_FILE}`,
      );
    });
  });

  describe('dnsmasqCronLine', () => {
    test('fetches into a hosts file and reloads — never restarts — the service', () => {
      const line = dnsmasqCronLine(
        'http://192.168.1.145:9191/blocklist.txt',
        `${DNSMASQ_OPENWRT_HOSTS_DIR}/blockingmachine.hosts`,
      );
      expect(line).toBe(
        `0 4 * * * curl -fsSL "http://192.168.1.145:9191/blocklist.txt" -o /tmp/hosts/blockingmachine.hosts && /etc/init.d/dnsmasq reload`,
      );
      // The recipe this replaced restarted the wrong thing twice over: a conf file under a
      // directory that is not OpenWrt's conf-dir, applied by a signal that never re-reads config.
      expect(line).not.toContain('/etc/dnsmasq.d');
      expect(line).not.toContain('restart');
      // -f so a 404 page cannot be installed as a hosts file the way `curl -s` allowed.
      expect(line).toContain('-fsSL');
    });
  });

  describe('dnsmasqReloadCommand', () => {
    test('is SIGHUP-shaped, because only hosts inputs are re-read that way', () => {
      expect(dnsmasqReloadCommand()).toBe('/etc/init.d/dnsmasq reload');
    });
  });

  describe('dnsmasqFormatWarning', () => {
    test('is silent once hosts is the configured export', () => {
      expect(dnsmasqFormatWarning('hosts')).toBeNull();
    });

    test('names the format every consumer on the pane shares', () => {
      const warning = dnsmasqFormatWarning('adguard');
      expect(warning).toContain('"adguard"');
      expect(warning).toContain('hosts');
    });
  });

  describe('DNSMASQ_STEPS', () => {
    test('declares each recipe once, in order, with real text', () => {
      const ids = DNSMASQ_STEPS.map((step) => step.id);
      expect(ids).toEqual(['technitium', 'openwrt', 'dnsmasq', 'pfblocker']);
      for (const step of DNSMASQ_STEPS) {
        expect(step.title.trim().length).toBeGreaterThan(0);
        expect(step.detail.trim().length).toBeGreaterThan(0);
      }
    });

    test('the dnsmasq recipes state the SIGHUP contract honestly', () => {
      const openwrt = DNSMASQ_STEPS.find((step) => step.id === 'openwrt')!;
      expect(openwrt.detail).toContain('addn-hosts=/tmp/hosts');
      expect(openwrt.detail).toContain('reload');
      // The step names the old shape it replaced, so a user holding it recognises it.
      expect(openwrt.detail).toContain('/etc/dnsmasq.d');
      const generic = DNSMASQ_STEPS.find((step) => step.id === 'dnsmasq')!;
      expect(generic.detail).toContain('addn-hosts');
      expect(generic.detail.toLowerCase()).toContain('only load at startup');
    });
  });
});
