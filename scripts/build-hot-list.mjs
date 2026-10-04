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
 * Three inputs, in order of fidelity:
 *   --hits <file>      a browser-reported rule-hit ledger (paths, request types and initiators
 *                      were all applied by the browser; the honest one)
 *   --sessions <path>  the extension's own session exports — the file, or a directory of them —
 *                      merged inline. This is what a *deployment's* measurement looks like: the
 *                      ledger above is committed in this repository, the exports are what a hub's
 *                      own users can hand it, and a build that only read the repo's ledger could
 *                      never represent them.
 *   --trace <file>     a captured request-host trace, replayed through the domain evaluator
 *
 * Only one measurement input at a time — naming two is ambiguous about what was measured.
 *
 * Reads the compiled core output, so it needs a build first. The header is deterministic — no
 * clock, and paths are relative to the repo root — so `--check` is a plain diff.
 *
 * ## `--check` reads its own provenance
 *
 * The list used to be derived from one checked-in trace fixture forever, so `--check` compared
 * against that fixture and there was nothing to decide. That stops being true the moment the list
 * is derived from the accumulated browser ledger instead: a check hard-wired to the fixture would
 * then fail on the ledger-derived list it was supposed to be protecting, and the obvious "fix" —
 * dropping `--check` from CI — removes the only thing keeping a hand-edited hot list honest.
 *
 * So the generated header records the exact flags that produced it, and `--check` replays them
 * when the caller names no input. A file with no `Derivation:` line predates this and falls back
 * to the fixture, which is what it was built from.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lastValue, parseArgvOrExit } from './argv.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'packages', 'core', 'dist');

const DEFAULT_LIST = 'packages/cli/filters/output/genericBrowserRules.txt';
const DEFAULT_TRACE = 'packages/cli/src/__tests__/fixtures/browsing-trace.txt';
const DEFAULT_OUT = 'packages/cli/filters/output/hotlist.txt';

// Parsed through the shared refusing parser (scripts/argv.mjs): a `--list` followed by nothing —
// or by another flag — used to land in `flags` and let `values.get` fall through to the default,
// so `--list --check` silently checked the *default* list instead of refusing the missing value.
const { flags, values } = parseArgvOrExit(process.argv.slice(2), {
  values: ['--list', '--hits', '--trace', '--sessions', '--out', '--share'],
  flags: ['--check', '--write'],
});

// `--share` is the one flag whose value is a number — and `Number('abc')` answering NaN is the
// same silent replacement as a missing one: a share of NaN ranks nothing the caller meant.
// Checked here, before the dist load, like every other argument refusal.
const shareText = lastValue(values, '--share');
if (shareText !== undefined && !Number.isFinite(Number(shareText))) {
  console.error(`\n--share is not a number: ${JSON.stringify(shareText)}\n`);
  process.exit(2);
}

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

const outPath = resolve(root, lastValue(values, '--out') ?? DEFAULT_OUT);

/** The checked-in file when checking: both what `--check` compares against and where the
 *  provenance comes from when the caller named no input. */
let existing = null;
if (flags.has('--check')) {
  try {
    existing = readFileSync(outPath, 'utf8');
  } catch {
    console.error(`Missing ${displayPath(outPath)}. Run with --write.\n`);
    process.exit(1);
  }
}

/**
 * The flags a checked-in list records, so a check with no input re-derives from what actually
 * produced the file rather than from whatever the script's defaults happen to be today.
 *
 * The reader is core's, beside the writer — see `parseHotListDerivation`. This only adds the line
 * it is replaying, because a weekly run that silently picked different inputs than the file names
 * is the failure this exists to prevent, and that is worth saying out loud in the log.
 */
function parseDerivation(text) {
  const declared = coverage.parseHotListDerivation(text);
  if (!declared) return null;
  const line = /^!\s*Derivation:\s*(.+)$/m.exec(text);
  console.log(`Re-deriving from the list's own provenance: ${line[1].trim()}`);
  return declared;
}

const namedList = lastValue(values, '--list') ?? null;
const namedHits = lastValue(values, '--hits') ?? null;
const namedTrace = lastValue(values, '--trace') ?? null;
const namedSessions = values.get('--sessions') ?? [];

// The three measurement inputs answer different questions, and naming two is ambiguous about
// which measurement produced the list — the same silent substitution the argv parser refuses
// everywhere else, one level up. Repeating `--hits` or `--trace` reads as "merge these" and is
// refused for the same reason; `--sessions` is the only input that is legitimately plural.
for (const flag of ['--hits', '--trace']) {
  if ((values.get(flag) ?? []).length > 1) {
    console.error(
      `\n${flag} names one file — it was given ${values.get(flag).length}. ` +
        `Merge the inputs first (ledger:merge for ledgers) and name the result.\n`,
    );
    process.exit(2);
  }
}
const namedMeasurements = [namedHits && '--hits', namedTrace && '--trace', namedSessions.length > 0 && '--sessions'].filter(
  Boolean,
);
if (namedMeasurements.length > 1) {
  console.error(
    `\nOne measurement per build: ${namedMeasurements.join(' and ')} were both named. ` +
      `Merge ledgers with ledger:merge first, or pass the sessions directly.\n`,
  );
  process.exit(2);
}
// Only consulted when the caller named nothing at all. An explicit `--trace` against a
// ledger-derived list is a request to rebuild it from a trace, not a check of what is there.
const declared =
  namedList || namedHits || namedTrace || namedSessions.length > 0 ? null : parseDerivation(existing);

