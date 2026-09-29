/**
 * Integration tests for `scripts/compile-tier-rulesets.mjs`.
 *
 * The compiler is exercised by running it, not by importing it — it is a packaging step, so
 * the thing worth testing is the artifact it produces, in the shape the extension will
 * actually load. Every compiled tier is therefore run through the extension's own
 * `validateTierRuleset`, the same validator the runtime trusts, and the MV3 budget invariant
 * is checked against the same limit the compliance guardian enforces.
 *
 * The hub's real blocklist is never touched: each case passes explicit `--input` files and a
 * private `--rules-dir`, so the suite is hermetic and the checked-in curated tiers stay put.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_STATIC_TIER_IDS, validateTierRuleset } from '../shared/rulesetTiers.js';

const COMPILER = fileURLToPath(new URL('../../../../scripts/compile-tier-rulesets.mjs', import.meta.url));

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'bm-tiers-'));
  mkdirSync(join(workDir, 'rules'), { recursive: true });
  // A *synthetic* curated baseline rather than the repository's files. The checked-in tiers
  // may themselves already be a compiled 30,000-rule output, so copying them would make this
  // suite pass or fail depending on whether someone had just run a package build.
  for (const tier of ALL_STATIC_TIER_IDS) {
    writeCurated(tier, [`curated-${tier.replace('tier_', '')}.example.com`]);
  }
  // The catalogue the baseline check reads its expected counts from, in the same shape as
  // `src/shared/rulesetTiers.ts` but with counts that match the synthetic baseline above.
  writeCatalogue(Object.fromEntries(ALL_STATIC_TIER_IDS.map((tier) => [tier, 1])));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeCurated(tier: string, hosts: string[]): void {
  const rules = hosts.map((host, index) => ({
    id: index + 1,
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter: `||${host}^` },
  }));
  writeFileSync(join(workDir, 'rules', `${tier}.json`), JSON.stringify(rules, null, 2), 'utf8');
}

function readTier(tier: string): Array<{ id: number; priority: number; action: { type: string }; condition: { urlFilter: string } }> {
  return JSON.parse(readFileSync(join(workDir, 'rules', `${tier}.json`), 'utf8'));
}

/** The extension catalogue's `ruleCount` fields, which declare the curated baseline's size. */
function writeCatalogue(counts: Record<string, number>): void {
  const entries = ALL_STATIC_TIER_IDS.map(
    (tier) =>
      `  { id: '${tier}', label: 'L', description: 'D', path: 'rules/${tier}.json', category: 'core', defaultEnabled: false, ruleCount: ${counts[tier] ?? 0} },`,
  ).join('\n');
  writeFileSync(
    join(workDir, 'catalogue.ts'),
    `export const STATIC_RULE_TIERS = [\n${entries}\n] as const;\n`,
    'utf8',
  );
}

