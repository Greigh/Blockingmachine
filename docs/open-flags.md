# Open Flags

Flagged but unfixed work, and the decisions behind it, recorded the moment it is
flagged rather than left in conversation. An entry states why it was left, what
it would take, and how a fix could be verified. Closed entries move to the
bottom with the commit that closed them, so the list doubles as a record of
what was deferred and when it was picked up.

Nothing here is scheduled. The list exists so nothing is *relied on* silently.

---

## Open

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

- **`--residual` silently falling back to `tier_core`** — fixed in `fb7bb83` (2026-09-29). Invalid names now refuse with the valid tiers listed; the parser's post-hoc guard is gone.
- **`--json` payloads routed through the colourised logger** — fixed in `fb7bb83`. `writeJson` writes stdout untouched; `tier-plan --json` and `validate --verbose` use it; the tier-plan test parses the real stream.
- **CI not running `check:vocabulary`** — fixed in `fb7bb83`. The "Verify generated artifacts" step re-derives the vocabulary on every push.
- **Throughput test measuring the runner** — fixed in `fb7bb83`. The mini-ai batch claim now rests on cache accounting (`hits: 0, misses: 5`); wall-clock kept as a loose smoke bound.
- **Tier selection drift between the browser and the saved selection** — fixed in `6ef982e` (2026-09-30). `compareRulesetState` + the popup's `TierDriftNotice`; the dynamic half remains open as flag 1.
