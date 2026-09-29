# Element classifier vs. five live pages

The element corpus is synthetic. Every case was written by hand to teach a shape, which
means it encodes the shapes someone thought of. This is the result of running the shipping
scanner over real pages instead, finding where it is wrong, and fixing those cases.

## What was run

The real collection path, not a mock of it:

- `elementScanner.ts`'s candidate rule and two-pass confirm, via the extension's own
  `isCandidateElement` / `snapshotElement`, compiled from `packages/browser-extension/src`
  with the project's `tsc`.
- `MiniAiElementClassifier` from `packages/core/dist`, the shipped fitted weights.
- The page side only reads raw DOM facts (tag, id, classes, attributes, text, rect,
  computed style, ancestors) and nothing decides anything in the page: the classifier ran
  in Node over the captured facts.

Five pages, chosen to cover the disagreement between "ad-shaped" and "an ad": one docs
site, one newspaper front page, one news-heavy paper with a paywall, one developer home
page, one encyclopedia article whose title is *Tracker (file system)*.

| page | nodes | candidates classified |
|---|---|---|
| `developer.mozilla.org` (DOM docs) | 1,154 | 58 |
| `theguardian.com/international` | 4,880 | 599 |
| `github.com/blockingmachine` | 895 | 64 |
| `nytimes.com` | 2,961 | 224 |
| `en.wikipedia.org/wiki/Tracker_(file_system)` | 470 | 74 |

The harness and the capture files live in a local `live-scan/` scratch directory — deliberately not
committed, and the directory itself is ignored so a capture cannot land in the repo by accident:
`analyze.mjs` replays a capture, `probe.mjs` prints the feature vector and evidence families for one
element, `recv-0*.json` are the captures.

**Limits of the evidence.** Five pages is a sample, not a survey; it is one render of each
page, at one viewport (440×903 on GitHub, 1440×900 elsewhere), on one day. Nothing here
measures how often a real user meets these elements, so the numbers below are counts of
wrong verdicts in a sample, not rates.

## Where it was wrong

Measured on the shipped model, before any change: **109 of 1,019 classifications across
the five pages were actionable, and 52 of those were wrong** — 33 outright `hide` verdicts
on things no one wants hidden.

