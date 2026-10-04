#!/usr/bin/env node
/**
 * Release rehearsal: run the tier compiler and extension packaging for real, against a fixture
 * blocklist, and open the shipped archives to assert what is actually in them.
 *
 * The point is to catch packaging breaks on a pull request rather than at release. A rehearsal
 * that only watches exit codes cannot tell a zip is missing its rulesets; this one unzips both
 * archives and checks that every manifest-declared ruleset is present, parses, and carries the
 * fixture hosts that prove the compile reached the artifact.
 *
 * The rehearsal rewrites the real tier files, exactly as a release does — but it snapshots them
 * byte-for-byte first and restores them when it finishes, pass or fail, so a rehearsal never
 * commits a compile by accident.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgvOrExit } from './argv.mjs';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(ROOT_DIR, 'packages', 'browser-extension');
const RULES_DIR = join(EXTENSION_DIR, 'rules');
const COUNTS_PATH = join(EXTENSION_DIR, 'src', 'shared', 'tierCounts.generated.ts');
const OUT_DIR = join(ROOT_DIR, 'dist', 'extensions');
const FIXTURE = join(ROOT_DIR, 'scripts', 'fixtures', 'release-rehearsal-blocklist.txt');

const TIER_IDS = [
  'tier_core',
  'tier_ads',
  'tier_privacy',
  'tier_annoyances',
  'tier_security',
  'tier_unclassified',
];
// The two tiers the manifest ships opt-in and the compile fills only from evidence inputs —
// curated seeds never land there, so an empty file is the correct shape on a fixture plan.
const MAY_SHIP_EMPTY = new Set(['tier_security', 'tier_unclassified']);

// What the fixture is built to produce — a host whose vocabulary places it, in a `rehearsal.example`
// zone no real blocklist could carry, so finding it in the artifact is proof rather than luck.
const EXPECTED_PLACEMENTS = [
  ['ads.rehearsal.example', 'tier_ads'],
  ['metrics.rehearsal.example', 'tier_privacy'],
  ['consent.rehearsal.example', 'tier_annoyances'],
  ['malware.rehearsal.example', 'tier_core'],
  ['plain.rehearsal.example', 'tier_unclassified'],
  ['dns.rehearsal.example', 'tier_unclassified'],
];
// Lines the compiler must refuse — none may appear in any tier file or archive.
const REFUSED = [
  'allowed.rehearsal.example',
  '192.168.9.9',
  'singlelabel',
  'wildcard.rehearsal.example',
];

parseArgvOrExit(process.argv.slice(2), {
  summary: 'rehearse a release against the fixture blocklist and inspect the archives it ships',
});

function step(message) {
  console.log(`==> ${message}`);
}

function fail(message) {
  const error = new Error(`release rehearsal: ${message}`);
  error.rehearsalFailure = true;
  throw error;
}

/** Snapshot every file the compile is allowed to rewrite, byte for byte. */
function snapshotTierState() {
  const paths = [...TIER_IDS.map((t) => join(RULES_DIR, `${t}.json`)), COUNTS_PATH];
  return new Map(paths.map((p) => [p, existsSync(p) ? readFileSync(p) : null]));
}

function restoreTierState(snapshot) {
  for (const [path, bytes] of snapshot) {
    if (bytes === null) {
      rmSync(path, { force: true });
    } else {
      writeFileSync(path, bytes);
    }
  }
}

function tierRules(tierId) {
  const path = join(RULES_DIR, `${tierId}.json`);
  if (!existsSync(path)) fail(`the compile left no ${tierId}.json to package`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`the compile wrote a ${tierId}.json that is not valid JSON`);
  }
}

function hostInRules(host, rules) {
  return rules.some(
    (rule) =>
      typeof rule?.condition?.urlFilter === 'string' && rule.condition.urlFilter.includes(host),
  );
}

/** assertFixturePlan verifies the fixture compile placed and refused exactly what it should. */
function assertFixturePlan(report) {
  for (const tier of TIER_IDS) {
    if (!Number.isInteger(report.counts?.[tier] ?? NaN)) {
      fail(`compiler report has no count for ${tier}`);
    }
  }
  const allRules = new Map(TIER_IDS.map((t) => [t, tierRules(t)]));
  for (const [host, tier] of EXPECTED_PLACEMENTS) {
    if (!hostInRules(host, allRules.get(tier))) {
      fail(`fixture host ${host} did not land in ${tier}`);
    }
  }
  for (const host of REFUSED) {
    for (const [tier, rules] of allRules) {
      if (hostInRules(host, rules)) {
        fail(`refused fixture line ${host} produced a rule in ${tier}`);
      }
    }
  }
}

function zipListing(zipPath) {
  try {
    return execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    fail(`unzip cannot read ${zipPath} — the archive is not a readable zip`);
  }
}

function zipMember(zipPath, name) {
  try {
    return execFileSync('unzip', ['-p', zipPath, name], { encoding: 'utf8' });
  } catch {
    fail(`${name} is declared but absent from ${zipPath}`);
  }
}

