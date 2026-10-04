#!/usr/bin/env node
/**
 * Gates the share of the shipped list's path-scoped blocking rules that a request URL can
 * decide — the measurement `blockingmachine coverage` reports as "path-scoped" rules that a
 * URL trace can settle rather than merely report.
 *
 *   npm run build --workspace=@blockingmachine/core
 *   node scripts/check-path-decidability.mjs                 # measure the shipped list, gate at 0.80
 *   node scripts/check-path-decidability.mjs --min 0.9       # a stricter floor
 *   node scripts/check-path-decidability.mjs --list <file>   # measure a different list
 *
 * Why the gate exists. The path bucket is only *potentially* URL-decidable: `||host/path$script`
 * also names a request type no URL carries, and a mangled host anchor refuses the matcher
 * outright. The residue is large enough to matter — on the shipped list it is mostly request-type
 * modifiers and `$replace=` rewrites — so a list update that quietly floods the bucket with
 * undecidable shapes would still pass every replay test while making the URL half of coverage
 * worth less. This check is the floor under that.
 *
 * Exits non-zero below `--min`, and also when the list has no path-scoped rules at all: a share
 * of nothing is not a passing measurement.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lastValue, parseArgvOrExit } from './argv.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'packages', 'core', 'dist');

const DEFAULT_LIST = 'packages/cli/filters/output/genericBrowserRules.txt';
const DEFAULT_MIN = 0.8;

const { values } = parseArgvOrExit(process.argv.slice(2), {
  values: ['--list', '--min'],
  flags: [],
});

// Refused before the dist load, like every other argument refusal: a `--min` that reads as NaN
// would otherwise floor at NaN and pass everything.
const minText = lastValue(values, '--min');
const min = minText === undefined ? DEFAULT_MIN : Number(minText);
if (!Number.isFinite(min) || min < 0 || min > 1) {
  console.error(`\n--min must be a share between 0 and 1: ${JSON.stringify(minText)}\n`);
  process.exit(2);
}

async function load(relativePath) {
  const path = join(dist, relativePath);
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

const { pathRuleDecidability } = await load('coverage.js');

/** Repo-relative when inside the repo, so the report does not bake in a home directory. */
function displayPath(path) {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, absolute);
  return rel && !rel.startsWith('..') ? rel : absolute;
}

const listPath = resolve(root, lastValue(values, '--list') ?? DEFAULT_LIST);
const lines = readFileSync(listPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const { pathScoped, urlDecidable, share } = pathRuleDecidability(lines);
const percent = (share * 100).toFixed(1);

console.log('\nPath-rule decidability\n');
console.log(`  list          : ${displayPath(listPath)} (${lines.length.toLocaleString()} lines)`);
console.log(`  path-scoped   : ${pathScoped.toLocaleString()} blocking rules`);
console.log(`  URL-decidable : ${urlDecidable.toLocaleString()} (${percent}%)`);
console.log(`  floor         : ${(min * 100).toFixed(1)}%`);

if (pathScoped === 0) {
  console.error('\nThe list carries no path-scoped rules at all — a share of nothing is not a passing measurement.\n');
  process.exit(1);
}
if (share < min) {
  console.error(
    `\nFAIL: ${percent}% of path-scoped rules are URL-decidable, below the ${(min * 100).toFixed(1)}% floor ` +
      `(${pathScoped - urlDecidable} rules a URL cannot settle).\n`,
  );
  process.exit(1);
}
console.log('');
