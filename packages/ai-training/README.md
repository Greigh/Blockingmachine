# ai-training — M1: lexical featurizer

**Status:** M1 scaffold. Python 3.10+, standard library only, zero dependencies.

This package is the *training* half of Blockingmachine's AI core. It never
ships to users. Inference stays in TypeScript (`@blockingmachine/core`).

This is the in-repo home of the training half (`packages/ai-training/`).

## What's in the repo, and what stays local

Committed: every `*.py` source, this README, `requirements.txt`, and the
**frozen feature contract** — `bigram_table.json` (the background bigram
model `gen_ts_assets.py` needs to regenerate `featureSpec.ts`) and
`fixtures.json` (the Python/TypeScript parity vectors). `thresholds.json`
and `thresholds_v2.json` are committed as the recorded operating points.

Not committed (see `.gitignore`): `labels.db`, `observations-*.db`, the
downloaded filter lists, and every `model_artifacts*` / `model*.json` file.
Those are a few megabytes of SQLite and third-party data plus reproducible
training output, so they live on the machine that produced them. Rebuild
them with the pipeline below. The one trained artifact that *does* ship is
`packages/core/ai-weights/model.json`, which is committed deliberately as
the served weights and hash-pinned by the M5 promotion ceremony.

Consequence worth knowing: from a fresh clone, `gen_ts_assets.py` can
regenerate `featureSpec.ts` (it only needs `tokens.py` + `bigram_table.json`)
but cannot regenerate the weights or the reference scores until the
pipeline has been re-run to produce `model_artifacts/`.

## Layout

| File | Purpose |
|---|---|
| `features.py` | The featurizer. `featurize(domain) -> dict`, `featurize_vector(domain) -> list`. `FEATURE_NAMES` order is the cross-language contract. |
| `tokens.py` | `TOKEN_LIST`, `COMMON_TLDS`, `SUSPICIOUS_TLDS` (part of feature v1). |
| `bigrams.py` | Background bigram model for `bigram_anomaly`. `python bigrams.py` exports `bigram_table.json` for the TS port. |
| `make_fixtures.py` | Generates `fixtures.json` — the parity contract for the TypeScript port. |
| `test_fixtures.py` | Recomputes every fixture; fails on any mismatch. Run after any change. |
| `separability.py` | M1 exit gate: do the features separate trackers from benign domains? |

## Quick start

Run everything from this directory:

```bash
python bigrams.py          # export bigram_table.json (for the TS port later)
python make_fixtures.py    # generate fixtures.json
python test_fixtures.py    # parity check + sanity checks
python separability.py --pos-file adguard_tracking.txt --neg-file majestic.csv
```

Data sources (downloaded once, kept local): AdGuard Tracking Protection
filter (`adguard_tracking.txt`, tracker positives) and the Majestic Million
(`majestic.csv`, benign negatives). EasyPrivacy/Tranco downloads proved
flaky from here, so the script accepts local files via `--pos-file` /
`--neg-file` and still attempts the URLs as fallback.

## The contract

- `FEATURE_VERSION = 1` in `features.py`. Changing **any** feature
  definition, token list, or the bigram background sample bumps the
  version and requires regenerating `fixtures.json` and `bigram_table.json`.
- The TypeScript port must reproduce `fixtures.json` vectors within 1e-9.
  Same domain, same vector, in any language — that's what makes the
  exported model weights meaningful on both sides.

## M1 exit criteria

1. `test_fixtures.py` passes.
2. `separability.py` prints **GATE: PASS** — at least 5 features with
   |Cohen's d| > 0.5 between EasyPrivacy domains and Tranco top-10k.

## What's next (M2)

## M2: label store + first trained model — DONE (2026-09-29)

### Pipeline

```bash
python3 labels.py --pos-file adguard_tracking.txt --neg-file majestic.csv --neg-limit 10000
.venv/bin/python train.py       # LightGBM, stratified 80/10/10 split, seed 42
.venv/bin/python evaluate.py    # eval gates + importance.json + allowlist.json
.venv/bin/python export.py      # model.json (bm-gbdt/1) + verification
```

