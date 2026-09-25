import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Load environment variables from root .env if present
const envPath = path.resolve(rootDir, '.env');
if (fs.existsSync(envPath) && process.loadEnvFile) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Ignore .env parse errors
  }
}

const isDryRun = process.argv.includes('--dry-run');
const token = process.env.NPMJS_TOKEN || process.env.NODE_AUTH_TOKEN;
const registryUrl = 'https://registry.npmjs.org/';

console.log(`[publish-npmjs] Target Registry: ${registryUrl}`);

if (!token && !isDryRun) {
  console.warn('[publish-npmjs] No NPMJS_TOKEN provided. Skipping live publication to npmjs.com.');
  process.exit(0);
}

const packages = [
  path.join(rootDir, 'packages', 'core'),
  path.join(rootDir, 'packages', 'cli')
];

function resolveDistTag(version) {
  // 1. Explicit --tag argument
  const tagIdx = process.argv.indexOf('--tag');
  if (tagIdx !== -1 && process.argv[tagIdx + 1] && !process.argv[tagIdx + 1].startsWith('-')) {
    return process.argv[tagIdx + 1];
  }
  const tagArg = process.argv.find((a) => a.startsWith('--tag='));
  if (tagArg) {
    return tagArg.split('=')[1];
  }

  // 2. Explicit environment variable
  if (process.env.NPM_TAG) return process.env.NPM_TAG;
  if (process.env.DIST_TAG) return process.env.DIST_TAG;

  // 3. Infer from version prerelease tag (e.g. 1.0.0-beta.1 -> beta, 1.0.0-rc.5 -> rc)
  const dashIndex = version.indexOf('-');
  if (dashIndex !== -1) {
    const prerelease = version.slice(dashIndex + 1);
    const match = prerelease.match(/^([a-zA-Z0-9_-]+?)(?:\.|\d|$)/);
    if (match && match[1]) {
      return match[1].toLowerCase();
    }
    return prerelease.toLowerCase();
  }

  return 'latest';
}

for (const pkgDir of packages) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  const originalRaw = fs.readFileSync(pkgJsonPath, 'utf8');
  const pkgData = JSON.parse(originalRaw);

  const distTag = resolveDistTag(pkgData.version);

  console.log(`\n[publish-npmjs] Publishing ${pkgData.name}@${pkgData.version} to npmjs.com with tag "${distTag}"...`);

  try {
    const modifiedPkg = {
      ...pkgData,
      publishConfig: {
        access: 'public',
        registry: registryUrl
      }
    };

    fs.writeFileSync(pkgJsonPath, JSON.stringify(modifiedPkg, null, 2) + '\n');

    const args = ['publish'];
    if (isDryRun) {
      args.push('--dry-run');
    }
    args.push('--tag', distTag);
    args.push('--access', 'public');
    args.push('--registry', registryUrl);
    if (token) {
      args.push(`--//registry.npmjs.org/:_authToken=${token}`);
    }

    console.log(`[publish-npmjs] Executing: npm ${args.map(a => a.startsWith('--//') ? '--//registry.npmjs.org/:_authToken=***' : a).join(' ')} in ${path.basename(pkgDir)}`);

    execFileSync('npm', args, {
      cwd: pkgDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        npm_config_registry: registryUrl
      }
    });

    console.log(`[publish-npmjs] Successfully published ${pkgData.name}@${pkgData.version}`);
  } catch (err) {
    const sanitizedMsg = (err?.message || String(err)).replace(/_authToken=[^\s]+/g, '_authToken=***');
    console.error(`[publish-npmjs] Failed publishing ${pkgData.name}: ${sanitizedMsg}`);
  } finally {
    fs.writeFileSync(pkgJsonPath, originalRaw);
  }
}

console.log('\n[publish-npmjs] npmjs publication cycle complete.');
