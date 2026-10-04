/**
 * BIND's mechanism choice, and the two recipes it switches between.
 *
 * BIND offers two ways to block a name and they invert *which file you re-copy*: the RPZ artifact is
 * the zone, the null-zone artifact is the configuration. That inversion is the thing a user has to
 * be told about explicitly, because a recipe that gets it backwards produces a deployment that looks
 * configured and silently keeps serving yesterday's rules — or, worse, serves nothing.
 *
 * The pane picks a mechanism and the export format has to match it, so the warning is a real
 * function rather than a string: a user who selects the null-zone recipe while the export is still
 * RPZ is following steps that cannot work.
 */

import { describe, test, expect } from '@jest/globals';
import {
  BIND_MECHANISMS,
  BIND_NULL_FILE,
  BIND_NULL_STEPS,
  BIND_STEPS,
  BIND_ZONE_ID,
  bindFormatWarning,
  bindIncludeLine,
  bindMechanismForFormat,
  bindNamedConfZoneLine,
  bindNullZoneContents,
  bindReloadCommand,
  bindResponsePolicyLine,
  bindZoneFileName,
  type BindMechanism,
} from '../bindDeploy';

describe('the BIND mechanism choice', () => {
  test('offers both mechanisms, RPZ first because it is better on every axis but one', () => {
    expect(BIND_MECHANISMS.map((m) => m.id)).toEqual(['rpz', 'null-zone']);
    expect(BIND_MECHANISMS[0]!.format).toBe('bind');
    expect(BIND_MECHANISMS[1]!.format).toBe('bind-null');
    // The null zone's single advantage is stated, so the choice is not presented as a coin flip.
    expect(BIND_MECHANISMS[1]!.summary).toMatch(/never changes/);
    // And its two real costs, so nobody picks it believing it is equivalent.
    expect(BIND_MECHANISMS[1]!.summary).toMatch(/Cannot exempt/);
    expect(BIND_MECHANISMS[1]!.summary).toMatch(/NODATA/);
  });

  test('maps each export format to its mechanism, and nothing else to one', () => {
    expect(bindMechanismForFormat('bind')).toBe('rpz');
    expect(bindMechanismForFormat('bind-null')).toBe('null-zone');
    expect(bindMechanismForFormat('adguard')).toBeNull();
    expect(bindMechanismForFormat('unbound')).toBeNull();
  });

  test('every option names a format that really maps back to it', () => {
    for (const option of BIND_MECHANISMS) {
      expect(bindMechanismForFormat(option.format)).toBe(option.id);
    }
  });
});

describe('the format warning', () => {
  test('is silent when the export matches the selected mechanism', () => {
    expect(bindFormatWarning('bind', 'rpz')).toBeNull();
    expect(bindFormatWarning('bind-null', 'null-zone')).toBeNull();
  });

  test('names the other BIND format when the user picked the other mechanism', () => {
    // A real choice rather than a mistake, but a silent one — the recipe below would not work.
    const notice = bindFormatWarning('bind-null', 'rpz');
    expect(notice).toContain('bind');
    expect(notice).toMatch(/Set Format/);
  });

  test('names the current format when it is not a BIND artifact at all', () => {
    const notice = bindFormatWarning('adguard', 'rpz');
    expect(notice).toContain('adguard');
    expect(notice).toMatch(/blocks nothing/);
  });
});

describe('the artifacts each mechanism names', () => {
  test('the RPZ file name follows the export, the null-zone one never changes', () => {
    expect(bindZoneFileName('/etc/bind/mine.rpz', 'rpz')).toBe('mine.rpz');
    expect(bindZoneFileName('', 'rpz')).toBe('db.blockingmachine.rpz');
    // Inverting this is the mistake the null-zone step is written around.
    expect(bindZoneFileName('/etc/bind/mine.rpz', 'null-zone')).toBe(BIND_NULL_FILE);
  });

  test('the null zone file is the three lines BIND needs and nothing else', () => {
    const lines = bindNullZoneContents().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('IN SOA');
    expect(lines[2]).toContain('IN NS');
    // A record here would answer a real query instead of nothing, which defeats the mechanism.
    expect(bindNullZoneContents()).not.toMatch(/CNAME|^\d/);
  });

  test('the include line is optional-argument so the pane can show a default', () => {
    expect(bindIncludeLine()).toBe('include "/etc/bind/blockingmachine-zones.conf";');
    expect(bindIncludeLine('/tmp/zones.conf')).toBe('include "/tmp/zones.conf";');
  });
});

describe('the two named.conf snippets', () => {
  test('the RPZ zone line and the response-policy line agree on the zone name', () => {
    // A mismatch here is the classic BIND mistake: the zone loads and blocks nothing.
    expect(bindNamedConfZoneLine('/etc/bind/db.blockingmachine.rpz')).toContain(`zone "${BIND_ZONE_ID}"`);
    expect(bindResponsePolicyLine()).toContain(`zone "${BIND_ZONE_ID}"`);
  });

  test('the reload command reloads that same zone', () => {
    expect(bindReloadCommand()).toBe(`rndc reload ${BIND_ZONE_ID}`);
  });
});

describe.each([
  ['rpz', BIND_STEPS],
  ['null-zone', BIND_NULL_STEPS],
] as [BindMechanism, typeof BIND_STEPS][])('the %s recipe', (_mechanism, steps) => {
  test('has ordered, uniquely-identified steps with real text', () => {
    const ids = steps.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('reload');
    for (const step of steps) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.detail.trim().length).toBeGreaterThan(40);
    }
  });

  test('says the file is local and must be re-copied, because BIND cannot fetch one', () => {
    const reload = steps.find((step) => step.id === 'reload')!;
    expect(reload.detail).toMatch(/re-copied|replaced|replacing/);
  });
});

describe('what each recipe says that the other does not', () => {
  test('only the RPZ recipe explains the wildcard pair', () => {
    // The under-blocking fix is invisible in the file, so the recipe is where a user learns why
    // there are two records per domain rather than one.
    const wildcard = BIND_STEPS.find((s) => s.id === 'wildcard')!;
    expect(wildcard.title).toMatch(/two records/);
    expect(wildcard.detail).toMatch(/\*\.ads\.example\.com/);
    expect(wildcard.detail).toMatch(/subdomain/);
    expect(BIND_NULL_STEPS.find((s) => s.id === 'wildcard')).toBeUndefined();
  });

  test('only the null-zone recipe states the two things it cannot do', () => {
    const limits = BIND_NULL_STEPS.find((s) => s.id === 'limits')!;
    expect(limits.detail).toMatch(/allowed subdomain/);
    expect(limits.detail).toMatch(/NODATA at the apex/);
    expect(limits.detail).toMatch(/use the RPZ recipe/);
    expect(BIND_STEPS.find((s) => s.id === 'limits')).toBeUndefined();
  });

  test('the null-zone recipe writes the file once and never again', () => {
    const save = BIND_NULL_STEPS.find((s) => s.id === 'save')!;
    expect(save.detail).toMatch(/never changes/);
    // Inverted against RPZ, and the reload step is where that has to be said.
    expect(BIND_NULL_STEPS.find((s) => s.id === 'reload')!.detail).toMatch(/inverts/i);
  });
});
