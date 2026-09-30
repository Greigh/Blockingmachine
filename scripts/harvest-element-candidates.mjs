#!/usr/bin/env node
/**
 * Turns harvested real elements into the corpus candidate queue.
 *
 *   npm run build --workspace=@blockingmachine/core
 *   node scripts/harvest-element-candidates.mjs                        # print the run report
 *   node scripts/harvest-element-candidates.mjs --write                 # rewrite the candidate queue
 *   node scripts/harvest-element-candidates.mjs --check                 # fail if the queue is stale
 *   node scripts/harvest-element-candidates.mjs --in ~/element-harvest.json   # add a browser export
 *
 * The element corpus is synthetic, which means it contains the shapes someone thought
 * of. `docs/element-classifier-live-scan.md` is the measurement of what that costs: 52
 * wrong actionable verdicts across five real pages, none of which the corpus could have
 * caught. So this script grows the corpus the only honest way — from elements real pages
 * actually produced — and it grows it as a **queue**, not as a corpus.
 *
 * Three things it deliberately does not do:
 *
 *  1. **It does not label anything from the model.** Every harvested record carries the
 *     class, action and confidence the shipping model gave the element; the labelling
 *     rule in `packages/core/src/ai/elementCorpusHarvest.ts` accepts a person's decision
 *     and nothing else. A candidate the model agrees with is recorded as provenance and
 *     stays unlabelled, because a corpus built from the model's own answers would grade
 *     perfectly and teach nothing.
 *  2. **It does not touch `elementEvalCorpus.ts`.** The graded corpus carries the safety
 *     pins — 54 of 117 cases scored, zero destroyed content, the relative ECE and Brier
 *     bounds — and a harvest queue is not a review. What this writes is a separate
 *     artifact that nothing in the harness imports. Promotion is a person editing the
 *     corpus, which is why a candidate already covered by a corpus case is reported as
 *     `promoted` and stops being proposed.
 *  3. **It does not look at the clock when it derives.** Age is measured against the
 *     newest capture in the inputs unless `--now` says otherwise, so the generated file
 *     is a pure function of its inputs and `--check` is a plain diff. The age of that
 *     newest capture is printed, because a queue that only describes last year's DOM is
 *     worth knowing about.
 *
 * Reads the compiled core output, so it needs a build first — same contract as the
 * element-weight fit and the vocabulary derivation.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'packages', 'core', 'dist', 'ai');
const defaultInput = join(root, 'packages', 'core', 'src', 'ai', 'data', 'element-harvest.jsonl');
const target = join(root, 'packages', 'core', 'src', 'ai', 'data', 'element-harvest-candidates.json');

const DAY_MS = 24 * 60 * 60 * 1000;

/** `--flag value` pairs (repeats kept), plus bare `--flags`. */
function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      values.set(arg, [...(values.get(arg) ?? []), next]);
      i += 1;
    } else {
      flags.add(arg);
    }
  }
  return { flags, values };
}

const { flags, values } = parseArgs(process.argv.slice(2));

if (flags.has('--help')) {
  console.log(`
Harvests real element captures into the corpus candidate queue.

  --in <file>        a harvest export to read (repeatable; defaults to the committed
                     live-scan capture in packages/core/src/ai/data/element-harvest.jsonl)
  --now <iso>        measure capture age against this instant instead of the newest capture
  --max-age <days>   drop captures older than this (default 90)
  --per-host <n>     cap candidates per host (default 3)
  --total <n>        cap the queue (default 200)
  --write            rewrite the generated candidate queue
  --check            fail if the generated queue is stale
`);
  process.exit(0);
}

async function load(module) {
  const path = join(dist, module);
  try {
    return await import(pathToFileURL(path).href);
  } catch (error) {
    console.error(`\nCould not load ${path}\n`);
    console.error('The harvest reads the compiled core package. Build it first:\n');
    console.error('  npm run build --workspace=@blockingmachine/core\n');
    console.error(`(${error instanceof Error ? error.message : String(error)})`);
    process.exit(2);
  }
}

const harvest = await load('elementCorpusHarvest.js');
const corpus = await load('elementEvalCorpus.js');
const classifier = await load('elementClassifier.js');

const { formatHarvestReport, parseHarvestFile, proposeHarvestEvalCase, selectHarvestCandidates } = harvest;
const { ELEMENT_EVAL_CORPUS } = corpus;
const { elementSignature } = classifier;

const inputs = (values.get('--in') ?? []).map((file) => resolve(file));
if (inputs.length === 0) inputs.push(defaultInput);

const report = [];
report.push('\n🌾 [Element harvest] Real elements → corpus candidates\n');

/**
 * Reads one harvest file.
 *
 * The format is JSONL with `#` comment lines — the one the extension writes on export and
 * the hub reads back — and the parser is the core one, so a file cannot mean one thing to
 * the browser and another to the corpus queue.
 */
function readRecords(file) {
  if (!existsSync(file)) {
    console.error(`\n🚨 [Element harvest] No such harvest file: ${relative(root, file)}\n`);
    process.exit(1);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`\n🚨 [Element harvest] Could not read ${relative(root, file)}\n`);
    console.error(`(${error instanceof Error ? error.message : String(error)})\n`);
    process.exit(1);
  }
  const { records, rejected, comments } = parseHarvestFile(text);
  report.push(
    `   read     ${relative(root, file)} — ${records.length} record(s)` +
      `${rejected ? `, ${rejected} unusable` : ''}${comments.length ? `, ${comments.length} comment line(s)` : ''}`,
  );
  return records;
}

