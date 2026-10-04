# What the shadow log records, and why the rate is a privacy decision

The learned GBDT classifier ships in **shadow mode**: it scores every domain the Sentinel
watchdog sweep looks at and writes what it thought next to what production did, and it
never blocks, quarantines or enforces anything. That is the design, not a temporary state —
see the promotion gate in [packages/ai-training/README.md](../packages/ai-training/README.md),
where a model earns the right to act only after a human runs the gate and the gate passes.

This document is the privacy account of that log. It exists because the log is the one
place in the app where the names of things you visited are written down for the purpose of
improving a model, and "it's all local" is not an answer to "what exactly".

## Where the file is

`<userData>/learned-shadow.jsonl` — one JSON object per line, appended, never rewritten.
`<userData>` is Electron's per-user data directory:

| platform | path |
|---|---|
| macOS | `~/Library/Application Support/Blockingmachine/learned-shadow.jsonl` |
| Windows | `%APPDATA%\Blockingmachine\learned-shadow.jsonl` |
| Linux | `~/.config/Blockingmachine/learned-shadow.jsonl` |

Nothing else is written. There is no second copy, no rotation, and no upload: the file is
read by `shadow.py` and `drift.py` on the same machine, by a person, deliberately. Deleting
it costs nothing but the accumulated shadow window, and the next sweep recreates it empty.

## What one record contains

There are two shapes in the file. The **per-domain** records — disagreements and samples —
have exactly seven fields, and no more:

| field | what it is |
|---|---|
| `domain` | the hostname, e.g. `cdn.example-partner.net` |
| `learnedScore` | the model's score, 0–1 |
| `learnedDecision` | `allow`, `review` or `block` — what the model *would* have done |
| `referenceDecision` | `allow`, `review` or `block` — what production actually did |
| `allowlisted` | whether the golden-benign allowlist matched before scoring |
| `at` | ISO timestamp, shared by every record from one sweep |
| `sample` | `true` on sample records only; absent on disagreement records |

The **summary** record has five, and holds no hostname:

| field | what it is |
|---|---|
| `type` | `"summary"` — how a reader tells the two shapes apart |
| `evaluated` | domains this sweep scored, agreements included |
| `disagreements` | how many of those the model and production saw differently |
| `at` | ISO timestamp for the sweep's counters |
| `modelVersion` | the promotion version of the weights that scored it, or `null` when they have no manifest |

Both lists are not prose. They are pinned by test — `holds the documented fields and
nothing else` and `carries no hostname at all` in
[learnedShadowSampling.test.ts](../packages/electron-app/src/__tests__/learnedShadowSampling.test.ts)
assert the key set of a real record of each shape equals exactly its set, so a field added
for debugging convenience fails the suite rather than quietly widening the disclosure.

The summary is also how the promotion gate knows the app is running at all: a domain the
model and production *agreed* about is never written down, so a log of disagreements alone
cannot measure how much traffic passed through the model — and `gate.py` read `0 domains
scored` however long the app had been running. That is why the one record kind in the file
that says nothing about *which* sites you visited is the one that fills the coverage check.

## What it deliberately does not contain

- **No URL, path or query string.** A DNS log has one of these per query; the sample keeps
  the host and drops the rest. A path is personal in a way a hostname is not.
- **No client identity** — no MAC address, no hostname of the device, no LAN name. The
  watchdog's heat ledger knows which client sent a query; the shadow log is not told.
- **No page content**, no referrer, no headers, no response bodies. The classifier reads
  a hostname and nothing else, so there is nothing else to record.
- **No human-readable browsing history.** This is the line that matters: the file is not a
  log of what you did, it is a log of what a model guessed about a hostname. A hostname can
  still be sensitive — a hostname can be someone's health portal, someone's employer, or
  someone's search — which is why the rate below is a stated number and the file is local.

## The rate, and why it is 1%

`LEARNED_SHADOW_SAMPLE_RATE` in
[shadowMode.ts](../packages/core/src/ai/learned/shadowMode.ts) is **0.01**: one percent of
*all* scored domains is written as a `sample: true` record, independently of whether the
model agreed with production. The hook states it
([index.ts](../packages/electron-app/src/index.ts), `setupAiWatchdogTimer`) and
`shadowScoreWatchdogDomains` takes the rate as a **required** argument with no default,
because a default is how this went missing once already: the hook called it with two
arguments, the parameter defaulted to 0, and the drift stage failed with *"no sample records
in the shadow log"* while the app looked perfectly healthy. TypeScript now has to be told.

The two per-domain kinds of record answer different questions, and that is why both exist:

- **Disagreements** are where this model differs from the lists. Useful for finding breakage
  risk, useless for measuring the traffic distribution — a population of exceptions tells
  you nothing about what normal looks like.
- **Samples** are a random slice of *everything* scored, which is what the drift stage
  needs: PSI over production traffic against the training baseline, so a change in how
  advertisers name their infrastructure shows up before it breaks anything.

The **summary** is not a disclosure at all: it is the per-sweep arithmetic, written once per
sweep that scored at least one domain, and it is the only record the gate's coverage check
can read. Its `modelVersion` is the promotion version from
[manifest.json](../packages/core/ai-weights/README.md) when the shipped weights carry one
and `null` when they do not — which is the current state, since the shipped export predates
the promotion ceremony. `shadow.py` reports the unversioned portion of coverage beside the
total so a gate report cannot present a count as though it identified a model.

One percent is not a privacy dial set to "as low as still works". PSI bins each feature into
ten buckets and compares production proportions against the baseline, so the smallest
bucket needs enough observations to be worth comparing at all; `gate.py` is sized at
`min_shadow_days: 7` and `min_shadow_scored: 1000`. A lower rate does not make the app more
private, it makes the bin empty and the gate un-runnable — so the honest privacy answer is
"one percent, on this device, in a file you can delete", not "as little as possible". A
higher rate buys nothing the smallest bin cannot already see.

## Turning it off, and what stopping it costs

The sample slice is not a setting, and that is deliberate: a toggle would be a second place
for the rate to live, and the number in the code, the number in this document and the number
in the log have to be the same number. To stop the log entirely, stop the app from sweeping
(disable the AI watchdog in Settings), or delete the file. Deleting it resets the M5 shadow
window to zero, which means the promotion gate starts its 7 days over — it does not promote
anything on less.

## If you would rather it did not exist

That is a legitimate position and the honest answer is that the M5 drift stage would then
have no input, so the promotion gate could not run on real traffic and the model would stay
in shadow mode indefinitely. The trade is: 1% of resolved hostnames, by name, to a local
file, in exchange for a model that can be checked against reality before it is trusted to
break a site.
