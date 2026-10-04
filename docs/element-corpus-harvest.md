# Growing the element corpus from real pages

`ELEMENT_EVAL_CORPUS` is 117 shapes somebody sat down and wrote. Every one of them is a
shape somebody *thought of*, and
[`element-classifier-live-scan.md`](element-classifier-live-scan.md) is the measurement of
what that costs: running the shipping scanner over five real pages produced **52 wrong
actionable verdicts, 33 of them outright hides of things nobody wanted hidden** — Wikipedia's
own logo among them — and **not one of the offending shapes was in the corpus**.

So the corpus is now grown from real elements. This is how, and what it deliberately will
not do.

## The pipeline

| stage | where | what it does |
|---|---|---|
| capture | `packages/browser-extension/src/content/elementHarvestCapture.ts` | turns elements on the page into records |
| buffer | `packages/browser-extension/src/background/elementHarvestStore.ts` | one bounded, deduplicating buffer in the service worker |
| export | the popup's element-scan card | writes the buffer to a file, and drains it |
| readout | `packages/electron-app/src/elementHarvest.ts` | the hub reads the file the user pointed it at |
| queue | `scripts/harvest-element-candidates.mjs` | the file becomes a candidate queue |
| rules | `packages/core/src/ai/elementCorpusHarvest.ts` | selection, labelling, redaction, the file format |

```bash
npm run build --workspace=@blockingmachine/core
# in the browser: Element scan card → "Export captured elements" → blockingmachine-element-harvest-*.jsonl
npm run harvest:elements -- --in ~/Downloads/blockingmachine-element-harvest-2026-09-30.jsonl
npm run check:element-candidates        # what CI runs
```

## Two capture paths, and the difference is the point

**A page scan** records the elements the model would act on, **with no label**. They are
capped at 12 per page and sampled by confidence, because the scanner has already collapsed
nested duplicates and grouped clusters — a page with forty of the same ad slot contributes
one record. Every scan the user asks for captures; nothing captures on its own.

**A `hide`/`keep` decision** — the right-click menu on an element — records the element the
person acted on, **with that decision attached**. This is the only route by which a harvested
element ever gets a label, and it is the more valuable of the two, because a decision is
usually about something the scan never flagged. A `keep` on a shape the model already called
`Content` is invisible to any verdict-scoped harvest: nothing flagged it, so nothing queued
it, and the person is the only source that would ever have said so.

## Why a model's verdict is not a label

Every record carries what the model said: class, action, confidence. It is recorded as
**provenance** and nothing reads it as ground truth.
`proposeHarvestEvalCase(candidate)` returns `null` unless the record also carries a person's
decision.

This is the load-bearing decision in the whole change. A corpus labelled from the model's
own answers would agree with the model by construction: every accuracy, F1 and calibration
number over it would be perfect, the weight fit would move nothing, and the corpus would
look like it had grown by dozens of cases while teaching nothing at all. The suite pins the
refusal directly — an undecided capture produces no case *however confident the model was*.

What a click *can* honestly state is the action, because that is the consequential axis —
and how far it reaches is a second question the picker deliberately does not ask. A click
rules on **one element**; whether the claim covers the whole shape is the decision's
`scope`, recorded on the `human` record in the harvest file. Absent scope means
`element`, and the bands below show both:

| decision | scope | `expected` | band | what it does not say |
|---|---|---|---|---|
| `keep` | `element` (default) | `['Content']` | `max: suggest` | that the shape may never be pointed at — one element's keep forbids hiding, nothing wider |
| `keep` | `shape` | `['Content']` | `min: leave`, `max: leave` | — the class follows, since "must stay visible" and "is content" are the same statement about a real shape |
| `hide` | `element` (default) | `['Ad', 'Tracker', 'Annoyance']` | `min: suggest`, `max: hide` | that the shape must be removed everywhere — the click saw one element |
| `hide` | `shape` | `['Ad', 'Tracker', 'Annoyance']` | `min: hide`, `max: hide` | whether it is an ad, a tracker or a nag. `expected[0]` is canonical by convention, so the note says plainly that a reviewer has to name it |

`shape` scope is never inferred — not from sightings, not from confidence. It is a
reviewer's assertion that the decision generalises, recorded on the decision itself
(`"scope": "shape"` in the JSONL record) so the queue shows *why* a proposal carries a
shape-wide band. The proposal carries `harvestScope` through into the promoted case, so a
corpus entry keeps which evidence it was built from.

## Why candidates are not cases

The queue is written to its own artifact,
`packages/core/src/ai/data/element-harvest-candidates.json`, and **nothing that grades, fits
or calibrates imports it**. This change added no case to the graded corpus: when the
pipeline landed, `elementEvalCorpus.ts` held 117 cases with 54 of them scored for action
calibration (reference ECE 0.0346, shipped 0.0369) and the weight table not refitted. It now
holds **222** cases with **101** scored (reference ECE 0.0950, shipped 0.0958) — grown by
hand in `elementEvalCorpus.ts` and **not** by promoting anything out of this queue, which is
the separation above doing its job rather than being overtaken by it. (The scored count
moved because the calibration metric now also scores required-but-silent cases and ceiling
violations; see `element-classifier-live-scan.md`.)

Promotion is a person running `--promote` — not a person hand-editing the corpus, and not
the pipeline promoting itself:

```console
$ npm run harvest:elements -- --promote theguardian.com/div|promo/g-promo-slim \
    --scope element --class Annoyance          # previews the case it would write
$ npm run harvest:elements -- --promote theguardian.com/div|promo/g-promo-slim \
    --scope element --class Annoyance --write  # appends it under the marker
```

