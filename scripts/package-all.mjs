#!/usr/bin/env node

/**
 * Blockingmachine Complete Release Packaging Automation
 * Builds all monorepo distribution artifacts and gathers them into ./make/
 * 
 * Artifacts collected in ./make/:
 * - Desktop installers: macOS (.dmg, .zip), Linux (.deb, .rpm), Windows (.exe)
 * - NPM packages: @blockingmachine/core (.tgz), @blockingmachine/cli (.tgz)
 * - Browser extensions: Chrome Web Store (.zip), Firefox AMO (.zip)
 * - Cryptographic verification: SHA256SUMS.txt
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');
const MAKE_DIR = resolve(ROOT_DIR, 'make');

const rootPkg = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8'));
const version = rootPkg.version;

console.log(`\n🚀 [Package All] Building and collecting release artifacts for v${version}`);
console.log(`📁 Target directory: ${MAKE_DIR}\n`);

mkdirSync(MAKE_DIR, { recursive: true });

// 1. Build and package browser extensions
console.log('📦 [1/4] Packaging Manifest V3 browser extensions...');
execSync('node scripts/package-extension.mjs', { cwd: ROOT_DIR, stdio: 'inherit' });

const extDir = resolve(ROOT_DIR, 'dist/extensions');
if (existsSync(extDir)) {
  for (const file of readdirSync(extDir)) {
    if (file.endsWith('.zip')) {
      cpSync(resolve(extDir, file), resolve(MAKE_DIR, file));
    }
  }
}

// 2. Pack NPM core and cli tarballs
console.log('\n📦 [2/4] Packing NPM release packages...');
for (const pkg of ['core', 'cli']) {
  const pkgDir = resolve(ROOT_DIR, 'packages', pkg);
  execSync('npm pack', { cwd: pkgDir, stdio: 'inherit' });
  for (const file of readdirSync(pkgDir)) {
    if (file.endsWith('.tgz')) {
      cpSync(resolve(pkgDir, file), resolve(MAKE_DIR, file));
      execSync(`rm -f "${resolve(pkgDir, file)}"`);
    }
  }
}

// 3. Package Electron desktop app
console.log('\n📦 [3/4] Building desktop application installers via Electron Forge...');
execSync('npm run --prefix packages/electron-app make', { cwd: ROOT_DIR, stdio: 'inherit' });

const forgeOutDir = resolve(ROOT_DIR, 'packages/electron-app/out/make');
if (existsSync(forgeOutDir)) {
  const findFiles = (dir) => {
    let results = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(findFiles(fullPath));
      } else if (/\.(dmg|zip|exe|deb|rpm)$/i.test(entry.name)) {
        results.push(fullPath);
      }
    }
    return results;
  };

  const installers = findFiles(forgeOutDir);
  for (const installer of installers) {
    let destName = basename(installer);
    // Normalize plain Blockingmachine.dmg to include version and arch
    if (destName === 'Blockingmachine.dmg') {
      const arch = process.arch;
      destName = `Blockingmachine-${version}-${arch}.dmg`;
    }
    cpSync(installer, resolve(MAKE_DIR, destName));
  }
}

// 4. Generate SHA256SUMS.txt
console.log('\n🔒 [4/4] Generating cryptographic SHA-256 verification checksums...');
const allFiles = readdirSync(MAKE_DIR)
  .filter((f) => f !== 'SHA256SUMS.txt' && statSync(resolve(MAKE_DIR, f)).isFile())
  .sort();

const checksumLines = allFiles.map((filename) => {
  const fileBuffer = readFileSync(resolve(MAKE_DIR, filename));
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  return `${hash}  ${filename}`;
});

const checksumFile = resolve(MAKE_DIR, 'SHA256SUMS.txt');
writeFileSync(checksumFile, checksumLines.join('\n') + '\n', 'utf8');

console.log('\n✨ [Success] All release artifacts generated inside ./make/:\n');
const summary = allFiles.map((filename) => {
  const sizeMb = (statSync(resolve(MAKE_DIR, filename)).size / (1024 * 1024)).toFixed(2);
  const hash = checksumLines.find((l) => l.endsWith(` ${filename}`)).slice(0, 16);
  return { File: filename, Size: `${sizeMb} MB`, 'SHA-256 (prefix)': `${hash}...` };
});

console.table(summary);
console.log(`Verification file: ${checksumFile}\n`);