The venv (`.venv/`, LightGBM 4.7.0) is used for everything from
`train.py` onward; M1 scripts remain stdlib-only.

**Deviation from DESIGN.md:** the design calls for a time-based split,
but v1 labels carry no meaningful timestamps (list snapshots), so M2
uses a stratified random split (seed 42). Time-based splitting arrives
with M4, when daemon/crawler observations give real `observed_at` data.

### Results (v1, lexical features only)

| Metric | Value | Target |
|---|---|---|
| test average_precision | **0.9747** (n=2289) | ≥ 0.95 |
| precision@recall=0.90 | 0.9278 | ≥ 0.99 (deferred: needs behavioral features) |
| train/val/test AP | 0.9808 / 0.9767 / 0.9747 | no overfitting gap |
| exported model.json | 357.9 KB, 112 trees | < 500 KB budget |
| export verification | max diff 0.00e+00 over 500 domains | exact |

**Top features by gain:** `label_depth` (42.9k) ≫ `len` (18.6k) >
`max_label_len` > `entropy` > `bigram_anomaly`. `token_hits` contributes
little (822) — the hand-picked tracker vocabulary was weaker than
intuition suggested; the data, not the author, ranks the signals now.
`punycode` / `ip_literal` / `tld_suspicious` have zero gain (too rare
in v1 data to matter).

### Key finding: the golden set became an allowlist

11 of 67 golden benign domains (SSO logins, CDNs — `fonts.gstatic.com`
scored 0.99) look exactly like trackers *lexically*: compare
`fonts.gstatic.com` vs `cm.g.doubleclick.net` — same depth, same token
hit (`gstatic` contains "stat"), similar entropy. No lexical model can
separate them; this is a feature-coverage limit, not a tuning problem.

Resolution (product-consistent): the golden set ships as
**`model_artifacts/allowlist.json`** (`bm-allowlist/1`), checked
**before** the model scores — the same philosophy as the `@@`
whitelist rules Blockingmachine already has. The model handles the
unknown; the allowlist protects the known-critical. Behavioral features
(M3) should shrink the allowlist's load over time.

### What's next (M3)

# M3: TypeScript port + shadow mode — DONE (2026-09-29)

Scaffolded directly in a checkout of `greigh/blockingmachine`
(`~/workspace/blockingmachine/`, **not committed** — review then commit
on your side).

## What was built

**`packages/core/src/ai/learned/`** (served by `@blockingmachine/core`):
- `featureSpec.ts` — GENERATED by `gen_ts_assets.py` from `tokens.py` +
  `bigram_table.json`. Version, feature order, token/TLD lists, 1444-entry
  bigram table. Never hand-edit.
- `featurizer.ts` — exact TS port of `features.py`, including the gnarly
  bits: first-appearance-order entropy, non-overlapping token counts,
  `vowel_ratio` = vowels/alphabetic, `ip_literal` mirroring
  `ipaddress.ip_address` (strict IPv4, IPv6 with `::` + embedded IPv4).
- `gbdt.ts` — dependency-free forward pass for `bm-gbdt/1` JSON.
- `modelLoader.ts` — validates format, feature_version, and feature
  order (a reordered list throws instead of silently misrouting weights);
  allowlist checked BEFORE scoring; garbage input degrades to allow.
- `shadowMode.ts` — `runShadowComparison`: model vs production verdicts,
  disagreements to an injected sink. Runtime-agnostic.
- `index.ts` — re-exports; wired into `src/ai/index.ts` as section 9.

**`packages/core/ai-weights/`** — `model.json` + `allowlist.json` copied
from this package by `gen_ts_assets.py`; `package.json` `files` updated
so they ship with the npm package. Refresh procedure in
`ai-weights/README.md`.

**`packages/core/src/__tests__/learned-model.test.ts`** — jest parity
suite: fixture vectors, end-to-end scores, ip_literal battery, loader
validation, allowlist overrule, shadow-mode smoke.

