#!/usr/bin/env node
/**
 * Builds the coverage-derived hot set from a measurement of real traffic.
 *
 *   npm run build --workspace=@blockingmachine/core
 *   node scripts/build-hot-list.mjs            # print what it would ship
 *   node scripts/build-hot-list.mjs --write    # rewrite the hot list
 *   node scripts/build-hot-list.mjs --check    # fail if the file on disk is stale
 *
 * The selection itself lives in `packages/core/src/coverage.ts` (`selectHotList`), next to the
 * coverage curve that justifies it — this script only drives it, prints what it kept, and
 * transcribes the result. Keeping the list machine-written is the point: a hot set retyped by
 * hand drifts from the measurement that supposedly produced it, and nothing notices.
 *
 * Two inputs, in order of fidelity:
 *   --hits <file>   a browser-reported rule-hit ledger (paths, request types and initiators were
 *                   all applied by the browser; the honest one)
 *   --trace <file>  a captured request-host trace, replayed through the domain evaluator
 *
 * Reads the compiled core output, so it needs a build first. The header is deterministic — no
 * clock, and paths are relative to the repo root — so `--check` is a plain diff.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'packages', 'core', 'dist');

const DEFAULT_LIST = 'packages/cli/filters/output/genericBrowserRules.txt';
const DEFAULT_TRACE = 'packages/cli/src/__tests__/fixtures/browsing-trace.txt';
const DEFAULT_OUT = 'packages/cli/filters/output/hotlist.txt';

/** `--flag value` pairs, plus bare `--flags`. */
function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      values.set(arg, next);
      i += 1;
    } else {
      flags.add(arg);
    }
  }
  return { flags, values };
}

const { flags, values } = parseArgs(process.argv.slice(2));

async function load(relative) {
  const path = join(dist, relative);
  try {
    return await import(pathToFileURL(path).href);
  } catch (error) {
    console.error(`\nCould not load ${path}\n`);
    console.error('This script reads the compiled core package. Build it first:\n');
    console.error('  npm run build --workspace=@blockingmachine/core\n');
    console.error(`(${error instanceof Error ? error.message : String(error)})`);
    process.exit(2);
  }
}

const coverage = await load(join('coverage.js'));
const replay = await load(join('ruleReplay.js'));
const ledger = await load(join('ledgerAggregate.js'));
const evaluator = await load(join('ai', 'domainEvaluator.js'));

/** Repo-relative when inside the repo, so the header does not bake in a home directory. */
function displayPath(path) {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, absolute);
  return rel && !rel.startsWith('..') ? rel : absolute;
}

function readLines(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim());
}

const listPath = resolve(root, values.get('--list') ?? DEFAULT_LIST);
const outPath = resolve(root, values.get('--out') ?? DEFAULT_OUT);
const share = values.has('--share') ? Number(values.get('--share')) : 1;

const listLines = readLines(listPath).filter(Boolean);
if (listLines.length === 0) {
  console.error(`No rules found in ${displayPath(listPath)}.`);
  process.exit(2);
}

let hits;
let exceptions;
let measuredOn;