const records = inputs.flatMap(readRecords);
if (records.length === 0) {
  console.error(`\n🚨 [Element harvest] No usable records in:\n   ${inputs.map((f) => relative(root, f)).join('\n   ')}\n`);
  process.exit(1);
}

const newest = records.reduce((latest, record) => Math.max(latest, record.capturedAt), 0);
const now = values.has('--now') ? Date.parse(values.get('--now')[0]) : newest;
if (!Number.isFinite(now)) {
  console.error(`\n🚨 [Element harvest] --now is not a date: ${values.get('--now')[0]}\n`);
  process.exit(1);
}

const number = (flag, fallback) => {
  if (!values.has(flag)) return fallback;
  const parsed = Number(values.get(flag)[0]);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`\n🚨 [Element harvest] ${flag} needs a non-negative number: ${values.get(flag)[0]}\n`);
    process.exit(1);
  }
  return Math.floor(parsed);
};

const selection = selectHarvestCandidates(records, {
  now,
  maxAgeDays: number('--max-age', 90),
  perHost: number('--per-host', 3),
  total: number('--total', 200),
});

report.push(formatHarvestReport(selection));
const ageDays = Math.max(0, Math.round((Date.now() - newest) / DAY_MS));
report.push(
  `   newest   capture is ${ageDays} day(s) old (${new Date(newest).toISOString().slice(0, 10)})` +
    `${values.has('--now') ? ', measured against --now' : '; age is measured against this capture'}`,
);

/**
 * A candidate whose shape and action band a corpus case already pins has been promoted:
 * it stays in the queue for provenance but is no longer something to act on.
 */
function alreadyPromoted(candidate, proposal) {
  return ELEMENT_EVAL_CORPUS.some((entry) => {
    if (elementSignature(entry.snapshot).exact !== candidate.signature) return false;
    if (entry.maxAction !== proposal.maxAction) return false;
    return (entry.minAction ?? 'leave') === (proposal.minAction ?? 'leave');
  });
}

const queue = selection.candidates.map((candidate) => {
  const proposal = proposeHarvestEvalCase(candidate);
  return {
    ...candidate,
    // `label: null` is the whole point of the artifact: nobody has ruled on this shape, so
    // there is no case to write. The model's verdict above is why it is on the list.
    case: proposal ? { ...proposal, promoted: alreadyPromoted(candidate, proposal) } : null,
  };
});

const proposals = queue.filter((entry) => entry.case);
const unpromoted = proposals.filter((entry) => entry.case && !entry.case.promoted);
report.push(
  `   cases    ${proposals.length} labelled candidate(s), ${unpromoted.length} not yet in the corpus` +
    `${proposals.length - unpromoted.length ? `, ${proposals.length - unpromoted.length} already promoted` : ''}`,
);

if (unpromoted.length > 0) {
  report.push('');
  for (const entry of unpromoted) {
    report.push(`   · ${entry.id} — ${entry.observed.elementClass}/${entry.observed.action} ${entry.observed.confidence}%`);
    report.push(`     labelled  ${entry.human.action} by a person · ${entry.sightings} sighting(s)`);
    report.push(`     proposes  ${entry.case.label} → ${entry.case.expected.join('|')} (${entry.case.minAction}–${entry.case.maxAction})`);
  }
}

const document = {
  generated: 'npm run harvest:elements -- --write',
  note: [
    'Generated from harvested real element captures. Imported by nothing that grades, fits or',
    'calibrates: the graded corpus is packages/core/src/ai/elementEvalCorpus.ts, and a candidate',
    'enters it only when a person promotes it. `human: null` means nobody has ruled on this shape,',
    'so no case may be written for it; `observed` is what the model said at capture time and is',
    'provenance, not a label. Text is truncated to what the classifier can use and no URL is kept.',
  ],
  sources: inputs.map((file) => relative(root, file).split('\\').join('/')),
  records: selection.records,
  generatedFrom: new Date(newest).toISOString(),
  graded: {
    corpus: 'packages/core/src/ai/elementEvalCorpus.ts',
    cases: ELEMENT_EVAL_CORPUS.length,
    note: 'Unchanged by this run. Nothing here feeds the weight fit, the harness or the calibration metric.',
  },
  stats: {
    hosts: selection.hosts,
    queued: selection.candidates.length,
    labelled: selection.labelled,
    unlabelled: selection.unlabelled,
    duplicates: selection.duplicates,
    stale: selection.stale,
    rejected: selection.rejected,
    capped: selection.capped,
  },
  candidates: queue,
};

const rendered = `${JSON.stringify(document, null, 2)}\n`;

report.push('');
console.log(report.join('\n'));

const unlabelledWithCase = queue.filter((entry) => entry.case && !entry.human);
if (unlabelledWithCase.length > 0) {
  console.error('\n🚨 [Element harvest] Refusing to write: a candidate without a person\'s decision has a case.');
  console.error('   A case is a claim about a real page, and the only source accepted for it is a');
  console.error('   person. Fix proposeHarvestEvalCase() rather than the artifact.\n');
  process.exit(1);
}

if (flags.has('--write')) {
  writeFileSync(target, rendered, 'utf8');
  console.log(`\n✅ [Element harvest] Wrote ${relative(root, target)}`);
  console.log('   Nothing in the graded corpus changed; review the queue and promote by hand\n');
} else if (flags.has('--check')) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (current !== rendered) {
    console.error(`\n🚨 [Element harvest] ${relative(root, target)} is stale.`);
    console.error('   Run: npm run harvest:elements\n');
    process.exit(1);
  }
  console.log(`\n✅ [Element harvest] Candidate queue matches a fresh harvest of ${selection.records} record(s)\n`);
} else {
  console.log('\nDry run — pass --write to update the candidate queue, --check to fail when it is stale.\n');
}
