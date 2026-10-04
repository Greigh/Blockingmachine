import { describe, test, expect } from '@jest/globals';
import {
  BIND_NULL_STEPS,
  BIND_STEPS,
  BIND_ZONE_ID,
  bindFetchCommand,
  bindFormatWarning,
  bindHomeAssistantUrl,
  bindNamedConfZoneLine,
  bindReloadCommand,
  bindResponsePolicyLine,
  bindSyntaxNote,
  bindZoneFileName,
} from '../bindDeploy';

describe('BIND deploy helpers', () => {
  describe('bindZoneFileName', () => {
    test('uses the compiled file name so the copy target is unambiguous', () => {
      expect(bindZoneFileName('/Users/alice/Library/db.blockingmachine.rpz')).toBe(
        'db.blockingmachine.rpz',
      );
      expect(bindZoneFileName('C:\\Blockingmachine\\named.conf')).toBe('named.conf');
    });

    test('falls back to the conventional RPZ name when there is no path yet', () => {
      expect(bindZoneFileName('')).toBe('db.blockingmachine.rpz');
    });
  });

  describe('the two named.conf lines', () => {
    test('declare the zone with the path the file will actually live at', () => {
      const line = bindNamedConfZoneLine('/etc/bind/db.blockingmachine.rpz');
      expect(line).toBe(
        `zone "${BIND_ZONE_ID}" { type master; file "/etc/bind/db.blockingmachine.rpz"; };`,
      );
    });

    test('fall back to the Debian path rather than writing an empty file name', () => {
      expect(bindNamedConfZoneLine('')).toContain('file "/etc/bind/db.blockingmachine.rpz"');
    });

    test('enable the policy, which is what makes named consult the zone', () => {
      expect(bindResponsePolicyLine()).toBe(`response-policy { zone "${BIND_ZONE_ID}"; };`);
    });

    test('the reload names the zone, so it does not reload the whole server', () => {
      expect(bindReloadCommand()).toBe(`rndc reload ${BIND_ZONE_ID}`);
    });
  });

  describe('bindFormatWarning', () => {
    test('is silent once BIND is the configured export', () => {
      expect(bindFormatWarning('bind')).toBeNull();
    });

    test('names the current format and says why a wrong one is worse than an empty one', () => {
      const warning = bindFormatWarning('hosts');
      expect(warning).toContain('"hosts"');
      // A zone file with the wrong records in it loads cleanly and blocks nothing — the failure
      // this warning exists to prevent.
      expect(warning).toContain('loads cleanly');
    });
  });

  describe('BIND_STEPS', () => {
    test('declares each step once, in order, with real text', () => {
      const ids = BIND_STEPS.map((step) => step.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[0]).toBe('compile');
      for (const step of BIND_STEPS) {
        expect(step.title.trim().length).toBeGreaterThan(0);
        expect(step.detail.trim().length).toBeGreaterThan(0);
      }
    });

    test('says both lines are needed, not just the zone stanza', () => {
      const namedConf = BIND_STEPS.find((step) => step.id === 'namedconf')!;
      expect(namedConf.detail).toContain('response-policy');
      expect(namedConf.detail).toContain('options');
    });

    test('is honest that this is a local file, not a feed', () => {
      const reload = BIND_STEPS.find((step) => step.id === 'reload')!;
      expect(reload.detail).toContain('re-copied');
      // Privoxy's action file is a local file too, so the contrast is Shadowrocket's re-fetch.
      expect(reload.detail.toLowerCase()).toContain('unlike the shadowrocket');
    });

    test('offers the add-on as the copy source that survives this desktop', () => {
      const addon = BIND_STEPS.find((step) => step.id === 'addon')!;
      expect(addon.detail.toLowerCase()).toContain('home assistant');
      expect(addon.detail.toLowerCase()).toContain('whatever export format');
      // Only the RPZ recipe gets the offer: the null zone has no per-compile file to fetch.
      expect(BIND_NULL_STEPS.some((step) => step.id === 'addon')).toBe(false);
    });
  });

  describe('the add-on fetch', () => {
    test('points at the zone the add-on renders, at the path the stanza expects', () => {
      expect(bindHomeAssistantUrl()).toBe('http://homeassistant.local:9191/db.blockingmachine.rpz');
      const command = bindFetchCommand(bindHomeAssistantUrl(), '/etc/bind/db.blockingmachine.rpz');
      expect(command).toBe(
        'curl -fsSL "http://homeassistant.local:9191/db.blockingmachine.rpz" -o /etc/bind/db.blockingmachine.rpz',
      );
    });

    test('falls back to the conventional zone path when none is chosen yet', () => {
      expect(bindFetchCommand('http://x/zone')).toContain('-o /etc/bind/db.blockingmachine.rpz');
    });
  });

  describe('bindSyntaxNote', () => {
    test('explains the two policy answers and why no ordering is needed', () => {
      const note = bindSyntaxNote();
      expect(note).toContain('CNAME .');
      expect(note).toContain('rpz-passthru.');
      expect(note.toLowerCase()).toContain('without any ordering');
    });
  });
});
