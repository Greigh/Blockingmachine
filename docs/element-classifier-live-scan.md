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
*(That is the corpus as it stood after this scan. It has since grown to **222** cases
holding 212, with 5 held-out wins and 2 named regressions — the flag-10 contested cases —
and the two findings below say what moved, and neither is this scan's result.)*

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

What it did not do is close the gap the finding named. Unregularised still generalised
better on the 40 held-out cases (0.0877 against 0.1443) — the folds trained on ~62 cases and
could not see the difference. Selecting on the held-out set would make that set a fitted
quantity, so strength 1 shipped and the residual gap was recorded rather than tuned away.
The fix named for it was more labelled cases, not a better hyperparameter.

**It half worked at 162, and on 222 it did not.** At 162 the ordering had crossed on
cross-entropy — unregularised 0.4404 against the shipped 0.4234 — while unregularised was
still ahead on held-out *accuracy*, 0.9818 against 0.9455, and on Brier, 0.0776 against
0.1276. And the cross-entropy half was thinner than the number suggested: it was **one
case**, `hero-image-300x250`, where both heads are wrong and the bare fit is wrong
catastrophically. Remove it and the bare fit led on all three metrics with perfect accuracy
— the same one-case claim this project spent two rounds removing from the other comparisons,
found one level down.

Growing the corpus is what the finding asked for, and it is why the tail argument is
now gone rather than strengthened. Over the 76 held-out cases the shipped table and the bare
fit are **tied on accuracy** (0.9211 each, 70 of 76, one contested case per head), the bare
fit is **ahead on cross-entropy** (0.5171 against 0.6589), and the shipped table's only lead
is Brier by 0.0143 (0.1644 against 0.1787) — narrower than what shifting one case's confidence
is worth. The two tables disagree on **2 of 76** cases at all, in two families, one each way.
And the tail defence has reversed: the prior was introduced to keep the head off the
probability floor on cases it has not seen, and `first-party-ad-break` — an empty `<hr>` whose
class carries the word `ad` — gets **zero** probability on every accepted label from the
shipped table against a 0.0255 floor from the bare fit. Three shipped cases fall below a
tenth of the accepted mass against two. What the prior buys is a conservatively *average*
head (0.8373 accepted probability against 0.7928), which is real and modest.

Dropping that one case leaves every ordering intact, so this is not one case distorting a
picture. The conclusion is the narrow one: the choice of `priorStrength: 1` is currently
*unevidenced* rather than wrong, and 74 of the 76 held-out cases cannot tell the two tables
apart at all. `element-weights-fit.test.ts` pins all four measurements — including the two
that contradict the prior — so the record cannot drift back into claiming a win.

A second recorded claim moved with it: "no regularisation is the worst candidate"
was true on the 117-case folds (1.0929 against 0.5813) and is not now, where unregularised
scores 0.8713 and only strengths 1 (0.8017) and 2 (0.8396) beat it while 5, 10, 20 and 50
(0.9066 → 1.0643) are all worse. The folds are a weaker discriminator at the
heavy-regularisation end than they were on a smaller corpus, so the suite now asserts the
narrower true thing — the selected strength beats unregularised *and* is the best
regularised score — instead of a claim the numbers stopped supporting. For the first time
the held-out set also *agrees* with the folds about the hyperparameter: strength 1 is the
best held-out cross-entropy in the grid — strength 2 now edges it on accuracy (0.9342
against 0.9211), which says the folds' cross-entropy read, not the accuracy read, is the
one to trust. The selection still folds over training cases only, which is the point — the
held-out set must not become a fitted quantity — but the two are no longer in open
disagreement.

The last hole in the choice was that the grid only ever asked *which prior strength*. The
selection now asks *which regulariser*: `selectRegularisation` scores `none`, six prior
strengths, and an `early-stop` candidate over the same folds — the same unregularised
Adam, halted and restored to the checkpoint a carved-out inner validation slice liked
best. Early stopping is a real regulariser on this corpus (0.8580 against unregularised
0.8713, better than every prior from strength 5 up) and still loses to prior:1 (0.8017),
so the shipped table now earns its place against a measured alternative rather than only
against its own absence — the honest version of what flag 12 asked for.

**2. The action-calibration metric could not score a `leave` verdict.** `elementEvaluation.ts`
read a leave verdict's confidence as `1 − p(acting is right)`, but that confidence is a
class probability, so "84% sure this is Content" became a claim about a counterfactual
action. That is why the metric floored around 0.10, and why adding six confident leave-only
cases moved it from 0.1016 to 0.1228 **for the hand-tuned reference and the fitted head
alike** — the scale tracked corpus composition, not the weights.

`elementActionCalibrationPair` still returns `null` for a `leave` verdict where the corpus
states no requirement — its confidence is a class probability and correct restraint would
only pad the average. But a `leave` below a *required* band is a decision the model made,
and it now scores `{confidence, 0}` like any other out-of-band verdict rather than exiting
the scored set: the metric averages over **101 of 222** — every case stating an expectation
about acting, including the three must-hide cases the model answers with silence, which are
charged as errors instead of dropping out (`calibration.unacted` counts them in the report).
A `maxAction` is itself a stated expectation on the forbidden side, so a verdict above the
ceiling — a hide on a suggest-capped case — scores too (`calibration.overacted`), which is
how flag 14's two destroyed-content cases became calibration-visible. Eleven permitted-only
cases whose expected sets accept no clean read gained `minAction: 'suggest'` — the corpus
already claims they *are* threats, so restraint is not an acceptable answer — leaving 46
genuinely two-sided permitted cases unscored while they stay inside the band.
Restraint on cases requiring nothing is measured separately, by `missedHides`,
`undersoldHides` and the action mix (now `91 hide, 5 suggest, 124 leave`). On the corrected
scale the two heads are close, and the numbers are quoted against the corpus that exists
rather than the one this scan was written against: reference ECE **0.0652**, shipped
**0.0661**, a delta of +0.0009, with Brier scores of 0.0489 and 0.0491 — both heads moved
up together because both leave the same eight required cases and exceed the same two
ceilings. The regression bound
that replaced the frozen absolute bar is stated relative to that reference, which is what
the old metric's knife-edge `0.11` backstop should have been from the start.

The caveat this paragraph used to carry is closed: `sponsored-story-300x250` and
`first-party-advert-label` were the flag-14 pair — first-party copy carrying a disclosure
word that both heads hid at 98% on the container-markup rule alone. Disclosure words
(`sponsored`, `advert`, `advertising`, …) now need an independent corroborating hint —
a delivery attribute, an ad-network resource, a vendor path, a cross-origin frame — before
they can hide, and neither case carries one, so both now land on `suggest`. `destroyedContent`
is empty and `DESTROYED_CONTENT_ALLOWANCES` is deleted rather than trimmed; the third-party
cases carried by the same words still hide, their snapshots carrying the delivery
attributes a real sponsored unit ships.