Every refusal is deliberate, because each one is a question the reviewer did not answer:

- a candidate with **no human decision** cannot promote;
- **scope must be explicit** — recorded on the decision (`"scope": "shape"` in the JSONL)
  or passed as `--scope`; a flag that disagrees with the record refuses rather than
  rewriting it, and the scope the plan used is written back onto the record;
- a `hide` decision must **name its class** (`--class Ad|Tracker|Annoyance`, repeatable or
  comma-separated) — the proposal's expected set is a placeholder by design;
- a `keep` decision refuses `--class` — "must stay visible" already fixed the class;
- a label already in the corpus file refuses a second copy.

`--write` appends the rendered case under the `// ─── Harvested promotions` marker at the
end of `ELEMENT_EVAL_CORPUS`, in the file's own `snap()`/`attr()` style — the render and
insertion are core functions the suite pins, so the write path is not a string a reviewer
trims by hand. Afterward: rebuild core (`--promote` reads the compiled corpus), run the
suite, then `npm run harvest:elements` to refresh the queue — the newly-covered candidate
reports `promoted` and stops being proposed.

A promoted case's band can only be as wide as the recorded `scope` allows, so a
single click can never land a `hide`–`hide` floor on its own. The queue helps by marking a
candidate whose shape and action band a corpus case already covers as `promoted` (the
corpus band must sit inside the proposal's, so a stronger written case still drains a
weaker claim), and the queue **drains** as cases land instead of re-proposing the same
shape forever.

## What a harvest record is allowed to hold

A record is someone's browsing, so:

- the **host** is kept and the **URL** is not — a path is personal and a corpus is not;
- rendered **text is truncated to 120 characters** on the way *in*, before the record is
  stored, so nothing on disk holds more of a page than the classifier's vocabulary reads;
- the buffer is bounded at **400 distinct shapes** and evicts **undecided shapes before
  decided ones**, because a person's decision is the most expensive thing in there to lose;
- the export **drains**, so the next file is new browsing rather than a re-send.

The file is **JSONL with `#` comment lines** — one element per line, so a half-delivered
export costs those records rather than the file. The extension writes it, the hub reads it,
and `scripts/harvest-element-candidates.mjs --in` builds the queue from it, all through the
same core parser.

## Selection

A page can hold hundreds of candidates and one site can be seen ten times a day, so the queue
is a review queue:

- repeats of one module on one host collapse into one candidate with a **sighting count** —
  and a module is keyed on the signature *plus its leading class or id*, so two shapes that
  share a token (`div|promo` as a strip and `div|promo` as a rail) stay separate entries;
- a **decision is never overwritten** by a later undecided sighting of the same shape;
- the **strongest verdict** a shape ever got is the one kept, not the most recent shrug;
- captures older than **90 days** are dropped — last year's DOM is not evidence about this
  year's web;
- **per-host and total caps** stop one noisy site filling the queue;
- undecided shapes the model wants to **leave alone** are dropped, and kept the moment a
  person rules on them;
- order is **decisions first, then sightings, then recency, then id** — stable under
  reordering, because the artifact is generated and diff-checked in CI.

Age is measured against the newest capture in the inputs, not the clock, so
`check:element-candidates` is a plain diff that does not expire. The driver's report prints
the age of that capture anyway.

## What the real capture produced

`packages/core/src/ai/data/element-harvest.jsonl` is the live scan's own capture,
transcribed — the same elements, with the verdicts the model gave them *before* the five
fixes that scan produced. Running the pipeline over it:

```
16 records → 11 candidates from 5 hosts
  11 labelled, 0 unlabelled · 5 repeat sightings merged
  6 already promoted · 5 awaiting review
```

The candidates worth reading are the argument for the whole exercise:

- one is the NYT's hidden `tpc-check` frame — `Tracker/hide 98%`, the file's only `hide`
  label, and the one real detection the reviewer agreed with. A corpus grown only from
  complaints would have had no idea it was worth keeping.
- one is the Guardian's own ad-named promo div — `theguardian.com/div|ad — Content/leave
  84%` — which the model already leaves alone. A verdict-scoped harvest would never have
  collected it; the reviewer's `keep` is the whole record.
- and three are `div|promo` keeps the queue used to merge: the NYT's `.g-promo-slim` and
  `.live-updates-promo` are now two candidates with one sighting each, and the Guardian's
  `g-promo-slim` is its own — none of them retired by `event-promo-card`, whose leading
  class (`event-promo`) is a different module than any of theirs.

**Six candidates report `promoted`; the rest await a case.** A promoted mark means a corpus
case pins the same signature, a compatible leading identifier, and a band at least as strong
as the proposal's — `corpusCaseCoversHarvestProposal`. The band containment is what keeps
the drain honest after scopes: a leave-only case still retires an element-scoped `keep`
proposal (`leave`–`suggest`), because it forbids more than the click claimed.

## The key change this produced

Candidates used to key on the signature alone — the classifier's grouping token — so two
genuinely different modules whose first ad token was the same collapsed into one entry,
and one promoted case closed the merged reviews of both. The key is now signature plus
leading identifier (`classes[0] ?? id`), and the promoted match runs on the same pair with
one fallback: a case whose snapshot names no identifier (a token carried by the tag itself,
like `amp-ad`) still covers every module under its signature. A case that names a module
closes only that module's review — which is exactly what a case covers, and nothing wider.
