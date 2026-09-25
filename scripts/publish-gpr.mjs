import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const isDryRun = process.argv.includes('--dry-run');

const packages = [
  {
    dir: path.join(rootDir, 'packages', 'core'),
    targetNames: ['@greigh/blockingmachine-core', '@greigh/core', '@blockingmachine/core']
  },
  {
    dir: path.join(rootDir, 'packages', 'cli'),
    targetNames: ['@greigh/blockingmachine-cli', '@greigh/cli', '@blockingmachine/cli']
  }
];

console.log(`[publish-gpr] Starting GitHub Packages publication (${isDryRun ? 'DRY-RUN' : 'LIVE'})...`);

for (const pkg of packages) {
  const pkgJsonPath = path.join(pkg.dir, 'package.json');
  const originalRaw = fs.readFileSync(pkgJsonPath, 'utf8');
  const pkgData = JSON.parse(originalRaw);

  for (const targetName of pkg.targetNames) {
    console.log(`\n[publish-gpr] Preparing publication for ${targetName}...`);
    try {
      const modifiedPkg = {
        ...pkgData,
        name: targetName,
        publishConfig: {
          access: 'public',
          registry: 'https://npm.pkg.github.com/',
          scope: targetName.split('/')[0]
        },
        repository: {
          type: 'git',
          url: 'git+https://github.com/greigh/Blockingmachine.git',
          directory: path.relative(rootDir, pkg.dir)
        }
      };

      fs.writeFileSync(pkgJsonPath, JSON.stringify(modifiedPkg, null, 2) + '\n');

function resolveDistTag(version) {
  const tagIdx = process.argv.indexOf('--tag');
  if (tagIdx !== -1 && process.argv[tagIdx + 1] && !process.argv[tagIdx + 1].startsWith('-')) {
    return process.argv[tagIdx + 1];
  }
  const tagArg = process.argv.find((a) => a.startsWith('--tag='));
  if (tagArg) {
    return tagArg.split('=')[1];
  }
  if (process.env.NPM_TAG) return process.env.NPM_TAG;
  if (process.env.DIST_TAG) return process.env.DIST_TAG;
  const dashIndex = version.indexOf('-');
  if (dashIndex !== -1) {
    const prerelease = version.slice(dashIndex + 1);
    const match = prerelease.match(/^([a-zA-Z0-9_-]+?)(?:\.|\d|$)/);
    if (match && match[1]) return match[1].toLowerCase();
    return prerelease.toLowerCase();
  }
  return 'latest';
}

      const distTag = resolveDistTag(pkgData.version);
      const args = ['publish'];
      if (isDryRun) {
        args.push('--dry-run');
      }
      args.push('--tag', distTag);
      args.push('--registry', 'https://npm.pkg.github.com');
      console.log(`[publish-gpr] Executing: npm ${args.join(' ')} in ${pkg.dir}`);

      execFileSync('npm', args, {
        cwd: pkg.dir,
        stdio: 'inherit',
        env: {
          ...process.env,
          npm_config_registry: 'https://npm.pkg.github.com/'
        }
      });
      console.log(`[publish-gpr] Successfully published ${targetName}@${pkgData.version}`);
      // Once the primary name succeeds, break to avoid duplicate variants unless intended
      if (!isDryRun) {
        break;
      }
    } catch (err) {
      console.warn(`[publish-gpr] Failed publishing ${targetName}: ${err.message}`);
    } finally {
      fs.writeFileSync(pkgJsonPath, originalRaw);
    }
  }
}

console.log('\n[publish-gpr] Publication cycle complete.');
