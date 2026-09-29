import { describe, test, expect } from '@jest/globals';
import {
  UNBOUND_TARGETS,
  unboundFeedFileName,
  unboundFeedUrl,
  unboundFetchCommand,
  unboundFormatWarning,
  unboundIncludeDirective,
} from '../unboundDeploy';

describe('Unbound deploy helpers', () => {
  describe('unboundFeedFileName', () => {
    test('serves the real compiled file once Unbound is the export format', () => {
      expect(unboundFeedFileName('unbound', '/Users/alice/Library/unbound.conf')).toBe('unbound.conf');
      expect(unboundFeedFileName('unbound', '/Users/alice/Library/rules.txt')).toBe('rules.txt');
    });

    test('handles a Windows path separator', () => {
      expect(unboundFeedFileName('unbound', 'C:\\Blockingmachine\\unbound.conf')).toBe('unbound.conf');
    });

    test('falls back to the conventional name when Unbound is not the export', () => {
      expect(unboundFeedFileName('adguard', '/Users/alice/Library/adguard.txt')).toBe('unbound.conf');
      expect(unboundFeedFileName('unbound', '')).toBe('unbound.conf');
    });
  });

  describe('unboundFeedUrl', () => {
    test('points the hub at the Unbound export over the LAN', () => {
      expect(
        unboundFeedUrl('http://192.168.1.145:9191', 'unbound', '/Users/alice/Library/unbound.conf'),
      ).toBe('http://192.168.1.145:9191/unbound.conf');
    });

    test('does not double up the separator when the base has a trailing slash', () => {
      expect(unboundFeedUrl('http://192.168.1.145:9191/', 'unbound', '/tmp/unbound.conf')).toBe(
        'http://192.168.1.145:9191/unbound.conf',
      );
    });

    test('names the host placeholder when the feed server is not running', () => {
      expect(unboundFeedUrl('', 'unbound', '/tmp/unbound.conf')).toBe(
        'http://<your-computer-ip>:9191/unbound.conf',
      );
    });
  });

  describe('unboundIncludeDirective', () => {
    test('quotes the drop-in path, which the unbound parser requires', () => {
      expect(unboundIncludeDirective('/etc/unbound/unbound.conf.d/blockingmachine.conf')).toBe(
        'include: "/etc/unbound/unbound.conf.d/blockingmachine.conf"',
      );
    });
  });

  describe('unboundFetchCommand', () => {
    test('refreshes the drop-in file and re-reads it with the right reload command', () => {
      const linux = UNBOUND_TARGETS.find((t) => t.id === 'linux');
      expect(unboundFetchCommand('http://192.168.1.145:9191/unbound.conf', linux!.configPath)).toBe(
        `curl -fsSL "http://192.168.1.145:9191/unbound.conf" -o ${linux!.configPath} && sudo unbound-control reload`,
      );
    });

    test('uses the OpenWrt service reload rather than unbound-control', () => {
      const openwrt = UNBOUND_TARGETS.find((t) => t.id === 'openwrt');
      expect(unboundFetchCommand('http://hub/unbound.conf', openwrt!.configPath)).toContain(
        '/etc/init.d/unbound reload',
      );
    });

    test('still produces a working command for a path nobody declared', () => {
      expect(unboundFetchCommand('http://hub/unbound.conf', '/tmp/custom.conf')).toBe(
        'curl -fsSL "http://hub/unbound.conf" -o /tmp/custom.conf && unbound-control reload',
      );
    });
  });

  describe('unboundFormatWarning', () => {
    test('is silent once Unbound is the configured export', () => {
      expect(unboundFormatWarning('unbound')).toBeNull();
    });

    test('names the current format so the fix is obvious', () => {
      const warning = unboundFormatWarning('hosts');
      expect(warning).toContain('"hosts"');
      expect(warning).toContain('local-zone');
    });
  });

  describe('UNBOUND_TARGETS', () => {
    test('declares each flavour once, with its own config path', () => {
      const ids = UNBOUND_TARGETS.map((target) => target.id);
      expect(new Set(ids).size).toBe(ids.length);

      // `unboundFetchCommand` resolves the reload command by matching the config path, so two
      // targets sharing one would silently pick whichever came first.
      const paths = UNBOUND_TARGETS.map((target) => target.configPath);
      expect(new Set(paths).size).toBe(paths.length);
    });

    test('every target carries an absolute path and a reload command', () => {
      for (const target of UNBOUND_TARGETS) {
        expect(target.configPath.startsWith('/')).toBe(true);
        expect(target.configPath.endsWith('.conf')).toBe(true);
        expect(target.reloadCommand.trim().length).toBeGreaterThan(0);
        expect(target.name.trim().length).toBeGreaterThan(0);
      }
    });
  });
});
