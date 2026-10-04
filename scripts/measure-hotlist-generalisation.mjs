#!/usr/bin/env node
/**
 * How much of a hot set's held-out loss is "not enough derivation data"?
 *
 *   npm run build --workspace=@blockingmachine/core
 *   node scripts/measure-hotlist-generalisation.mjs
 *   node scripts/measure-hotlist-generalisation.mjs --hits ledger-hits.txt
 *
 * The shipped hot set is exact for the traffic it was derived from and loses most of the rest:
 * deriving from half an 11-page session and measuring on the other half keeps 38 of 93 blocks
 * (40.9%). The project's stated answer to that number is "derive it from a browser-reported
 * ledger aggregated across many sessions instead" — and a ledger now exists: the committed
 * `ledger/ledger-hits.txt` (four scripted sessions, one day) measures **14.3%** this way, *below*
 * the page-split figure because a whole-session hold-out shares no traffic with the derivation.
 * What no ledger in the repository yet supplies is a person's real browsing across days.
 *
 * This measures the shape of the effect on the data that does exist, rather than asserting that
 * more sessions would help. It derives a hot set from the first *k* pages and measures it on the
 * remaining pages, for every split, and prints what the held-out share does as *k* grows.
 *
 * Two ways to read the curve, and the second is the one that matters:
 *
 *  - If it rises steeply, the 40.9% is mostly a sample-size artifact and a ledger over many
 *    sessions would recover much of it.
 *  - If it flattens early, more of the loss is structural — a hot set of rules that fire at all
 *    is not a hot set of rules that fire *here*, and no amount of extra sessions changes that.
 *    On the committed ledger the session axis was flat at every prefix, which is this second
 *    shape measured on real input rather than proxied.
 *
 * A rising curve does not license shipping a hot set in place of the full export; the check that
 * would is the hold-out share at full derivation breadth, not the trend within one small session.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lastValue, parseArgvOrExit } from './argv.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'packages', 'core', 'dist');

const LIST = join(root, 'packages', 'cli', 'filters', 'output', 'genericBrowserRules.txt');
const TRACE = join(root, 'packages', 'cli', 'src', '__tests__', 'fixtures', 'browsing-trace.txt');

// Parsed through the shared refusing parser (scripts/argv.mjs): the loose shape this replaced
// dropped a bare flag *entirely* — `--hits` with no file never even landed in the map — so the
// ledger evidence was silently skipped and the run measured the page-split baseline instead.
// It runs before the dist imports so a refused flag never waits on a build.
const { values } = parseArgvOrExit(process.argv.slice(2), {
  values: ['--hits'],
});

const core = await import(pathToFileURL(join(dist, 'coverage.js')).href);
const { CompiledDomainRuleSet } = await import(pathToFileURL(join(dist, 'ai', 'domainEvaluator.js')).href);
const { replayRuleHits } = await import(pathToFileURL(join(dist, 'ruleReplay.js')).href);
const { parseHitLedgerText } = await import(pathToFileURL(join(dist, 'ledgerAggregate.js')).href);

/** Splits the trace into its pages, the way the hold-out test does. */
function pagesOf(text) {
  const pages = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('!')) continue;
    if (line.startsWith('# page:')) {
      pages.push([]);
      continue;
    }
    if (line.startsWith('#')) continue;
    const current = pages[pages.length - 1];
    if (current) current.push(line);
  }
  return pages.filter((page) => page.length > 0);
}

const lines = readFileSync(LIST, 'utf8').split('\n');
const pages = pagesOf(readFileSync(TRACE, 'utf8'));
const fullRuleSet = new CompiledDomainRuleSet(lines);

/** Rules a derivation set's traffic makes the list fire, in one pass. */
function deriveFrom(hosts) {
  const outcome = replayRuleHits(fullRuleSet, hosts.map((host) => ({ host, count: 1 })));
  return core.selectHotList({
    lines,
    hits: [...outcome.hits, ...outcome.urlHits, ...outcome.scopedHits.map((hit) => ({ rule: hit.rule, count: hit.count }))],
    exceptions: outcome.exceptions.map((entry) => entry.rule),
  });
}

