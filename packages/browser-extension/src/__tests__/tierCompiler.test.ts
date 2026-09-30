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
// Core owns the ledger format. The compiler reads it without importing core (it runs before
// any build), so the two readers are pinned against each other here instead — from the specific
// module, so the suite does not drag in the whole package.
import { parseHitLedgerText } from '../../../core/src/ledgerAggregate.js';
// Core owns the host extractor the hub writes the attribution files with. The compiler has its
// own copy for the same reason it has its own ledger reader — it runs before core is built — so
// the two are pinned against each other here rather than trusted to stay in step. The pin goes
// through the compiler's own report rather than importing the script, which is also the level at
// which the agreement actually matters: what the compiler placed, not what a function returns.
import { extractHostFromRule as coreExtractHostFromRule } from '../../../core/src/ruleHost.js';

const COMPILER = fileURLToPath(new URL('../../../../scripts/compile-tier-rulesets.mjs', import.meta.url));

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'bm-tiers-'));
  mkdirSync(join(workDir, 'rules'), { recursive: true });
  // A *synthetic* curated baseline rather than the repository's files. The checked-in tiers
  // may themselves already be a compiled 30,000-rule output, so copying them would make this
  // suite pass or fail depending on whether someone had just run a package build.
  writeBaselineCurated();
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

/**
 * The synthetic curated baseline this suite compiles on top of.
 *
 * The compiler reads the tier files on disk as its curated seed, so a second run in the same
 * rules directory compiles on top of the *first run's output* — which is the additive-by-design
 * behaviour, and also means a before/after comparison has to put the baseline back first or it
 * is comparing a ranked build against a ranked build.
 */