**Electron shadow mode** — `packages/electron-app/src/learnedShadow.ts`
+ a 12-line hook in `setupAiWatchdogTimer` (`src/index.ts`): every
watchdog sweep shadow-scores all scanned domains, appending
disagreements to `<userData>/learned-shadow.jsonl`. Read-only — the
model never blocks or quarantines. Fail-soft: missing/corrupt weights
log once and disable, never break the watchdog.

## Verification (no npm install available in this environment)

- `tsc --strict` clean on `src/ai/learned/` (real TypeScript 5).
- Parity via Node 24 type-stripping over the actual sources:
  23/23 fixture vectors within 1e-9 (worst 5.3e-15),
  8/8 end-to-end P(tracker) scores **exact** (worst diff 0),
  14/14 ip_literal cases match Python's `ipaddress`.
- Perf: **0.032 ms/classify** (112 trees) — inside the 0.05 ms
  Mini-AI budget the design targeted.
- The jest suite itself needs `npm install` + `npm test` in the repo;
  run it on your side to confirm in the real toolchain.

## What's next (M4)

Daemon/crawler observations → behavioral + graph features
(`featureSpec` v2, retrain, `gen_ts_assets.py` regenerates everything),
then threshold tuning on the shadow log and the promotion gate.

# M4: behavioral + graph features (v2) — DONE (2026-09-29)

Real HTTP/TLS/DNS observations for 800 sampled domains
(400 tracker / 400 benign), collected politely (4 workers, 10 s
timeouts, identifiable UA, 200 KB body cap, no JS execution):

    .venv/bin/python crawl.py --db observations-2026-09-29.db \
        --per-class 400 --seed 42

`crawl.py` never throws on a poisoned domain (IncompleteRead and
friends are caught; partial bodies kept) — one bad host must not
kill an 800-domain run. Learned that the hard way mid-run.

## v2 schema (features2.py)

v1's 15 lexical features (positions 0–14, byte-identical) plus 8
behavioral/graph features: `redirect_count`, `fetch_error`,
`has_set_cookie`, `cookie_count`, `body_kw_hits`, `https_ok`,
`cert_free_ca`, `cname_depth`. Missing observations are **NaN, not
imputed** — LightGBM learns the missing direction per split, and the
export carries `default_left` per node so the TS port routes NaN
identically (verified exact on export).

Retrain into a separate artifacts dir (v1 stays pristine):

    .venv/bin/python train.py --features 2 \
        --observations observations-2026-09-29.db --out model_artifacts_v2
    .venv/bin/python evaluate.py --artifacts model_artifacts_v2 \
        --observations observations-2026-09-29.db
    .venv/bin/python export.py --artifacts model_artifacts_v2 \
        --observations observations-2026-09-29.db --out model_v2_experimental.json

The v2 model is **experimental evidence, not shipped**: 800 observed
domains can't carry a production retrain. It answers one question —
do behavioral features move precision@recall=0.90 toward the 0.99
target? (See results below.) The TS side is v2-ready regardless:
`featurizeLearned(domain, obs?)`, version-tolerant loader (accepts
feature_version 1 or 2), NaN routing in `evaluateGbdt`.

## Results

| model | test AP | P@R=0.90 | notes |
|---|---|---|---|
| v1 lexical | 0.9747 | 0.9278 | shipped |
| v2 +behavioral | 0.9745 | 0.9353 | 800 observed; no real lift (see below) |