const listPath = resolve(root, namedList ?? declared?.list ?? DEFAULT_LIST);
const share = shareText !== undefined ? Number(shareText) : (declared?.share ?? 1);

/** The session-export inputs this build is merging inline, in the order they were named. */
const sessionInputs = namedSessions.length > 0 ? namedSessions : (declared?.sessions ?? []);

/** The header's replay line, in the same order every time so the file is a stable diff. */
const measurementFlag = namedHits || declared?.hits
  ? `--hits ${displayPath(resolve(root, namedHits ?? declared.hits))}`
  : sessionInputs.length > 0
    ? sessionInputs.map((p) => `--sessions ${displayPath(resolve(root, p))}`).join(' ')
    : `--trace ${displayPath(resolve(root, namedTrace ?? declared?.trace ?? DEFAULT_TRACE))}`;
const derivation = [
  `--list ${displayPath(listPath)}`,
  measurementFlag,
  share === 1 ? null : `--share ${share}`,
]
  .filter(Boolean)
  .join(' ');

const listLines = readLines(listPath).filter(Boolean);
if (listLines.length === 0) {
  console.error(`No rules found in ${displayPath(listPath)}.`);
  process.exit(2);
}

let hits;
let exceptions;
let measuredOn;

if (namedHits ?? declared?.hits) {
  const hitsPath = resolve(root, namedHits ?? declared.hits);
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
} else if (sessionInputs.length > 0) {
  // The extension's own exports — the measurement a deployment can actually produce. Merged inline
  // through the same core functions `ledger:merge` drives, so a build that reads sessions and a
  // build that reads the merged file can never disagree about what the evidence said.
  const sessionFiles = sessionInputs.flatMap((input) => {
    const absolute = resolve(root, input);
    if (!existsSync(absolute)) {
      console.error(`\n--sessions path does not exist: ${displayPath(absolute)}\n`);
      process.exit(2);
    }
    if (statSync(absolute).isDirectory()) {
      const names = readdirSync(absolute)
        .filter((name) => name.toLowerCase().endsWith('.json'))
        .sort();
      if (names.length === 0) {
        console.error(`\n--sessions directory holds no exports: ${displayPath(absolute)}\n`);
        process.exit(2);
      }
      return names.map((name) => join(absolute, name));
    }
    return [absolute];
  });

  const parsedSessions = [];
  let rejectedSessions = 0;
  for (const file of sessionFiles) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      console.error(`\n--sessions file is not JSON: ${displayPath(file)} (${error instanceof Error ? error.message : String(error)})\n`);
      process.exit(2);
    }
    const parsed = ledger.readBrowserLedgerSessions(doc);
    rejectedSessions += parsed.rejected;
    parsedSessions.push(...parsed.sessions);
  }
  if (parsedSessions.length === 0) {
    console.error(
      `\nNo usable sessions in ${sessionInputs.map((p) => displayPath(resolve(root, p))).join(', ')}.` +
        `${rejectedSessions > 0 ? ` (${rejectedSessions} rejected — an export needs startedAt and a hits array.)` : ''}\n`,
    );
    process.exit(2);
  }

  const aggregate = ledger.mergeBrowserLedger(parsedSessions);
  hits = aggregate.rules.map((entry) => ({ rule: entry.rule, count: entry.count }));
  exceptions = aggregate.exceptions.map((entry) => entry.rule);

  const span = aggregate.firstSeen && aggregate.lastSeen ? ` ${aggregate.firstSeen}..${aggregate.lastSeen}` : '';
  measuredOn =
    `${sessionInputs.map((p) => displayPath(resolve(root, p))).join(', ')} ` +
    `(browser session exports merged inline: ${aggregate.sessions} session${aggregate.sessions === 1 ? '' : 's'} ` +
    `across ${aggregate.days.length} day${aggregate.days.length === 1 ? '' : 's'}${span}` +
    `${rejectedSessions > 0 ? `, ${rejectedSessions} unusable skipped` : ''})`;
} else {
  const tracePath = resolve(root, namedTrace ?? declared?.trace ?? DEFAULT_TRACE);
  const hosts = readLines(tracePath).filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
  if (hosts.length === 0) {
    console.error(`No usable requests found in the trace (${displayPath(tracePath)}).`);
    process.exit(2);
  }
  const ruleSet = new evaluator.CompiledDomainRuleSet(listLines);
  // Split the host from the path rather than discarding the path. A trace line that carries a
  // URL lets the replay decide path-scoped rules against the request that actually carried it;
  // collapsing to a host here threw that away before the replay ever saw it.
  const requests = hosts.map((line) => {
    const value = line.trim().toLowerCase();
    const host = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0];
    return {
      host,
      url: value.includes('/') ? value.replace(/#.*$/, '') : undefined,
      count: 1,
    };
  });
  // The same replay the coverage command reports from. A hot set derived by a different loop than
  // the one that measures it is a hot set nobody has checked.
  const outcome = replay.replayRuleHits(ruleSet, requests);
  // Every winner is kept, context-scoped ones included: preserving the verdicts the measurement saw
  // is the whole point, and a scoped winner read as a zone block is still the verdict that was
  // measured. URL-decided path rules are winners too, and belong alongside the hostname ones.
  hits = [
    ...outcome.hits,
    ...outcome.urlHits,
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
const source = coverage.formatHotList(selection, {
  source: displayPath(listPath),
  measuredOn,
  derivation,
});

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
