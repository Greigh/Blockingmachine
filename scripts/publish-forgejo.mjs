import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lastValue, parseArgvOrExit } from './argv.mjs';

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

// Refusing parse: `--dry-rnu` used to publish for real, and `--tag` with no value fell through
// to the version-inference guess — a named flag silently answered by a different question.
const { flags: argvFlags, values: argvValues } = parseArgvOrExit(process.argv.slice(2), {
  values: ['--tag'],
  flags: ['--dry-run'],
});
const isDryRun = argvFlags.has('--dry-run');
const explicitTag = lastValue(argvValues, '--tag') ?? null;
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

function resolveDistTag(version, explicitTag) {
  // 1. Explicit --tag argument — already refused at parse time if it carried no value.
  if (explicitTag) return explicitTag;

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

const failures = [];

for (const pkgDir of packages) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  const originalRaw = fs.readFileSync(pkgJsonPath, 'utf8');
  const pkgData = JSON.parse(originalRaw);

  const distTag = resolveDistTag(pkgData.version, explicitTag);

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

    // Captured (not inherited) stdio so the failure class is inspectable: an
    // "already published" conflict is idempotent, every other nonzero exit is a real
    // failure that must turn the caller red — a swallowed 401 used to read as success.
    const result = spawnSync('npm', args, {
      cwd: pkgDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_registry: registryUrl
      }
    });
    const scrub = (s) => (s || '')
      .replace(/_authToken=\S+/g, '_authToken=***')
      .split(String(token)).join('***');
    if (result.stdout) process.stdout.write(scrub(result.stdout));
    if (result.stderr) process.stderr.write(scrub(result.stderr));
    if (result.error) throw result.error;

    if (result.status !== 0) {
      const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (/EPUBLISHCONFLICT|cannot publish over the previously published|already published/i.test(combined)) {
        console.log(`[publish-forgejo] ${pkgData.name}@${pkgData.version} is already published — treating as up-to-date.`);
      } else {
        throw new Error(`npm publish exited with code ${result.status}`);
      }
    } else {
      console.log(`[publish-forgejo] Successfully published ${pkgData.name}@${pkgData.version}`);
    }
  } catch (err) {
    const sanitizedMsg = (err?.message || String(err)).replace(/_authToken=[^\s]+/g, '_authToken=***');
    console.error(`[publish-forgejo] Failed publishing ${pkgData.name}: ${sanitizedMsg}`);
    failures.push(`${pkgData.name}@${pkgData.version}`);
  } finally {
    fs.writeFileSync(pkgJsonPath, originalRaw);
  }
}

if (failures.length > 0) {
  console.error(`\n[publish-forgejo] ${failures.length} package(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}

console.log('\n[publish-forgejo] Forgejo publication cycle complete.');
