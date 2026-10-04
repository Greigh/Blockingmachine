/**
 * The ledger dropbox, and everything downstream of it.
 *
 * The shipped blocklist cut is decided by evidence, not by input order — but only when there is
 * evidence, and there is evidence only when someone exports the extension's hit ledger and merges
 * it into `ledger/ledger-hits.txt`. That makes a chain of small steps where any one can quietly
 * stop happening: the directory scan stops finding exports, the merge stops being reproducible, the
 * hot list stops being verifiable because its check is hard-wired to a fixture, or packaging stops
 * passing the ledger to the compiler. None of those breaks a build, so they are pinned here.
 *
 * The scripts are run rather than imported — they are CLI entry points whose behaviour *is* their
 * arguments — with explicit temp inputs, so the repository's own ledger and hot set are never
 * touched. Both scripts read compiled core output, so the cases that need it skip cleanly when the
 * package has not been built, the same way the BIND cases do.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const MERGE = join(ROOT, 'scripts', 'merge-browser-ledger.mjs');
const HOT_LIST = join(ROOT, 'scripts', 'build-hot-list.mjs');
const PACKAGE_EXTENSION = join(ROOT, 'scripts', 'package-extension.mjs');
const DROPOX = join(ROOT, 'ledger', 'ledger-hits.txt');
const CORE_DIST = join(ROOT, 'packages', 'core', 'dist', 'coverage.js');

// The two scripts under test load core's compiled output rather than its source, so they cannot run
// before a build. Skipping is the honest answer here — `npm test` runs before `npm run build` in
// CI — and a test that reported success by not running would be worse than one that says so.
const coreBuilt = existsSync(CORE_DIST);
const describeScripts = coreBuilt ? describe : describe.skip;

let workDir: string;

/** One browser session export, in the shape the popup downloads. */
function exportFile(day: string, hits: Array<[string, number]>, exceptions: string[] = []) {
  return JSON.stringify({
    version: 1,
    exportedAt: `${day}T23:00:00.000Z`,
    sessions: [
      {
        startedAt: `${day}T09:00:00.000Z`,
        feed: { url: 'http://127.0.0.1:8080/v1/list.txt', ruleCount: hits.length },
        hits: hits.map(([rule, count]) => ({ rule, count })),
        exceptions,
      },
    ],
  });
}

function run(script: string, args: string[]) {
  return execFileSync('node', [script, ...args], { cwd: ROOT, encoding: 'utf8' });
}

