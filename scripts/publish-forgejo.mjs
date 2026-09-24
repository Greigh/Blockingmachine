import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

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

for (const pkgDir of packages) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  const originalRaw = fs.readFileSync(pkgJsonPath, 'utf8');
  const pkgData = JSON.parse(originalRaw);

  console.log(`\n[publish-forgejo] Publishing ${pkgData.name}@${pkgData.version} to Forgejo...`);

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

    const tag = pkgData.version.includes('-') ? 'rc' : 'latest';
    const dryRunFlag = isDryRun ? '--dry-run' : '';
    const tokenFlag = token ? `--${authConfigKey}="${token}"` : '';

    const cmd = `npm publish ${dryRunFlag} --tag ${tag} --registry="${registryUrl}" ${tokenFlag}`;
    console.log(`[publish-forgejo] Executing: npm publish in ${path.basename(pkgDir)}`);

    execSync(cmd, {
      cwd: pkgDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        npm_config_registry: registryUrl
      }
    });

    console.log(`[publish-forgejo] Successfully published ${pkgData.name}@${pkgData.version}`);
  } catch (err) {
    console.error(`[publish-forgejo] Failed publishing ${pkgData.name}: ${err.message}`);
  } finally {
    fs.writeFileSync(pkgJsonPath, originalRaw);
  }
}

console.log('\n[publish-forgejo] Forgejo publication cycle complete.');
