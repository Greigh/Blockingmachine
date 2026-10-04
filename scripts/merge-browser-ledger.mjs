#!/usr/bin/env node
/**
 * Merges browser-reported sessions into one rule-hit ledger.
 *
 *   npm run build --workspace=@blockingmachine/core
 *   npm run ledger:merge -- --in exports/session-1.json --in exports/session-2.json \
 *     --out packages/cli/filters/output/ledger-hits.txt
 *   node scripts/build-hot-list.mjs --hits packages/cli/filters/output/ledger-hits.txt --write
 *
 *   — or skip the ledger entirely and derive from the exports in one step:
 *   node scripts/build-hot-list.mjs --sessions <export-dir-or-file> --write
 *
 * The extension exports one file per reported session; this turns N of them into the single
 * `<count> <rule>` ledger `build-hot-list.mjs --hits` consumes, with the coverage written into its
 * header. The merge itself lives in `packages/core/src/ledgerAggregate.ts`, so the semantics a hot
 * set is derived from — days rather than hits, exceptions off the block axis, order-independence —
 * are tested there rather than here. This script only reads files, calls it, and says what happened.
 *
 * It also prints the **per-tier split**, because that is the other number the exports now carry and
 * the one the tier plan is weighted by. It goes in the header rather than in the rule lines for a
 * reason worth stating: `readTierLedger` and the tier compiler both resolve a rule to its tiers, so a
 * `tier_core 543` line would be 543 rules *named* `tier_core` — a tier id masquerading as a host — and
 * the host list would inherit it.
 *
 * Deliberately no date filtering: "recent sessions only" sounds obvious and is the fastest way to
 * throw away the recurrence evidence that makes a ledger better than a trace. A rule that fired
 * daily for a month and not this week is exactly what a single trace misses.
 *
 * The accumulation this feeds is re-derived every week by `scripts/weekly-tier-compile.sh`, which
 * means the same inputs have to produce the same bytes or the weekly run is a coin flip. Input
 * order is therefore sorted, not taken as given: the `Source:` header records the input list, and
 * a directory's `readdir` order is filesystem-dependent.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgvOrExit } from './argv.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'packages', 'core', 'dist');

// Parsed through the shared refusing parser (scripts/argv.mjs): `--in` followed by another flag
// used to land in `flags` and let `values.get('--in')` answer undefined — a named export silently
// replaced by "no input", which then read a different file than the one that was typed.
const { values } = parseArgvOrExit(process.argv.slice(2), {
  values: ['--in', '--from', '--out', '--min-days', '--max-rules'],
});
const one = (key) => values.get(key)?.at(-1);

// `Number('abc')` answering NaN is a silent replacement for a bad value: a NaN min-days filters
// every session out below, which reads as "the exports held nothing" rather than "the flag was
// unreadable". Checked here, before any file is read, like every other argument refusal.
for (const flag of ['--min-days', '--max-rules']) {
  if (values.has(flag) && !Number.isFinite(Number(one(flag)))) {
    console.error(`\n${flag} is not a number: ${JSON.stringify(one(flag))}\n`);
    process.exit(2);
  }
}

/**
 * `--from <dir>` expands to that directory's `*.json`, sorted. It is the whole-directory case of
 * `--in`: the popup names every export `blockingmachine-hit-ledger-<date>.json`, so a week of
 * browsing is a pile of files in a downloads folder, and naming each one is the part people get
 * wrong. Sorted rather than readdir order, because the merged file records the input list in its
 * own header and the merge is re-run weekly.
 */
function expandFrom(dir) {
  const absolute = resolve(root, dir);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    console.error(`--from is not a directory: ${dir}\n`);
    process.exit(2);
  }
  const names = readdirSync(absolute)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort();
  if (names.length === 0) {
    console.error(`No .json exports in ${dir}. Nothing to merge.\n`);
    process.exit(2);
  }
  return names.map((name) => join(dir, name));
}

const inputs = [
  ...(values.has('--from') ? expandFrom(one('--from')) : []),
  ...(values.get('--in') ?? []),
];
if (inputs.length === 0) {
  console.error('\nMerge browser-reported sessions into a hit ledger.\n');
  console.error('  node scripts/merge-browser-ledger.mjs --from <export-dir> [--out <ledger.txt>]');
  console.error('  node scripts/merge-browser-ledger.mjs --in <session.json> [--in <session2.json> ...]');
  console.error('                                       [--out <ledger.txt>] [--min-days N] [--max-rules N]\n');
  console.error('Each input is a JSON export from the extension: an array of sessions, or an');
  console.error('object with a `sessions` array. --from takes every .json in a directory, in name');
  console.error('order. Without --out it prints the result instead.\n');
  process.exit(2);
}

let ledger;
try {
  ledger = await import(pathToFileURL(join(dist, 'ledgerAggregate.js')).href);
} catch (error) {
  console.error(`\nCould not load ${join(dist, 'ledgerAggregate.js')}\n`);
  console.error('This script reads the compiled core package. Build it first:\n');
  console.error('  npm run build --workspace=@blockingmachine/core\n');
  console.error(`(${error instanceof Error ? error.message : String(error)})\n`);
  process.exit(2);
}

