/**
 * Every export format the pipeline can emit has a way to deploy it.
 *
 * Three formats — `privoxy`, `shadowrocket` and `bind` — were emitted, advertised in the CLI
 * examples and published as subscribe URLs for years with no tab in the Hub, no recipe anywhere,
 * and no row in the README's format table. A user who compiled one got a file and no way to use
 * it. Nothing in the build could see that, because every individual piece was correct: the
 * formatter emitted the syntax, the validator accepted the name, the picker offered the choice. The
 * gap was only visible by walking the formats and asking what happens to each one, which is why it
 * survived an audit that had already found the other two.
 *
 * So that is what this does. `EXPORT_FORMATS` is the pipeline's own list — the same array the
 * exporter validates a requested format against — and every member must resolve to either a target
 * in the Deploy Hub registry or a recorded reason why that format is platform-neutral on purpose.
 * Adding a format therefore fails here until someone has decided where it deploys, which is the
 * decision the three closed formats each had to make anyway.
 *
 * The second failure this catches is quieter, and is why the file also reads the app's own
 * sources. A format is selectable in the desktop app only because three separate lists agree: the
 * formatter's union in core, the IPC validator in `index.ts`, and the picker in `Settings.tsx`.
 * Add a format to one and the other two go stale silently — the tab would point at a file the app
 * refuses to compile. `FilterFormat` is erased at runtime and cannot be walked, so the link
 * between it and the runtime list is a compile-time guard, and the other two are checked by
 * reading the source the user actually interacts with.
 *
 * Failures are shaped as "collect the offenders, expect an empty list" throughout, so a red run
 * names the formats at fault rather than a count — the fix is always a decision about a specific
 * format, and a count does not say which one.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPORT_FORMATS, type FilterFormat } from '@blockingmachine/core';

import { DEPLOY_TARGETS, type DeployTargetId } from '../deploy/deployTargets';
import { UNBOUND_TARGETS, unboundFeedUrl } from '../unboundDeploy';
import { SHADOWROCKET_STEPS, shadowrocketFeedUrl } from '../shadowrocketDeploy';
import { PRIVOXY_STEPS, privoxyFeedUrl } from '../privoxyDeploy';
import { BIND_STEPS } from '../bindDeploy';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The two directions the formatter union and the runtime list can drift.
 *
 * Both assertions are *declarations*: if either type is not `never`, the annotation rejects `true`
 * and the build fails here rather than a format quietly reaching the exporter unhandled. They are
 * deliberately not tests, because a test cannot see this — the value is `true` either way at
 * runtime, and only the compiler can tell the difference.
 */
type FormatsTheFormatterDoesNotDeclare = Exclude<FilterFormat, (typeof EXPORT_FORMATS)[number]>;
type FormatsTheFormatterCannotHandle = Exclude<(typeof EXPORT_FORMATS)[number], FilterFormat>;
const _formatterUnionIsCoveredBothWays: [
  FormatsTheFormatterDoesNotDeclare extends never ? true : never,
  FormatsTheFormatterCannotHandle extends never ? true : never,
] = [true, true];

/**
 * Each deployable format, and the Hub targets that deploy it.
 *
 * Deliberately partial: a format that is platform-neutral is absent rather than present-and-empty,
 * so a row cannot be both answers at once. `adguard` and `abp` share their targets on purpose —
 * core emits byte-identical output for them, both reaching the same exporter branch and the same
 * header generator — so a target that deploys one deploys the other, and listing them separately
 * would imply a difference that is not there.
 */
const DEPLOYED_AS: Partial<Record<FilterFormat, readonly DeployTargetId[]>> = {
  adguard: ['adguard-home', 'adguard-desktop'],
  abp: ['adguard-home', 'adguard-desktop'],
  hosts: ['hosts'],
  dnsmasq: ['dnsmasq'],
  unbound: ['unbound'],
  // Both BIND artifacts deploy through the one BIND tab, which offers a mechanism selector rather
  // than two tabs — they differ in what you re-copy per compile, not in who runs them.
  bind: ['bind'],
  'bind-null': ['bind'],
  privoxy: ['privoxy'],
  shadowrocket: ['shadowrocket'],
};

/**
 * Formats that are platform-neutral *by design*, with the reason recorded.
 *
 * A reason is required, not optional: the cheap way to silence the headline test is to add a format
 * here with an empty string, and that would reproduce the original gap with a comment attached.
 */
const PLATFORM_NEUTRAL: Partial<Record<FilterFormat, string>> = {
  domains:
    'One domain per line is the point: it is meant for whatever the user already runs. Naming a target would mean picking a client, which is the choice this format exists to avoid. The resolver-shaped formats are the ones that commit to a client, and each has one.',
  plain:
    'Raw rules with no syntax, same reasoning as `domains` — the escape hatch for a tool this project has no target for, so having no tab is the correct outcome rather than a gap.',
};

/**
 * Sinks that accept a list in several formats, so no single format selects them.
 *
 * The mirror of `DEPLOYED_AS`: a target reached from no format is a tab that can never say which
 * file it wants, which is the same class of gap pointing the other way.
 */
// `browser-extension` ships the extension package itself and the feed URL it should poll — no
// export format is its artifact. The other three consume a raw-domain sink rather than a syntax.
const FORMAT_AGNOSTIC_TARGETS: readonly DeployTargetId[] = [
  'browser-extension',
  'pihole',
  'home-assistant',
  'system-daemon',
];

