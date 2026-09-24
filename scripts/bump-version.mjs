#!/usr/bin/env node

/**
 * Blockingmachine Monorepo Version Bumping Utility
 *
 * Keeps all versions in sync across:
 *  - Root package.json
 *  - All packages/* /package.json files
 *  - Inter-package dependency ranges (@blockingmachine/core, @blockingmachine/cli, etc.)
 *  - package-lock.json (via npm install --package-lock-only)
 *  - README.md release badge
 *
 * Usage:
 *   node scripts/bump-version.js <version>
 *   npm run version:bump <version>
 *
 * Examples:
 *   node scripts/bump-version.js 1.0.0-rc.3
 *   node scripts/bump-version.js "1.0.0 rc3"
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// 1. Parse and normalize version input
const rawInput = process.argv.slice(2).join(' ').trim();

if (!rawInput || rawInput === '-h' || rawInput === '--help') {
  console.log(`
Blockingmachine Monorepo Version Bump Tool

Usage:
  npm run version:bump <version>
  node scripts/bump-version.js <version>

Examples:
  npm run version:bump 1.0.0-rc.3
  npm run version:bump "1.0.0 rc3"
  npm run version:bump 1.0.0
`);
  process.exit(rawInput ? 0 : 1);
}

function normalizeVersion(input) {
  let v = input.trim();
  // Strip leading 'v' or 'V'
  if (v.startsWith('v') || v.startsWith('V')) {
    v = v.slice(1).trim();
  }

  // Handle patterns like "1.0.0 rc3", "1.0.0 rc.3", "1.0.0-rc3" -> "1.0.0-rc.3"
  const rcMatch = v.match(/^(\d+\.\d+\.\d+)[-\s]rc\.?(\d+)$/i);
  if (rcMatch) {
    return `${rcMatch[1]}-rc.${rcMatch[2]}`;
  }

  // Handle patterns like "1.0.0 beta3", "1.0.0-beta.3"
  const betaMatch = v.match(/^(\d+\.\d+\.\d+)[-\s]beta\.?(\d+)$/i);
  if (betaMatch) {
    return `${betaMatch[1]}-beta.${betaMatch[2]}`;
  }

  // Handle patterns like "1.0.0 alpha3"
  const alphaMatch = v.match(/^(\d+\.\d+\.\d+)[-\s]alpha\.?(\d+)$/i);
  if (alphaMatch) {
    return `${alphaMatch[1]}-alpha.${alphaMatch[2]}`;
  }

  return v;
}

const targetVersion = normalizeVersion(rawInput);

// Validate SemVer syntax
const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

if (!semverRegex.test(targetVersion)) {
  console.error(`❌ Error: "${rawInput}" (normalized to "${targetVersion}") is not a valid SemVer string.`);
  console.error('Expected formats: 1.0.0, 1.0.0-rc.3, 1.0.0-beta.1');
  process.exit(1);
}

console.log(`\n🚀 Synchronizing Blockingmachine monorepo version to: ${targetVersion}\n`);

// 2. Discover package.json files
const rootPkgPath = path.join(rootDir, 'package.json');
const packagesDir = path.join(rootDir, 'packages');

const packagePaths = [rootPkgPath];
const workspaceNames = new Set();

if (fs.existsSync(packagesDir)) {
  const dirs = fs.readdirSync(packagesDir, { withFileTypes: true });
  for (const dir of dirs) {
    if (dir.isDirectory()) {
      const pkgPath = path.join(packagesDir, dir.name, 'package.json');
      if (fs.existsSync(pkgPath)) {
        packagePaths.push(pkgPath);
        try {
          const content = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (content.name) {
            workspaceNames.add(content.name);
          }
        } catch {
          // ignore parse errors for now
        }
      }
    }
  }
}

console.log(`📦 Internal workspaces identified:`);
workspaceNames.forEach(name => console.log(`   - ${name}`));
console.log('');

// 3. Update all package.json files and dependencies
const updatedFiles = [];

for (const pkgPath of packagePaths) {
  const relPath = path.relative(rootDir, pkgPath);
  const rawContent = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(rawContent);

  const prevVersion = pkg.version;
  pkg.version = targetVersion;

  // Update internal dependencies
  const depSections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  let depsUpdated = 0;

  for (const section of depSections) {
    if (pkg[section] && typeof pkg[section] === 'object') {
      for (const depName of Object.keys(pkg[section])) {
        if (workspaceNames.has(depName)) {
          pkg[section][depName] = `^${targetVersion}`;
          depsUpdated++;
        }
      }
    }
  }

  // Preserve formatting with 2 spaces and trailing newline
  const newContent = JSON.stringify(pkg, null, 2) + '\n';
  fs.writeFileSync(pkgPath, newContent, 'utf8');

  console.log(`✅ [${relPath}] version: ${prevVersion} -> ${targetVersion} (${depsUpdated} internal deps updated)`);
  updatedFiles.push(relPath);
}

// 4. Update README.md badge if present
const readmePath = path.join(rootDir, 'README.md');
try {
  let readme = fs.readFileSync(readmePath, 'utf8');
  // Shields.io uses double dashes for hyphens in tags: 1.0.0-rc.3 -> 1.0.0--rc.3
  const shieldsTag = targetVersion.replace(/-/g, '--');
  const badgeRegex = /img\.shields\.io\/badge\/Release-v[0-9a-zA-Z_.-]+-orange\.svg/g;
  const newBadge = `img.shields.io/badge/Release-v${shieldsTag}-orange.svg`;

  if (badgeRegex.test(readme)) {
    readme = readme.replace(badgeRegex, newBadge);
    fs.writeFileSync(readmePath, readme, 'utf8');
    console.log(`✅ [README.md] Release badge updated to v${shieldsTag}`);
    updatedFiles.push('README.md');
  }
} catch {
  // README.md does not exist or is not accessible
}

// 5. Sync package-lock.json
console.log(`\n🔒 Updating package-lock.json via "npm install --package-lock-only"...`);
try {
  execSync('npm install --package-lock-only', {
    cwd: rootDir,
    stdio: 'inherit',
  });
  console.log(`✅ [package-lock.json] Synchronized cleanly.`);
  updatedFiles.push('package-lock.json');
} catch (error) {
  console.warn(`⚠️ Warning: npm install --package-lock-only encountered an error:`, error.message);
}

// 6. Summary & next steps
console.log(`\n🎉 Successfully bumped all packages to v${targetVersion}!`);
console.log(`\nModified files:`);
updatedFiles.forEach(f => console.log(`   - ${f}`));

console.log(`
Next release steps:
   git add .
   git commit -m "chore(release): v${targetVersion}"
   git tag -a v${targetVersion} -m "Release v${targetVersion}"
`);
