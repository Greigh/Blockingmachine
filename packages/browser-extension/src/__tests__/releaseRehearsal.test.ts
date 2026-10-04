/**
 * The release rehearsal is the only thing standing between a packaging break and a release —
 * this pins its wiring rather than re-running it, since the CI step runs it for real.
 *
 * What a wiring test can and must pin: that CI invokes the same script a human runs, that the
 * rehearsal exercises the real packaging path rather than a flagged-off shortcut, that tier
 * state is snapshotted before the compile and restored in a finally, that the fixture names a
 * host for every placement the script asserts, and that the archive checks open the zip rather
 * than trusting the packager's exit code.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

const script = readFileSync(join(ROOT, 'scripts', 'release-rehearsal.mjs'), 'utf8');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const fixture = readFileSync(
  join(ROOT, 'scripts', 'fixtures', 'release-rehearsal-blocklist.txt'),
  'utf8',
);
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

describe('release rehearsal wiring', () => {
  test('CI runs the rehearsal through the same script a human runs', () => {
    expect(pkg.scripts['rehearse:release']).toBe('node scripts/release-rehearsal.mjs');
    expect(workflow).toContain('npm run rehearse:release');
  });

  test('packaging runs the real release path — no --skip-tiers', () => {
    // A rehearsal that skipped packaging's own compile step would rehearse a different release
    // than the one that ships.
    expect(script).not.toContain('--skip-tiers');
    expect(script).toContain('package-extension.mjs');
  });

  test('the compile output is consumed as the single JSON document the contract promises', () => {
    expect(script).toContain("'--json'");
    expect(script).toContain('JSON.parse(planOut)');
  });

  test('tier state is snapshotted before the compile and restored in a finally', () => {
    const snapshotAt = script.indexOf('snapshotTierState()');
    const compileAt = script.indexOf('compile-tier-rulesets.mjs');
    const finallyAt = script.lastIndexOf('} finally');
    expect(snapshotAt).toBeGreaterThanOrEqual(0);
    expect(snapshotAt).toBeLessThan(compileAt);
    expect(finallyAt).toBeGreaterThan(compileAt);
    expect(script.slice(finallyAt)).toContain('restoreTierState');
  });

  test('the fixture names a host for every placement the script asserts', () => {
    for (const host of [
      'ads.rehearsal.example',
      'metrics.rehearsal.example',
      'consent.rehearsal.example',
      'malware.rehearsal.example',
      'plain.rehearsal.example',
      'dns.rehearsal.example',
    ]) {
      expect(fixture).toContain(host);
      expect(script).toContain(host);
    }
  });

  test('the fixture also carries the refused shapes the assertions rely on', () => {
    for (const refused of [
      '@@||allowed.rehearsal.example^',
      '##',
      '$dnsrewrite',
      '*.wildcard.rehearsal.example',
    ]) {
      expect(fixture).toContain(refused);
    }
  });

  test('the archive assertions open the zip rather than trusting the packager output', () => {
    // `unzip -Z1`/`unzip -p` read the archive itself — a rehearsal that only checked the
    // packager's exit code would never see a declared-but-absent ruleset.
    expect(script).toContain("'unzip'");
    expect(script).toContain('rule_resources');
    expect(script).toContain('service_worker');
    expect(script).toContain('gecko');
  });
});
