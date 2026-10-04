#!/usr/bin/env node
/**
 * Turns harvested real elements into the corpus candidate queue.
 *
 *   npm run build --workspace=@blockingmachine/core
 *   node scripts/harvest-element-candidates.mjs                        # print the run report
 *   node scripts/harvest-element-candidates.mjs --write                 # rewrite the candidate queue
 *   node scripts/harvest-element-candidates.mjs --check                 # fail if the queue is stale
 *   node scripts/harvest-element-candidates.mjs --in ~/element-harvest.json   # add a browser export
 *   node scripts/harvest-element-candidates.mjs --promote <id>          # preview a promoted corpus case
 *   node scripts/harvest-element-candidates.mjs --promote <id> --write  # append it to the corpus
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
 *  2. **It does not let the queue grade itself.** The graded corpus carries the safety
 *     pins — scored coverage, zero destroyed content, the relative ECE and Brier bounds —
 *     and a harvest queue is not a review. The `--promote` mode is the review: it refuses
 *     a candidate with no human decision, requires an explicit scope the record does not
 *     already state, and makes a `hide` name its class — then writes the case under the
 *     promoted-cases marker in `elementEvalCorpus.ts` and the scope back onto the record.
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
import { parseArgvOrExit } from './argv.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'packages', 'core', 'dist', 'ai');
const defaultInput = join(root, 'packages', 'core', 'src', 'ai', 'data', 'element-harvest.jsonl');
const target = join(root, 'packages', 'core', 'src', 'ai', 'data', 'element-harvest-candidates.json');
const corpusDefault = join(root, 'packages', 'core', 'src', 'ai', 'elementEvalCorpus.ts');

const DAY_MS = 24 * 60 * 60 * 1000;

// Parsed through the shared refusing parser (scripts/argv.mjs): `--max-age` at end of argv used
// to land in `flags` and let the defaults answer instead — a named value silently replaced by 90
// days — and a flag nobody knows (`--wirte`) parsed as a flag nobody read.
const { flags, values } = parseArgvOrExit(process.argv.slice(2), {
  values: ['--in', '--now', '--max-age', '--per-host', '--total', '--promote', '--scope', '--class', '--label', '--note', '--corpus'],
  flags: ['--write', '--check', '--help'],
});

// Numeric and date flags are validated before any file is read — an unreadable value must not
// surface as a missing harvest file, because a missing file is not the mistake that was made.
for (const flag of ['--max-age', '--per-host', '--total']) {
  const text = values.get(flag)?.at(-1);
  if (text !== undefined && (!Number.isFinite(Number(text)) || Number(text) < 0)) {
    console.error(`\n🚨 [Element harvest] ${flag} needs a non-negative number: ${text}\n`);
    process.exit(1);
  }
}
if (values.has('--now') && !Number.isFinite(Date.parse(values.get('--now').at(-1)))) {
  console.error(`\n🚨 [Element harvest] --now is not a date: ${values.get('--now').at(-1)}\n`);
  process.exit(1);
}
if (values.has('--promote') && flags.has('--check')) {
  console.error('\n🚨 [Element harvest] --promote and --check answer different questions; run them separately\n');
  process.exit(1);
}

if (flags.has('--help')) {
  console.log(`
Harvests real element captures into the corpus candidate queue.

  --in <file>        a harvest export to read (repeatable; defaults to the committed
                     live-scan capture in packages/core/src/ai/data/element-harvest.jsonl)
  --now <iso>        measure capture age against this instant instead of the newest capture
  --max-age <days>   drop captures older than this (default 90)
  --per-host <n>     cap candidates per host (default 3)
  --total <n>        cap the queue (default 200)
  --promote <id>     render the corpus case a reviewed candidate promotes to
  --scope <scope>    element|shape — required at promotion when the record's
                     decision states none; must agree with it when it does
  --class <cls>      name the class a hide decision implies (repeatable or
                     comma-separated; required for hide, refused for keep)
  --label <slug>     corpus label for the promoted case (defaults to the proposal's)
  --note <text>      extra note appended to the promoted case's notes
  --corpus <file>    corpus file to append to (defaults to elementEvalCorpus.ts)
  --write            rewrite the generated candidate queue — or, with --promote,
                     append the case and write the scope back onto the record
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

const {
  formatHarvestReport,
  harvestCandidateId,
  harvestLeadingIdentifier,
  harvestProposalIsPromoted,
  parseHarvestFile,
  planHarvestPromotion,
  proposeHarvestEvalCase,
  sanitizeHarvestedElement,
  selectHarvestCandidates,
} = harvest;
const { ELEMENT_EVAL_CORPUS, insertPromotedCaseSource, renderElementEvalCaseSource } = corpus;

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

const recordsByFile = new Map(inputs.map((file) => [file, readRecords(file)]));
const records = [...recordsByFile.values()].flat();
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

const promoteId = values.get('--promote')?.at(-1);
if (promoteId !== undefined) {
  const candidate = selection.candidates.find((entry) => entry.id === promoteId);
  if (!candidate) {
    console.error(`\n🚨 [Element harvest] No candidate '${promoteId}' in the queue.`);
    const labelled = selection.candidates.filter((entry) => entry.human);
    if (labelled.length) {
      console.error('   Reviewed candidates:');
      for (const entry of labelled) console.error(`     ${entry.id}`);
    } else {
      console.error('   No candidate carries a human decision — nothing can promote.');
    }
    process.exit(1);
  }

  const classes = (values.get('--class') ?? []).flatMap((value) => value.split(',').map((part) => part.trim()));
  let plan;
  try {
    plan = planHarvestPromotion(candidate, ELEMENT_EVAL_CORPUS, {
      scope: values.get('--scope')?.at(-1),
      classes,
      label: values.get('--label')?.at(-1),
      note: values.get('--note')?.at(-1),
    });
  } catch (error) {
    console.error(`\n🚨 [Element harvest] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  const renderedCase = renderElementEvalCaseSource(plan.entry);

  if (!flags.has('--write')) {
    console.log(`\n🌾 [Element harvest] ${promoteId} promotes to:\n\n${renderedCase}\n`);
    console.log('   Dry run — pass --write to append it under the promoted-cases marker.\n');
    process.exit(0);
  }

  const corpusPath = resolve(values.get('--corpus')?.at(-1) ?? corpusDefault);
  const corpusSource = readFileSync(corpusPath, 'utf8');
  // The coverage check above runs against the compiled corpus; a second promote of the
  // same label before a rebuild would append the case twice, so the file itself is the
  // last word on whether the label is taken.
  if (corpusSource.includes(`label: '${plan.entry.label}'`)) {
    console.error(`\n🚨 [Element harvest] a case labelled '${plan.entry.label}' already exists in ${relative(root, corpusPath)}\n`);
    process.exit(1);
  }
  let corpusNext;
  try {
    corpusNext = insertPromotedCaseSource(corpusSource, renderedCase);
  } catch (error) {
    console.error(`\n🚨 [Element harvest] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  writeFileSync(corpusPath, corpusNext, 'utf8');

  // The scope the promotion asserted goes back onto the record — the file then states
  // what the promote claimed, and the queue's proposals stay consistent with the case.
  let scoped = 0;
  for (const file of recordsByFile.keys()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let changed = 0;
    const out = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return line;
      }
      const record = sanitizeHarvestedElement(parsed);
      if (!record || !parsed.human) return line;
      if (harvestCandidateId(record.host, record.signature, harvestLeadingIdentifier(record.snapshot)) !== candidate.id) {
        return line;
      }
      parsed.human.scope = plan.scope;
      changed += 1;
      return JSON.stringify(parsed);
    });
    if (changed) {
      writeFileSync(file, out.join('\n'), 'utf8');
      scoped += changed;
    }
  }

  console.log(`\n✅ [Element harvest] Appended '${plan.entry.label}' to ${relative(root, corpusPath)}`);
  console.log(`   scope '${plan.scope}' written back to ${scoped} record(s); expected: ${plan.entry.expected.join('|')} · ${plan.entry.minAction ?? 'leave'}–${plan.entry.maxAction}`);
  console.log('   Rebuild core, run the suite, then `npm run harvest:elements` to refresh the queue\n');
  process.exit(0);
}

report.push(formatHarvestReport(selection));
const ageDays = Math.max(0, Math.round((Date.now() - newest) / DAY_MS));
report.push(
  `   newest   capture is ${ageDays} day(s) old (${new Date(newest).toISOString().slice(0, 10)})` +
    `${values.has('--now') ? ', measured against --now' : '; age is measured against this capture'}`,
);

const queue = selection.candidates.map((candidate) => {
  const proposal = proposeHarvestEvalCase(candidate);
  return {
    ...candidate,
    // `label: null` is the whole point of the artifact: nobody has ruled on this shape, so
    // there is no case to write. The model's verdict above is why it is on the list.
    case: proposal
      ? { ...proposal, promoted: harvestProposalIsPromoted(candidate, proposal, ELEMENT_EVAL_CORPUS) }
      : null,
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
    report.push(
      `     labelled  ${entry.human.action} by a person · ${entry.sightings} sighting(s) · scope ${entry.human.scope ?? 'element'}`,
    );
    report.push(
      `     proposes  ${entry.case.label} → ${entry.case.expected.join('|')} (${entry.case.minAction ?? 'leave'}–${entry.case.maxAction})`,
    );
  }
}

const document = {
  generated: 'npm run harvest:elements -- --write',
  note: [
    'Generated from harvested real element captures. Imported by nothing that grades, fits or',
    'calibrates: the graded corpus is packages/core/src/ai/elementEvalCorpus.ts, and a candidate',
    'enters it only when a person promotes it. `human: null` means nobody has ruled on this shape,',
    'so no case may be written for it; `observed` is what the model said at capture time and is',
    'provenance, not a label. `human.scope` records how far a decision is claimed to reach:',
    'absent means the click ruled on one element, and only a reviewer-set `shape` scope lets a',
    'proposal pin the whole shape at hide or leave. Text is truncated to what the classifier',
    'can use and no URL is kept.',
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
  console.log('   Nothing in the graded corpus changed; promote a reviewed candidate with --promote <id>\n');
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
