/**
 * Platform gate for the `prebuild` npm hook — `npm run build` runs on every
 * OS this monorepo builds on, but helper/macos/build.sh is a macOS target
 * (pf + launchd + clang against the SDK). Spawning bash directly from the
 * package.json line would fail on Windows runners that lack it, so this
 * tiny shim does the platform check in Node and only invokes the script
 * on darwin. build.sh itself also no-ops off-darwin; the gate exists so a
 * contributor on Windows never even forks bash.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform === 'darwin') {
  const script = join(fileURLToPath(new URL('.', import.meta.url)), 'macos', 'build.sh');
  execFileSync('bash', [script], { stdio: 'inherit' });
}
