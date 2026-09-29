import { describe, test, expect } from '@jest/globals';
import {
  SHADOWROCKET_STEPS,
  shadowrocketFeedFileName,
  shadowrocketFeedUrl,
  shadowrocketFormatWarning,
  shadowrocketSyntaxNote,
} from '../shadowrocketDeploy';

describe('Shadowrocket deploy helpers', () => {
  describe('shadowrocketFeedFileName', () => {
    test('serves the real compiled file once Shadowrocket is the export format', () => {
      expect(shadowrocketFeedFileName('shadowrocket', '/Users/alice/Library/shadowrocket.conf')).toBe(
        'shadowrocket.conf',
      );
      expect(shadowrocketFeedFileName('shadowrocket', '/Users/alice/Library/rules.txt')).toBe('rules.txt');
    });

    test('handles a Windows path separator', () => {
      expect(shadowrocketFeedFileName('shadowrocket', 'C:\\Blockingmachine\\shadowrocket.conf')).toBe(
        'shadowrocket.conf',
      );
    });

    test('falls back to the conventional name when Shadowrocket is not the export', () => {
      expect(shadowrocketFeedFileName('adguard', '/Users/alice/Library/adguard.txt')).toBe(
        'shadowrocket.conf',
      );
      expect(shadowrocketFeedFileName('shadowrocket', '')).toBe('shadowrocket.conf');
    });
  });

  describe('shadowrocketFeedUrl', () => {
    test('points the hub at the Shadowrocket export over the LAN', () => {
      expect(
        shadowrocketFeedUrl(
          'http://192.168.1.145:9191',
          'shadowrocket',
          '/Users/alice/Library/shadowrocket.conf',
        ),
      ).toBe('http://192.168.1.145:9191/shadowrocket.conf');
    });

    test('does not double up the separator when the base has a trailing slash', () => {
      expect(shadowrocketFeedUrl('http://192.168.1.145:9191/', 'shadowrocket', '/tmp/sr.conf')).toBe(
        'http://192.168.1.145:9191/sr.conf',
      );
    });

    test('names the host placeholder when the feed server is not running', () => {
      expect(shadowrocketFeedUrl('', 'shadowrocket', '/tmp/sr.conf')).toBe(
        'http://<your-computer-ip>:9191/sr.conf',
      );
    });
  });

  describe('shadowrocketFormatWarning', () => {
    test('is silent once Shadowrocket is the configured export', () => {
      expect(shadowrocketFormatWarning('shadowrocket')).toBeNull();
    });

    test('names the current format so the fix is obvious', () => {
      const warning = shadowrocketFormatWarning('adguard');
      expect(warning).toContain('"adguard"');
      expect(warning).toContain('DOMAIN-SUFFIX');
    });
  });

  describe('SHADOWROCKET_STEPS', () => {
    test('declares each step once, in order, with real text', () => {
      const ids = SHADOWROCKET_STEPS.map((step) => step.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[0]).toBe('feed');
      for (const step of SHADOWROCKET_STEPS) {
        expect(step.title.trim().length).toBeGreaterThan(0);
        expect(step.detail.trim().length).toBeGreaterThan(0);
      }
    });

    test('tells the user where to paste the URL and that no cron is needed', () => {
      const subscribe = SHADOWROCKET_STEPS.find((step) => step.id === 'subscribe')!;
      // The device is the client: Shadowrocket re-fetches a remote config itself, so unlike the
      // Unbound drop-in there is no server-side refresh command to write.
      expect(subscribe.detail).toContain('Remote Config');
      expect(subscribe.detail.toLowerCase()).toContain('re-fetches');
    });

    test('is honest that allowed domains are omitted rather than emitted as rules', () => {
      const exceptions = SHADOWROCKET_STEPS.find((step) => step.id === 'exceptions')!;
      expect(exceptions.detail).toContain('omitted');
      expect(exceptions.detail).toContain('# EXCEPTION:');
    });
  });

  describe('shadowrocketSyntaxNote', () => {
    test('explains why the rules are DOMAIN-SUFFIX rather than DOMAIN', () => {
      const note = shadowrocketSyntaxNote();
      expect(note).toContain('DOMAIN-SUFFIX');
      expect(note).toContain('everything under it');
      expect(note).toContain('Surge');
    });
  });
});
