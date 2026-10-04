/**
 * The scripts/ argument parser, and the refusal contract it keeps.
 *
 * Every script used to parse `--flag value` pairs loosely, and the loose parser's silence had a
 * shape: a flag followed by nothing became a bare flag and the script ran on the default it was
 * meant to replace; a typo'd flag parsed as a flag nobody read and did nothing; a stray
 * positional was skipped; `Number()` answered a malformed number with NaN, which reads as "the
 * exports held nothing" rather than "the flag was unreadable". Each of those is a question the
 * operator asked, answered by a different one — the same failure `--residual` refuses in the
 * tier compiler.
 *
 * The parser itself is exercised through `node --input-type=module -e` — the same subprocess
 * convention `ledgerCut.test.ts` uses for the scripts, applied to the module — because it is a
 * plain `.mjs` jest cannot import, and its behaviour *is* what it returns or throws.
 */

import { describe, test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const ARGV_URL = pathToFileURL(join(ROOT, 'scripts', 'argv.mjs')).href;

const SPEC = { values: ['--in', '--out'], flags: ['--check'], positionals: 1 };

type ParseResult =
  | { ok: true; values: Record<string, string[]>; flags: string[]; positional: string[] }
  | { ok: false; error: string };

/** Run the parser in node itself and return its result or its refusal message. */
function parse(args: string[], spec: unknown = SPEC): ParseResult {
  const driver =
    `import { parseArgv } from ${JSON.stringify(ARGV_URL)};` +
    `try {` +
    `  const r = parseArgv(${JSON.stringify(args)}, ${JSON.stringify(spec)});` +
    `  console.log(JSON.stringify({ ok: true, values: Object.fromEntries(r.values),` +
    `    flags: [...r.flags], positional: r.positional }));` +
    `} catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }`;
  return JSON.parse(execFileSync('node', ['--input-type=module', '-e', driver], {
    cwd: ROOT,
    encoding: 'utf8',
  }));
}

/** Run a script and return status + combined output — the same shape ledgerCut's `attempt` gives. */
function attempt(script: string, args: string[]) {
  try {
    const stdout = execFileSync('node', [join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('parseArgv', () => {
  test('honours what it is given: values, flags, positionals, repeats, and --name=value', () => {
    const result = parse(['--in', 'a.txt', '--in=b.txt', '--check', 'pos1']);
    expect(result).toEqual({
      ok: true,
      // Repeats keep every value in order — `--in a --in b` is two inputs, not the last one twice.
      values: { '--in': ['a.txt', 'b.txt'] },
      flags: ['--check'],
      positional: ['pos1'],
    });
  });

  test('refuses a value flag followed by nothing, by a flag, or by a bare =', () => {
    for (const args of [['--in'], ['--in', '--check'], ['--in='], ['--in', '-x']]) {
      const result = parse(args);
      expect([args, result.ok]).toEqual([args, false]);
      if (!result.ok) expect(result.error).toContain('--in needs a value');
    }
  });

  test('refuses a boolean flag carrying a value', () => {
    // `--check=yes` is where an intended positional or value disappears into a flag that was
    // never meant to absorb it.
    const result = parse(['--check=yes']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('--check takes no value');
  });

  test('refuses an unknown flag, a short flag that was never declared, and a stray positional', () => {
    for (const args of [['--chcek'], ['-z'], ['one', 'two'], ['--in', 'a.txt', 'one', 'two']]) {
      const result = parse(args);
      expect([args, result.ok]).toEqual([args, false]);
    }
    const unknown = parse(['--chcek']);
    if (!unknown.ok) {
      // The refusal names the token and lists what the script does take, so a typo is
      // correctable without reading the source.
      expect(unknown.error).toContain('--chcek');
      expect(unknown.error).toContain('--in');
    }
  });

  test('a bare -- ends the flags, so a dash word after it is a positional like any other', () => {
    const result = parse(['--in', 'a.txt', '--', '--check']);
    expect(result).toEqual({ ok: true, values: { '--in': ['a.txt'] }, flags: [], positional: ['--check'] });
  });

  test('refuses everything when the script declares nothing', () => {
    for (const args of [['--x'], ['file.txt']]) {
      const result = parse(args, {});
      expect([args, result.ok]).toEqual([args, false]);
    }
  });
});

describe('the refusal contract across the scripts', () => {
  // Every case exits before touching the filesystem: the parse happens at the top of the script,
  // so a refused flag can never arrive after something was written.
  test.each([
    // [script, args, expected message fragment]
    ['merge-browser-ledger.mjs', ['--in'], '--in needs a value'],
    ['merge-browser-ledger.mjs', ['--in', '--out', 'x'], '--in needs a value'],
    ['merge-browser-ledger.mjs', ['--bogus'], 'Unknown flag'],
    ['merge-browser-ledger.mjs', ['--min-days', 'abc'], '--min-days is not a number'],
    ['merge-browser-ledger.mjs', ['--max-rules', '12abc'], '--max-rules is not a number'],
    ['merge-browser-ledger.mjs', ['extra.txt'], 'Unexpected argument'],
    ['build-hot-list.mjs', ['--wirte'], 'Unknown flag'],
    ['build-hot-list.mjs', ['--share', 'abc', '--list', 'x', '--hits', 'y'], '--share is not a number'],
    ['build-hot-list.mjs', ['--list'], '--list needs a value'],
    ['build-hot-list.mjs', ['--sessions'], '--sessions needs a value'],
    ['build-hot-list.mjs', ['--hits', 'a', '--trace', 'b'], 'One measurement per build'],
    ['build-hot-list.mjs', ['--trace', 'a', '--trace', 'b'], '--trace names one file'],
    ['check-path-decidability.mjs', ['--list'], '--list needs a value'],
    ['check-path-decidability.mjs', ['--min', 'abc'], '--min must be a share'],
    ['check-path-decidability.mjs', ['--min', '1.5'], '--min must be a share'],
    ['check-path-decidability.mjs', ['--bogus'], 'Unknown flag'],
    ['package-extension.mjs', ['--skip-tier'], 'Unknown flag'],
    ['package-all.mjs', ['anything'], 'Unexpected argument'],
    ['verify-mv3-compliance.mjs', ['--bogus'], 'Unknown flag'],
    ['bump-version.mjs', ['1.0.0', '--typo'], 'Unknown flag'],
    ['release.mjs', ['1.0.0', 'extra'], 'Unexpected argument'],
    ['release.mjs', ['--skpi-tests'], 'Unknown flag'],
    ['release.mjs', ['--tag'], '--tag needs a value'],
    ['release.mjs', ['--tag='], '--tag needs a value'],
    ['release.mjs', ['--tag', 'x!'], 'not a valid npm dist-tag'],
    ['publish-npmjs.mjs', ['--tag'], '--tag needs a value'],
    ['publish-npmjs.mjs', ['--dry-rnu'], 'Unknown flag'],
    ['publish-gpr.mjs', ['--tag='], '--tag needs a value'],
    ['publish-forgejo.mjs', ['--bogus'], 'Unknown flag'],
    ['derive-tier-vocabulary.mjs', ['--rules-dir'], '--rules-dir needs a value'],
    ['derive-tier-vocabulary.mjs', ['--wirte'], 'Unknown flag'],
    ['fit-element-weights.mjs', ['--wirte'], 'Unknown flag'],
    ['fit-element-weights.mjs', ['--check=yes'], 'takes no value'],
    ['harvest-element-candidates.mjs', ['--max-age'], '--max-age needs a value'],
    ['harvest-element-candidates.mjs', ['--max-age', 'abc'], 'non-negative number'],
    ['harvest-element-candidates.mjs', ['--promote'], '--promote needs a value'],
    ['harvest-element-candidates.mjs', ['--promote', 'x', '--scope'], '--scope needs a value'],
    ['harvest-element-candidates.mjs', ['--promote', 'x', '--class'], '--class needs a value'],
    ['harvest-element-candidates.mjs', ['--promote', 'x', '--label'], '--label needs a value'],
    ['harvest-element-candidates.mjs', ['--promote', 'x', '--note'], '--note needs a value'],
    ['harvest-element-candidates.mjs', ['--promote', 'x', '--corpus'], '--corpus needs a value'],
    ['harvest-element-candidates.mjs', ['--promote', 'x', '--check'], 'different questions'],
    ['measure-hotlist-generalisation.mjs', ['--hits'], '--hits needs a value'],
    ['ledger-browser-run.mjs', ['--sites', '--keep-profile'], '--sites needs a value'],
    ['ledger-browser-run.mjs', ['--sites', 'abc'], 'not a number'],
    ['ledger-browser-run.mjs', ['--bogus'], 'Unknown flag'],
    // The release rehearsal takes no arguments at all — a named value there is a flag nobody
    // reads, and refusing it must happen before the first tier file is snapshotted or rewritten.
    ['release-rehearsal.mjs', ['--bogus'], 'Unknown flag'],
    ['release-rehearsal.mjs', ['fixture.txt'], 'Unexpected argument'],
  ])('%s %j refuses loudly', (script, args, fragment) => {
    const result = attempt(script, args as string[]);
    expect(result.status).toBeGreaterThan(0);
    expect(result.output).toContain(fragment);
  });

  test('the unbound harness routes its five positionals through the same parser', () => {
    // Source-read rather than subprocess: the harness imports `./unboundReachability.js` and its
    // siblings, which only exist inside the electron app's compiled output — there is no way to
    // run it standalone. What can be pinned is that it parses argv through the shared parser and
    // bounds the positional list instead of silently dropping a sixth.
    const source = readFileSync(
      join(ROOT, 'scripts', 'unbound-reachability-harness.mjs'),
      'utf8',
    );
    expect(source).toContain("parseArgvOrExit(process.argv.slice(2), { positionals: 5 })");
  });
});
