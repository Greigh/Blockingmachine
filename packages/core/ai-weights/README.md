# ai-weights — learned model artifacts

Versioned weights for the learned GBDT classifier
(`@blockingmachine/core` → `src/ai/learned/`).

| File | Format | Provenance |
|---|---|---|
| `model.json` | `bm-gbdt/1` | Exported by `export.py` in the training package; LightGBM trained on 22,878 labeled domains (AdGuard tracking list positives, Majestic Million negatives). 112 trees, test average precision 0.9747. |
| `allowlist.json` | `bm-allowlist/1` | 67 hand-curated benign domains (banks, SSO, CDNs, gov/edu). Checked BEFORE the model scores — the model cannot lexically distinguish deep-subdomain benign infrastructure from trackers. |

## Refreshing

After any retrain, re-run from the training package:

```bash
cd <training-package>
.venv/bin/python export.py        # regenerates model.json
.venv/bin/python evaluate.py      # regenerates allowlist.json
.venv/bin/python gen_ts_assets.py --repo <this-repo>
```

`gen_ts_assets.py` copies both files here. The jest parity test
(`src/__tests__/learned-model.test.ts`) pins the TypeScript port to the
Python ground truth — if the artifacts and the port drift, the test
fails loudly instead of misclassifying quietly.

## Thresholds

`model.json` ships initial thresholds (`block: 0.92`, `review: 0.65`)
from offline list data. They are starting values, not gospel:
`runShadowComparison` (shadow mode) collects live disagreement evidence
so thresholds can be tuned on real traffic before the model ever
blocks anything.

Measured operating points on the held-out test set (v1 model):
block t=0.92 → precision **0.9902**, recall 0.775;
review t=0.65 → precision 0.9748, recall 0.866.
`tune_thresholds.py` in the training package recomputes the curve and
also reads `learned-shadow.jsonl` once the Electron app produces it —
prefer the shadow-log tuning over the offline numbers.

## Feature versions

The TypeScript port is forward-compatible: the loader accepts
`feature_version` **1** (lexical only, the shipped model) or **2**
(lexical + behavioral observations via `featurizeLearned(domain, obs)`
/ `classify(domain, obs)`). A v2 model scores unobserved domains with
all-NaN behavioral features, routed by each split's `default_left` —
exactly matching the Python trainer. Swapping in a v2 `model.json`
needs no code change; `gen_ts_assets.py` already emits both contracts
(`LEARNED_FEATURE_NAMES` / `LEARNED_FEATURE_NAMES_V2`).

## Packaging note

`packages/core/package.json` `files` includes `ai-weights` so the
artifacts ship with the npm package, not just the workspace checkout.