/** Repo-relative when inside the repo, so the header does not bake in a home directory. */
function displayPath(path) {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, absolute);
  return rel && !rel.startsWith('..') ? rel : absolute;
}

const collected = [];
let rejected = 0;
let tierRejected = 0;
// Only files that actually held sessions (usable or rejected — either is proof the file was a
// session export) are named as inputs. A `--from` directory can hold unrelated `.json` — a meta
// sidecar, a saved plan — and listing them under `Source:` would record inputs that never were.
const contributors = [];
for (const input of inputs) {
  const path = resolve(root, input);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`Could not read ${displayPath(path)}: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
  const read = ledger.readBrowserLedgerSessions(parsed);
  rejected += read.rejected;
  tierRejected += read.tierRejected;
  collected.push(...read.sessions);
  if (read.sessions.length === 0 && read.rejected === 0) {
    console.log(`Skipped ${displayPath(path)}: valid JSON but no sessions — not a ledger export`);
    continue;
  }
  contributors.push(displayPath(path));
  const tiered = read.sessions.filter((s) => Array.isArray(s.tiers) && s.tiers.length > 0).length;
  console.log(
    `Read ${displayPath(path)}: ${read.sessions.length} usable session(s), ${read.rejected} rejected` +
      `, ${tiered} with a tier split`,
  );
}

if (collected.length === 0) {
  console.error('\nNo usable sessions. A session needs a parseable date and a hits array.\n');
  process.exit(2);
}

const minDays = values.has('--min-days') ? Number(one('--min-days')) : 1;
const maxRules = values.has('--max-rules') ? Number(one('--max-rules')) : undefined;

const aggregate = ledger.mergeBrowserLedger(collected, { minDays, maxRules });
// Combine the two rejection counts rather than picking one: the reader counts the bad tier ids it
// dropped before the merge ever saw them, and the merge counts any that reached it unvalidated
// (a caller that skips the reader). They are disjoint sets, so the sum cannot double-count.
const reported = {
  ...aggregate,
  rejected,
  tierRejected: tierRejected + aggregate.tierRejected,
};
const text = ledger.toHitLedgerText(reported, {
  source: contributors.join(', '),
  note: 'Produced by scripts/merge-browser-ledger.mjs',
});

console.log('');
console.log(`  coverage : ${ledger.summarizeBrowserLedger(reported)}`);
console.log(`  rules    : ${aggregate.rules.length} blocking${aggregate.exceptions.length > 0 ? ` + ${aggregate.exceptions.length} exceptions` : ''}`);
if (minDays > 1) console.log(`  min days : ${minDays} (rules that fired on fewer days were dropped)`);

// The per-tier tally, printed because the tier plan is weighted by it and this merge is where the
// number a plan would use is produced. Coverage is on the same lines as the counts for the reason
// the summary leads with it: a table over one session of ten is a real measurement of one session,
// and a reader who has to ask how many sessions carried it will assume all of them did.
if (aggregate.tiers.length > 0) {
  const widest = Math.max(...aggregate.tiers.map((tier) => tier.tier.length));
  console.log(`  tiers    : ${aggregate.tierSessions} of ${aggregate.sessions} sessions carried a split`);
  for (const tier of aggregate.tiers) {
    const span =
      tier.sessions === 1 && tier.days.length === 1
        ? ''
        : `  (${tier.sessions} session${tier.sessions === 1 ? '' : 's'}, ${tier.days.length} day${tier.days.length === 1 ? '' : 's'})`;
    console.log(`    ${tier.tier.padEnd(widest)}  ${String(tier.count.toLocaleString()).padStart(9)}${span}`);
  }
  if (aggregate.tierUnattributed > 0) {
    console.log(`    ${'(no tier)'.padEnd(widest)}  ${String(aggregate.tierUnattributed.toLocaleString()).padStart(9)}  (the synced list, not a tier)`);
  }
  if (aggregate.tierSessions < aggregate.sessions) {
    console.log(
      `  ⚠️  ${aggregate.sessions - aggregate.tierSessions} session(s) predate the per-tier axis, so the\n` +
        `     table above does not describe all of the evidence. They are counted, not guessed at.`,
    );
  }
} else {
  console.log('  tiers    : none — no input carried a per-tier split. The block axis is unaffected.');
}
if (aggregate.rules.length === 0) {
  console.error('\nEvery rule was filtered out — check --min-days against the coverage above.\n');
  process.exit(1);
}
console.log('');

if (values.has('--out')) {
  const outPath = resolve(root, one('--out'));
  writeFileSync(outPath, text, 'utf8');
  console.log(`Wrote ${displayPath(outPath)}\n`);
} else {
  console.log('Dry run — pass --out <file> to write the ledger.\n');
  console.log(text);
}