function runCompiler(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(
      'node',
      [
        COMPILER,
        '--rules-dir',
        join(workDir, 'rules'),
        '--counts-path',
        join(workDir, 'counts.ts'),
        '--catalogue-path',
        join(workDir, 'catalogue.ts'),
        ...args,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { stdout, status: 0 };
  } catch (err: any) {
    return { stdout: `${err.stdout || ''}${err.stderr || ''}`, status: err.status ?? 1 };
  }
}

function writeInput(name: string, lines: string[]): string {
  const path = join(workDir, name);
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

/** A blocklist in the shapes the hub actually emits, plus everything that must be refused. */
const MIXED_INPUT = [
  '! comment line',
  '# another comment',
  '0.0.0.0 ads.tracker-example.com',
  '127.0.0.1 beacon.metrics-example.com',
  '0.0.0.0 cdn.adnet-example.com',
  '||abp-anchored-example.com^',
  '||popup.nag-example.com^$third-party',
  'address=/dnsmasq-example.com/0.0.0.0',
  'local-zone: "consent-example.com" always_nxdomain',
  'plain-domain-example.com',
  // Must be refused:
  '@@||allowlisted-example.com^',
  'example.com##.ad-banner',
  'example.org#%#//scriptlet("abort-on-property-read", "x")',
  '0.0.0.0 localhost',
  '127.0.0.1 local',
  '192.168.1.10',
  'singlelabel',
  'co.uk',
  '*.wildcard-example.com',
  'tracker-example.com$dnsrewrite=1.2.3.4',
  '',
  '   ',
];

describe('tier compiler', () => {
  test('compiles a hub blocklist into valid static rulesets', () => {
    const input = writeInput('merged.txt', MIXED_INPUT);
    const result = runCompiler(['--input', input, '--budget', '1000', '--json']);

    expect(result.status).toBe(0);
    for (const tier of ALL_STATIC_TIER_IDS) {
      const rules = readTier(tier);
      const validation = validateTierRuleset(rules, tier);
      // The extension's own validator is the acceptance test: anything it rejects would be
      // rejected by Chrome too.
      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
    }
  });

  test('never emits a rule for a line it must refuse', () => {
    const input = writeInput('merged.txt', MIXED_INPUT);
    expect(runCompiler(['--input', input, '--budget', '1000']).status).toBe(0);

    const all = ALL_STATIC_TIER_IDS.flatMap((tier) =>
      readTier(tier).map((rule) => rule.condition.urlFilter),
    );
    for (const refused of [
      '||allowlisted-example.com^',
      '||localhost^',
      '||local^',
      '||192.168.1.10^',
      '||singlelabel^',
      '||co.uk^',
      '||*.wildcard-example.com^',
      '||tracker-example.com^',
    ]) {
      expect(all).not.toContain(refused);
    }
  });

  test('keeps every curated host, in the tier it already occupied', () => {
    writeCurated('tier_core', ['always-blocked.example.com']);
    writeCurated('tier_ads', ['always-an-ad.example.net']);

    const input = writeInput('merged.txt', [
      '0.0.0.0 ads.something.example.com',
      '0.0.0.0 always-blocked.example.com',
    ]);
    expect(runCompiler(['--input', input, '--budget', '1000']).status).toBe(0);

    const core = readTier('tier_core').map((rule) => rule.condition.urlFilter);
    const ads = readTier('tier_ads').map((rule) => rule.condition.urlFilter);

    // Curated entries survive, and a curated host appearing in the hub list is not moved.
    expect(core).toContain('||always-blocked.example.com^');
    expect(ads).toContain('||always-an-ad.example.net^');
    expect(core.filter((filter) => filter === '||always-blocked.example.com^')).toHaveLength(1);
    // The curated list must never be dropped by the budget.
    expect(core.length).toBeGreaterThanOrEqual(1);
  });

  test('attributes a whole list to a tier exactly, with no classification guesswork', () => {
    const adsList = writeInput('ads.txt', ['0.0.0.0 ordinary-looking-host-1.example', '0.0.0.0 ordinary-looking-host-2.example']);
    const privacyList = writeInput('privacy.txt', ['0.0.0.0 plain-name.example']);
    expect(
      runCompiler(['--input', `tier_ads=${adsList}`, '--input', `privacy=${privacyList}`, '--budget', '1000'])
        .status,
    ).toBe(0);

    const ads = readTier('tier_ads').map((rule) => rule.condition.urlFilter);
    const privacy = readTier('tier_privacy').map((rule) => rule.condition.urlFilter);

    // Names with no category vocabulary at all still land where the operator put them.
    expect(ads).toContain('||ordinary-looking-host-1.example^');
    expect(privacy).toContain('||plain-name.example^');
    expect(ads).not.toContain('||plain-name.example^');
  });

  test('stays inside the budget and never exceeds the guaranteed static limit', () => {
    const hosts = Array.from({ length: 400 }, (_, i) => `0.0.0.0 host-${i}.budget-example.com`);
    const input = writeInput('large.txt', hosts);
    const result = runCompiler(['--input', input, '--budget', '400', '--json']);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.total).toBeLessThanOrEqual(400);
    expect(report.counts.tier_core + report.counts.tier_ads + report.counts.tier_privacy + report.counts.tier_annoyances).toBe(
      report.total,
    );
    // The overflow is reported, never silent.
    expect(report.omittedTotal).toBeGreaterThan(0);

    const shipped = ALL_STATIC_TIER_IDS.reduce((sum, tier) => sum + readTier(tier).length, 0);
    expect(shipped).toBeLessThanOrEqual(400);
  });

  test('spreads unspent capacity instead of pouring it into the first tier', () => {
    // Only ads and privacy have candidates. Without proportional redistribution every freed
    // slot would land in whichever tier is served first.
    const ads = writeInput('ads.txt', Array.from({ length: 200 }, (_, i) => `host-${i}.ad-example.com`));
    const privacy = writeInput('privacy.txt', Array.from({ length: 200 }, (_, i) => `host-${i}.analytics-example.com`));
    // A budget deliberately smaller than demand, so redistribution actually runs. Under the
    // old first-tier-wins pass, every freed slot went to tier_ads and privacy was left at its
    // 20% share; the property that matters is that neither tier is starved.
    const result = runCompiler([
      '--input', `tier_ads=${ads}`,
      '--input', `tier_privacy=${privacy}`,
      '--budget', '300',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.total).toBe(300);
    expect(report.counts.tier_ads).toBeGreaterThan(100);
    expect(report.counts.tier_privacy).toBeGreaterThan(100);
  });

  test('is deterministic: the same input produces byte-identical tiers', () => {
    const input = writeInput('merged.txt', MIXED_INPUT);
    runCompiler(['--input', input, '--budget', '100']);
    const first = ALL_STATIC_TIER_IDS.map((tier) => readFileSync(join(workDir, 'rules', `${tier}.json`), 'utf8'));

    runCompiler(['--input', input, '--budget', '100']);
    const second = ALL_STATIC_TIER_IDS.map((tier) => readFileSync(join(workDir, 'rules', `${tier}.json`), 'utf8'));

    expect(second).toEqual(first);
  });

  test('--check verifies the curated baseline on its own terms before anything is compiled', () => {
    // No compilation is recorded, so there is no hub-derived plan for these files to be stale
    // against. What *is* knowable is that every tier is present, is a non-empty ruleset array, and
    // holds exactly the count the extension's catalogue declares for it.
    const clean = runCompiler(['--check']);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('Curated baseline in place');

    // A hand edit that adds a rule without the catalogue moving is what this catches — the failure
    // an unconditional "compare against the hub plan" check reported as staleness on every machine.
    writeCurated('tier_core', ['one.example.com', 'two.example.com']);
    const drifted = runCompiler(['--check']);
    expect(drifted.status).toBe(1);
    expect(drifted.stdout).toContain('catalogue declares');
  });

  test('--check compares against a fresh compile once a compilation is recorded', () => {
    const input = writeInput('merged.txt', ['0.0.0.0 ads.fresh-example.com']);

    // Still the baseline state: the check has nothing to compare the plan to yet.
    expect(runCompiler(['--input', input, '--budget', '1000', '--check']).status).toBe(0);

    expect(runCompiler(['--input', input, '--budget', '1000']).status).toBe(0);
    expect(runCompiler(['--input', input, '--budget', '1000', '--check']).status).toBe(0);

    // The list it was compiled from has since grown, so the tiers really are stale now.
    const grown = writeInput('grown.txt', [
      '0.0.0.0 ads.fresh-example.com',
      '0.0.0.0 more.ads-example.com',
    ]);
    expect(runCompiler(['--input', grown, '--budget', '1000', '--check']).status).toBe(1);
  });

  test('writes the real counts so the popup cannot report the curated baseline', () => {
    const input = writeInput('merged.txt', Array.from({ length: 30 }, (_, i) => `0.0.0.0 host-${i}.ad-example.com`));
    expect(runCompiler(['--input', input, '--budget', '1000']).status).toBe(0);

    const generated = readFileSync(join(workDir, 'counts.ts'), 'utf8');
    for (const tier of ALL_STATIC_TIER_IDS) {
      const shipped = readTier(tier).length;
      expect(generated).toContain(`'${tier}': ${shipped},`);
    }
    expect(generated).toContain('GENERATED_TIER_COUNTS');
  });

  test('refuses to run when there is no readable input at all', () => {
    // An empty rules directory too, so the failure is the missing input rather than an
    // empty tier — the two causes must not produce the same message.
    rmSync(join(workDir, 'rules'), { recursive: true, force: true });
    mkdirSync(join(workDir, 'rules'), { recursive: true });

    const result = runCompiler(['--input', join(workDir, 'does-not-exist.txt')]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Nothing to compile');
  });

  test('refuses to emit an empty tier rather than shipping a manifest entry with no rules', () => {
    rmSync(join(workDir, 'rules'), { recursive: true, force: true });
    mkdirSync(join(workDir, 'rules'), { recursive: true });
    const input = writeInput('merged.txt', ['0.0.0.0 ads.only-example.com']);

    const result = runCompiler(['--input', input, '--budget', '100']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('must ship at least one rule');
  });
});
