#!/usr/bin/env node

/**
 * Multi-Store Browser Extension Packaging Automation
 * Builds the extension bundle, validates MV3 compliance, and packages clean
 * .zip archives for Chrome Web Store and Firefox Add-ons (AMO).
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, cpSync, rmSync } from 'fs';
import { resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { parseArgvOrExit } from './argv.mjs';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const ROOT_DIR = resolve(__dirname, '..');
const EXT_DIR = resolve(ROOT_DIR, 'packages/browser-extension');
const DIST_DIR = resolve(EXT_DIR, 'dist');
const OUT_DIR = resolve(ROOT_DIR, 'dist/extensions');

/**
 * The accumulated browser ledger, when it holds evidence.
 *
 * `--hits` is what decides the cut: the budget is 30,000 rules against a ~117,000-domain input, so
 * which 30,000 ship is the whole decision. Without evidence the compiler takes candidates in input
 * order, and a merged blocklist's order is a merge artifact — whichever upstream list was
 * concatenated first gets the slots, which says nothing about the traffic anyone generates.
 *
 * Present-if-usable rather than required: the file is a dropbox that starts empty, and a package
 * built before any browser has reported anything still has to build. An empty dropbox means no
 * `--hits`, and the compiler says so in its own report rather than this script guessing.
 */
const LEDGER = resolve(ROOT_DIR, 'ledger/ledger-hits.txt');
const ledgerHasHits = () =>
  existsSync(LEDGER) && /^#*\s*\d+\s+\S/m.test(readFileSync(LEDGER, 'utf8'));

console.log('📦 [Package Extension] Starting multi-store extension packaging...');

// Refusing parse: `--skip-tier` (no s) used to land nowhere and silently run the full compile
// the operator tried to skip.
const { flags: argvFlags } = parseArgvOrExit(process.argv.slice(2), { flags: ['--skip-tiers'] });
const skipTiers = argvFlags.has('--skip-tiers');

// 1. Compile the desktop hub's active blocklist into the static tier files.
//
// This has to happen *before* the bundle is built, because the counts module it writes is
// imported by the runtime — the popup's capacity display would otherwise report the
// curated baseline while the package shipped tens of thousands of rules. Pass --skip-tiers
// to release the checked-in curated baseline instead (smaller artifact, no hub needed).
if (skipTiers) {
  console.log('⏭️  [1/6] Skipping tier compilation (--skip-tiers): shipping the curated baseline.');
} else {
  const ranked = ledgerHasHits();
  console.log('🗂️  [1/6] Compiling static ruleset tiers from the desktop hub blocklist...');
  if (ranked) console.log('     Ranking the cut by the accumulated browser ledger (ledger/ledger-hits.txt).');
  try {
    execFileSync(
      'node',
      ['scripts/compile-tier-rulesets.mjs', ...(ranked ? ['--hits', LEDGER] : [])],
      {
        cwd: ROOT_DIR,
        stdio: 'inherit',
      },
    );
  } catch (err) {
    console.error('❌ [Error] Tier compilation failed. Pass --skip-tiers to ship the curated baseline.');
    process.exit(1);
  }
}

// 2. Build extension bundle
console.log('🔨 [2/6] Building extension distribution bundle...');
execFileSync('npm', ['run', 'build', '--workspace=@blockingmachine/browser-extension'], {
  cwd: ROOT_DIR,
  stdio: 'inherit',
});

// 3. Validate MV3 compliance
console.log('🔍 [3/6] Running Manifest V3 compliance guardian...');
execFileSync('node', ['scripts/verify-mv3-compliance.mjs'], {
  cwd: ROOT_DIR,
  stdio: 'inherit',
});

// 3. Read manifest and version
const manifestPath = resolve(DIST_DIR, 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  console.error('❌ [Error] manifest.json missing from dist directory.');
  process.exit(1);
}
const version = manifest.version || '1.0.0';

mkdirSync(OUT_DIR, { recursive: true });

// Helper to compute sha256
function sha256(filePath) {
  const content = readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Helper to zip a directory safely without shell injection
function createZip(sourceDir, targetZipPath) {
  rmSync(targetZipPath, { force: true });
  execFileSync('zip', ['-q', '-r', targetZipPath, '.', '-x', '*.DS_Store', '-x', '__MACOSX*'], { cwd: sourceDir });
}

// 5. Chrome Web Store package
console.log('🌐 [4/6] Packaging Chrome Web Store bundle...');
const chromeZip = resolve(OUT_DIR, `blockingmachine-chrome-mv3-v${version}.zip`);
createZip(DIST_DIR, chromeZip);
const chromeSha = sha256(chromeZip);
const chromeSizeKb = (statSync(chromeZip).size / 1024).toFixed(1);
console.log(`✅ [Chrome] ${basename(chromeZip)} (${chromeSizeKb} KB, SHA-256: ${chromeSha.slice(0, 16)}...)`);

// 6. Firefox AMO package
console.log('🦊 [5/6] Packaging Firefox AMO bundle with gecko manifest extension...');
const firefoxDistDir = resolve(OUT_DIR, 'firefox-stage');
rmSync(firefoxDistDir, { recursive: true, force: true });
mkdirSync(firefoxDistDir, { recursive: true });
cpSync(DIST_DIR, firefoxDistDir, { recursive: true });

// Inject Firefox AMO gecko ID
const firefoxManifest = {
  ...manifest,
  browser_specific_settings: {
    gecko: {
      id: 'blockingmachine@greighstudios.com',
      strict_min_version: '109.0',
    },
  },
};
writeFileSync(
  resolve(firefoxDistDir, 'manifest.json'),
  JSON.stringify(firefoxManifest, null, 2),
  'utf8'
);

const firefoxZip = resolve(OUT_DIR, `blockingmachine-firefox-mv3-v${version}.zip`);
createZip(firefoxDistDir, firefoxZip);
const firefoxSha = sha256(firefoxZip);
const firefoxSizeKb = (statSync(firefoxZip).size / 1024).toFixed(1);
console.log(`✅ [Firefox] ${basename(firefoxZip)} (${firefoxSizeKb} KB, SHA-256: ${firefoxSha.slice(0, 16)}...)`);

// Clean up staging directory
rmSync(firefoxDistDir, { recursive: true, force: true });

// 7. Summary Table
console.log('\n📊 [6/6] Multi-Store Release Artifacts Ready:');
console.log('┌───────────────────────────────────────────────────┬──────────┬──────────────────────┐');
console.log('│ Archive                                           │ Size     │ SHA-256 Checksum     │');
console.log('├───────────────────────────────────────────────────┼──────────┼──────────────────────┤');
console.log(`│ ${basename(chromeZip).padEnd(49)} │ ${(chromeSizeKb + ' KB').padEnd(8)} │ ${chromeSha.slice(0, 20)}... │`);
console.log(`│ ${basename(firefoxZip).padEnd(49)} │ ${(firefoxSizeKb + ' KB').padEnd(8)} │ ${firefoxSha.slice(0, 20)}... │`);
console.log('└───────────────────────────────────────────────────┴──────────┴──────────────────────┘');
console.log(`🚀 Artifacts saved to: ${OUT_DIR}\n`);
