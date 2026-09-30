# Open Flags

Flagged but unfixed work, and the decisions behind it, recorded the moment it is
flagged rather than left in conversation. An entry states why it was left, what
it would take, and how a fix could be verified. Closed entries move to the
bottom with the commit that closed them, so the list doubles as a record of
what was deferred and when it was picked up.

Nothing here is scheduled. The list exists so nothing is *relied on* silently.

---

## Open

### 6. The harvest queue keys on the classifier's signature, so two different modules that share a token collapse

- **Where:** `packages/core/src/ai/elementCorpusHarvest.ts` (`selectHarvestCandidates`, keyed on `harvestCandidateId(host, signature)`), visible in the generated `packages/core/src/ai/data/element-harvest-candidates.json`.
- **What:** A candidate is one shape on one host, and the shape is the classifier's own signature — `div|promo` for both the NYT's `.g-promo-slim` and its `.live-updates-promo`. Those are two different first-party modules, and the committed capture merges them into a single candidate with two sightings, keeping only the first record's snapshot. The live evidence is in the queue itself: `nytimes.com/div|promo — Content/leave 84%, 2 sighting(s)`. Keying more finely is not a one-line change, because the same key is what a *promoted* corpus case is matched against — a finer key that a case does not cover would report an already-pinned shape as still awaiting review, which is the more misleading of the two errors.
- **Why left:** The signature is the right key for the decision that actually matters (does a corpus case already cover this?), and the harvest is a review queue rather than a measurement, so a merged candidate costs a reviewer one glance rather than a wrong number. Choosing a second key means deciding what a corpus case covers when two shapes share a token, which is a question about the corpus rather than about the harvest.
- **Fix shape:** Key candidates on `signature` plus the leading class or id, and match promoted cases on the same pair — falling back to the bare signature when a case has no leading identifier, so a promoted case still covers the shapes it actually generalises to. Then the two NYT modules are separate entries.
- **Verify:** The committed capture queues `nytimes.com/div|promo` as two candidates with one sighting each, and a promoted case whose snapshot has no class still marks the shapes it covers.

### 7. A harvested `hide` decision is a statement about one element, and a corpus case is a statement about a shape

- **Where:** `packages/core/src/ai/elementCorpusHarvest.ts` (`proposeHarvestEvalCase`, the `hide` branch).
- **What:** Marking one element `hide` teaches the model that *that shape* is removed everywhere, and the proposal turns it into a must-hide case with the three removal classes. A person who hid a sticky newsletter modal on one site has said something true about that element and something broader about the shape, and the queue cannot tell the two apart. Promote enough such cases and the corpus grows a generalisation nobody checked. Nothing is broken today — promotion is a deliberate edit and the case note says the class is unresolved — but the note is the only guard.
- **Why left:** The alternative is a second label (`hide once`, `hide always`) which is a picker change, and a picker that asks two questions to collect one bit of evidence is a worse product than one that asks the question it can answer.
- **Fix shape:** Have the proposal record the *scope* it was derived from (`element` vs `shape`) and have promotion require an explicit scope choice; or weight a harvested must-hide case below a written one in the fit, so a queue cannot outvote the corpus.
- **Verify:** A synthetic candidate with a `hide` decision and one sighting cannot raise the must-hide count on its own; promoting it explicitly can.

### 8. The hostname calibration gates are absolute while the element ones became reference-relative

