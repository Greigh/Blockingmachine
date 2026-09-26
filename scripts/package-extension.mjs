#!/usr/bin/env node

/**
 * Multi-Store Browser Extension Packaging Automation
 * Builds the extension bundle, validates MV3 compliance, and packages clean
 * .zip archives for Chrome Web Store and Firefox Add-ons (AMO).
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync, cpSync, rmSync } from 'fs';
import { resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const ROOT_DIR = resolve(__dirname, '..');
const EXT_DIR = resolve(ROOT_DIR, 'packages/browser-extension');
const DIST_DIR = resolve(EXT_DIR, 'dist');
const OUT_DIR = resolve(ROOT_DIR, 'dist/extensions');

console.log('📦 [Package Extension] Starting multi-store extension packaging...');

// 1. Build extension bundle
console.log('🔨 [1/5] Building extension distribution bundle...');
execFileSync('npm', ['run', 'build', '--workspace=@blockingmachine/browser-extension'], {
  cwd: ROOT_DIR,
  stdio: 'inherit',
});

// 2. Validate MV3 compliance
console.log('🔍 [2/5] Running Manifest V3 compliance guardian...');
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

// 4. Chrome Web Store package
console.log('🌐 [3/5] Packaging Chrome Web Store bundle...');
const chromeZip = resolve(OUT_DIR, `blockingmachine-chrome-mv3-v${version}.zip`);
createZip(DIST_DIR, chromeZip);
const chromeSha = sha256(chromeZip);
const chromeSizeKb = (statSync(chromeZip).size / 1024).toFixed(1);
console.log(`✅ [Chrome] ${basename(chromeZip)} (${chromeSizeKb} KB, SHA-256: ${chromeSha.slice(0, 16)}...)`);

// 5. Firefox AMO package
console.log('🦊 [4/5] Packaging Firefox AMO bundle with gecko manifest extension...');
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

// 6. Summary Table
console.log('\n📊 [5/5] Multi-Store Release Artifacts Ready:');
console.log('┌───────────────────────────────────────────────────┬──────────┬──────────────────────┐');
console.log('│ Archive                                           │ Size     │ SHA-256 Checksum     │');
console.log('├───────────────────────────────────────────────────┼──────────┼──────────────────────┤');
console.log(`│ ${basename(chromeZip).padEnd(49)} │ ${(chromeSizeKb + ' KB').padEnd(8)} │ ${chromeSha.slice(0, 20)}... │`);
console.log(`│ ${basename(firefoxZip).padEnd(49)} │ ${(firefoxSizeKb + ' KB').padEnd(8)} │ ${firefoxSha.slice(0, 20)}... │`);
console.log('└───────────────────────────────────────────────────┴──────────┴──────────────────────┘');
console.log(`🚀 Artifacts saved to: ${OUT_DIR}\n`);