| # | defect | live evidence | root cause |
|---|---|---|---|
| 1 | A zero-area box read as a 1×1 beacon | MDN 5 scripts, Guardian 8 scripts + 3 photos, GitHub 5 scripts, NYT 15 scripts, Wikipedia's own logo — 33 `Tracker/hide 98%` | `isPixel` was `width <= 4 && height <= 4` on *any* tag. An unrendered `<script>`, a lazy photo and a collapsed slot all measure 0×0, and 0 ≤ 4 |
| 2 | Path-relative URLs parsed as hostnames | `src="/static/client/runtime.js"` → host `static`; `/w/load.php` → host `w` | `hostOfUrl` prefixed `https://` and stripped the leading slash, so the first path segment became a domain. `sourceKind` then read as "remote, not a CDN" |
| 3 | Framework-generated ids as ad markers | `div#_R_ad_` (GitHub's account menu) → `Ad/hide 98%` | React's id fragment `_R_ad_` is a two-atom compound whose edge is `ad`, so it satisfied the compound rule. The element is a working menu |
| 4 | Instrumentation attributes naming a Tracker | 7 footer profile links on GitHub → `Tracker/suggest` | `dataTrackerAttribute` was weighted at `+12` for Tracker, near `trackerStrongToken`'s `+13`, and it was as strong for Content at `−8`. One attribute flipped a link from Content to Tracker |
| 5 | Ad containers labelled `Tracker` | Guardian's `.top-fronts-banner-ad-container` → `Tracker/hide 80%` on `adTokens=["ad"]` | Not a policy error: defect 1's bogus `pixel-shape` family is definitive, and `impliedClassFor` maps it to Tracker, which outranks the weak ad vocabulary that was actually present. Fixed by fixing 1 |

The through-line: four of the five are **a measurement being read as a conclusion**. A
zero rect is not "1×1", a relative path is not a remote host, a generated id is not a name,
and an analytics attribute is not a tracker.

## What was deliberately not changed

- Guardian `.g-promo-slim` / NYT `.g-promo-slim` and `.live-updates-promo` modules: flagged
  by my own "ad-shaped" heuristic, and correctly left alone. They are first-party
  cross-promotion, and the model leaves them as Content.
- The Guardian's 40 DFP ad slots, `doubleclick`/`amazon-adsystem` loaders and
  `scorecardresearch` beacon: all still `Ad/hide 98%` / `Tracker/hide 98%`.
- NYT's `iframe#3pCheckIframeId` (`static01.nyt.com/ads/tpc-check.html`): still
  `Tracker/hide`, on a hidden cross-origin frame whose path says `ads`. Its declared
  `width="0" height="0"` and `display:none` are the beacon idiom.
- `.top-fronts-banner-ad-container` × 8 now report `Content 84%`, i.e. leave. The *label*
  is unlovely for a collapsed ad slot, but `leave` is the safe outcome and calling an empty
  0×0 div an ad buys nothing.

One change I made and then reverted, because the evidence contradicted the theory: I first
stopped treating an invisible element as third-party-frame evidence, on the grounds that a
zero box is not styled invisibility. The NYT frame is `display:none` with declared 0×0, so
the signal was *true* and I had suppressed a real detection. The classifier cannot tell a
duration-style `visible` from the cheap pass's rect-derived one, so the rule reads style
where it can and a zero rect is simply not used as a beacon claim.

## The fixes

| # | change | where |
|---|---|---|
| 1 | `isPixel` requires a rendered box (`area > 0`) **and** a tag that can own one (`PIXEL_SHAPED_TAGS`). `details.pixelBox` reports the measured box, so the reason string can no longer say "1×1" about a 0×0 | `elementClassifier.ts` |
| 2 | `hostOfUrl` returns `null` for path-relative references (`/x`, `./x`, `../x`, `?q`, `#f`). Protocol-relative `//cdn.example/a.js` still resolves | `elementClassifier.ts` |
| 3 | Ids matching `GENERATED_ID_LIKE` (`_R_*`, `:r3:`, `radix-*`, `mui-*`, `headlessui-*`, `downshift-*`) contribute no vocabulary at all | `elementClassifier.ts` |
| 4 | `dataTrackerAttribute` counts only on an element that is already tracker-flavoured (tracking vocabulary, measurement host, beacon or frame shape), and the prior rates it with `trackerWeakToken` instead of `trackerStrongToken` | `elementClassifier.ts` |
| 5 | The Content reason names the weak vocabulary it actually found instead of claiming there was none | `elementClassifier.ts` |

Five cases were added to the labelled corpus from these pages — a GitHub footer profile
link, the `_R_ad_` menu, GitHub's own bundle script, MDN's relative-src script, Wikipedia's
logo, a lazy Guardian photo — plus one guard case (a real 1×1 beacon *with* an analytics
attribute, still `Tracker/hide`), so the fixes are pinned by the corpus rather than by my
reading of it.

## Result

Corpus: **117/117** class-and-action correct for both the hand-tuned reference and the
fitted table; held-out 40 cases, accuracy **0.90 → 0.95**, logLoss 0.2528 → 0.1796,
Brier 0.128 → 0.0902, 2 wins and no regressions. The weights were refitted and the drift
test (`npm run check:element-weights`) confirms the checked-in table is a fresh fit.

Live pages, actionable verdicts:

| page | before | after |
|---|---|---|
| `developer.mozilla.org` | 5 | **0** |
| `theguardian.com` | 62 | **42** |
| `github.com` | 14 | **0** |
| `nytimes.com` | 26 | **11** |
| `en.wikipedia.org` | 2 | **0** |
| total | 109 | **53** |

Every remaining verdict is one of the two ad slots families, a vendor loader or the NYT
hidden frame; the 33 spurious hides are gone, and no real ad detection was lost.

## Two open findings, now closed

Both findings recorded here have since been acted on. They are kept in the record because
each one changed a number the project quotes.

**1. The prior's selection rule was measuring starvation, not value.** `selectPriorStrength`
used to choose on a *single* inner split of the training cases, which sees about half of
them, so each candidate was fitted on ~half the data it would finally see and validated on
~a quarter. At that scale an unregularised fit looked catastrophic (inner logLoss 1.18
against 0.34) and a positive strength always won — but the same unregularised fit
generalised *better* than any regularised one once trained on the whole split (held-out
logLoss 0.0877 against 0.1796). The selection was measuring the fit's starvation rather
than the prior's value.

It now folds every training case into validation (5 deterministic, class-stratified folds;
the held-out set is still untouched) and averages the held-out fold of each split. On that
scale the grid separates properly — mean fold logLoss `0` 1.0929, `1` 0.5813, `2` 0.6028,
`5` 0.6535, `10` 0.6600, `20` 0.6828, `50` 0.7020 — and the chosen strength has fallen
from 5 to **1**: the hand-tuned centre is worth one labelled element against 77, so the
corpus outweighs it about **77:1**. The change is visible in what ships: mean held-out
cross-entropy **0.1796 → 0.1443** and held-out accuracy **0.90 → 0.95**.

What it did not do is close the gap the finding named. Unregularised still generalises
better on the 40 held-out cases (0.0877 against 0.1443) — the folds train on ~62 cases and
cannot see the difference. Selecting on the held-out set would make that set a fitted
quantity, so strength 1 ships and the residual gap is recorded rather than tuned away. The
fix for it is more labelled cases, not a better hyperparameter.

**2. The action-calibration metric could not score a `leave` verdict.** `elementEvaluation.ts`
read a leave verdict's confidence as `1 − p(acting is right)`, but that confidence is a
class probability, so "84% sure this is Content" became a claim about a counterfactual
action. That is why the metric floored around 0.10, and why adding six confident leave-only
cases moved it from 0.1016 to 0.1228 **for the hand-tuned reference and the fitted head
alike** — the scale tracked corpus composition, not the weights.

`elementActionCalibrationPair` now returns `null` for a `leave` verdict, so the metric
averages over the cases where the model actually acts (**63 of 117**) and the report prints
that coverage beside the number. Restraint is measured separately, by `missedHides`,
`undersoldHides` and the action mix (`61 hide, 2 suggest, 54 leave`). On the corrected
scale the two heads are close — reference ECE 0.0424, shipped 0.0444, a delta of +0.0020 —
and the Brier scores are 0.0059 and 0.0062. The regression bound that replaced the frozen
absolute bar is stated relative to that reference, which is what the old metric's
knife-edge `0.11` backstop should have been from the start.