- **Where:** `packages/core/src/__tests__/ai-evaluation.test.ts:80-81` asserts `report.calibration.ece <= 0.15` and `report.calibration.brier <= 0.12` in absolute terms.
- **What:** The element calibration bounds were rewritten as margins against the hand-tuned reference (`ECE_REGRESSION_MARGIN = 0.005`, `ECE_ABSOLUTE_HEADROOM = 0.02`, both relative) when the metric was corrected in `29e7f15`, because an absolute bar on a metric whose scale moved is a bar that quietly becomes a knife-edge. The hostname gates have the same shape and have not had it: they are frozen numbers whose meaning depends on a metric definition that has changed twice in this project's history.
- **Why left:** Out of scope for the element-calibration fix, which was about the element corpus. It is recorded here rather than left in a review comment, which is the whole reason this file exists.
- **Fix shape:** Re-express both as a margin over `ELEMENT_HAND_TUNED_WEIGHTS`-style reference for the hostname model, plus an absolute headroom, the way `packages/core/src/__tests__/element-ai-evaluation.test.ts` now does.
- **Verify:** A deliberately worse weight set fails the hostname calibration suite on the margin rather than needing the absolute number to be lowered.

### 5. The calibration metric's scored set is co-extensive with the model's acting set only while the safety pins hold

- **Where:** `packages/core/src/ai/elementEvaluation.ts` (`elementActionCalibrationPair`), guarded in `packages/core/src/__tests__/element-ai-evaluation.test.ts`.
- **What:** The corrected metric scores the 54 must-hide cases the model *acts on*. If a future weight change undersold one of those to `suggest`, that case would drop out of the calibration average via the leave-exclusion exactly when it becomes a calibration error — the average would shrink and possibly improve, absorbing the regression. Not silent today: `undersoldHides`/`missedHides` are pinned empty in the same suite, so the regression fails loudly there. The residual risk is only that the calibration number itself would look healthy while the safety assertion carried the whole load.
- **Why left:** The obvious hardening (score an undersold hide as `actual: 0` even on a `leave`-flavoured minimum, or report `unscoredRegressions` beside `scored`) conflates two axes in one number; deciding between them is a metric-design call, not a bug.
- **Fix shape:** Either widen the pair to score must-hide cases on any verdict (confidence on a `leave` stays uninterpreted, so the label would need a separate convention), or add a report field counting expectations the model dodged by staying silent, asserted non-decreasing.
- **Verify:** A synthetic corpus entry with `minAction: 'hide'` that the shipped model leaves alone fails the calibration test rather than shrinking the average.

### 1. The popup reports a site pause or allowance the browser may not be enforcing

- **Where:** `packages/browser-extension/src/shared/siteControl.ts` (`deriveShieldStatus`, ~line 174), `packages/browser-extension/src/background/index.ts` (`reconcileDynamicRules`, ~line 390).
- **What:** The dynamic half has the exact defect the tier drift notice fixed. `deriveShieldStatus` reads decisions out of storage and calls the shield *Active* or *Paused* from that alone; it never asks the browser whether the corresponding DNR rules exist. `reconcileDynamicRules` compares storage against the browser and repairs a difference on every worker start, but the repair is silent — and when it fails (a quota rejection, a torn-down worker, a browser that refuses the write), the popup goes on describing a state that is not real until the worker happens to start again.
- **Why left:** Tier drift was committed first (`6ef982e`); doing the dynamic half in the same change would have doubled its surface. The repair logic (`userDecisionsAreInstalled`, `customRulesAreInstalled` in `dnrManager.ts`) already exists, so this is a reporting task, not a new comparison.
- **Fix shape:** Have `GET_SITE_CONTROL` (or a `GET_SITE_CONTROL` successor) read `dnr.installedFamilies()` and compose a drift field into `SiteControlView`, the way `RulesetStatus` now carries `drift`. Render it beside the shield status with the same show-don't-auto-repair rule: the reconcile is a button, not a side effect of opening the popup.
- **Verify:** Extension tests stubbing `getDynamicRules` to disagree with storage; the notice renders per direction (a pause that is not pausing, an allowance that is not allowing); a browser that will not answer renders unread rather than in sync.

### 2. Failed dynamic-rule applies are invisible to the user

