import { describe, test, expect } from '@jest/globals';
import {
  PRIVOXY_CONF_DIR,
  PRIVOXY_STEPS,
  privoxyActionsFileDirective,
  privoxyFeedFileName,
  privoxyFeedUrl,
  privoxyFetchCommand,
  privoxyFormatWarning,
  privoxyHomeAssistantUrl,
  privoxyReloadCommand,
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
    test('is the config line Privoxy needs, naming a file — never a URL', () => {
      // `actionsfile` resolves relative to the config directory; a feed address in it is the
      // deployment that reads as plausible and loads nothing.
      expect(privoxyActionsFileDirective('blockingmachine.action')).toBe(
        'actionsfile blockingmachine.action',
      );
      expect(privoxyActionsFileDirective('blockingmachine.action')).not.toContain('://');
    });
  });

  describe('privoxyFetchCommand', () => {
    test('fetches the feed into the config directory as a copy, not a subscription', () => {
      expect(
        privoxyFetchCommand('http://192.168.1.145:9191/privoxy.action', 'privoxy.action'),
      ).toBe(
        `curl -fsSL "http://192.168.1.145:9191/privoxy.action" -o ${PRIVOXY_CONF_DIR}/privoxy.action`,
      );
    });
  });

  describe('privoxyReloadCommand', () => {
    test('restarts the service, because Privoxy has no reload signal', () => {
      const command = privoxyReloadCommand();
      expect(command).toContain('restart');
      expect(command).toContain('privoxy');
    });
  });

  describe('PRIVOXY_STEPS', () => {
    test('declares each step once, in order, with real text', () => {
      const ids = PRIVOXY_STEPS.map((step) => step.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[0]).toBe('compile');
      for (const step of PRIVOXY_STEPS) {
        expect(step.title.trim().length).toBeGreaterThan(0);
        expect(step.detail.trim().length).toBeGreaterThan(0);
      }
    });

    test('is a local-file recipe: copy the artifact, then restart', () => {
      const copy = PRIVOXY_STEPS.find((step) => step.id === 'copy')!;
      expect(copy.detail).toContain('/etc/privoxy/');
      const actionsfile = PRIVOXY_STEPS.find((step) => step.id === 'actionsfile')!;
      expect(actionsfile.detail).toContain('actionsfile');
      // The line that used to read as a subscription is now stated as what it is.
      expect(actionsfile.detail.toLowerCase()).toContain('not a url');
      const reload = PRIVOXY_STEPS.find((step) => step.id === 'reload')!;
      expect(reload.detail.toLowerCase()).toContain('restart');
      expect(reload.detail.toLowerCase()).toContain('no reload signal');
    });

    test('is honest that the ordering rule is last-match-wins', () => {
      const ordering = PRIVOXY_STEPS.find((step) => step.id === 'ordering')!;
      expect(ordering.detail).toContain('{-block}');
      expect(ordering.detail.toLowerCase()).toContain('last matching action');
    });

    test('offers the add-on as the copy source that survives this desktop', () => {
      const addon = PRIVOXY_STEPS.find((step) => step.id === 'addon')!;
      expect(addon.detail.toLowerCase()).toContain('home assistant');
      // The add-on renders from the published DNS feed — the format warning above belongs
      // to the hub's compiled file, not to this route.
      expect(addon.detail.toLowerCase()).toContain('whatever export format');
      // And it is an alternative, not a second mandatory copy.
      expect(addon.title.toLowerCase()).toContain('or');
    });
  });

  describe('privoxyHomeAssistantUrl', () => {
    test('points at the route the add-on renders, not at a compiled file name', () => {
      expect(privoxyHomeAssistantUrl()).toBe('http://homeassistant.local:9191/privoxy.action');
      expect(privoxyHomeAssistantUrl(8080)).toBe('http://homeassistant.local:8080/privoxy.action');
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