/** The recipe-backed targets, with the module exports that make up each recipe. */
const RECIPES = [
  { target: 'unbound', label: 'Unbound', steps: UNBOUND_TARGETS, feedUrl: unboundFeedUrl },
  { target: 'shadowrocket', label: 'Shadowrocket', steps: SHADOWROCKET_STEPS, feedUrl: shadowrocketFeedUrl },
  { target: 'privoxy', label: 'Privoxy', steps: PRIVOXY_STEPS, feedUrl: privoxyFeedUrl },
  // BIND cannot fetch a zone over HTTP, so it has no feed URL and no URL-shaped helper. The
  // `null` pins that fact rather than leaving it looking like an omission.
  { target: 'bind', label: 'BIND DNS', steps: BIND_STEPS, feedUrl: null },
] as const;

/** Formats offered in the Settings format picker, read from the block that renders the select. */
function readPickerFormats(): string[] {
  const settings = readFileSync(join(appRoot, 'src/Settings.tsx'), 'utf8');
  const start = settings.indexOf('value={exportFormat}');
  if (start < 0) throw new Error('the format picker was not found in Settings.tsx');
  // Scoped deliberately: Settings.tsx renders 23 other <option> elements, so a whole-file read
  // would report every dropdown in the app as a format.
  const end = settings.indexOf('</select>', start);
  if (end < 0) throw new Error('the format picker select is unterminated in Settings.tsx');
  return [...settings.slice(start, end).matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]!);
}

/** Formats the main-process IPC validator accepts, read from `isValidFormat`. */
function readValidatorFormats(): string[] {
  const main = readFileSync(join(appRoot, 'src/index.ts'), 'utf8');
  const start = main.indexOf('const validFormats');
  if (start < 0) throw new Error('the validFormats array was not found in index.ts');
  const end = main.indexOf('];', start);
  if (end < 0) throw new Error('the validFormats array is unterminated in index.ts');
  return [...main.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('export format deploy coverage', () => {
  test('every format the exporter can emit is deployable or recorded as platform-neutral', () => {
    const covered = new Set([...Object.keys(DEPLOYED_AS), ...Object.keys(PLATFORM_NEUTRAL)]);
    expect(EXPORT_FORMATS.filter((format) => !covered.has(format))).toEqual([]);
  });

  test('a format is not claimed both ways', () => {
    const overlap = Object.keys(DEPLOYED_AS).filter((format) => format in PLATFORM_NEUTRAL);
    expect(overlap).toEqual([]);
  });

  test('neither answer names a format the pipeline cannot emit', () => {
    const emittable = new Set<string>(EXPORT_FORMATS);
    const invented = [...Object.keys(DEPLOYED_AS), ...Object.keys(PLATFORM_NEUTRAL)].filter(
      (format) => !emittable.has(format),
    );
    // A stale row is the other half of the drift: the format was renamed or removed and the
    // coverage table kept answering for a file the exporter no longer writes.
    expect(invented).toEqual([]);
  });

  test('every exemption states why the format is platform-neutral', () => {
    const unreasoned = Object.entries(PLATFORM_NEUTRAL)
      .filter(([, reason]) => !reason || reason.trim().length < 40)
      .map(([format]) => format);
    expect(unreasoned).toEqual([]);
  });

  test('a deployable format names at least one real target', () => {
    const nameless = Object.entries(DEPLOYED_AS)
      .filter(([, targets]) => !targets || targets.length === 0)
      .map(([format]) => format);
    expect(nameless).toEqual([]);
  });

  test('every target a format names exists in the Hub registry', () => {
    const known = new Set<string>(DEPLOY_TARGETS.map((target) => target.id));
    const dangling = Object.entries(DEPLOYED_AS)
      .flatMap(([format, targets]) => (targets ?? []).map((target) => `${format} -> ${target}`))
      .filter((entry) => !known.has(entry.slice(entry.indexOf('-> ') + 3)));
    // A renamed or removed target would otherwise read as a format that has lost its deployment.
    expect(dangling).toEqual([]);
  });

  test('every Hub target is reachable from a format or is a format-agnostic sink', () => {
    const used = new Set<string>(Object.values(DEPLOYED_AS).flatMap((targets) => targets ?? []));
    const orphans = DEPLOY_TARGETS.map((target) => target.id).filter(
      (id) => !used.has(id) && !FORMAT_AGNOSTIC_TARGETS.includes(id),
    );
    expect(orphans).toEqual([]);
  });

  test('the Settings format picker offers exactly what the pipeline emits', () => {
    expect(readPickerFormats().slice().sort()).toEqual([...EXPORT_FORMATS].sort());
  });

  test('the IPC validator accepts exactly what the pipeline emits', () => {
    expect(readValidatorFormats().slice().sort()).toEqual([...EXPORT_FORMATS].sort());
  });

  test.each(RECIPES)('$label has a recipe of ordered, uniquely-identified steps', ({ steps }) => {
    const ids = steps.map((step) => step.id);
    expect(steps.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.each(RECIPES.filter((recipe) => recipe.feedUrl))(
    '$label builds a feed URL from the LAN address',
    ({ feedUrl, target }) => {
      const url = feedUrl!('http://192.168.1.145:9191', target, '/exports/blockingmachine.action');
      expect(url).toContain('192.168.1.145:9191');
      // The placeholder is what the pane shows before the feed server has a LAN address, and
      // pasting it into a config is the one outcome that cannot work.
      expect(url).not.toContain('<your-computer-ip>');
    },
  );
});

// Keeps the compile-time guard above from being reported as unused; the declaration is the check.
void _formatterUnionIsCoveredBothWays;