function assertArchive(zipPath, { gecko = false } = {}) {
  const listing = zipListing(zipPath);
  const names = new Set(listing);
  if (!names.has('manifest.json')) fail(`no manifest.json in ${zipPath}`);
  let manifest;
  try {
    manifest = JSON.parse(zipMember(zipPath, 'manifest.json'));
  } catch {
    fail(`manifest.json in ${zipPath} is not valid JSON`);
  }
  if (manifest.manifest_version !== 3) {
    fail(`${zipPath} manifest is not manifest_version 3`);
  }
  if (gecko && manifest.browser_specific_settings?.gecko?.id !== 'blockingmachine@greighstudios.com') {
    fail(`firefox archive is missing its gecko extension id`);
  }
  // Every ruleset the manifest declares must be present and parse — a declared-but-missing ruleset
  // is a broken install, and a missing-but-declared one never existed.
  const resources = manifest.declarative_net_request?.rule_resources ?? [];
  if (resources.length !== TIER_IDS.length) {
    fail(`manifest declares ${resources.length} rulesets, expected ${TIER_IDS.length}`);
  }
  const fixtureHosts = new Map(EXPECTED_PLACEMENTS);
  for (const { id, path } of resources) {
    if (!names.has(path)) fail(`manifest declares ${id} at ${path} but the archive lacks it`);
    let rules;
    try {
      rules = JSON.parse(zipMember(zipPath, path));
    } catch {
      fail(`${path} shipped but is not valid JSON`);
    }
    if (!Array.isArray(rules)) fail(`${path} is not a rules array`);
    if (rules.length === 0 && !MAY_SHIP_EMPTY.has(id)) {
      fail(`${path} shipped empty — a curated tier must always carry rules`);
    }
    // The fixture host for this tier must have survived packaging — end-to-end proof. Only
    // curated tiers keep seeds across a recompile: compiled-only tiers are rebuilt from inputs,
    // so their fixture hosts are asserted at the compile step above, not against the archive.
    for (const [host, tier] of fixtureHosts) {
      if (tier !== id || MAY_SHIP_EMPTY.has(id)) continue;
      if (!hostInRules(host, rules)) {
        fail(`fixture host ${host} was compiled into ${id} but missing from the shipped ${path}`);
      }
    }
    for (const host of REFUSED) {
      if (hostInRules(host, rules)) {
        fail(`refused fixture host ${host} shipped in ${path}`);
      }
    }
  }
  const worker = manifest.background?.service_worker;
  if (worker && !names.has(worker)) fail(`service worker ${worker} missing from ${zipPath}`);
  const popup = manifest.action?.default_popup;
  if (popup && !names.has(popup)) fail(`popup page ${popup} missing from ${zipPath}`);
  const junk = listing.filter((n) => n.includes('.DS_Store') || n.includes('__MACOSX'));
  if (junk.length > 0) fail(`archive carries junk entries: ${junk.join(', ')}`);
  return { manifest, listing };
}

const snapshot = snapshotTierState();
try {
  step('Compiling the fixture blocklist into the real tier files');
  const planOut = execFileSync(
    'node',
    [join(ROOT_DIR, 'scripts', 'compile-tier-rulesets.mjs'), '--input', FIXTURE, '--json'],
    { cwd: ROOT_DIR, encoding: 'utf8' },
  );
  let plan;
  try {
    plan = JSON.parse(planOut);
  } catch {
    fail('the compiler did not emit a single JSON document on --json');
  }
  assertFixturePlan(plan);
  console.log(
    `   ${plan.total?.toLocaleString?.() ?? '?'} rules planned — fixture hosts placed in ` +
      `ads, privacy, annoyances, core and unclassified`,
  );

  step('Packaging the extension exactly as a release does (compile, bundle, MV3 gate, zips)');
  execFileSync('node', [join(ROOT_DIR, 'scripts', 'package-extension.mjs')], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });

  step('Opening the shipped archives');
  const zips = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => f.endsWith('.zip')) : [];
  const chromeZip = zips.find((f) => f.includes('chrome-mv3'));
  const firefoxZip = zips.find((f) => f.includes('firefox-mv3'));
  if (!chromeZip) fail('no chrome archive was produced in dist/extensions');
  if (!firefoxZip) fail('no firefox archive was produced in dist/extensions');
  const chrome = assertArchive(join(OUT_DIR, chromeZip));
  assertArchive(join(OUT_DIR, firefoxZip), { gecko: true });
  console.log(
    `   chrome archive carries ${chrome.manifest.declarative_net_request.rule_resources.length} ` +
      `rulesets, service worker and every fixture host — firefox archive carries the gecko id`,
  );

  step('Restoring the tier files the rehearsal rewrote');
} catch (error) {
  if (error?.rehearsalFailure) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  restoreTierState(snapshot);
}