- **Where:** `packages/browser-extension/src/background/index.ts` `applyCurrentRules` catch block, ~line 362.
- **What:** A failed `dnr.updateDynamicRules` logs `console.warn` and returns 0. The caller often cannot distinguish that from success, storage keeps the decision, and the popup reports it as applied. This is the *cause* behind flag 1 — even with drift reporting added, the moment of failure would be silent until the next reconcile.
- **Why left:** Fixing it properly (surfacing the error into the decision record, or a badge) is a design decision about where failures live, too large for a drive-by.
- **Fix shape:** Record the failure (a `lastApplyError` alongside `lastAppliedRuleCount`, or a per-decision error) and let the drift notice from flag 1 name it as the reason.
- **Verify:** A test where `updateDynamicRules` rejects: the decision is still in storage, the popup names the failure, and the next successful apply clears it.

### 3. `--shares` silently ignores tier names that are not tiers

- **Where:** `scripts/compile-tier-rulesets.mjs`, the `--shares` branch at line 886–891.
- **What:** `if (TIER_IDS.includes(tier))` drops any `--shares privacy=40` misspelling without a word, and the compile then runs on the default shares. Same class of bug as the `--residual` clobber fixed in `fb7bb83`: a value the operator named is quietly answered with something else. It is also the only remaining branch in `parseArgs` with that shape — `--residual`, `--hits`, `--attribution` and `--security` all refuse now.
- **Why left:** Deliberately deferred when `--residual` was fixed, to keep that commit about one flag.
- **Fix shape:** Refuse the whole `--shares` argument when any part names a non-tier (or a share that is not a non-negative integer), listing the valid tiers; mirror the `--residual` error wording. Add integration tests next to the `--residual` ones in `packages/browser-extension/src/__tests__/tierCompiler.test.ts`.
- **Verify:** `--shares privacyy=40` exits 1 naming the valid tiers, nothing is written; a valid mixed case (`tier_ads=60,privacy=10`) still parses; a non-numeric share is refused too.

### 4. Remaining CLI `--json` paths write through `console.log` without a pinned test

- **Where:** `packages/cli/src/commands/CoverageCommand.ts:320`, `AiCrawlCommand.ts:50`, `AiScanCommand.ts:84` and `:256`.
- **What:** These already bypass the logger, so they are not broken today — but unlike `tier-plan`, nothing pins them to stdout-parseability, so the original defect (payload routed through winston) could reintroduce itself in any of them without a failing test. `tier-plan --json` is the only command whose test parses the real stream.
- **Why left:** Four near-identical tests felt like the point where the check wants to become a shared helper rather than four copies.
- **Fix shape:** One shared stdout-capture helper (as `tierPlan.test.ts` now inlines) asserted per `--json` command; or route all four through `writeJson` and pin the writer once.
- **Verify:** Each suite parses its command's captured stdout with `JSON.parse` and asserts no ANSI bytes.

---

## Closed

- **Element calibration scoring a permitted suggest as an expected action** — fixed (this commit, 2026-09-30). The pair now states ground truth only where the corpus requires or forbids acting; re-measured at 54 of 117 cases, reference ECE 0.0346 / shipped 0.0369. The residual softness is recorded as open flag 5.
- **`--residual` silently falling back to `tier_core`** — fixed in `fb7bb83` (2026-09-29). Invalid names now refuse with the valid tiers listed; the parser's post-hoc guard is gone.
- **`--json` payloads routed through the colourised logger** — fixed in `fb7bb83`. `writeJson` writes stdout untouched; `tier-plan --json` and `validate --verbose` use it; the tier-plan test parses the real stream.
- **CI not running `check:vocabulary`** — fixed in `fb7bb83`. The "Verify generated artifacts" step re-derives the vocabulary on every push.
- **Throughput test measuring the runner** — fixed in `fb7bb83`. The mini-ai batch claim now rests on cache accounting (`hits: 0, misses: 5`); wall-clock kept as a loose smoke bound.
- **Tier selection drift between the browser and the saved selection** — fixed in `6ef982e` (2026-09-30). `compareRulesetState` + the popup's `TierDriftNotice`; the dynamic half remains open as flag 1.