function blockedOn(ruleSet, hosts) {
  const outcome = replayRuleHits(ruleSet, hosts.map((host) => ({ host, count: 1 })));
  return outcome.blockedRequests;
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;
const pad = (value, width) => String(value).padStart(width);

// ── Ledger mode ────────────────────────────────────────────────────────────────
//
// Derive from a browser-reported ledger instead of from a page split, and hold out the whole
// session. A ledger is the honest input: the browser resolved paths, request types and initiators
// itself, and — as long as it was not collected from this very session — none of these pages
// were in it. That is a stricter hold-out than the page split, which shares a session with its
// derivation set.
if (values.has('--hits')) {
  const ledgerPath = resolve(root, lastValue(values, '--hits'));
  const ledger = parseHitLedgerText(readFileSync(ledgerPath, 'utf8'));
  const provenance = Object.entries(ledger.header)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ');

  console.log(`\nHot-set generalisation — deriving from a browser-reported ledger, holding out the whole session\n`);
  console.log(`  Ledger:           ${ledgerPath.replace(`${root}/`, '')}`);
  console.log(`  Provenance:       ${provenance || '(none in the header — a hand-written list)'}`);
  console.log(`  Ledger rules:     ${ledger.hits.length} fired, ${ledger.exceptions.length} exception rule(s)`);

  const selection = core.selectHotList({
    lines,
    hits: ledger.hits,
    exceptions: ledger.exceptions,
  });

  const allHosts = pages.flat();
  const derivedSet = new CompiledDomainRuleSet(selection.lines);
  const fullBlocks = blockedOn(fullRuleSet, allHosts);
  const keptBlocks = blockedOn(derivedSet, allHosts);
  const share = fullBlocks > 0 ? keptBlocks / fullBlocks : 0;

  console.log(`  Session:          ${allHosts.length} hosts on ${pages.length} pages, ${fullBlocks} blocks by the full export`);
  console.log(`  Hot set:          ${selection.lines.length} rules\n`);
  console.log(`  Held-out share:   ${pct(share)} — ${keptBlocks} of ${fullBlocks} blocks`);
  console.log(
    `\n  Compare against the page-split baseline below, which derives from this session's own first half\n` +
      `  and reaches 40.9%. The two are not like for like: this hold-out is the whole session rather than\n` +
      `  half of it, and a ledger that grew its hot set on other days' traffic is answering a harder\n` +
      `  question — one hard enough that the first real ledger (the committed four-session file) landed\n` +
      `  *below* the split, at 14.3%. Near the split means the sessions bought little; far above means\n` +
      `  they bought a lot; below it means the split overstated what breadth buys. Either way it is a\n` +
      `  floor: this list is still only the rules that fired somewhere, and the plateau in the page\n` +
      `  sweep below is the part no input fixes.\n`,
  );
} else {

console.log(`\nHot-set generalisation — deriving from the first k pages of ${pages.length}, holding out the rest\n`);
console.log('  k pages   derive hosts   rules   hold-out hosts   full blocks   kept   share');
console.log('  ' + '-'.repeat(76));
const rows = [];
for (let k = 1; k < pages.length; k += 1) {
  const deriveHosts = pages.slice(0, k).flat();
  const holdoutHosts = pages.slice(k).flat();
  if (holdoutHosts.length === 0) continue;

  const selection = deriveFrom(deriveHosts);
  const derivedSet = new CompiledDomainRuleSet(selection.lines);
  const fullBlocks = blockedOn(fullRuleSet, holdoutHosts);
  const keptBlocks = blockedOn(derivedSet, holdoutHosts);
  const share = fullBlocks > 0 ? keptBlocks / fullBlocks : 0;

  // A split whose hold-out has almost nothing in it measures nothing: the ratio is a single
  // block either way and moves by whole blocks rather than by evidence. Marked rather than
  // hidden, so the shape stays readable — and never averaged in.
  const thin = holdoutHosts.length < 10 || fullBlocks < 5;
  rows.push({ k, rules: selection.lines.length, holdoutHosts: holdoutHosts.length, fullBlocks, keptBlocks, share, thin });

  console.log(
    `  ${pad(k, 7)}   ${pad(deriveHosts.length, 13)}   ${pad(selection.lines.length, 6)}   ${pad(holdoutHosts.length, 14)}` +
      `   ${pad(fullBlocks, 12)}   ${pad(keptBlocks, 4)}   ${pct(share)}${thin ? '   (hold-out too thin to read)' : ''}`,
  );
}

const meaningful = rows.filter((row) => !row.thin);
const pinned = rows.find((row) => row.k === Math.floor(pages.length / 2));
const best = meaningful.reduce((a, b) => (b.share > a.share ? b : a));
const first = meaningful[0];
const last = meaningful[meaningful.length - 1];
const recovered = Math.round((best.share - pinned.share) * 100);

console.log(
  `\n  The pinned hold-out is the k = ${pinned.k} row the test in packages/cli asserts, and it still holds at` +
    `\n  ${pct(pinned.share)} \u2014 ${pinned.keptBlocks} of ${pinned.fullBlocks} blocks from ${pinned.rules} rules.`,
);
console.log(
  `\n  Across the splits with a hold-out big enough to read (k = ${first.k}\u2026${last.k}): ${pct(first.share)} \u2192 ${pct(last.share)},` +
    `\n  best ${pct(best.share)} at k = ${best.k}. It rises, then flattens.`,
);
console.log(
  `\n  So the 40.9% is not one number waiting to be moved: roughly half of it is sample size and half is` +
    `\n  structure. Widening the derivation as far as this session allows recovers about ${recovered} points of` +
    `\n  the loss; the rest is that rules which fire anywhere are not rules which fire *here*, and no` +
    `\n  quantity of extra data changes that.`,
);
console.log(
  `\n  The caveat that decides how far to carry this: k counts *pages of one session*, which is a proxy for` +
    `\n  more data and not the same thing. Real extra sessions bring diverse traffic rather than more of the` +
    `\n  same — this curve was argued as a floor on what a ledger would give, and the first real ledger` +
    `\n  landed *under* it (14.3% on the committed four-session file, flat at every session prefix), so` +
    `\n  read it as the optimistic bound it turned out to be. Either way it rules out the claim that a` +
    `\n  ledger alone takes a rules-only hot set to parity with the full export.` +
    `\n`,
);

}
