/**
 * Platform gate for the Linux third of the `prebuild` npm hook — the
 * mirror of build-if-darwin.mjs / build-if-win32.mjs. helper/linux/
 * build.sh compiles the netfilter REDIRECT acceptor + the shared core;
 * this shim only forks bash on linux so a darwin/Windows contributor's
 * `npm run build` never touches it (the helper stays source-only here —
 * helper-linux.test.ts compiles it itself wherever a C compiler exists,
 * since the file is deliberately darwin-compilable for the selftest).
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform === 'linux') {
  const script = join(fileURLToPath(new URL('.', import.meta.url)), 'linux', 'build.sh');
  execFileSync('bash', [script], { stdio: 'inherit' });
}
