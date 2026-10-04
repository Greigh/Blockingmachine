import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Bundler-safety regression guard.
 *
 * The Electron app bundles `@blockingmachine/core` output with webpack
 * (target: electron-main). Patterns that are legal in plain Node ESM are
 * treated by webpack as build-time module dependencies and break CI with
 * "Module not found: Can't resolve" or "Critical dependency" errors:
 *
 *   1. Static relative-path literals: `new URL('./db', import.meta.url)`
 *      (webpack requires the target to exist as a module — data dirs fail).
 *   2. require()/import() with a *computed* path argument (cannot be
 *      statically resolved). Literal-string requires are fine: webpack
 *      resolves and inlines them (see config/meta.ts reading package.json).
 *
 * This test scans every runtime source file in `src/` (excluding tests) so a
 * regression fails here with guidance instead of in a red GitHub Actions run.
 */

const SRC_ROOT = join(process.cwd(), 'src');

interface ForbiddenRule {
  name: string;
  pattern: RegExp;
  guidance: string;
}

const FORBIDDEN_RULES: ForbiddenRule[] = [
  {
    name: "static relative-path literal in new URL(..., import.meta.url)",
    pattern: /new\s+URL\(\s*['"`]\.{1,2}\//,
    guidance:
      'Webpack parses a relative-path literal in new URL(..., import.meta.url) as a module dependency and the build fails when the target is data rather than code. Compute the path at runtime from string parts.',
  },
  {
    name: 'require() with a computed path argument',
    pattern: /\brequire\s*\(\s*[A-Za-z_$][^)'"]*\)/,
    guidance:
      'require() with a computed path cannot be statically resolved by webpack ("Critical dependency"). Use node:fs readFileSync + JSON.parse for data files.',
  },
  {
    name: 'import() with a computed path argument',
    pattern: /\bimport\s*\(\s*(?!['"`])[A-Za-z_$]/,
    guidance:
      'import() with a computed path becomes a webpack "Critical dependency". Import static string specifiers only.',
  },
];

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      out.push(...listTsFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('bundler safety of core runtime sources', () => {
  const files = listTsFiles(SRC_ROOT);

  it('actually scans the source tree (guard stays meaningful)', () => {
    expect(files.length).toBeGreaterThan(25);
    expect(files.some((f) => f.endsWith('db-loader.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('reputation.ts'))).toBe(true);
  });

  it('every runtime source file is free of bundler-hostile module patterns', () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (isCommentLine(lines[i])) continue;
        for (const rule of FORBIDDEN_RULES) {
          if (rule.pattern.test(lines[i])) {
            violations.push(
              `${relative(process.cwd(), file)}:${i + 1} — ${rule.name}. ${rule.guidance}`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('documents the invariant in db-loader.ts for future editors', () => {
    const source = readFileSync(join(SRC_ROOT, 'ai', 'db-loader.ts'), 'utf8');
    expect(source).toMatch(/bundler safety/i);
  });
});