function writeBaselineCurated(): void {
  for (const tier of ALL_STATIC_TIER_IDS) {
    writeCurated(tier, [`curated-${tier.replace('tier_', '')}.example.com`]);
  }
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

/** Hosts in a fixed input order, so "last in the list" is a statement about the fixture. */
const adsHosts = (count: number) =>
  Array.from({ length: count }, (_, i) => `host-${String(i).padStart(2, '0')}.adnet-example.com`);

/** The hosts that made it into a tier, in the order the file holds them. */
const shippedHosts = (tier: string) =>
  readTier(tier).map((rule) => rule.condition.urlFilter.replace(/^\|\||\^$/g, ''));

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

  test('places hosts that match no vocabulary in the residual, which is an opt-in tier by default', () => {
    const input = writeInput('unclassifiable.txt', ['0.0.0.0 plain-domain-example.com']);
    const result = runCompiler(['--input', input, '--budget', '1000', '--json']);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.unclassified).toBe(1);
    // The default is opt-in on purpose: `tier_core` ships enabled on a fresh install, and most of
    // a merged blocklist matches no vocabulary at all, so parking these there would silently make
    // every user block thousands of hosts the classifier could not justify.
    expect(report.residualTier).toBe('tier_ads');
    expect(shippedHosts('tier_ads')).toContain('plain-domain-example.com');
  });

  test('an explicit --residual takes the unclassified hosts, including the enabled tier', () => {
    const input = writeInput('unclassifiable.txt', ['0.0.0.0 plain-domain-example.com']);
    // The short name is accepted, and this is the deliberate choice the opt-in default exists to
    // make the operator spell out: unclassified hosts in the tier every fresh install enables.
    const result = runCompiler(['--input', input, '--budget', '1000', '--residual', 'core', '--json']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).residualTier).toBe('tier_core');
    expect(shippedHosts('tier_core')).toContain('plain-domain-example.com');
  });

  test('refuses a --residual that is not a tier instead of quietly choosing one', () => {
    const input = writeInput('unclassifiable.txt', ['0.0.0.0 plain-domain-example.com']);
    const before = readTier('tier_core');

    const typo = runCompiler(['--input', input, '--budget', '1000', '--residual', 'tier_adz']);
    expect(typo.status).toBe(1);
    expect(typo.stdout).toContain('--residual is not a tier');
    // The valid names are printed, so the flag can be corrected without reading the source.
    expect(typo.stdout).toContain('tier_annoyances');
    // Nothing was written: the run failed before a plan was made, so the curated baseline is
    // untouched rather than compiled under a tier the operator never named. The old fallback was
    // `tier_core` — the one tier a fresh install enables — which is the worst place to guess.
    expect(readTier('tier_core')).toEqual(before);

    // A flag with no value at all is the same operator error and gets its own sentence.
    const missing = runCompiler(['--input', input, '--budget', '1000', '--residual']);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('--residual needs a tier name');
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

/**
 * Ranking the 30,000-rule cut by the browser's own rule-hit evidence.
 *
 * The cut is the decision that matters — it decides what the extension blocks — and taking
 * candidates in input order lets a merge artifact decide it instead. The property under test is
 * not "ranking happened" but "the measured host shipped and the unmeasured one at the front of
 * the list did not", plus the boundaries that keep this from being a ranking that re-tiers,
 * re-orders the curated baseline, or quietly falls back to input order when the evidence file is
 * wrong.
 */
describe('tier compiler · ranking the cut by rule-hit evidence', () => {
  test('spends the budget on measured hosts instead of the front of the list', () => {
    const ads = writeInput('ads.txt', adsHosts(20));
    // The two busiest hosts are last in the input, which is the whole point: input order would
    // have spent the slots on host-00 and host-01.
    const hits = writeInput('hits.txt', ['12 ||host-19.adnet-example.com^', '3 ||host-18.adnet-example.com^']);

    const ranked = runCompiler(['--input', `tier_ads=${ads}`, '--hits', hits, '--budget', '8', '--json']);
    expect(ranked.status).toBe(0);
    const rankedHosts = shippedHosts('tier_ads');

    expect(rankedHosts).toContain('host-19.adnet-example.com');
    expect(rankedHosts).toContain('host-18.adnet-example.com');
    // Most-fired first, ahead of the unmeasured hosts that outrank nothing.
    const firstSynced = rankedHosts.filter((host) => host !== 'curated-ads.example.com');
    expect(firstSynced[0]).toBe('host-19.adnet-example.com');
    expect(firstSynced[1]).toBe('host-18.adnet-example.com');

    // The same input without evidence keeps input order, and host-19 never ships. The baseline is
    // restored first: the compiler seeds from the tier files on disk, so the second run would
    // otherwise compile on top of the ranked output and inherit host-19 as a curated host.
    writeBaselineCurated();
    const unranked = runCompiler(['--input', `tier_ads=${ads}`, '--budget', '8', '--json']);
    expect(unranked.status).toBe(0);
    const unrankedHosts = shippedHosts('tier_ads');
    expect(unrankedHosts).not.toContain('host-19.adnet-example.com');
    expect(unrankedHosts).toContain('host-00.adnet-example.com');
  });

  test('reports what ranking bought rather than only that it ran', () => {
    const ads = writeInput('ads.txt', adsHosts(20));
    const hits = writeInput('hits.txt', ['12 ||host-19.adnet-example.com^', '3 ||host-18.adnet-example.com^']);

    const crowded = JSON.parse(
      runCompiler(['--input', `tier_ads=${ads}`, '--hits', hits, '--budget', '8', '--json']).stdout,
    );
    expect(crowded.hitEvidence).not.toBeNull();
    expect(crowded.hitEvidence.source).toContain('hits.txt');
    expect(crowded.hitEvidence.hosts).toBe(2);
    expect(crowded.hitEvidence.hits).toBe(15);
    expect(crowded.hitEvidence.shippedWithEvidence).toBe(2);
    // Both measured hosts took slots the input-ordered plan had given to unmeasured ones.
    expect(crowded.hitEvidence.promoted).toBe(2);
    expect(crowded.hitEvidence.promotedExamples).toEqual(
      expect.arrayContaining(['host-19.adnet-example.com', 'host-18.adnet-example.com']),
    );

    // With a budget nothing is crowded out of, the same flag reports zero rather than claiming
    // a promotion that did not happen.
    const roomy = JSON.parse(
      runCompiler(['--input', `tier_ads=${ads}`, '--hits', hits, '--budget', '1000', '--json']).stdout,
    );
    expect(roomy.hitEvidence.promoted).toBe(0);
    expect(roomy.hitEvidence.shippedWithEvidence).toBe(2);
  });

  test('says nothing was measured when no evidence file was given', () => {
    const ads = writeInput('ads.txt', adsHosts(20));
    const report = JSON.parse(runCompiler(['--input', `tier_ads=${ads}`, '--budget', '8', '--json']).stdout);

    // Null rather than an empty evidence block, so a report can never imply a ranked build.
    expect(report.hitEvidence).toBeNull();
  });

  test('keeps curated hosts first and in their own tier, evidence or not', () => {
    writeCurated('tier_ads', ['hand-picked.example.com']);
    const ads = writeInput('ads.txt', adsHosts(20));
    // The curated host has the *most* hits of anything, which is exactly the case where a naive
    // "sort everything by hits" would reorder the one part of the file nobody asked to change.
    const hits = writeInput('hits.txt', [
      '900 ||hand-picked.example.com^',
      '2 ||host-19.adnet-example.com^',
    ]);

    expect(runCompiler(['--input', `tier_ads=${ads}`, '--hits', hits, '--budget', '8']).status).toBe(0);

    const hosts = shippedHosts('tier_ads');
    // Curated first, then the measured host it out-scored 450 to 1.
    expect(hosts[0]).toBe('hand-picked.example.com');
    expect(hosts[1]).toBe('host-19.adnet-example.com');
  });

  test('never re-tiers a busy host out of the tier its vocabulary put it in', () => {
    // A privacy host with more hits than anything in ads stays in privacy: which tier something
    // belongs to is a statement about what it is, not about how often it fires.
    const privacy = writeInput('privacy.txt', adsHosts(6).map((host) => host.replace('adnet', 'analytics')));
    const hits = writeInput('hits.txt', [
      '500 ||host-05.analytics-example.com^',
      '1 ||host-00.analytics-example.com^',
    ]);

    expect(runCompiler(['--input', `tier_privacy=${privacy}`, '--hits', hits, '--budget', '1000']).status).toBe(0);
    expect(shippedHosts('tier_privacy')).toContain('host-05.analytics-example.com');
    expect(shippedHosts('tier_ads')).not.toContain('host-05.analytics-example.com');
  });

  test('refuses a mistyped evidence file instead of quietly shipping input order', () => {
    const ads = writeInput('ads.txt', adsHosts(20));

    const missing = runCompiler(['--input', `tier_ads=${ads}`, '--hits', join(workDir, 'nope.txt')]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('--hits file not found');
    // The message has to say how to make one, or the operator is left at the failure.
    expect(missing.stdout).toContain('ledger:merge');
  });

  test('refuses a ledger that names no rule at all', () => {
    const ads = writeInput('ads.txt', adsHosts(20));
    const empty = writeInput('hits.txt', ['# Browser-reported rule-hit ledger', '# Days: 0', '42']);

    const result = runCompiler(['--input', `tier_ads=${ads}`, '--hits', empty]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('no usable rule hits');
  });

  test('never ranks by an exception, which is on the record because it allowed a request', () => {
    const ads = writeInput('ads.txt', [
      'allowed-example.com',
      ...adsHosts(20),
    ]);
    // A huge count on an `@@` rule: it saved the request, so it is not a reason to ship a block.
    const hits = writeInput('hits.txt', ['500 @@||allowed-example.com^', '1 ||host-00.adnet-example.com^']);

    const report = JSON.parse(
      runCompiler(['--input', `tier_ads=${ads}`, '--hits', hits, '--budget', '8', '--json']).stdout,
    );
    expect(report.hitEvidence.hosts).toBe(1);
    expect(report.hitEvidence.hits).toBe(1);
    expect(report.hitEvidence.skipped).toBe(1);
    // The exception is not even a candidate for the head of the tier.
    const synced = shippedHosts('tier_ads').filter((host) => host !== 'curated-ads.example.com');
    expect(synced[0]).toBe('host-00.adnet-example.com');
  });

  test('carries the ledger’s own provenance into the report', () => {
    const ads = writeInput('ads.txt', adsHosts(20));
    const hits = writeInput('hits.txt', [
      '# Browser-reported rule-hit ledger',
      '# Sessions: 12',
      '# Days: 34',
      '# First seen: 2026-08-01',
      '7 ||host-19.adnet-example.com^',
    ]);

    const result = runCompiler(['--input', `tier_ads=${ads}`, '--hits', hits, '--budget', '8']);
    expect(result.status).toBe(0);
    // Printed rather than left for the reader to go and find: "ranked by 34 days" and "ranked by
    // one afternoon" are the same mechanism and very different evidence.
    expect(result.stdout).toContain('12 session(s) across 34 day(s)');
  });

  test('is deterministic with evidence: the same ledger produces byte-identical tiers', () => {
    const ads = writeInput('ads.txt', adsHosts(20));
    const hits = writeInput('hits.txt', [
      '5 ||host-19.adnet-example.com^',
      '5 ||host-18.adnet-example.com^',
      '5 ||host-01.adnet-example.com^',
    ]);

    expect(runCompiler(['--input', `tier_ads=${ads}`, '--hits', hits, '--budget', '8']).status).toBe(0);
    const first = ALL_STATIC_TIER_IDS.map((tier) => readFileSync(join(workDir, 'rules', `${tier}.json`), 'utf8'));

    expect(runCompiler(['--input', `tier_ads=${ads}`, '--hits', hits, '--budget', '8']).status).toBe(0);
    const second = ALL_STATIC_TIER_IDS.map((tier) => readFileSync(join(workDir, 'rules', `${tier}.json`), 'utf8'));

    expect(second).toEqual(first);
  });

  test('ranks a wildcard rule by the host it is about, not refuses it', () => {
    // The input side refuses `*.host` because a zone block cannot express "subdomains only". As
    // *evidence* it is not a refusal: `||host^` is how the tier would ship that coverage, and
    // ranking only reorders hosts the input produced, so widening cannot add one.
    const ads = writeInput('ads.txt', adsHosts(20));
    const hits = writeInput('hits.txt', ['9 *.host-19.adnet-example.com', '2 |host-18.adnet-example.com|']);

    const report = JSON.parse(
      runCompiler(['--input', `tier_ads=${ads}`, '--hits', hits, '--budget', '8', '--json']).stdout,
    ).hitEvidence;
    expect(report.hosts).toBe(2);
    expect(report.hits).toBe(11);
    expect(report.skipped).toBe(0);

    const synced = shippedHosts('tier_ads').filter((host) => host !== 'curated-ads.example.com');
    expect(synced[0]).toBe('host-19.adnet-example.com');
  });

  test('reads provenance written in the hot list’s own `!` comment style', () => {
    const ads = writeInput('ads.txt', adsHosts(20));
    // `build-hot-list.mjs` writes its header over `!`; a reader that only understood `#` would
    // report this evidence's worth as unknown, which is the one thing the header exists to say.
    const hits = writeInput('hits.txt', [
      '! Source:          genericBrowserRules.txt (249,751 lines)',
      '! Measured on:     browsing-trace.txt (request trace replay, 232 requests)',
      '||host-19.adnet-example.com^ 7',
    ]);

    const result = runCompiler(['--input', `tier_ads=${ads}`, '--hits', hits, '--budget', '8']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('measured on browsing-trace.txt');
  });

  test('counts the ledger exactly as core’s parser does', () => {
    const ads = writeInput('ads.txt', adsHosts(20));
    const ledger = [
      '# Browser-reported rule-hit ledger',
      '# Sessions: 3',
      '# Days: 2',
      '7 ||host-19.adnet-example.com^',
      '2 ||host-18.adnet-example.com^',
      '1 ||host-00.adnet-example.com^',
      '500 @@||allowed-example.com^',
      '42',
    ].join('\n');
    const hits = writeInput('hits.txt', ledger.split('\n'));

    const report = JSON.parse(
      runCompiler(['--input', `tier_ads=${ads}`, '--hits', hits, '--budget', '8', '--json']).stdout,
    ).hitEvidence;
    const core = parseHitLedgerText(ledger);

    // Same block entries, same total, same refusals. The compiler has its own reader so it can run
    // before core is built; this is what keeps that from becoming a second, drifting definition.
    // The one deliberate difference is a `*.host` rule, which core keeps as written and this
    // reader counts against the base host — asserted separately, above.
    expect(report.read).toBe(core.hits.length);
    expect(report.hits).toBe(core.hits.reduce((sum, hit) => sum + hit.count, 0));
    expect(report.hosts).toBe(core.hits.length);
    // One exception plus one bare number: the two lines that name no block.
    expect(report.skipped).toBe(core.exceptions.length + 1);
    expect(report.header.sessions).toBe('3');
    expect(report.header.days).toBe('2');
  });
});

/**
 * `--attribution`: placing a host from the hub's own category instead of from its name.
 *
 * The vocabulary this replaces is not merely weak, it is wrong in a specific way — it cannot tell
 * a host that is *only* an ad host from one that a publisher filed as an ad and two tracking
 * lists, because both look like words in a name. So these tests check the placement of hosts the
 * two methods would place *differently*, not merely that a flag is accepted.
 */
describe('compile-tier-rulesets — per-category attribution', () => {
  /** Writes an attribution directory in the shape the desktop hub produces. */
  function writeAttribution(
    name: string,
    files: Record<string, string[]>,
    manifestOverrides: Record<string, unknown> = {},
  ): string {
    const dir = join(workDir, name);
    mkdirSync(dir, { recursive: true });
    const categories = Object.keys(files);
    const counts: Record<string, number> = {};
    for (const [category, lines] of Object.entries(files)) {
      writeFileSync(join(dir, `${category}.txt`), lines.join('\n') + '\n', 'utf8');
      counts[category] = new Set(lines).size;
    }
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(
        {
          format: 'blockingmachine-category-attribution',
          version: 1,
          counts,
          hosts: new Set(Object.values(files).flat()).size,
          contested: 0,
          unusableRules: 0,
          categories,
          empty: [],
          ...manifestOverrides,
        },
        null,
        2,
      ),
      'utf8',
    );
    return dir;
  }

  test('places a host by the category its publisher filed it under, not by its name', () => {
    // The name says tracker. The publisher says ads. The category wins, and the vocabulary
    // would have put this host in tier_privacy.
    const input = writeInput('list.txt', ['||tracker-widget-example.com^', '||plain-example.com^']);
    const attribution = writeAttribution('attr-ok', {
      ads: ['||tracker-widget-example.com^'],
      privacy: ['||plain-example.com^'],
    });

    const report = JSON.parse(
      runCompiler(['--input', input, '--attribution', attribution, '--budget', '8', '--json']).stdout,
    );
    expect(report.attribution.placedByAttribution).toBe(2);
    expect(report.attribution.placedByVocabulary).toBe(0);
    expect(shippedHosts('tier_ads')).toContain('tracker-widget-example.com');
    expect(shippedHosts('tier_privacy')).toContain('plain-example.com');
  });

  test('a category beats the curated seed only where the seed says nothing', () => {
    // `curated-ads.example.com` is in the baseline for this suite; a category claiming it must
    // not move it, or a regenerated diff would touch the hand-picked part of the file.
    const input = writeInput('list.txt', ['||curated-ads.example.com^', '||fresh-example.com^']);
    const attribution = writeAttribution('attr-curated', { privacy: ['||curated-ads.example.com^'] });

    runCompiler(['--input', input, '--attribution', attribution, '--budget', '8']);
    expect(shippedHosts('tier_ads')).toContain('curated-ads.example.com');
    expect(shippedHosts('tier_privacy')).not.toContain('curated-ads.example.com');
  });

  test('resolves a host several publishers claimed by a stated precedence', () => {
    // ads + privacy + annoyances, all three true at once. One tier has to win, and the count of
    // such hosts is reported so a taxonomy that coarse is visible rather than assumed.
    const input = writeInput('list.txt', [
      '||contested-example.com^',
      '||ads-and-privacy-example.com^',
    ]);
    const attribution = writeAttribution('attr-contested', {
      ads: ['||contested-example.com^', '||ads-and-privacy-example.com^'],
      privacy: ['||contested-example.com^', '||ads-and-privacy-example.com^'],
      annoyances: ['||contested-example.com^'],
    });

    const result = runCompiler([
      '--input', input, '--attribution', attribution, '--budget', '8', '--json',
    ]);
    const report = JSON.parse(result.stdout);
    expect(report.attribution.contested).toBe(2);
    // Annoyances is the most specific claim; ads outranks privacy.
    expect(shippedHosts('tier_annoyances')).toContain('contested-example.com');
    expect(shippedHosts('tier_ads')).toContain('ads-and-privacy-example.com');
  });

  test('leaves security and unbreak to the residual, and says so by name', () => {
    // Routing the security lists into the always-on tier would put malware hosts in the tier that
    // ships enabled, which is the one thing the tier/model agreement check exists to catch. The
    // decision is the compiler's to report, not the reader's to discover.
    const input = writeInput('list.txt', ['||threat-gateway-example.com^', '||allowed-example.com^']);
    const attribution = writeAttribution('attr-security', {
      security: ['||threat-gateway-example.com^'],
      unbreak: ['||allowed-example.com^'],
    });

    const result = runCompiler([
      '--input', input, '--attribution', attribution, '--budget', '8',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no tier for: security, unbreak');
    // The residual is the opt-in tier, so nothing lands in the default-on one.
    expect(shippedHosts('tier_ads')).toContain('threat-gateway-example.com');
    expect(shippedHosts('tier_core')).not.toContain('threat-gateway-example.com');
  });

  test('a security host with a malware name still reaches the always-on tier, as it always did', () => {
    // The vocabulary fallback is not neutral, and pretending otherwise would be the more flattering
    // bug. `CORE_INDICATORS` is checked before the residual, so a host named for what it is —
    // `malware`, `phishing`, `scam` — has always gone to `tier_core` even when the hub filed it
    // under `security` and `security` maps to no tier. Attribution does not change that, and this
    // pins the behaviour so it is a decision rather than an accident: it is the *only* route by
    // which a security-list host reaches the always-on tier, and it is name-based, so a publisher
    // that files a threat domain under an unremarkable name gets the opt-in treatment instead.
    const input = writeInput('list.txt', ['||malware-gateway-example.com^']);
    const attribution = writeAttribution('attr-core-ind', { security: ['||malware-gateway-example.com^'] });

    runCompiler(['--input', input, '--attribution', attribution, '--budget', '8']);
    expect(shippedHosts('tier_core')).toContain('malware-gateway-example.com');

    // Same host, no attribution at all: the identical placement, which is the point — this path
    // belongs to the vocabulary, not to the categories.
    const plain = writeInput('plain.txt', ['||malware-gateway-example.com^']);
    runCompiler(['--input', plain, '--budget', '8']);
    expect(shippedHosts('tier_core')).toContain('malware-gateway-example.com');
  });

  test('falls back to vocabulary only for a host the hub had no category for', () => {
    const input = writeInput('list.txt', [
      '||tracker-widget-example.com^', // categorised as an ad, despite the name
      '||banner-host-example.com^', // uncategorised, but `banner` is in the ad vocabulary
      '||nothingrecognisable-example.com^', // uncategorised and unnamed
    ]);
    const attribution = writeAttribution('attr-partial', {
      ads: ['||tracker-widget-example.com^'],
    });

    const report = JSON.parse(
      runCompiler(['--input', input, '--attribution', attribution, '--budget', '8', '--json']).stdout,
    );
    expect(report.attribution.placedByAttribution).toBe(1);
    expect(report.attribution.placedByVocabulary).toBe(1);
    expect(report.unclassified).toBe(1);
    // The report states the split, so a partial attribution cannot read as a full one.
    expect(report.attribution.hosts).toBe(1);
  });

  test('says plainly when nothing was attributed rather than implying it was', () => {
    const input = writeInput('list.txt', ['||adnet-example.com^']);
    const result = runCompiler(['--input', input, '--budget', '8']);
    expect(result.stdout).toContain('no per-category attribution given');
  });

  test('refuses a missing directory instead of quietly guessing', () => {
    const input = writeInput('list.txt', ['||adnet-example.com^']);
    const result = runCompiler(['--input', input, '--attribution', join(workDir, 'nope'), '--json']);
    expect(result.status).not.toBe(0);
    // `runCompiler` folds stderr into stdout, so a refusal is readable the same way either way.
    expect(result.stdout).toContain('attribution directory not found');
  });

  test('refuses a manifest that is not one, rather than half-reading it', () => {
    const input = writeInput('list.txt', ['||adnet-example.com^']);
    const dir = writeAttribution('attr-wrong', { ads: ['||adnet-example.com^'] });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ format: 'something-else', categories: ['ads'] }),
      'utf8',
    );

    const result = runCompiler(['--input', input, '--attribution', dir, '--json']);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('not a Blockingmachine attribution manifest');
  });

  test('names a category the manifest promises but the directory lacks', () => {
    // Otherwise a deleted file reads as a category that simply matched nothing, which is the one
    // reading that would quietly shrink a user's blocking.
    const input = writeInput('list.txt', ['||adnet-example.com^']);
    const dir = writeAttribution('attr-short', { ads: ['||adnet-example.com^'] });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(
        { format: 'blockingmachine-category-attribution', version: 1, categories: ['ads', 'privacy'], counts: { ads: 1, privacy: 1 }, hosts: 1, contested: 0, unusableRules: 0, empty: [] },
        null,
        2,
      ),
      'utf8',
    );

    const result = runCompiler(['--input', input, '--attribution', dir, '--budget', '8']);
    expect(result.stdout).toContain('privacy (file missing)');
  });

  test('is deterministic: the same attribution produces byte-identical tiers', () => {
    const input = writeInput('list.txt', [
      ...adsHosts(12).map((host) => `||${host}^`),
      '||tracker-widget-example.com^',
    ]);
    const attribution = writeAttribution('attr-det', {
      ads: adsHosts(6).map((host) => `||${host}^`),
      privacy: ['||tracker-widget-example.com^'],
    });

    // `--budget 20` where the other cases use 8. With five tiers sharing the pool the annoyances
    // cap rounds to nothing at 8, so its single curated host is left unserved and the compiler
    // refuses the run outright rather than dropping it — which is the right refusal, and not what
    // this case is about. At 20 every tier's curated seed fits and the redistribution this test
    // needs still runs.
    expect(runCompiler(['--input', input, '--attribution', attribution, '--budget', '20']).status).toBe(0);
    const first = ALL_STATIC_TIER_IDS.map((tier) => readFileSync(join(workDir, 'rules', `${tier}.json`), 'utf8'));

    expect(runCompiler(['--input', input, '--attribution', attribution, '--budget', '20']).status).toBe(0);
    const second = ALL_STATIC_TIER_IDS.map((tier) => readFileSync(join(workDir, 'rules', `${tier}.json`), 'utf8'));

    expect(second).toEqual(first);
  });

  test('reads attribution through the same shapes core writes, agreeing host for host', () => {
    // The compiler carries its own `extractHostFromLine` so it can run before core is built, and
    // core owns a second one for the hub that writes these files. This is what keeps the two
    // copies from drifting — and it is why an attribution file can be a plain blocklist rather
    // than a format of its own.
    const shapes = [
      '||ads.example.com^',
      '0.0.0.0 hosts.example.com',
      'address=/dnsmasq.example.com/0.0.0.0',
      'local-zone: "unbound.example.com"',
      '||modifiers.example.com^$third-party',
      '||UPPER.Example.COM^',
      '||blocked.example.com^$badfilter',
    ];
    // What core says these are, computed here rather than asserted as a constant, so a change to
    // core's extractor has to be acknowledged in this test rather than silently diverging.
    const coreHosts = shapes.map(coreExtractHostFromRule).filter((host): host is string => !!host);

    const dir = writeAttribution('attr-shapes', { ads: shapes });
    const input = writeInput('list.txt', shapes);
    // A budget that leaves room: the four curated baseline hosts are served first, and at
    // `--budget 8` the share cap drops two of these regardless of attribution.
    const report = JSON.parse(
      runCompiler(['--input', input, '--attribution', dir, '--budget', '40', '--json']).stdout,
    );

    // The compiler's reader found exactly what core's did — six of the seven, with the seventh
    // naming a directive rather than a zone.
    expect(report.attribution.hosts).toBe(coreHosts.length);
    expect(coreHosts).toHaveLength(6);
    for (const host of coreHosts) {
      expect(shippedHosts('tier_ads')).toContain(host);
    }
    expect(shippedHosts('tier_ads')).not.toContain('blocked.example.com');
  });
});
