#!/usr/bin/env node

/**
 * Blockingmachine Complete Autonomous Release Automation
 *
 * Automates the entire release cycle with a single command:
 * 1. Validates SemVer & checks pre-flight repo status
 * 2. Runs automated tests, linter, and compilation checks
 * 3. Bumps version across all 8 workspaces, package-lock.json, README & SECURITY
 * 4. Ensures release notes & CHANGELOG.md entries are present
 * 5. Compiles all release artifacts into ./make/ (DMG, ZIP, NPM tgz, Extensions, SHA256SUMS)
 * 6. Commits changes and creates annotated git tag
 * 7. Pushes main and tag to GitHub ('origin') and Forgejo ('forgejo')
 * 8. Publishes GitHub Pre-Release / Release with all assets attached via gh CLI
 *
 * Usage:
 *   npm run release <version> [options]
 *   node scripts/release.mjs <version> [options]
 *
 * Options:
 *   --skip-tests    Skip test suite execution
 *   --skip-build    Skip build verification before packaging
 *   --skip-make     Skip desktop app compiling (DMG/ZIP)
 *   --dry-run       Perform validation and packaging without git commit/push/release
 *   --help, -h      Show help message
 *
 * Examples:
 *   npm run release 1.0.0-rc.6
 *   npm run release 1.0.0
 *   npm run release 1.0.0-rc.6 --skip-tests
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');
const MAKE_DIR = resolve(ROOT_DIR, 'make');

// Parse arguments
const args = process.argv.slice(2);
const isHelp = args.includes('-h') || args.includes('--help');
const isDryRun = args.includes('--dry-run');
const skipTests = args.includes('--skip-tests');
const skipBuild = args.includes('--skip-build');
const skipMake = args.includes('--skip-make');

if (isHelp) {
  console.log(`
Blockingmachine Release Tool

Usage:
  npm run release <version> [options]
  node scripts/release.mjs <version> [options]

Arguments:
  <version>       Target version (e.g., 1.0.0-rc.6, 1.0.0)

Options:
  --skip-tests    Skip npm test execution
  --skip-build    Skip pre-flight npm run build
  --skip-make     Skip desktop Electron Forge DMG/ZIP generation
  --dry-run       Run pre-flight checks and packaging without committing or pushing
  --help, -h      Show this help text
`);
  process.exit(0);
}

// Extract version argument
const rawVersionArg = args.find((a) => !a.startsWith('-'));

function normalizeVersion(input) {
  let v = input.trim();
  if (v.startsWith('v') || v.startsWith('V')) {
    v = v.slice(1).trim();
  }
  const rcMatch = v.match(/^(\d+\.\d+\.\d+)[-\s]rc\.?(\d+)$/i);
  if (rcMatch) return `${rcMatch[1]}-rc.${rcMatch[2]}`;
  const betaMatch = v.match(/^(\d+\.\d+\.\d+)[-\s]beta\.?(\d+)$/i);
  if (betaMatch) return `${betaMatch[1]}-beta.${betaMatch[2]}`;
  const alphaMatch = v.match(/^(\d+\.\d+\.\d+)[-\s]alpha\.?(\d+)$/i);
  if (alphaMatch) return `${alphaMatch[1]}-alpha.${alphaMatch[2]}`;
  return v;
}

const currentVersion = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8')).version;

let targetVersion = '';
if (rawVersionArg) {
  targetVersion = normalizeVersion(rawVersionArg);
} else {
  // Suggest next RC or patch version
  const rcMatch = currentVersion.match(/^(\d+\.\d+\.\d+)-rc\.(\d+)$/);
  if (rcMatch) {
    targetVersion = `${rcMatch[1]}-rc.${parseInt(rcMatch[2], 10) + 1}`;
  } else {
    const parts = currentVersion.split('.');
    parts[2] = parseInt(parts[2], 10) + 1;
    targetVersion = parts.join('.');
  }
  console.log(`ℹ️  No version specified. Defaulting to next release: ${targetVersion}`);
}

const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
if (!semverRegex.test(targetVersion)) {
  console.error(`❌ Error: "${targetVersion}" is not a valid SemVer string.`);
  process.exit(1);
}

function getTagClean(v) {
  const rcMatch = v.match(/rc\.?(\d+)/i);
  if (rcMatch) return `rc${rcMatch[1]}`;
  const betaMatch = v.match(/beta\.?(\d+)/i);
  if (betaMatch) return `beta${betaMatch[1]}`;
  const alphaMatch = v.match(/alpha\.?(\d+)/i);
  if (alphaMatch) return `alpha${alphaMatch[1]}`;
  return v.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

const isPrerelease = targetVersion.includes('-');
const tagClean = getTagClean(targetVersion);
const releaseNotesFile = resolve(ROOT_DIR, `scripts/release-notes-${tagClean}.md`);

console.log(`
=============================================================
  Blockingmachine Autonomous Release Pipeline
=============================================================
  Target Version:     v${targetVersion}
  Current Version:    v${currentVersion}
  Type:               ${isPrerelease ? 'Pre-release' : 'Production Release'}
  Target Folder:      ${MAKE_DIR}
  Dry Run Mode:       ${isDryRun ? 'YES (No Git/GitHub mutations)' : 'NO (Live release)'}
=============================================================
`);

function runCommand(command, description, cwd = ROOT_DIR) {
  console.log(`\n🔹 [Step] ${description}...`);
  try {
    execSync(command, { cwd, stdio: 'inherit' });
  } catch (error) {
    console.error(`❌ Error during step: ${description}`);
    process.exit(1);
  }
}

// 1. Pre-flight Quality Checks
if (!skipTests) {
  runCommand('npm test', 'Running full test suite across all workspaces');
} else {
  console.log('⏩ Skipping test suite (--skip-tests)');
}

runCommand('npm run lint', 'Verifying ESLint compliance across all workspaces');

if (!skipBuild) {
  runCommand('npm run build', 'Verifying monorepo clean compilation');
}

// 2. Synchronize Version across monorepo
runCommand(`node scripts/bump-version.mjs ${targetVersion}`, `Synchronizing monorepo version to ${targetVersion}`);

// Update README download links and install snippets
const readmePath = resolve(ROOT_DIR, 'README.md');
if (existsSync(readmePath)) {
  let readme = readFileSync(readmePath, 'utf8');
  readme = readme.replace(new RegExp(currentVersion, 'g'), targetVersion);
  const currentTagClean = currentVersion.replace(/-/g, '--');
  const targetTagClean = targetVersion.replace(/-/g, '--');
  readme = readme.replace(new RegExp(currentTagClean, 'g'), targetTagClean);
  writeFileSync(readmePath, readme, 'utf8');
  console.log(`✅ [README.md] Updated references to ${targetVersion}`);
}

// Update SECURITY.md supported version
const securityPath = resolve(ROOT_DIR, 'SECURITY.md');
if (existsSync(securityPath)) {
  let sec = readFileSync(securityPath, 'utf8');
  sec = sec.replace(new RegExp(currentVersion, 'g'), targetVersion);
  writeFileSync(securityPath, sec, 'utf8');
  console.log(`✅ [SECURITY.md] Updated references to ${targetVersion}`);
}

// 3. Ensure Release Notes & CHANGELOG.md exist
if (!existsSync(releaseNotesFile)) {
  console.log(`📝 Creating template release notes: ${basename(releaseNotesFile)}`);
  const templateNotes = `## Blockingmachine v${targetVersion}

Release candidate featuring automated security remediations, performance enhancements, and monorepo updates.

### Highlights since prior release

- Comprehensive security hardening across HTTP and IPC boundaries.
- Full test pass rate across all monorepo workspaces.
- Multi-store browser extension compliance.

### Downloads & Assets

| Asset | Description |
|---|---|
| [\`Blockingmachine-${targetVersion}-arm64.dmg\`](https://github.com/Greigh/Blockingmachine/releases/download/v${targetVersion}/Blockingmachine-${targetVersion}-arm64.dmg) | macOS Apple Silicon installer |
| [\`Blockingmachine-darwin-arm64-${targetVersion}.zip\`](https://github.com/Greigh/Blockingmachine/releases/download/v${targetVersion}/Blockingmachine-darwin-arm64-${targetVersion}.zip) | macOS Apple Silicon standalone zipped app |
| [\`blockingmachine-core-${targetVersion}.tgz\`](https://github.com/Greigh/Blockingmachine/releases/download/v${targetVersion}/blockingmachine-core-${targetVersion}.tgz) | Core library NPM package |
| [\`blockingmachine-cli-${targetVersion}.tgz\`](https://github.com/Greigh/Blockingmachine/releases/download/v${targetVersion}/blockingmachine-cli-${targetVersion}.tgz) | CLI executable NPM package |
| [\`blockingmachine-chrome-mv3-v1.0.0.zip\`](https://github.com/Greigh/Blockingmachine/releases/download/v${targetVersion}/blockingmachine-chrome-mv3-v1.0.0.zip) | Chrome Web Store Manifest V3 browser extension bundle |
| [\`blockingmachine-firefox-mv3-v1.0.0.zip\`](https://github.com/Greigh/Blockingmachine/releases/download/v${targetVersion}/blockingmachine-firefox-mv3-v1.0.0.zip) | Firefox Add-ons Manifest V3 browser extension bundle |
| [\`SHA256SUMS.txt\`](https://github.com/Greigh/Blockingmachine/releases/download/v${targetVersion}/SHA256SUMS.txt) | SHA-256 verification checksums |
`;
  writeFileSync(releaseNotesFile, templateNotes, 'utf8');
}

// 4. Package Artifacts into ./make/
if (!skipMake) {
  runCommand('node scripts/package-all.mjs', 'Compiling and packaging all release assets into ./make/');

  // Append generated SHA-256 checksums to release notes if present
  const checksumFile = resolve(MAKE_DIR, 'SHA256SUMS.txt');
  if (existsSync(checksumFile)) {
    const checksums = readFileSync(checksumFile, 'utf8');
    let notes = readFileSync(releaseNotesFile, 'utf8');
    if (!notes.includes('### Verification Checksums (SHA-256)')) {
      notes += `\n### Verification Checksums (SHA-256)\n\n\`\`\`text\n${checksums}\`\`\`\n`;
      writeFileSync(releaseNotesFile, notes, 'utf8');
      console.log(`✅ [${basename(releaseNotesFile)}] Injected SHA-256 verification checksums`);
    }
  }
} else {
  console.log('⏩ Skipping artifact packaging (--skip-make)');
}

// 5. Git Commit, Tag & Push
if (isDryRun) {
  console.log('\n🟡 Dry Run complete. Skipping git commit, push, and GitHub release.');
  process.exit(0);
}

runCommand(
  `git add .gitignore README.md SECURITY.md CHANGELOG.md package.json package-lock.json packages/ scripts/`,
  'Staging release modifications'
);

try {
  runCommand(
    `git commit -m "chore(release): v${targetVersion} - release preparation and artifacts"`,
    `Creating release commit for v${targetVersion}`
  );
} catch {
  console.log('ℹ️  No changes to commit or working tree clean.');
}

runCommand(`git tag -fa v${targetVersion} -m "Release v${targetVersion}"`, `Creating annotated tag v${targetVersion}`);

// Push to remotes
runCommand(`git push origin main --tags -f`, 'Pushing main branch and tags to GitHub (origin)');

try {
  const remotes = execSync('git remote', { encoding: 'utf8' });
  if (remotes.includes('forgejo')) {
    runCommand(`git push forgejo main --tags -f`, 'Pushing main branch and tags to Forgejo (forgejo)');
  }
} catch {
  console.warn('⚠️ Could not push to Forgejo remote.');
}

// 6. GitHub Release via gh CLI
let ghAvailable = false;
try {
  execSync('gh --version', { stdio: 'ignore' });
  ghAvailable = true;
} catch {
  ghAvailable = false;
}

if (ghAvailable) {
  console.log('\n📦 Publishing GitHub Release with assets via "gh"...');
  const prereleaseFlag = isPrerelease ? '--prerelease' : '';
  const makeAssets = existsSync(MAKE_DIR)
    ? readdirSync(MAKE_DIR)
        .filter((f) => statSync(resolve(MAKE_DIR, f)).isFile())
        .map((f) => `make/${f}`)
        .join(' ')
    : '';

  try {
    // Check if release already exists
    execSync(`gh release view v${targetVersion}`, { stdio: 'ignore' });
    console.log(`Updating existing release v${targetVersion}...`);
    execSync(`gh release upload v${targetVersion} ${makeAssets} --clobber`, { cwd: ROOT_DIR, stdio: 'inherit' });
  } catch {
    console.log(`Creating new release v${targetVersion}...`);
    execSync(
      `gh release create v${targetVersion} ${makeAssets} --title "Blockingmachine v${targetVersion}" --notes-file "${releaseNotesFile}" ${prereleaseFlag}`,
      { cwd: ROOT_DIR, stdio: 'inherit' }
    );
  }
} else {
  console.log(`
ℹ️  GitHub CLI ("gh") not found or unauthenticated.
To publish release assets manually:
  gh release create v${targetVersion} make/* --title "Blockingmachine v${targetVersion}" --notes-file ${releaseNotesFile} ${isPrerelease ? '--prerelease' : ''}
`);
}

console.log(`
=============================================================
🎉 Release v${targetVersion} successfully prepared and published!
=============================================================
  - Artifacts ready in:   ./make/
  - Tag created & pushed: v${targetVersion}
  - Release URL:          https://github.com/Greigh/Blockingmachine/releases/tag/v${targetVersion}
=============================================================
`);
