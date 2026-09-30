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

What a click *can* honestly state is the action, because that is the consequential axis:

| decision | `expected` | band | what it does not say |
|---|---|---|---|
| `keep` | `['Content']` | `min: leave`, `max: leave` | — the class follows, since "must stay visible" and "is content" are the same statement about a real element |
| `hide` | `['Ad', 'Tracker', 'Annoyance']` | `min: hide`, `max: hide` | whether it is an ad, a tracker or a nag. `expected[0]` is canonical by convention, so the note says plainly that a reviewer has to name it |

## Why candidates are not cases

The queue is written to its own artifact,
`packages/core/src/ai/data/element-harvest-candidates.json`, and **nothing that grades, fits
or calibrates imports it**. This change added no case to the graded corpus: when the
pipeline landed, `elementEvalCorpus.ts` held 117 cases with 54 of them scored for action
calibration (reference ECE 0.0346, shipped 0.0369) and the weight table not refitted. It now
holds **162** cases with **74** scored (reference ECE 0.0351, shipped 0.0377) — grown by
hand in `elementEvalCorpus.ts` and **not** by promoting anything out of this queue, which is
the separation above doing its job rather than being overtaken by it.

Promotion is a person editing the corpus. The queue helps them by marking a candidate whose
shape and action band a corpus case already pins as `promoted`, so the queue **drains** as
cases land instead of re-proposing the same shape forever.

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

- repeats of one shape on one host collapse into one candidate with a **sighting count**;
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
16 records → 10 candidates from 5 hosts
  6 labelled, 0 unlabelled · 6 repeat sightings merged
  8 already promoted · 2 awaiting review
```

The two awaiting review are worth reading, because they are the argument for the whole
exercise:

- one is the NYT's hidden `tpc-check` frame — `Tracker/hide 98%`, the file's only `hide`
  label, and the one real detection the reviewer agreed with. A corpus grown only from
  complaints would have had no idea it was worth keeping.
- one is the Guardian's own ad-named promo div — `theguardian.com/div|ad — Content/leave
  84%` — which the model already leaves alone. A verdict-scoped harvest would never have
  collected it; the reviewer's `keep` is the whole record.

**The queue has drained from 4 to 2, and the two that left are the queue working.** Both
were `div|promo` on a news site, marked `keep` by the reviewer — the publisher's own
promotion, which the model already leaves alone. A hand-written case now pins that shape
(`event-promo-card`: "a promoted thing is not a promotion"), so both candidates are reported
as `promoted` and stop being proposed. That is the intended loop end to end: a person
declines to remove an element, the case lands in the corpus, and the queue stops asking.
It is also a live demonstration of the limitation below — the NYT's `.g-promo-slim` and
`.live-updates-promo` are two different modules that share the `div|promo` signature, so
the one promoted case retires the *pair* as a single queue entry, and the drained entry
still carries two sightings.

## The limitation this found

The queue keys on the classifier's signature, and the signature is the classifier's grouping
token. Two genuinely different modules whose first ad token is the same therefore collapse
into one candidate: the NYT's `.g-promo-slim` and `.live-updates-promo` are one queue entry
with two sightings. It is recorded as open flag 6 rather than papered over, because the fix
is not obvious — a finer key would also have to be the key a *promoted case* is matched
against, or the queue would report a covered shape as still to-do.