/** A run that is expected to fail, returning its status and combined output. */
function attempt(script: string, args: string[]) {
  try {
    run(script, args);
    return { status: 0, output: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'bm-ledger-'));
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('the committed dropbox', () => {
  test('exists, and every non-comment line in it is a count and a rule', () => {
    // The file is committed, so `--hits` never has to be passed conditionally by a human and the
    // weekly job always has something to read. What it must not do is hold a line that is not a
    // count and a rule: `build-hot-list`, `compile-tier-rulesets` and `readTierLedger` all read it
    // back, and a shape they cannot parse is a measurement they silently drop.
    expect(existsSync(DROPOX)).toBe(true);
    const text = readFileSync(DROPOX, 'utf8');
    expect(text).toContain('# Browser-reported rule-hit ledger');
    const hitLines = text.split('\n').filter((line) => /^\s*\d+\s+\S/.test(line));
    // Populated on purpose now — the README names what put it there — and a silently emptied one
    // is not a neutral state: it reverts the shipped cut to input order with nothing noticing.
    expect(hitLines.length).toBeGreaterThan(0);
    const malformed = text
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#') && !/^\s*\d+\s+\S/.test(line));
    expect(malformed).toEqual([]);
  });

  test('carries the per-tier tally in its header, where a reader can review it', () => {
    // The tally is the number the tier plan is weighted by, and the header is where it is exported
    // alongside the rule lines — as comments, never as rules, because `readTierLedger` and the tier
    // compiler both resolve a rule to its tiers and would read `tier_core 543` as 543 rules.
    const text = readFileSync(DROPOX, 'utf8');
    expect(text).toContain('# Tiers:');
    expect(text).toMatch(/^# Tier sessions: \d+ of \d+$/m);
  });

  test('the readme says what is and is not committed, in the file itself', () => {
    const readme = readFileSync(join(ROOT, 'ledger', 'README.md'), 'utf8');
    // The distinction is the whole privacy argument for the dropbox, so it belongs where someone
    // about to commit a ledger will read it, not only in a commit message.
    expect(readme).toMatch(/not\*{0,2} a browsing history/i);
    expect(readme).toMatch(/No URLs/i);
    expect(readme).toContain('--from');
  });
});

describeScripts('merging a directory of exports', () => {
  test('--from reads every export in name order, and repeats byte for byte', () => {
    const dir = join(workDir, 'exports');
    mkdirSync(dir, { recursive: true });
    // Written out of order on purpose: a `readdir` that happened to sort would pass a test that
    // only ever wrote files in order.
    writeFileSync(
      join(dir, 'blockingmachine-hit-ledger-2026-09-29.json'),
      exportFile('2026-09-29', [['||second.example^', 1]]),
    );
    writeFileSync(
      join(dir, 'blockingmachine-hit-ledger-2026-09-28.json'),
      exportFile('2026-09-28', [['||first.example^', 3]], ['@@||allowed.example^']),
    );
    // Not an export, and must be left alone rather than parsed and rejected one line at a time.
    writeFileSync(join(dir, 'notes.txt'), 'ignore me');

    const out = join(workDir, 'from-a.txt');
    run(MERGE, ['--from', dir, '--out', out]);
    const first = readFileSync(out, 'utf8');

    const outAgain = join(workDir, 'from-b.txt');
    run(MERGE, ['--from', dir, '--out', outAgain]);
    expect(readFileSync(outAgain, 'utf8')).toBe(first);

    // Same inputs named by hand, in the order the directory scan found them.
    const outNamed = join(workDir, 'from-named.txt');
    run(MERGE, [
      '--in',
      join(dir, 'blockingmachine-hit-ledger-2026-09-28.json'),
      '--in',
      join(dir, 'blockingmachine-hit-ledger-2026-09-29.json'),
      '--out',
      outNamed,
    ]);
    expect(readFileSync(outNamed, 'utf8')).toBe(first);

    // The accumulation is what makes a ledger better than a trace: a rule that fired on two days
    // survives `--min-days`, which is the recurrence a single session cannot show.
    expect(first).toContain('# Sessions: 2');
    expect(first).toContain('# Days: 2');
    expect(first).toContain('3 ||first.example^');
    expect(first).toContain('1 @@||allowed.example^');
  });

  test('--from names only the files that contributed, and says so for the rest', () => {
    // A downloads folder holds unrelated JSON — a session meta sidecar, a saved plan — and
    // listing one under `Source:` would record it as an input it never was. The per-file log
    // calls the skip what it is rather than printing a "0 usable sessions" line that reads as
    // a refusal that never happened.
    const dir = join(workDir, 'exports-mixed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'blockingmachine-hit-ledger-2026-09-29.json'),
      exportFile('2026-09-29', [['||second.example^', 1]]),
    );
    writeFileSync(
      join(dir, 'blockingmachine-hit-ledger-2026-09-29.meta.json'),
      JSON.stringify({ pages: ['example.com'], exportedAt: '2026-09-29T23:00:00.000Z' }),
    );

    const out = join(workDir, 'from-mixed.txt');
    const output = run(MERGE, ['--from', dir, '--out', out]);
    const text = readFileSync(out, 'utf8');

    expect(output).toMatch(/Skipped .*meta\.json.*not a ledger export/);
    expect(text).toContain('# Source: ');
    expect(text).not.toContain('meta.json');
    expect(text).toContain('blockingmachine-hit-ledger-2026-09-29.json');
    expect(text).toContain('# Sessions: 1');
  });

  test('the committed dropbox is byte-for-byte the merge of the session exports beside it', () => {
    // The file is the evidence the shipped cut is ranked by, so it has to be reproducible: the same
    // session exports through the same merge give the same bytes, and anything else means the
    // committed file was hand-edited or merged from sessions that were not committed. Either is
    // exactly what the weekly job cannot afford to discover.
    const sessions = readdirSync(join(ROOT, 'ledger'))
      .filter((name) => /^session-.+\.json$/.test(name) && !name.endsWith('.meta.json'))
      .sort();
    expect(sessions.length).toBeGreaterThan(0);

    const out = join(workDir, 'remerged.txt');
    run(MERGE, [
      ...sessions.flatMap((name) => ['--in', join('ledger', name)]),
      '--out',
      out,
    ]);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(DROPOX, 'utf8'));
  });

  test('a missing or empty directory is refused with something to act on', () => {
    const missing = attempt(MERGE, ['--from', join(workDir, 'no-such-dir'), '--out', join(workDir, 'x.txt')]);
    expect(missing.status).toBe(2);
    expect(missing.output).toMatch(/not a directory/i);

    const emptyDir = join(workDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const empty = attempt(MERGE, ['--from', emptyDir, '--out', join(workDir, 'y.txt')]);
    expect(empty.status).toBe(2);
    expect(empty.output).toMatch(/Nothing to merge/i);
  });
});

describeScripts('a hot list derived from the ledger stays verifiable', () => {
  test('a ledger-derived list passes --check with no input named at all', () => {
    const ledger = join(workDir, 'hits.txt');
    writeFileSync(
      ledger,
      ['# Sessions: 3', '# Days: 2', '', '4 ||ads.example^', '2 ||tracker.example^', ''].join('\n'),
    );
    const list = join(workDir, 'sources.txt');
    writeFileSync(
      list,
      [
        '! a list',
        '||ads.example^',
        '||tracker.example^',
        '||never-fired.example^',
        '@@||allowed.example^',
        '',
      ].join('\n'),
    );

    const out = join(workDir, 'hotlist.txt');
    run(HOT_LIST, ['--list', list, '--hits', ledger, '--out', out, '--write']);
    const written = readFileSync(out, 'utf8');
    expect(written).toContain('! Derivation:');
    expect(written).toContain('--hits');
    // The ledger's rules came in and the list's unfired tail was left behind.
    expect(written).toContain('||ads.example^');
    expect(written).not.toContain('||never-fired.example^');

    // The whole point: CI runs `check:hotlist` with no arguments, so a check that only knew the
    // trace fixture would fail this file — the artifact it exists to protect.
    const checked = run(HOT_LIST, ['--check', '--out', out]);
    expect(checked).toContain('Re-deriving from the list');

    // And it still fails a hand-edited list, which is what it is for.
    writeFileSync(out, written.replace('||ads.example^', '||hand-picked.example^'));
    const tampered = attempt(HOT_LIST, ['--check', '--out', out]);
    expect(tampered.status).toBe(1);
    expect(tampered.output).toMatch(/does not match a fresh build/i);
  });

  test('a deployment can derive straight from its own session exports, no ledger step', () => {
    // The case `--sessions` exists for: a hub's own traffic arrives as the popup's
    // `blockingmachine-hit-ledger-*.json` downloads, and making it merge first means the
    // per-deployment build needs a second script and a scratch file. The directory form is the
    // downloads-folder shape; the derivation line it writes must replay byte-for-byte, because
    // `--check` is how a hub later knows the file it serves still matches its evidence.
    const dir = join(workDir, 'deployment-exports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'blockingmachine-hit-ledger-2026-01-10.json'),
      exportFile('2026-01-10', [['||ours.example^', 4], ['||only-us.example^', 2]], ['@@||keep.example^']),
    );
    writeFileSync(
      join(dir, 'blockingmachine-hit-ledger-2026-01-11.json'),
      exportFile('2026-01-11', [['||ours.example^', 6]]),
    );
    const list = join(workDir, 'deployment-list.txt');
    writeFileSync(
      list,
      ['! the deployment list', '||ours.example^', '||only-us.example^', '||theirs.example^', '@@||keep.example^', ''].join('\n'),
    );

    const out = join(workDir, 'deployment-hotlist.txt');
    run(HOT_LIST, ['--list', list, '--sessions', dir, '--out', out, '--write']);
    const written = readFileSync(out, 'utf8');
    expect(written).toContain('! Derivation:');
    expect(written).toContain(`--sessions ${dir}`);
    // The merged evidence: a rule only this deployment's users saw ships; one nobody fired does not.
    expect(written).toContain('||only-us.example^');
    expect(written).toContain('@@||keep.example^');
    expect(written).not.toContain('||theirs.example^');
    expect(written).toContain('2 sessions across 2 days');

    // Same exports through the merge script must produce the same selection — the inline merge is
    // the same core functions, not a second reading of the format.
    const merged = join(workDir, 'deployment-ledger.txt');
    run(MERGE, ['--from', dir, '--out', merged]);
    const viaLedger = join(workDir, 'deployment-hotlist-via-ledger.txt');
    run(HOT_LIST, ['--list', list, '--hits', merged, '--out', viaLedger, '--write']);
    const viaLedgerText = readFileSync(viaLedger, 'utf8');
    expect(viaLedgerText.split('\n').filter((l) => l && !l.startsWith('!')))
      .toEqual(written.split('\n').filter((l) => l && !l.startsWith('!')));

    // And `--check` re-derives from the recorded `--sessions` line rather than the repo ledger.
    const checked = run(HOT_LIST, ['--check', '--out', out]);
    expect(checked).toContain('Re-deriving from the list');
  });

  test('two measurement inputs name one ambiguity too many — refused, not silently ranked', () => {
    // `--hits` used to win silently over `--trace`; the same shape with sessions would tell a
    // deployment its exports were measured while a different file did the measuring.
    const list = join(workDir, 'deployment-list.txt');
    const refusal = attempt(HOT_LIST, [
      '--list', list, '--sessions', workDir, '--hits', join(workDir, 'hits.txt'), '--out', join(workDir, 'x.txt'),
    ]);
    expect(refusal.status).toBe(2);
    expect(refusal.output).toMatch(/One measurement per build/);

    const repeated = attempt(HOT_LIST, [
      '--list', list, '--hits', 'a.txt', '--hits', 'b.txt', '--out', join(workDir, 'y.txt'),
    ]);
    expect(repeated.status).toBe(2);
    expect(repeated.output).toMatch(/--hits names one file/);
  });
});

describe('packaging ranks the cut by the ledger when there is one', () => {
  test('and the committed dropbox is one, so --hits is what it passes', () => {
    // Read from source rather than run: `package-extension.mjs` builds a webpack bundle and writes
    // two archives on import, so there is no cheap way to observe the call. This is a
    // characterisation test and worth saying so — it pins the wiring, not the behaviour, and the
    // behaviour it pins is the compiler's, which `tierCompiler.test.ts` covers against real output.
    const source = readFileSync(PACKAGE_EXTENSION, 'utf8');
    expect(source).toContain("['--hits', LEDGER]");
    expect(source).toContain('ledger/ledger-hits.txt');
    // The predicate has to agree with what the dropbox actually contains, in both directions: passed
    // against an empty file the compiler exits 2 instead of falling back to input order, and missed
    // on a populated one the ledger is never read and the cut reverts to input order with no error.
    // The same shape is written out here so the two can be compared rather than trusted.
    expect(source).toContain('/^#*\\s*\\d+\\s+\\S/m');

    const dropbox = readFileSync(DROPOX, 'utf8');
    const usable = /^#*\s*\d+\s+\S/m.test(dropbox);
    expect(usable).toBe(true);
  });
});