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
const token = process.env.FORGEJO_TOKEN || process.env.GITEA_TOKEN || process.env.NODE_AUTH_TOKEN;
const serverUrl = (process.env.SERVER_URL || 'https://git.greighstudios.com').replace(/\/+$/, '');
const owner = process.env.OWNER || 'greighstudios';
const registryUrl = `${serverUrl}/api/packages/${owner}/npm/`;

console.log(`[publish-forgejo] Target Registry: ${registryUrl}`);

if (!token && !isDryRun) {
  console.warn('[publish-forgejo] No FORGEJO_TOKEN provided. Skipping live publication.');
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

  console.log(`\n[publish-forgejo] Publishing ${pkgData.name}@${pkgData.version} to Forgejo with tag "${distTag}"...`);

  try {
    const modifiedPkg = {
      ...pkgData,
      publishConfig: {
        access: 'public',
        registry: registryUrl
      }
    };

    fs.writeFileSync(pkgJsonPath, JSON.stringify(modifiedPkg, null, 2) + '\n');

    // Configure npm auth for this registry
    const registryHost = new URL(registryUrl).host;
    const registryPath = new URL(registryUrl).pathname;
    const authConfigKey = `//${registryHost}${registryPath}:_authToken`;

    const args = ['publish'];
    if (isDryRun) {
      args.push('--dry-run');
    }
    args.push('--tag', distTag);
    args.push('--registry', registryUrl);
    if (token) {
      args.push(`--${authConfigKey}=${token}`);
    }

    console.log(`[publish-forgejo] Executing: npm publish in ${path.basename(pkgDir)}`);

    execFileSync('npm', args, {
      cwd: pkgDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        npm_config_registry: registryUrl
      }
    });

    console.log(`[publish-forgejo] Successfully published ${pkgData.name}@${pkgData.version}`);
  } catch (err) {
    const sanitizedMsg = (err?.message || String(err)).replace(/_authToken=[^\s]+/g, '_authToken=***');
    console.error(`[publish-forgejo] Failed publishing ${pkgData.name}: ${sanitizedMsg}`);
  } finally {
    fs.writeFileSync(pkgJsonPath, originalRaw);
  }
}

console.log('\n[publish-forgejo] Forgejo publication cycle complete.');
