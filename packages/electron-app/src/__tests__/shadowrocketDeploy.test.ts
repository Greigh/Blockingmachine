import { describe, test, expect } from '@jest/globals';
import {
  SHADOWROCKET_STEPS,
  shadowrocketFeedFileName,
  shadowrocketFeedUrl,
  shadowrocketFormatWarning,
  shadowrocketHomeAssistantUrl,
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

  describe('shadowrocketHomeAssistantUrl', () => {
    test('points at the add-on path, which is not the desktop feed path', () => {
      expect(shadowrocketHomeAssistantUrl()).toBe('http://homeassistant.local:9191/shadowrocket.conf');
    });

    test('takes the port, because the add-on\'s is configurable', () => {
      expect(shadowrocketHomeAssistantUrl(8123)).toBe('http://homeassistant.local:8123/shadowrocket.conf');
    });

    test('names the add-on host, not the desktop\'s LAN address', () => {
      // A phone that can reach homeassistant.local is on the LAN; the desktop hub's feed URL is a
      // different machine, and the whole reason for offering the add-on is that it stays up.
      expect(shadowrocketHomeAssistantUrl()).not.toContain('192.168');
    });
  });

  describe('the Home Assistant add-on alternative', () => {
    test('is offered as a step, after serving the desktop feed', () => {
      const ids = SHADOWROCKET_STEPS.map((step) => step.id);
      expect(ids).toContain('addon');
      expect(ids.indexOf('addon')).toBeGreaterThan(ids.indexOf('feed'));
      // Before the paste step, or the user is told to paste a URL that was never offered.
      expect(ids.indexOf('addon')).toBeLessThan(ids.indexOf('subscribe'));
    });

    test('says the reason to prefer it: it keeps working when the desktop is off', () => {
      const addon = SHADOWROCKET_STEPS.find((step) => step.id === 'addon')!;
      expect(addon.detail).toContain('Home Assistant');
      expect(addon.detail.toLowerCase()).toContain('shut down');
    });

    test('is honest that the add-on renders a smaller set than the export', () => {
      // The add-on reads the DNS feed and cannot express the rules a rule set has no syntax for,
      // so its count is genuinely lower. Saying "the same" without the caveat would overstate it.
      const addon = SHADOWROCKET_STEPS.find((step) => step.id === 'addon')!;
      expect(addon.detail).toContain('lower');
      expect(addon.detail).toContain('DNS feed');
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
