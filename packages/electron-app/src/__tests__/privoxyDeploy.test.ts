import { describe, test, expect } from '@jest/globals';
import {
  PRIVOXY_STEPS,
  privoxyActionsFileDirective,
  privoxyFeedFileName,
  privoxyFeedUrl,
  privoxyFormatWarning,
  privoxySyntaxNote,
} from '../privoxyDeploy';

describe('Privoxy deploy helpers', () => {
  describe('privoxyFeedFileName', () => {
    test('serves the real compiled file once Privoxy is the export format', () => {
      expect(privoxyFeedFileName('privoxy', '/Users/alice/Library/privoxy.action')).toBe(
        'privoxy.action',
      );
      expect(privoxyFeedFileName('privoxy', '/Users/alice/Library/rules.txt')).toBe('rules.txt');
    });

    test('handles a Windows path separator', () => {
      expect(privoxyFeedFileName('privoxy', 'C:\\Blockingmachine\\privoxy.action')).toBe(
        'privoxy.action',
      );
    });

    test('falls back to the conventional name when Privoxy is not the export', () => {
      expect(privoxyFeedFileName('adguard', '/Users/alice/Library/adguard.txt')).toBe(
        'privoxy.action',
      );
      expect(privoxyFeedFileName('privoxy', '')).toBe('privoxy.action');
    });
  });

  describe('privoxyFeedUrl', () => {
    test('points the hub at the Privoxy export over the LAN', () => {
      expect(
        privoxyFeedUrl('http://192.168.1.145:9191', 'privoxy', '/Users/alice/Library/privoxy.action'),
      ).toBe('http://192.168.1.145:9191/privoxy.action');
    });

    test('does not double up the separator when the base has a trailing slash', () => {
      expect(privoxyFeedUrl('http://192.168.1.145:9191/', 'privoxy', '/tmp/px.action')).toBe(
        'http://192.168.1.145:9191/px.action',
      );
    });

    test('names the host placeholder when the feed server is not running', () => {
      expect(privoxyFeedUrl('', 'privoxy', '/tmp/px.action')).toBe(
        'http://<your-computer-ip>:9191/px.action',
      );
    });
  });

  describe('privoxyFormatWarning', () => {
    test('is silent once Privoxy is the configured export', () => {
      expect(privoxyFormatWarning('privoxy')).toBeNull();
    });

    test('names the current format so the fix is obvious', () => {
      const warning = privoxyFormatWarning('adguard');
      expect(warning).toContain('"adguard"');
      expect(warning).toContain('{+block}');
    });
  });

  describe('privoxyActionsFileDirective', () => {
    test('is the config line Privoxy needs, with the feed URL already in it', () => {
      expect(privoxyActionsFileDirective('http://192.168.1.145:9191/privoxy.action')).toBe(
        'actionsfile http://192.168.1.145:9191/privoxy.action',
      );
    });
  });

  describe('PRIVOXY_STEPS', () => {
    test('declares each step once, in order, with real text', () => {
      const ids = PRIVOXY_STEPS.map((step) => step.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[0]).toBe('feed');
      for (const step of PRIVOXY_STEPS) {
        expect(step.title.trim().length).toBeGreaterThan(0);
        expect(step.detail.trim().length).toBeGreaterThan(0);
      }
    });

    test('tells the user where the directive goes and that no cron is needed', () => {
      const subscribe = PRIVOXY_STEPS.find((step) => step.id === 'actionsfile')!;
      expect(subscribe.detail).toContain('actionsfile');
      // Privoxy is the client for a remote action file, so unlike the Unbound drop-in there is no
      // server-side refresh command to write.
      expect(subscribe.detail.toLowerCase()).toContain('no cron');
    });

    test('is honest that the ordering rule is last-match-wins', () => {
      const ordering = PRIVOXY_STEPS.find((step) => step.id === 'ordering')!;
      expect(ordering.detail).toContain('{-block}');
      expect(ordering.detail.toLowerCase()).toContain('last matching action');
    });
  });

  describe('privoxySyntaxNote', () => {
    test('explains the leading dot and the ordering rule', () => {
      const note = privoxySyntaxNote();
      expect(note).toContain('.example.com');
      // A bare host matches that host only — the difference the dot makes.
      expect(note).toContain('that host only');
      expect(note.toLowerCase()).toContain('last matching action');
    });
  });
});
