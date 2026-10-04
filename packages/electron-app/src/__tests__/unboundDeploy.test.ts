import { describe, test, expect } from '@jest/globals';
import {
  UNBOUND_TARGETS,
  unboundFeedFileName,
  unboundFeedUrl,
  unboundFetchCommand,
  unboundFormatWarning,
  unboundIncludeDirective,
  unboundReportUrl,
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
        `curl -fsSL 'http://192.168.1.145:9191/unbound.conf' -o '${linux!.configPath}.tmp'` +
          ` && mv '${linux!.configPath}.tmp' '${linux!.configPath}' && sudo unbound-control reload`,
      );
    });

    test('lands the file atomically — a curl that dies mid-body cannot truncate the live drop-in', () => {
      const cmd = unboundFetchCommand('http://hub/unbound.conf', '/etc/unbound/unbound.conf.d/bm.conf');
      expect(cmd).toContain("-o '/etc/unbound/unbound.conf.d/bm.conf.tmp'");
      expect(cmd).toContain(
        "mv '/etc/unbound/unbound.conf.d/bm.conf.tmp' '/etc/unbound/unbound.conf.d/bm.conf'",
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
        "curl -fsSL 'http://hub/unbound.conf' -o '/tmp/custom.conf.tmp'" +
          " && mv '/tmp/custom.conf.tmp' '/tmp/custom.conf' && unbound-control reload",
      );
    });

    test('appends the report-back tail when a report URL is given', () => {
      const cmd = unboundFetchCommand('http://hub/unbound.conf', '/tmp/custom.conf', {
        url: 'http://hub/v1/deploy-report?target=unbound',
      });
      expect(cmd).toBe(
        "curl -fsSL 'http://hub/unbound.conf' -o '/tmp/custom.conf.tmp'" +
          " && mv '/tmp/custom.conf.tmp' '/tmp/custom.conf' && unbound-control reload" +
          " && (curl -fsS -m 5 -o /dev/null -X POST 'http://hub/v1/deploy-report?target=unbound&ok=1' || true)" +
          " || curl -fsS -m 5 -o /dev/null -X POST 'http://hub/v1/deploy-report?target=unbound&ok=0'",
      );
    });

    test('swallows a failed ok-report so it cannot masquerade as a failed fetch', () => {
      // `base && post-ok || post-fail` would report `ok=0` when the fetch worked but the report
      // POST failed (hub restarted between the two calls). The `|| true` keeps `ok=0` honest:
      // it can only mean the fetch or the reload leg failed.
      const cmd = unboundFetchCommand('http://hub/unbound.conf', '/tmp/custom.conf', {
        url: 'http://hub/v1/deploy-report?target=unbound',
      });
      expect(cmd).toContain("ok=1' || true)");
    });

    test('carries the bearer token when one is configured, since the endpoint refuses without it', () => {
      const cmd = unboundFetchCommand('http://hub/unbound.conf', '/tmp/custom.conf', {
        url: 'http://hub/v1/deploy-report?target=unbound',
        token: 's3cret',
      });
      expect(cmd).toContain("-H 'Authorization: Bearer s3cret' 'http://hub/v1/deploy-report?target=unbound&ok=1'");
      expect(cmd).toContain("-H 'Authorization: Bearer s3cret' 'http://hub/v1/deploy-report?target=unbound&ok=0'");
    });

    test('a token with shell metacharacters stays a string, not a command', () => {
      // Inside double quotes `$(…)`, backticks and `"` still evaluate — a token copied out of
      // a hostile config would otherwise arrive at the user's shell as code. Single-quoting
      // is the only escape POSIX shell guarantees.
      const cmd = unboundFetchCommand('http://hub/unbound.conf', '/tmp/custom.conf', {
        url: 'http://hub/v1/deploy-report?target=unbound',
        token: 'x"$(touch /tmp/pwned)`id`',
      });
      // Every `$(` and backtick is inside a single-quoted span — strip those spans and nothing
      // executable can remain.
      expect(cmd.replace(/'[^']*'/g, 'X')).not.toMatch(/\$\(|`/);
    });
  });

  describe('unboundReportUrl', () => {
    test('lives on the same base the feed is served from', () => {
      expect(unboundReportUrl('http://192.168.1.145:9191')).toBe(
        'http://192.168.1.145:9191/v1/deploy-report?target=unbound',
      );
    });

    test('falls back to the copyable placeholder before the server has started', () => {
      expect(unboundReportUrl('')).toBe('http://<your-computer-ip>:9191/v1/deploy-report?target=unbound');
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

    test('names where the include belongs on each flavour — the file that survives regeneration', () => {
      // Two of the three rebuild unbound.conf from scratch, so "edit unbound.conf" is wrong on
      // both: OPNsense auto-includes unbound.opnsense.d drop-ins, OpenWrt appends
      // unbound_ext.conf, and Debian needs nothing — include-toplevel already globs conf.d.
      const placement = Object.fromEntries(
        UNBOUND_TARGETS.map((target) => [target.id, target.includePlacement]),
      );
      expect(placement.bsd).toContain('unbound.opnsense.d');
      expect(placement.openwrt).toContain('unbound_ext.conf');
      expect(placement.linux!.toLowerCase()).toContain('include-toplevel');
      for (const target of UNBOUND_TARGETS) {
        expect(target.includePlacement.trim().length).toBeGreaterThan(0);
      }
    });
  });
});
