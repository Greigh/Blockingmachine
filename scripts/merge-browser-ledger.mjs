#!/usr/bin/env node
/**
 * Merges browser-reported sessions into one rule-hit ledger.
 *
 *   npm run build --workspace=@blockingmachine/core
 *   npm run ledger:merge -- --in exports/session-1.json --in exports/session-2.json \
 *     --out packages/cli/filters/output/ledger-hits.txt
 *   node scripts/build-hot-list.mjs --hits packages/cli/filters/output/ledger-hits.txt --write
 *
 * The extension exports one file per reported session; this turns N of them into the single
 * `<count> <rule>` ledger `build-hot-list.mjs --hits` consumes, with the coverage written into its
 * header. The merge itself lives in `packages/core/src/ledgerAggregate.ts`, so the semantics a hot
 * set is derived from — days rather than hits, exceptions off the block axis, order-independence —
 * are tested there rather than here. This script only reads files, calls it, and says what happened.
 *
 * Deliberately no date filtering: "recent sessions only" sounds obvious and is the fastest way to
 * throw away the recurrence evidence that makes a ledger better than a trace. A rule that fired
 * daily for a month and not this week is exactly what a single trace misses.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'packages', 'core', 'dist');

/** `--flag value` pairs (repeats kept), plus bare `--flags`. */
function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      // Repeats are kept in order: `--in a --in b` is two inputs, not the last one twice.
      values.set(arg, [...(values.get(arg) ?? []), next]);
      i += 1;
    } else {
      flags.add(arg);
    }
  }
  return { flags, values };
}

const { flags, values } = parseArgs(process.argv.slice(2));
const one = (key) => values.get(key)?.at(-1);

const inputs = values.get('--in') ?? [];
if (inputs.length === 0) {
  console.error('\nMerge browser-reported sessions into a hit ledger.\n');
  console.error('  node scripts/merge-browser-ledger.mjs --in <session.json> [--in <session2.json> ...]');
  console.error('                                       [--out <ledger.txt>] [--min-days N] [--max-rules N]\n');
  console.error('Each --in file is a JSON export from the extension: an array of sessions, or an');
  console.error('object with a `sessions` array. Without --out it prints the result instead.\n');
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
  collected.push(...read.sessions);
  console.log(`Read ${displayPath(path)}: ${read.sessions.length} usable session(s), ${read.rejected} rejected`);
}

if (collected.length === 0) {
  console.error('\nNo usable sessions. A session needs a parseable date and a hits array.\n');
  process.exit(2);
}

const minDays = values.has('--min-days') ? Number(one('--min-days')) : 1;
const maxRules = values.has('--max-rules') ? Number(one('--max-rules')) : undefined;

const aggregate = ledger.mergeBrowserLedger(collected, { minDays, maxRules });
// Carry forward the rejections the per-file reads counted: the aggregate itself only sees sessions
// that already passed, and a merge that forgot them would understate what it could not read.
const reported = { ...aggregate, rejected };
const text = ledger.toHitLedgerText(reported, {
  source: inputs.map((input) => displayPath(input)).join(', '),
  note: 'Produced by scripts/merge-browser-ledger.mjs',
});

console.log('');
console.log(`  coverage : ${ledger.summarizeBrowserLedger(reported)}`);
console.log(`  rules    : ${aggregate.rules.length} blocking${aggregate.exceptions.length > 0 ? ` + ${aggregate.exceptions.length} exceptions` : ''}`);
if (minDays > 1) console.log(`  min days : ${minDays} (rules that fired on fewer days were dropped)`);
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