if (values.has('--hits')) {
  const hitsPath = resolve(root, values.get('--hits'));
  // One parser, in core, shared with the exporter that writes this format — a build that read the
  // ledger with its own copy of the rules would drift from the thing that produced it.
  const parsed = ledger.parseHitLedgerText(readFileSync(hitsPath, 'utf8'));
  hits = parsed.hits;
  exceptions = parsed.exceptions;

  // Provenance when the file states it, so the generated header can say what the reduction is
  // based on. A bare `<count> <rule>` file answers this with nothing, which is honest.
  const sessions = parsed.header.sessions;
  const days = parsed.header.days;
  const span =
    parsed.header['first seen'] && parsed.header['last seen']
      ? ` ${parsed.header['first seen']}..${parsed.header['last seen']}`
      : parsed.header['first seen']
        ? ` on ${parsed.header['first seen']}`
        : '';
  const provenance =
    sessions && days
      ? `browser-reported rule hits: ${sessions} session${sessions === '1' ? '' : 's'} across ${days} day${days === '1' ? '' : 's'}${span}`
      : 'browser-reported rule hits (no session provenance in the file)';
  measuredOn = `${displayPath(hitsPath)} (${provenance})`;
} else {
  const tracePath = resolve(root, values.get('--trace') ?? DEFAULT_TRACE);
  const hosts = readLines(tracePath).filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
  if (hosts.length === 0) {
    console.error(`No usable requests found in the trace (${displayPath(tracePath)}).`);
    process.exit(2);
  }
  const ruleSet = new evaluator.CompiledDomainRuleSet(listLines);
  const requests = hosts.map((host) => ({
    host: host.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0],
    count: 1,
  }));
  // The same replay the coverage command reports from. A hot set derived by a different loop than
  // the one that measures it is a hot set nobody has checked.
  const outcome = replay.replayRuleHits(ruleSet, requests);
  // Every winner is kept, context-scoped ones included: preserving the verdicts the measurement saw
  // is the whole point, and a scoped winner read as a zone block is still the verdict that was
  // measured.
  hits = [
    ...outcome.hits,
    ...outcome.scopedHits.map((hit) => ({ rule: hit.rule, count: hit.count })),
  ];
  exceptions = outcome.exceptions.map((entry) => entry.rule);
  measuredOn = `${displayPath(tracePath)} (request trace replay, ${hosts.length.toLocaleString()} requests)`;
}

if (hits.length === 0) {
  console.error('Nothing fired in the measurement, so there is no hot set to build.');
  process.exit(2);
}

const selection = coverage.selectHotList({ lines: listLines, hits, exceptions, share });
const source = coverage.formatHotList(selection, { source: displayPath(listPath), measuredOn });

const covered = `${selection.coveredRequests.toLocaleString()} of ${selection.totalRequests.toLocaleString()}`;
console.log('\nHot list');
console.log('');
console.log(`  source list           : ${displayPath(listPath)} (${selection.sourceLines.toLocaleString()} lines)`);
console.log(`  measured on           : ${measuredOn}`);
console.log(`  share requested       : ${(selection.share * 100).toFixed(1)}%`);
console.log(`  rules shipped         : ${selection.lines.length.toLocaleString()} rules`);
console.log(`  measured blocks kept  : ${covered} (${(selection.coverage * 100).toFixed(1)}%)`);
console.log(`  scopes kept           : ${selection.scopes.hostname.toLocaleString()} hostname · ${selection.scopes.initiator.toLocaleString()} initiator · ${selection.scopes.path.toLocaleString()} path · ${selection.scopes.request.toLocaleString()} request`);
console.log(`  exceptions kept       : ${selection.keptExceptions.length.toLocaleString()}`);
console.log(`  insurance left behind : ${selection.unfiredRules.toLocaleString()} blocking rules that never fired`);
if (selection.dropped.length > 0) {
  console.log(`  dropped (in-share)    : ${selection.dropped.length.toLocaleString()} rules that fired`);
  for (const entry of selection.dropped.slice(0, 5)) {
    console.log(`      ${String(entry.count).padStart(6)} x  ${entry.rule}`);
  }
}
console.log('');

if (flags.has('--check')) {
  let existing = '';
  try {
    existing = readFileSync(outPath, 'utf8');
  } catch {
    console.error(`Missing ${displayPath(outPath)}. Run with --write.\n`);
    process.exit(1);
  }
  if (existing !== source) {
    console.error('The checked-in hot list does not match a fresh build.\n');
    console.error('Re-run with --write and commit the result.\n');
    process.exit(1);
  }
  console.log('Hot list matches a fresh build.\n');
  process.exit(0);
}

if (flags.has('--write')) {
  writeFileSync(outPath, source, 'utf8');
  console.log(`Wrote ${displayPath(outPath)}\n`);
  process.exit(0);
}

console.log('Dry run — pass --write to update the hot list.\n');