**The honest finding: HTTP-level observations don't move the needle.**
On the 73 observed test domains, v2 AP is 0.9259 vs v1's 0.9326 —
indistinguishable from noise. Behavioral gain is concentrated in
`redirect_count` (14.6) and `fetch_error` (6.0); `cname_depth` had
zero variance in this sample (apex-heavy domains don't CNAME) and
`cert_free_ca` was unmeasurable from this sandbox (no direct TLS).
A tracker pixel and a benign endpoint look the same over plain HTTP:
no cookies, no redirects, 1×1 GIF. The signals that would actually
separate them — JS execution traces (canvas/font fingerprinting),
third-party request fan-out, CNAME-cloaked exfiltration — need a
real browser instrumented by the daemon, not `requests`. M4's value
is the pipeline (crawler, v2 schema with NaN-missing, `default_left`
export, TS v2-readiness), not the 800-sample model, which stays
**experimental** (`model_v2_experimental.json`, not shipped).

Operating points (v1 test set): block t=0.92 → precision **0.9902**,
recall 0.775; review t=0.65 → precision 0.9748, recall 0.866. The
shipped thresholds are deliberately conservative — 99% precision on
auto-block — and `tune_thresholds.py` documents the tradeoff curve.
Re-run it against `learned-shadow.jsonl` once the Electron app has
produced real traffic; that's the tuning that actually counts.

## What's next (M5)

Promotion gate per DESIGN.md: 7 days of shadow data, disagreement
review vs production verdicts, PSI drift checks, then a v2 model
trained on daemon-scale observations (not an 800-domain sample).

---

# M5: the promotion gate — DONE (2026-09-29)

The machinery that decides whether a trained model is allowed to block
real traffic. No silent auto-ship: a model promotes only after a human
runs the gate and the gate passes.

## The promotion ceremony

```
1. SHADOW   Electron app logs learned-shadow.jsonl for >= 7 days
            (shadowMode.ts; disagreement + 1% unbiased sample records, the
            rate the hook passes as LEARNED_SHADOW_SAMPLE_RATE — see
            docs/learned-shadow-privacy.md for what a sample record holds)
2. REVIEW   shadow.py --review-sample 120  -> review_queue.csv
            A human labels each row (reviewer_label 0/1). Breakage-risk
            rows (model=block / reference=allow) come first.
3. MERGE    active_learn.py --merge --queue reviewed.csv
            Reviewed rows enter labels.db as gold labels (weight 3.0).
4. GATE     gate.py --artifacts model_artifacts --export model.json \
              --allowlist model_artifacts/allowlist.json \
              --shadow learned-shadow.jsonl --reviews reviewed.csv \
              --baseline drift_baseline.json --out gate_report.json
            13 checks, exit 0 = PASS. A FAIL names its checks; fix the
            model or the data, not the gate.
5. PROMOTE  promote.py --candidate-dir ./candidate --weights <ai-weights> \
              --gate-report gate_report.json --confirm
            Refuses FAIL reports and hash-mismatched candidates. Archives
            the outgoing release to versions/vN/; writes manifest.json
            (SHA-256 of both artifacts). The TS loader verifies the
            manifest on startup and fails closed on mismatch.
6. ROLLBACK promote.py --weights <ai-weights> --rollback --confirm
            Restores the previous release as a NEW versioned entry
            (v3 = "rollback from v2 to v1") — the trail never has gaps.
```

Supporting tools: `drift.py` (`--export-baseline` once per trained
model, `--psi` for production-vs-training PSI; alerts at PSI > 0.2 on
top-10-importance features), `feedback.py` (Confirm-Threat / Mark-Safe
ingestion with canary + agreement anti-poisoning), `tune_thresholds.py
--shadow` (advisory operating-point check on real traffic — proxy labels
are reference verdicts, so it can only confirm the operating point
hasn't drifted, never set production thresholds).

`export.py` now stamps `trained_from_sha256` (hash of `model.txt`) into
`model.json`; the gate's `export_provenance` check verifies the exported
artifact derives from the evaluated booster, closing the
model.txt -> model.json -> manifest.json audit chain.

## What each threshold means

Defaults live in `gate.py` `DEFAULT_CONFIG` (override with `--config`):

- offline: test AP >= 0.95; **P@R=0.90 >= 0.99** (the design bar — the
  current v1 measures 0.9278, so it honestly fails); golden benign set:
  zero flips *after allowlist-first* (67/67 golden domains are protected
  by the allowlist, which decides before the model scores); artifact <=
  500 KB; feature contract match. The report also carries
  `precision_at_recall_90_allowlist_adjusted` — the same metric with the
  test rows the allowlist decides removed, i.e. "how precise the model is
  where it is actually allowed to speak". It is printed as `[info]` and
  recorded under `metrics`, **not** gated: the design bar is on the raw
  number, and whether the adjusted one justifies lowering it is the
  reviewer decision the open flag keeps open.
- shadow: >= 7 days, >= 1000 scored domains; >= 50 distinct disagreements
  reviewed (>= 30 distinct in the block direction, capped at available);
  **zero confirmed breakage** — one distinct domain where the reviewer
  calls a model-block benign is a veto. Reviewed block precision is
  reported as informational: it is measured on the hard-case disagreement
  subset, not production traffic.

  *Scored domains* come from the per-sweep `summary` records the app
  appends (`{"type": "summary", at, evaluated, disagreements,
  modelVersion}`), because a domain the model and production agreed about
  is never written down and a disagreements-only log cannot measure how
  much traffic passed through the model. The app writes one per sweep
  that scored at least one domain, and `modelVersion` is null until the
  shipped weights carry a promotion manifest — the current state. The
  count is the same either way, and `gate.py` states how much of it came
  from unversioned weights so a report cannot imply it identified a
  model. See [docs/learned-shadow-privacy.md](../../docs/learned-shadow-privacy.md).
- drift: PSI <= 0.2 on all top-10-importance features (baseline deciles +
  missing-fraction exported once per model; production = the unbiased
  sample records, never the disagreements).

## Verification (synthetic, 2026-09-29)

`synth_shadow.py` generates a learned-shadow.jsonl with the exact
Electron schema from the test set (booster scores are faithful — the TS
classifier is proven score-identical; the "reference" is the true label
+ 2% noise; the simulated reviewer is ground truth). Full chain run:

- default config: **FAIL** — `precision_at_recall_90` (0.9278 < 0.99)
  and `zero_confirmed_breakage` (6 distinct domains the model genuinely
  false-blocks at t=0.92). 11/13 checks pass. **This is the gate working
  as designed, not a bug: the v1 model does not meet the design bar.**
- relaxed config: PASS (proves the PASS branch executes end to end).
- promote: dry-run plan correct; refuses FAIL reports; refuses
  hash-mismatched candidates; tamper with model.json after install ->
  manifest hash mismatch detected; rollback v2 -> v3 with auditable note.
- drift: same-distribution traffic -> WATCH, no top-10 alerts; shifted
  traffic (all trackers) -> DRIFT with alerts on label_depth/len/
  max_label_len/entropy. Two real bugs found and fixed during
  verification: PSI binning dropped out-of-range values and assumed
  uniform baseline mass after decile dedup.
- feedback: canary trip quarantines the reporter's whole batch;
  flip-by-one-reporter waits in feedback_pending; second reporter agrees
  -> applied at weight 3.0. (Also fixed a SQLite locking bug: nested
  connections on the pending-table write path.)
- active_learn merge: 120 reviewed rows -> 87 distinct gold labels.

## Known deviations

- ~~Time-based splits from DESIGN.md §4 are not yet implemented; random
  stratified splits still in use.~~ **Fixed 2026-09-29:** `train.py` now
  splits by time per §4 (12 equal-duration buckets over the label
  store's `observed_at` span — train buckets 1–10, validate 11, test 12,
  stratified per class so a single import batch can't collapse a split).
  The current label store has zero time span (all rows share one import
  timestamp), so training loudly falls back to the seed-42 stratified
  random split and records the fallback in `test_set.json`; the time
  split activates automatically once feedback/crawler labels give
  `observed_at` real span. Retrained 2026-09-29: identical metrics
  (test AP 0.9747), confirming the fallback reproduces the old split.
- `tune_thresholds.py --shadow` is advisory only (see above).
- v2 stays experimental; nothing in M5 changes the shipped v1 weights.
  The real gate run happens after 7 days of actual Electron shadow data.
