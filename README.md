<div align="center">
  <img src="https://raw.githubusercontent.com/Greigh/Blockingmachine/main/assets/Blockingmachine.png" width="160" alt="Blockingmachine Logo" />

# Blockingmachine

[![License](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/Release-v1.0.0--rc.9-orange.svg)](https://github.com/greigh/Blockingmachine/releases/tag/v1.0.0-rc.9)
[![GitHub Packages](https://img.shields.io/badge/GitHub_Packages-v1.0.0--rc.9-2ea44f.svg)](https://github.com/users/Greigh/packages?repo_name=Blockingmachine)
[![Forgejo](https://img.shields.io/badge/Forgejo-git.greighstudios.com-ff6600.svg)](https://git.greighstudios.com/greighstudios/Blockingmachine)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24.0.0-339933.svg)](https://nodejs.org/)
[![Built with Electron](https://img.shields.io/badge/Built%20with-Electron%2044-47848F.svg)](https://www.electronjs.org/)
[![Written in TypeScript](https://img.shields.io/badge/Written%20in-TypeScript%205.8-3178C6.svg)](https://www.typescriptlang.org/)
[![Tests](<https://img.shields.io/badge/Tests-2%2C900%2B%20Passing%20(100%25)-brightgreen.svg>)](https://github.com/greigh/Blockingmachine/actions/workflows/ci.yml)
[![CI](https://github.com/greigh/Blockingmachine/actions/workflows/ci.yml/badge.svg)](https://github.com/greigh/Blockingmachine/actions/workflows/ci.yml)
[![CodeQL Analysis](https://github.com/greigh/Blockingmachine/actions/workflows/codeql.yml/badge.svg)](https://github.com/greigh/Blockingmachine/actions/workflows/codeql.yml)
[![HACS Validation](https://github.com/greigh/Blockingmachine/actions/workflows/hacs-validation.yml/badge.svg)](https://github.com/greigh/Blockingmachine/actions/workflows/hacs-validation.yml)
[![Security Policy](https://img.shields.io/badge/Security_Policy-Active-green.svg)](SECURITY.md)

_A modern network defense suite and filter list compiler for AdGuard, uBlock Origin & EasyList. Features an Electron desktop app, MV3 extension, loopback DNS daemon, Home Assistant hub, an iOS/Android companion app, and embedded Mini-AI classification with intelligent rule deduplication, multi-format exports, and 100% local processing._

</div>

---

## Overview

**Blockingmachine** is a unified, privacy-first network defense ecosystem engineered to compile high-speed adblock and DNS filter lists, synchronize homelab sinkholes, detect zero-day ad trackers with on-device machine intelligence, and enforce system-wide and in-browser blocking with sub-microsecond latency.

Designed for network engineers, homelab operators, and privacy advocates, Blockingmachine processes millions of filter rules in milliseconds, eliminates redundant subdomains via hierarchical suffix trees, runs procedural anti-circumvention scriptlets, and integrates natively with Home Assistant.

### Monorepo Workspaces

- **Desktop Application (`@blockingmachine/electron-app`)**: Native macOS/Linux/Windows Electron suite featuring the **Unified Rule & AI Inspector**, **AI Defense Radar**, **Deploy & Sync Hub**, **Curated Defense Modules**, and **Compiled Rule Browser**.
- **Browser Extension (`@blockingmachine/browser-extension`)**: High-performance Manifest V3 extension featuring dynamic `declarativeNetRequest` (DNR) compilation, procedural anti-adblock scriptlet defusers (Admiral, Google Funding Choices), in-page visual **ElementPicker**, and live AI Radar inspection.
- **System DNS Daemon (`@blockingmachine/system-daemon`)**: High-throughput loopback UDP/TCP DNS proxy on port 53/5353, powered by an in-memory reversed-label suffix trie for sub-microsecond $O(k)$ rule lookups, `$important` precedence resolution, upstream DNS-over-HTTPS (Quad9 default), and a local HTTP control API (`127.0.0.1:9292`).
- **Core Engine (`@blockingmachine/core`)**: Zero-dependency rule parsing engine, hierarchy-aware subdomain deduplicator, multi-format export compiler, Shannon entropy analyzer, CNAME uncloaking resolver, and embedded Mini-AI classification neural model.
- **Command Line Interface (`@blockingmachine/cli`)**: Autonomous CLI binary (`blockingmachine`) for CI/CD pipelines, automated homelab cron tasks, local feed serving, diffing, and DNS diagnostics.
- **Home Assistant Hub (`@blockingmachine/homeassistant-addon` & integration)**: HACS-compliant Home Assistant integration and local Add-on container providing a bidirectional telemetry mesh (`sensor.blockingmachine_browser_*`), live rule distribution via Server-Sent Events (`/v1/events`), and remote cosmetic shield toggles. The add-on also serves a **Shadowrocket rule set** at `/shadowrocket.conf`, so a phone can subscribe to the add-on rather than to a desktop hub that has to be awake — the usual reason a rule set stops arriving. It is rendered from the same DNS feed as the Unbound drop-in, and both feeds share one rule-to-host parser, so a domain sinkholed in the resolver is the domain the phone blocks.
- **Mobile Companion (`@blockingmachine/mobile`)**: React Native (Expo) iOS/Android remote control for the hub's `/v1/*` API — the same contract the HA integration speaks. Reads live status over SSE, toggles protection, checks domains against the compiled list, triggers compiles, and watches browser telemetry. Pairs three ways: QR scan, mDNS discovery of the hub's `_blockingmachine._tcp` advertisement, or manual entry; the feed token lives in the device keychain.
- **Audit & Database Layer (`blockingmachine-database`)**: Offline JSONL and MongoDB audit logging and rule snapshot rollback engine.

---

## 📦 Downloads & Installation

### Desktop Application (macOS Apple Silicon)

The latest pre-release desktop application is cryptographically signed with an Apple Developer ID (`Greigh Studios LLC (365KR8NF53)`):

| Package / Installer                        | Architecture                | Download                                                                                                                               |
| ------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Apple Silicon Disk Image (`.dmg`)**      | macOS `arm64` (M1/M2/M3/M4) | [Download `.dmg`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.9/Blockingmachine-1.0.0-rc.9-arm64.dmg)        |
| **Standalone Application Bundle (`.zip`)** | macOS `arm64` (M1/M2/M3/M4) | [Download `.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.9/Blockingmachine-darwin-arm64-1.0.0-rc.9.zip) |
| **SHA-256 Checksums**                      | All Platforms               | [Download `SHA256SUMS.txt`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.9/SHA256SUMS.txt)                    |

### Mobile Companion (Android)

The signed Android APK is published on the Forgejo generic package registry:

| Package / Installer | Platform | Download |
| ------------------- | -------- | -------- |
| **Android APK** (`.apk`) | Android 7.0+ (`minSdk 24`) | [Download `app-release.apk`](https://git.greighstudios.com/api/packages/greighstudios/generic/blockingmachine-mobile/1.0.0-rc.9/app-release.apk) |

Built from `packages/mobile` with `expo prebuild` + `./gradlew assembleRelease`. The iOS build goes through the same Expo dev-client flow; an App Store/TestFlight artifact is not published yet.

#### Checksum Verification

```bash
shasum -a 256 -c SHA256SUMS.txt
```

---

### NPM Packages

Blockingmachine distributes its core parsing engine and command-line interface as standalone packages on **npmjs.com**, **GitHub Packages**, and **Forgejo Packages**:

#### From npmjs.com (Public)

```bash
# Core Library
npm install @blockingmachine/core

# CLI Tool
npm install -g @blockingmachine/cli
```

#### From GitHub Packages

```bash
# Core Library
npm install @greigh/blockingmachine-core@1.0.0-rc.9 --registry=https://npm.pkg.github.com

# CLI Tool
npm install -g @greigh/blockingmachine-cli@1.0.0-rc.9 --registry=https://npm.pkg.github.com
```

#### From Forgejo Package Registry (`git.greighstudios.com`)

```bash
# Core Library
npm install @blockingmachine/core@1.0.0-rc.9 --registry=https://git.greighstudios.com/api/packages/greighstudios/npm/

# CLI Tool
npm install -g @blockingmachine/cli@1.0.0-rc.9 --registry=https://git.greighstudios.com/api/packages/greighstudios/npm/
```

Direct tarballs are also attached to [Release v1.0.0-rc.9](https://github.com/Greigh/Blockingmachine/releases/tag/v1.0.0-rc.9):

- `blockingmachine-core-1.0.0-rc.9.tgz`
- `blockingmachine-cli-1.0.0-rc.9.tgz`

---

## Key Features

### 🔍 Unified Rule & AI Inspector (`⌘5`)

- **Simultaneous Static & AI Evaluation**: Instantly assesses any domain or URL against your active compiled filter lists while simultaneously running live AI threat heuristics.
- **Heuristic Threat Profiling**: Measures lexical Shannon entropy ($H(X)$), detects algorithmic Domain Generation Algorithms (DGA), resolves multi-hop CNAME cloaking aliases, and breaks down mathematical feature weights.
- **Multi-Format Rule Synthesizer**: Generates syntax-perfect blocking rules in Universal (`||domain^`), AdGuard (`||domain^$important`), Pi-hole regex, uBlock Origin, Unbound, or Hosts format.
- **$badfilter Neutralization**: Automatically generates `$badfilter` exception syntax to neutralize upstream false positives and erroneous filter rules without altering third-party feeds.
- **1-Click Actions**: One-click **Add to Custom Rules**, **Whitelist (`@@`)**, rule clipboard copying, and Mini-AI feedback tuning (_Confirm Threat_ / _Mark Safe_).

### 📡 AI Defense Radar Hub (`⌘9`)

- **Sinkhole Query Scout**: Connects directly to AdGuard Home or Pi-hole to inspect recent DNS query logs for anomalous, uncategorized ad beacons and tracking telemetry.
- **Behavioral Stream Analysis**: Goes beyond lexical classification by analyzing *how* hostnames behave on your network — detecting periodic low-jitter **beaconing cadence** (machine-like telemetry check-ins) and **coordinated fan-out** (the same domain queried by multiple devices), then escalating risk when either corroborates a flagged verdict.
- **Persistent Radar Heat Map**: Remembers repeat offenders across watchdog sweeps with time-decayed heat scores, resolves zone-wide threat correlations (a flag on `ads.evil.com` warms `cdn.evil.com`), and drives an **adaptive watchdog cadence** that tightens sweeps under high threat pressure and stretches them on quiet networks. The AI Radar's **Top Repeat Offenders** card surfaces the hottest domains with per-domain flag counts, relative last-seen times, and one-click block / allowlist / inspect actions (allowlisting also clears the domain's zone heat). Offenders can also be **ignored** — a distinct "hide, don't trust" action that removes a domain (and its zone) from the list without creating any allowlist rule or whitelist feedback: scans and verdicts continue, heat is frozen instead of decayed, and hidden domains are restorable anytime from the collapsible Ignored section — or surfaced permanently inline via the **"Show ignored offenders inline"** preference in Settings → AI Engine (power-user browsing aid, applied live to any open Radar view).
- **Subdomain Compaction Engine**: Collapses swarms of ephemeral subdomains into clean parent zone wildcard rules to prevent list bloat.
- **Web Canary Crawler**: Proactively crawls target URLs to audit and extract third-party trackers, beacons, and programmatic ad auctions before you visit them — filtering out the site's own first-party hosts and rules you already block so every result is actionable.
- **Threat Quarantine Ledger**: Centralized persistent ledger tracking intercepted threats with category filtering, batch exports (ABP, Hosts, JSON), and one-click firewall blocking.

### 🧠 Centralized AI Engine & Sentinel Watchdog (Preferences `⌘,`)

- **Built-in Mini-AI Classifier (Default & Recommended)**: Embedded 25-feature mathematical neural classifier executing on-device in **<0.05ms** with zero daemons, zero cloud telemetry, and zero network overhead.
- **Learned GBDT Classifier (Offline-Trained, On-Device, Shadow Mode)**: A second, *learned* model that exists to generalize **beyond the filter lists** — catching zero-day trackers no list contains yet. The prime directive is *Python trains, TypeScript serves*: all training, evaluation and export live in [packages/ai-training](packages/ai-training) (Python, never shipped), and all serving is a dependency-free forward pass in [packages/core/src/ai/learned](packages/core/src/ai/learned) — 112 trees from a 366 KB `bm-gbdt/1` artifact, **0.032 ms/classify**, inside the same 0.05 ms on-device budget as the Mini-AI. Trained on **22,932 labeled domains** (12,976 AdGuard tracking positives, 9,956 Majestic Million negatives): held-out **average precision 0.9747 against a ≥0.95 target**.

  **It does not pass the promotion gate, and that is the gate working.** 11 of 13 checks pass; it fails `precision_at_recall_90` (**0.9278 against the 0.99 design bar**) and `zero_confirmed_breakage` (6 distinct domains it genuinely false-blocks). The bar is not lowered to make it pass — a missed tracker is invisible, a broken site is an uninstall. So the model ships in **shadow mode only**: it scores every Sentinel watchdog sweep and logs disagreements to `learned-shadow.jsonl`, and it never blocks, quarantines or enforces anything until a human has reviewed real traffic and a human-run gate passes. One confirmed broken domain is a veto.

  **The shadow log also carries a 1% random sample of ordinary traffic, and that is the one place the app writes down the names of things you visited.** Disagreements alone are a biased population — they are the domains where this model happens to differ from the lists — so the M5 drift stage (PSI over production traffic against the training baseline) reads a sample of *everything* scored instead, independently of whether the model agreed. A sample record is seven fields: hostname, the model's score and decision, the production decision, whether the allowlist matched, and a timestamp. No URL or path, no client identity, no page content, and nothing is ever transmitted — the file lives in the app's data directory and is read offline by the training scripts. The rate is one named constant (`LEARNED_SHADOW_SAMPLE_RATE`) that the watchdog hook has to pass explicitly, because a defaulted one is how the drift stage ended up with an empty log and a healthy-looking app. Full account in [docs/learned-shadow-privacy.md](docs/learned-shadow-privacy.md); the field list there is pinned by test, so a field added for convenience fails the suite.

  The most instructive result is that the golden benign set **had to become an allowlist**. 11 of 67 hand-curated benign domains (SSO logins, CDNs — `fonts.gstatic.com` scores 0.99) look exactly like trackers *lexically*: compare it with `cm.g.doubleclick.net` — same depth, same token hit, similar entropy. No lexical model can separate them, so the fix is structural rather than a tuning patch: [ai-weights/allowlist.json](packages/core/ai-weights) (67 domains) is checked **before the model scores**, the same philosophy as the existing `@@` whitelist rules. That is a feature-coverage limit stated honestly, not a threshold to nudge. The v2 behavioral features are the corresponding honest negative: HTTP-level observations (redirects, cookies, TLS) produced **no real lift** (test AP 0.9745 vs 0.9747), because a tracker pixel and a benign endpoint look identical over plain HTTP — the signals that would separate them need JS-execution traces from the daemon. v2 stays experimental and unshipped. The loader validates format, `feature_version` **and feature order** (a reordered list throws instead of silently misrouting weights), and the model **never fails open into blocking**: missing or mismatched weights mean lists-only mode.
- **Second AI Surface — On-Device DOM Element Classifier**: The same embedded engine now classifies **page elements**, not just hostnames, labelling each candidate *Ad*, *Tracker*, *Annoyance* or *Content*. Verdicts are built from independent evidence families (ad markup, ad delivery attributes, ad-network sources, ad ancestors, tracking-pixel geometry, consent/nag markers, social embeds, overlay shape, ad-like sizes, third-party frames) and then **gated by corroboration**: definitive evidence hides (98%), two independent signals hide (84%), one non-shape signal can only *suggest*, and **shape alone never names anything** — a 300×250 rectangle, a third-party frame or the word `banner` is never a fact on its own. A content shield means it never destroys article copy: long text with no definitive evidence is left alone, and an anti-adblock wall is only suggested. Its identifier tokenizer splits camelCase and punctuation, so `admonition`, `adapter`, `download`, `header` and `admin` are never misread as `ad`. The model's **statistical head is fit from the corpus rather than hand-written** (`src/ai/elementWeightFitting.ts`, regenerated with `npm run fit:element-weights`): full-batch Adam on soft-target cross-entropy, with the original hand-tuned table kept as the *centre of a Gaussian prior* — which is what makes fitting 104 parameters from 145 elements safe rather than absurd, and what lets the fit be compared against the thing it replaced. On a deterministic 145/75 stratified split the fit never sees the held-out cases and still beats the reference on all three head metrics: **accuracy 0.88 → 0.9467, cross-entropy 1.0077 → 0.6804, Brier 0.2634 → 0.1488, five cases won and none given up**. Brier is the one that matters most, being a proper scoring rule on the full label distribution — it cannot be improved by getting more confident without getting more right. The one hyperparameter that matters (prior strength) is selected by *5-fold cross-validation over the training cases* — a single inner split measured the fit's starvation rather than the prior's value, and replacing it moved the chosen strength from 5 to **1** — the fit beats the reference on both proper scoring rules across the entire prior grid from 1 to 50, and cross-validation picks a real prior strength over no prior (mean fold logLoss 0.7702 at strength 1 against 0.8518 unregularised) — though not over *every* strength, since at this corpus size 5, 10, 20 and 50 are all worse than no prior at all, and the suite states the narrower claim the numbers support. A test re-fits the table in-process and fails if the checked-in numbers drift from the corpus, naming the offending weight.

What the fit cost is recorded beside what it bought: a sharper head is better at ranking and slightly less conservative in the confidence it reports, so action-level ECE moves **0.0499 → 0.0509** and Brier **0.0113 → 0.0115** on the cases the metric scores. Getting that number to mean anything required fixing the metric twice — the old form read a `leave` verdict's *class* confidence as a probability that acting would have been right, and it read every case the corpus merely *permitted* acting on as ground truth that acting happened, so a permitted suggest was scored as an expected one and overconfidence on exactly those cases went unmeasured. It now averages only the **85 of 220** cases that state an expectation about acting — hiding required (`minAction`) or forbidden (`maxAction: 'leave'`) — restraint is measured by `missedHides` and the action mix, and the guarantee is stated as a regression bound against the hand-tuned reference. Measured on a **220-case** labelled corpus: **96.4% class accuracy (212/220), macro F1 0.877** — with the eight residual failures each named in the suite rather than absorbed into a tolerance. Growing the corpus from 67 cases is what found four rules that were wrong rather than merely untested. The *tag* was never part of the identifier vocabulary, so `<amp-ad>` — an element that exists to serve ads — was read as nothing but a 300×250 rectangle. A compound class scored exactly the same as a bare one, so `class="video-ad"` was only ever suggested while `adunit` hid outright; a compound identifier that **leads or ends** with `ad`/`ads` now names an ad, and position is the guard, because `no-ads-subscription` names an upsell rather than an ad. Push-notification prompts had no marker at all, so a pinned OneSignal opt-in was reported as page copy. And the destructive one: the article-length shield was bypassed by *any* vocabulary match, so `#advertising-policy` and a `sponsored-article-body` were **hidden at 98%, prose and all** — a page about advertising wears the same class word as an ad slot. Only a resource the page cannot be made of (an ad delivery attribute, an ad-network frame) can now overrule long-form prose, and a pinned overlay is exempt from the shield, because a modal is not the page it covers. Growing the corpus from real page shapes is now the standing method rather than the exception: at 117 cases every disagreement between the fitted head and the hand-tuned one was a `Content` case, so "two wins, zero regressions" was really "two cases, and 22 others where no head could fail". Round three added 45 labelled cases — a fingerprinting library on a public CDN, a privacy panel whose own text says "analytics and advertising", the retailer's own summer sale, a scheduler frame the page cannot work without, a 1×1 spacer that is not a beacon because it is loaded from the page's own path — taking the corpus to **162** and the held-out win to **six cases against one given up**, and it found five more defects a synthetic corpus had not: `track` was in the URL-path vocabulary, so `/embed/track/<id>` named an annoyance and **hid an embedded music player at 62%**; Mixpanel's library is served from `cdn.mxpnl.com`, so the `mixpanel.com` host entry never fired for the loader that is on the page; `newsletter-slidein`, `app-install` and `exit-intent` were missing from the nag markers; and the rule that suppresses path evidence on a CDN — right for `chart.js` — made a fingerprinting script on jsDelivr invisible, because the one table was mixing ordinary words with vendor product names. That last one is still a documented blind spot at the class level (`fingerprintjs-on-public-cdn`, the single held-out case the fit gives up) and is named in the suite rather than absorbed into a tolerance. Round four added 60 more, written the same way — ad-shaped geometry that is the page's own, first-party measurement that a rule cannot tell from a third party's, nags in places a modal detector does not look, and chrome the page genuinely needs — taking the corpus to **220**. Twenty-four of the sixty failed on arrival, and that is the method working: an `<hr>` whose class carries the word `ad` was being **hidden at 98%**, so a bare ad token is no longer definitive without geometry behind it, and `ad-marker` plus `ad-weak-marker` on one identifier now counts as the single hint it is rather than two. Seventeen labels moved as a result, each saying so in its own case note, because a disagreement is evidence about the *label* and not automatically about the model. Two of the new cases are ones both heads still destroy — first-party copy carrying the word "sponsored" or "advert" — which is open flag 14 and the most consequential thing the evaluation now reports. The round was commissioned to make the prior's cost measurable rather than arguable, and the measurement does not flatter it: over the 75 held-out cases the shipped table and the unregularised fit **tie on accuracy** at 0.9467 from one contested case each, the unregularised fit is **ahead on cross-entropy** (0.5231 against 0.6804), and the shipped table's only lead is a Brier margin narrower than one case. The tail argument has reversed too — the prior exists to keep the head off the probability floor on unseen cases, and the shipped head is the one that reaches it — so the module note and the suite now say the choice is *unevidenced rather than wrong* instead of claiming a win. What did not change is the real limit: Ad (14 held out) and Tracker (12) are still at 1.0 for both heads, so 26 of 75 cases are evidence of nothing, and writing ten first-party measurement cases made Tracker larger without making it contested. A case a rule already handles grows the corpus and tells you nothing about the weights. That is open flag 10, and the assertions that pin the saturation are written to fail the day it stops being true. Running the shipping scanner over five live pages (MDN, the Guardian front page, github.com, nytimes.com, Wikipedia) had already found five more defects a synthetic corpus had not — a zero-area box read as a 1×1 beacon (33 hides, including Wikipedia's own logo), a path-relative URL parsed as a hostname, a React-generated id named `ad`, and an analytics attribute weighted as strongly as the word `tracker` — and took actionable verdicts on those pages from **109 to 53** with every real detection kept. That finding is also the reason the corpus can now grow from real pages instead of from guesswork: page scans and your own `hide`/`keep` decisions about an element also **capture the elements they saw** (`docs/element-corpus-harvest.md`), the popup exports that buffer as a file, and `npm run harvest:elements` turns the file into a queue of **candidates**. A queue is not a corpus. Harvested elements are never graded and never refit the weights on their own — a candidate is labelled only by a decision a person made about a real element, because a label taken from the model's own verdict would make every number perfect and every number meaningless. Promoting a candidate into `elementEvalCorpus.ts` stays a deliberate act, and the queue marks the ones already promoted so it drains itself as cases land.
- **Evidence-Backed Impersonation Detection**: A brand name alone never triggers a malware verdict. Impersonation requires a second, independent signal — a credential lure (`apple-login.xyz`), a pseudo-TLD (`paypal-com.net`), an untrusted hosting platform (`paypal.workers.dev`), a high-abuse TLD, punycode, or an actual typosquat edit. That keeps real phishing caught while clearing the two big false-positive classes in ordinary DNS traffic: **vendor names used as hostname labels on other vendors' infrastructure** (e.g. `akamai.external.web.us-east-1.prod.diagnostic.networking.aws.dev`) and **brand names that are simply ordinary English words, their inflections, or hostname indices** (`max.`, `meta.`, `target.`, `discover.`, `bookings.`, `railways.`, `outlooks.`, `ups1.`, `zoom2.`, `netflix1.`). Leetspeak typosquats (`paypa1`, `g00gle`, `app1e`) still match, because those *replace* a letter and preserve length while an appended index does not. AWS-owned zones (`aws.dev`, `on.aws`) are registered as verified infrastructure, and the project's own `unbreak` allowlist is asserted never to produce a malware verdict.
- **Calibrated Entropy Engine**: Multi-tiered Shannon entropy scoring with base64 anomaly detection, segment decomposition, and bigram transition scoring.
- **Flexible Provider Support**:
  - **Local Heuristics**: Pure offline Shannon entropy, token decomposition, and CNAME uncloaking.
  - **Ollama Local LLM**: Air-gapped on-device neural models (`llama3.2`, `mistral`, `qwen2.5`, `deepseek-r1`).
  - **Google Gemini Flash**: Deep pattern reasoning via Gemini 2.0 Flash.
  - **OpenAI / Custom Server**: Full compatibility with OpenAI, Groq, LM Studio, OpenRouter, and custom endpoints.
- **Triage Cascade — Screen Everything, Escalate Only the Undecided**: Every mainstream blocker picks one inference engine and points it at everything, so enabling a model means paying for a model call per candidate. That fork is precisely where AdGuard's own LLM research hit the wall (*"a webpage has thousands of elements, and analyzing all of them would be slow and expensive"*), which is why their model only ever sees elements a filter list already flagged. This app inverts it: the embedded classifier — free, offline, ~0.05ms — screens **every** candidate, and `provider` becomes the *escalation backend* for the ones it cannot defend. Escalation targets **ambiguity, not risk**: a confidently-malicious host is trivially decidable and never spends budget, while a near-tie in the class distribution, the classifier's own `suspicious` bucket, conflicting feature contributions, or a clean verdict at 88% when recognised clean traffic reports ~99% are all worth a second opinion. The budget is **ranked and capped** (ambiguity first, then stakes, then a total tiebreak so the allocation never depends on query-log ordering), shared across a whole scan rather than granted per domain, and a candidate over budget is recorded as *deferred* with its local verdict intact — a cascade degrades into the local classifier, never into a gap. A tiebreaker also **cannot clear a verdict resting on name-based evidence**: if a model recommends allowing a hostname that a curated network lookup or CNAME uncloak flagged, the block stands and the disagreement is recorded as *contested*.
  - Measured against the classifiers' own corpora: **0% escalation** on the 205-case hostname corpus and the 110-case element corpus — the cascade costs nothing where the local model is already decisive.
  - Where it earns its keep: on the 6 `list-dependent` hostnames (ordinary-looking names like `comscore.com` whose meaning only a list can know), the local screen silently passes **5 of 6** and plain screening catches **0**. Clean-traffic discovery mode escalates 4 of them and catches **4 of 5**.
  - The honest limit, pinned by a test so it cannot be quietly overstated: the cascade escalates *uncertainty*, not *knowledge gaps*. A confidently-wrong verdict carries no signal to trip — `bat.bing.com` is called clean at 99% and no triage rule reaches it. That case is a coverage problem, not a model problem.
  - **The results list shows the cascade per row**, because a verdict on its own cannot answer the question the cascade was built for: was a model asked? Each row carries its outcome — screened locally, escalated, contested, deferred — with the ambiguity score that produced it, toned against the bar the engine actually escalates on, and the engine's own per-signal sentences one hover away. A row with no cascade record gets **no chip at all** rather than a greyed-out zero, since no record is not a decision.
  - The header separates the two reasons a record can be missing, because they mean opposite things. The **false-positive guard** returns before the screening pass, so an infrastructure or allowlisted domain is clean with no record while the cascade is running perfectly — measured on a `.example` sample, 4 of 9 rows and 39 of 42 in a second run. Reporting those as "not screened" would describe a deliberate skip as a coverage gap, so they are counted as *cleared before screening* and the remaining unrecorded rows are named separately, from the guard's own `falsePositiveGuard` record rather than from the sentence it appends to `reasons` — the CLI's report says the same thing, so the two readers cannot drift apart.
  - Reachability of the four buckets, measured rather than assumed: driving 51 hostnames through the real engine produced `screened-locally`, `escalated` and `deferred`, and no contested — because a non-clean verdict backed by name-based evidence has its ambiguity zeroed and never escalates, leaving *contested* to the narrow case of name-based evidence with conflicting feature contributions. That window is now **pinned by a test** rather than left as something read off the source: the suite asserts the assessment is ambiguous for exactly that combination and that the merge then records `contested`, so the rarest bucket in the list is a path this repo checks instead of a label nobody has seen.
- **Active Feedback Memory**: Tracks user corrections to refine heuristic weights over time, and **generalizes them across registrable zones**: whitelisting `api.example.com` also relaxes future flags on sibling `api2.example.com`, while exact-domain tunings always take precedence. One-click memory reset per domain or zone.

### 🌐 Manifest V3 Browser Extension (`@blockingmachine/browser-extension`)

- **DeclarativeNetRequest Rulesets**: Translates network blocking rules into native browser DNR rulesets for zero-latency network interception.
- **Procedural Scriptlet Defusers**: Defuses hostile anti-adblock detection walls (e.g. Admiral, Google Funding Choices CMP) without breaking legitimate page layouts.
- **Element Picker That Blocks On Click**: Click any element to hide it immediately — no separate confirm step — with `↑`/`↓` (or the wheel) to widen the selection to a parent or narrow it to a child, `S` to block every similar element, `Shift`-click to preview the removal first, and `Esc` to cancel. A live HUD shows the selector, its size, and whether the match is unique, and every block is undoable from the on-page toast.
- **Verified Selectors Only**: Rules are generated from stable ids, data attributes, and semantic classes, then *verified against the live document* before use — a selector that matches more than one element, or a bare tag like `div`, is refused rather than injected. Attribute values containing spaces or quotes are escaped correctly, so a rule that looks right is a rule that actually applies.
- **Rich Right-Click Menu**: Block the element, its siblings, its domain, a linked domain, or one exact URL; allow a domain or pause the current site; copy the CSS selector, domain, clean URL, or the resulting blocking rule; and ask what is already blocked on the page — all with labels that name the domain they will act on.
- **On-Device Element AI**: The popup's **AI · Element scan** card scans the page and reports which elements are ads, trackers or nags — nothing is hidden until you say so. **Show me where** outlines every candidate in place with a colour-coded verdict chip, and **Hide all N** writes the rules in one go. The same model is on the right-click menu as an **AI element scan** submenu (verdict / highlight all / block all / mark as ad / mark as content) and in the picker HUD, where `A` marks an element as an ad and blocks it while `N` marks it as content — every one of those decisions feeds back into the model, and a user's explicit ruling outranks a structural prior.
- **Real-Time SSE Sync**: Connects to the local Blockingmachine Hub via Server-Sent Events (`/v1/events`) to instantly hot-reload rules upon compilation without browser restarts.
- **Per-Site Shield Control**: Pause or resume blocking for the current site with one switch (implemented as an `allowAllRequests` frame rule, so the page and everything it loads are exempt), pause everywhere with the master switch, and allow or re-block any individual third-party domain from the block list. User decisions are allocated the highest DNR priorities, so an explicit choice can never be overruled by a blocklist rule. The toolbar badge shows per-tab blocked counts and resets on navigation.
- **Per-Site Rule Scope (`initiatorDomains`)**: A path-level rule is only safe to ship if it applies where the list meant it to. Rules that name their own sites — the adblock `$domain=` modifier — compile into DNR `initiatorDomains` instead of a blanket whole-zone block, so `||ubembed.com^$domain=brokerdeal.de|pctipp.ch` fires only on those two sites and `$domain=~partner.example` becomes `excludedInitiatorDomains`. Paths are kept rather than discarded, so `||cdn.example.com/ads.js` blocks that file instead of the whole host; a hostless `/pop.js` rule is refused unless its own scope makes it safe; and a scope that has no DNR domain equivalent is refused rather than widened into a global block. One filter line is still at most one rule — several `$domain=` variants of the same filter fold into a single rule naming all their sites, and a precise rule a global zone block already covers is dropped. Measured against the compiled list in this repository: **7,485 rules keep their real path** instead of collapsing into a zone block, **1,879 rules are per-site scoped**, and the set totals 127,820 rules — within 1.5% of the 125,913 the zone-collapsing compiler produced, so the precision costs effectively no rule budget.
- **The Browser Is Asked What It Holds, Never Assumed**: Almost every piece of state this extension acts on also exists somewhere in the browser, and the browser's copy is the one that is true. The enabled static tiers are reconciled on every service-worker start (the browser is read, and repaired to the saved selection, so an update that reset the rulesets to the manifest defaults is fixed instead of leaving the popup reporting tiers the browser has switched off); the context menus are removed and rebuilt; per-tab telemetry is pruned against `chrome.tabs.query`. Two surfaces were not, and both failed in the direction that costs the user something. **The dynamic rules were rebuilt from memory**: a Manifest V3 worker is torn down constantly, so the first site pause, domain allowance or custom rule after any restart ran with an empty blocklist in hand — and rebuilding from an empty list is `removeRuleIds: everything`, so *pausing one site deleted every blocking rule the extension had installed* while the popup went on reporting the shield as **Active**, because the decisions it reads back were still in storage. Dynamic rules are now split into the user's own decisions (priority 500 and above) and everything a compiled list produced (below it), and an apply that has no list to install **reads `getDynamicRules()` first and replaces only the user's half**, leaving the installed list exactly as the browser holds it — those rules *are* the last compilation, since the planner that built them is the same pure function. Kept rules are counted against the quota before the new plan is bounded, the filters this call supersedes are retired (so a custom rule is never installed twice), and new ids start above the highest id kept. A startup reconcile then asks the browser whether the user's decisions are actually installed, in both directions — a decision with no rule behind it is a pause that is not pausing, and a rule with no decision behind it is blocking something the user allowed — and repairs only a difference; an empty list family triggers a fetch rather than a copy of a multi-megabyte list kept in storage, which asks once per profile rather than once per worker start. Nothing is remembered from a previous worker, because the browser is holding the answer. **The periodic alarms were created once and never read**: `chrome.alarms` is browser state that Chrome documents as clearable on a browser restart or an update, and both alarms this extension depends on were created inside `onInstalled` with no `onStartup` listener and no reading back — so a profile that had ever lost them stopped syncing rules and stopped pushing telemetry, permanently and silently, since nothing distinguishes "quiet" from "never scheduled". The schedule is stated once and reconciled against `chrome.alarms.getAll()` on every worker start, on `onStartup` and on `onInstalled`, repairing only what is absent, one-shot or on the wrong period and issuing no call when it is already right. The one thing deliberately *stored* rather than read is the last-sync timestamp, which has no browser-side equivalent: without it the popup reported "never synced" beside a rule count that was plainly not zero.
- **Decision Manager**: The Hub tab lists every paused site and allowed domain with one-click restore, repaired defensively on load so corrupt storage can't wedge the shield.
- **Rule Hit Ledger**: Every request the browser blocks is attributed back to the filter line that produced it — resolving dynamic rules from the live list and static tier rules from the shipped ruleset files — and counted per rule in a bounded, batched ledger that survives service-worker restarts. It is the only measurement of list efficiency that reflects real path- and type-aware matching rather than a hostname approximation, and it is exported ready for `blockingmachine coverage --hits`. It works on a packed install too: Chrome exposes the live `onRuleMatchedDebug` event to *unpacked* extensions only, so a packed build is reconciled through `getMatchedRules` instead — on demand when the popup asks for a tab's telemetry (opening the popup is a user gesture, which both grants `activeTab` for that tab and exempts the call from Chrome's 20-calls-per-10-minutes quota) and on a budgeted background tick. Because that API withholds the request URL, a match is attributed there to the tab and the rule that fired, with the blocked host inferred from that rule's own anchor; when the extension is unpacked, the live event still supplies exact URLs and initiators.
- **Static Tiers Compiled From Your Own Blocklist at Package Time**: Left alone the tier files carry a ~118-rule hand-curated baseline, so a release shipped ~118 static rules while the Hub on the same machine had already compiled a six-figure blocklist. `npm run package:extension` now runs `scripts/compile-tier-rulesets.mjs` first and compiles the Hub's active blocklist into the tier files, so a packaged build carries the synced list. The budget is the whole problem: MV3 guarantees an extension only **30,000 static rules across its *enabled* rulesets**, and the Hub's list is **122,801 distinct hosts**, so "ship everything" is not achievable and a script that pretended otherwise would either drop most of the input silently or produce an extension Chrome refuses to load. The compiler therefore fills the six tiers to a shared 30,000-rule ceiling — keeping the invariant that *any* combination of enabled tiers still installs — **redistributes unspent capacity in proportion** to what each tier is still holding (serving tiers in order instead poured every freed slot into the first tier and starved the other three), and reports exactly what shipped and what overflowed on every run. In practice it compiles **743,634 lines → 122,801 hosts → 30,000 rules shipped, 92,811 omitted**, with the overflow stated rather than hidden. Point `--input tier_ads=list.txt` at a source to attribute a whole list to a tier exactly instead of classifying it, and `--residual <tier>` to choose where hosts matching no vocabulary land. **Where a host belongs is not a guess when the hub can say so**: the desktop hub knows which publisher each of its ~740,000 rules came from and therefore what kind of thing it is, and every compilation now writes that down as one blocklist per category beside the lists it already produces. `--attribution <savePath>/categories` places each host from its publisher's own filing, demoting the hostname vocabulary to a fallback for a host the hub had no category for — which matters, because the vocabulary placed **12,444 of the hub's 122,801 hosts (10.1%)** and left the rest unclassified, and it cannot distinguish a host that is only an ad host from one three publishers filed differently. A host several publishers claimed is resolved by a stated precedence and the count is reported, and the report always splits the two paths — `60 of 122,693 hosts attributed · 12,427 by hostname vocabulary · 110,206 unclassified` — because how much a given list is covered depends on which sources that compilation enabled, and a figure that looks fixed would be a lie. The three hub categories that map to no tier are named in the report with the reason: `unbreak` and `anti-circumvention` are allowlists, and `security` is left out on purpose because routing the threat lists into the always-on tier would file malware hosts into the tier that ships enabled, against the check that keeps the tiers and the model agreeing. The manifest beside the category files now also records **which configured sources the compilation was built from** — name and URL per list, each with the categories its rules actually resolved to and the hosts they produced, and a fetch that failed kept on the record with its error rather than dropped — so a build can say what it was built from, and the compiler carries the same source list into the bundle's `GENERATED_TIER_SOURCE` provenance. **The classifier's own verdicts are a different input and get their own tier.** Every hub compilation already walks its distinct hosts through the embedded model, so it now writes what the model decided to `filters/output/malware.txt`, with a header naming the provenance as a verdict rather than a publisher list, and the compiler discovers that file into *Threat & malware*; `--security <file>` names one explicitly, `--no-security` ships the tier empty, and every run says which it did. Its share of the budget is **12% — about 3,600 slots**, sized from the measurement rather than from taste: classifying the real 190,035-host list takes **161,846 ms (0.852 ms per host)** and yields those 6,392 verdicts. The tier has no curated seed, so it is **rebuilt from the current verdicts on every run** rather than extended — the one behaviour a model-fed tier needs and the one the additive curated tiers must not have, since a host the model flags once and later clears should stop being blocked; run against an empty verdict file it ships zero rules and the file on disk becomes `[]`. The same measurement is why the curated security lists still do not go into it: over the project's own 34-host security module the classifier calls **28 hosts `Clean`, 6 `Advertising` and 0 `Malware/Phishing`**, so filing those lists into a tier the model grades would create a disagreement rather than resolve one. Name-evident threats are unaffected — `CORE_INDICATORS` still routes a host called `malware.example.com` to the always-on *Core shield* — because the two tiers specialise by the kind of evidence behind them, a name a publisher chose and a verdict a model reached. Use `--residual <tier>` to choose where hosts matching no vocabulary land. They now land in their own tier, *Unclassified*, and that is the whole point of the flag existing: they used to land in *Ad networks*, which on the hub's real 117,303-host list made **104,818 of that tier's 108,459 rules (96.6%)** hosts nothing had ever called an ad — so a user switching on a row labelled ad blocking was switching on a catch-all. Measured on that list at the real 30,000-rule budget, *Ad networks* went from shipping **24,721** rules (21,080 of them unclassified) to **3,641**, exactly the hosts that were placed in it; the residual ships **20,470** under its own name, and *Tracking & analytics* gained **610** rules because it is no longer competing with a 108,459-candidate tier for the same budget. The default is still an *opt-in* tier on purpose: parking thousands of hosts the classifier could not justify in the default-on tier would silently change what every user blocks. An unrecognised tier name is refused rather than answered with a different tier, for the same reason: the residual is a statement about where the classifier's leftovers go, and quietly substituting one is how that decision gets made for the user instead of by them. Curated hosts are read from the files already on disk and are never lost or re-tiered, so compiling is purely additive; `--check` fails a release whose tiers are stale, and `--skip-tiers` ships the baseline instead. **Which** 30,000 of the 122,801 survive is decided by `--hits <ledger>`: point it at the `<count> <rule>` text `npm run ledger:merge` produces and the browser's own hit evidence ranks each tier's candidates before the budget is allocated, most-fired first, with the unmeasured remainder still the deterministic tail. Taking them in input order instead hands the decision to a merged blocklist's concatenation order — whichever upstream list was pasted first gets the slots, which says nothing about the traffic the user generates. Ranking is opt-in because a default evidence file would make the plan depend on a locally generated artifact, which is how `--check` came to fail on every machine that had ever compiled; it ranks *within* a tier and never re-tiers, and curated hosts keep their place because they are hand-picked rather than measured. Every run says which of the shipped rules carry measured hits and how many evidence-backed hosts took the slots of unmeasured ones, so the effect of the flag is stated rather than assumed. Measured against a real 122,801-host list and a 68-host ledger: 68 of the 30,000 shipped rules carry measured hits, and **40 hosts that a merged list had left in the tail now ship, displacing 40 unmeasured ones** — including `siteintercept.qualtrics.com`, `confiant-integrations.net` and `webcontentassessor.com`, none of which the input order had reached. The real counts are written into the bundle, so the popup's "slots free" readout stays truthful after packaging instead of reporting the baseline.
- **Static Rule Tiers**: The extension carries rules in both forms Manifest V3 allows. Synced lists feed the **dynamic** ruleset (subject to the 30,000 dynamic quota the sync pipeline watermarks against); a curated baseline ships as **static** rulesets declared in the manifest, which the browser loads from disk and which the user can switch on and off at runtime — *Core shield*, *Ad networks*, *Tracking & analytics*, *Consent & nags*, *Threat & malware*, and *Unclassified*, each with its own rule count and a live "slots free" readout in the Hub tab. *Threat & malware* is the one that is not curated, and the one that ships **off**: it holds the embedded classifier's own malware and phishing verdicts — **6,392 of them over the hub's real 190,035-host list** — so its membership rule is a model's verdict rather than a publisher's filing, and enabling it is a decision the user makes knowingly instead of one made for them. Two tiers are allowed to be empty — *Threat & malware* and *Unclassified*, both of which are compiled rather than curated and have nothing to hold until this machine has run a classification — and the catalogue says so in the type system rather than in a comment: `curatedSeed: false` is what tells the ruleset validator, the compiler's `--check` and the tier/model agreement suite that an empty `tier_security.json` is the honest state of a checkout that has never run the classifier rather than a lost baseline. The point is capacity: a disabled tier consumes no rule budget at all, so the extension's reach is the dynamic quota **plus** whichever tiers are on, and a tier adds blocking the quota has no room for. Every tier ships only bottom-priority **block** rules, which is what guarantees a synced exception (priority 2), a site pause (1000), or your own allowance (500) always outranks anything a tier ships — a shipped ruleset can never override your decision. Both halves matter: static rules lose priority *ties* to dynamic and session rules, but priorities are compared across every match, so a static `allow` parked at priority 2 would still beat a dynamic block at 1 and let a shipped list override the extension's own blocking. A test walks the shipped tier files for both properties, and the MV3 compliance script re-checks them on the bytes Chrome actually parses, so a bad tier fails the release rather than shipping. Toggling a tier writes the new selection to storage and then reconciles it against the browser's own enabled-rulesets state, which is read on every service-worker start, on every rule application, and before every pause or resume — so the choice survives restarts and, more importantly, **repairs itself**: an extension update puts the browser back on the manifest defaults, and reconciling by reading the browser rather than blindly re-issuing is what turns those tiers back on instead of leaving the popup reporting tiers that are actually switched off; **Pause everywhere** silences every tier as well as the dynamic rules (your selection is remembered and returns on resume) while pausing a single site already outranks the tiers through its `allowAllRequests` rule. **And when the repair cannot be made, the popup says so rather than rendering a state it has not verified.** The tier card compares the saved selection against the browser's own enabled rulesets every time it reads them and reports the difference: the tiers the browser has on that you turned off, and the ones you turned on that it has off — because those are two different problems, and rendering the toggles as if they were the browser's state hides both. A browser that will not report its rulesets is shown as **unread** rather than as agreeing, since an empty diff for a browser that said nothing is the assumption the comparison exists to refuse. The reconcile is a button (`Re-apply my selection`, or `Re-apply the pause` while blocking is paused everywhere) rather than something automatic, so the disagreement stays visible until someone acts on it — which is what makes a pause that never landed visible too.
- **Capacity-Aware Tier Planner**: "Enable everything" is only the right answer while the browser grants the whole static budget, and that is not guaranteed — Chrome's 30,000 static rules is a *floor* drawn from a pool shared with every other installed extension, so a congested browser grants less than the extension ships and the tiers have to compete for what remains. `planTierSelection` in `src/shared/tierPlanner.ts` makes that choice. It derives live capacity from `getAvailableStaticRuleCount()`, which reports what can still be *added*, so capacity is what is already enabled **plus** that figure — and it falls back to the guaranteed 30,000 when the browser declines to answer, which is the figure the tier files are compiled against. It then enumerates every subset of the tiers exactly rather than greedily by benefit density: measured in the suite, a 600-rule tier worth 500 benefit beats two 500-rule tiers worth 490 each, and a greedy pass loses to it — the same ordering bug the packaging compiler's redistribution once had. Ties break toward *fewer rules used*, so a plan leaves static headroom for the next compilation instead of sitting flush against the ceiling, and then by catalogue order so the same input always yields the same plan. **Benefit is now the rule-hit ledger's measured blocks rather than rule count** — the planner has always accepted a `benefit` per tier and nothing supplied one, so the popup graded tiers by what they blocked on one line and ranked them by size on the one below, and only the first said so. `planTierBenefits` supplies the ledger's per-tier tally, and most of what it does is refuse: a tier's benefit is only used if it *has* a number, because **a disabled tier's zero is not a measurement** — a tier that is switched off cannot block, so a plan reading its silence as worthless would rank every tier you had deliberately turned off below every tier you had left on, and would argue for turning them back on. A tier that fired before you switched it off keeps its history and does count, which is what makes the evidence basis reachable for anyone who has tried each tier once; a tier that is on but has seen less than the 50 matches the blocking card requires is *unobserved* rather than idle, and does not count either. A tier that carries **no rules at all** is *empty* — not idle, not unobserved, and outside the gate entirely — because a tier with nothing to block with can never be measured and no amount of traffic will change that. The exemption is load-bearing rather than tidy: *Threat & malware* ships empty and off on every machine that has not run the classifier, so a tier that could never be measured would have held every plan on every fresh install on the rule-count basis permanently. An empty tier is left out of the blocking card's "2 of 4 tiers" for the same reason — counting it would present an unwinnable tier as one that was given its chance and wasted it — and it is never a number in the weighting either, since there is nothing to weigh. The benefit is raw blocks rather than a rate, because the planner maximises a sum under a slot constraint and a rate would reward a tier for being small — rule counts remain the cost side of every comparison, which is how a 435-rule tier that earned its slots outranks a 1,800-rule one that did not. The two bases are never blended — a blend would rank a tier with no evidence against a tier with a number, and the no-evidence tier always loses — and the plan **says which one produced it**, naming the tier it could not measure, because a plan that quietly reverted to rule count is indistinguishable from one that weighed the evidence and found it fine. Measured on a congested pool where the choice is genuinely open, the same 2,100 slots and the same four tiers give **Core + Tracking + Consent by rule count (2,033 rules)** and **Core + Ad networks by measured blocks (1,833 rules, 5,005 blocks against 30)**. The per-tier tally lives in extension storage and now leaves the machine with the export — each session carries it as a second axis alongside the rule lines, and the committed dropbox's `# Tiers:` header reports the merged split with its coverage. On a machine with no sessions yet, a plan is still planned by rule count and says so; that is the gate working. Pinned tiers are a user decision, not a suggestion, so they are honoured even when they overshoot, with the overshoot surfaced rather than quietly discarded. The popup renders a **Recommended plan** card with the one-line summary, an *Apply* button that appears only when the plan differs from the current selection, and the tradeoff explained in prose: which budget is binding, why each excluded tier lost, and how many slots stay free. The explanation distinguishes two failures that read as nonsense when conflated — a tier larger than the entire budget *on its own* is unfixable rather than unlucky ("23,523 rules against 12,033 slots"), while a tier that fits alone but not alongside what was kept reports its exact shortfall — and it only calls the dynamic budget "the tight one" when the dynamic budget is what actually forced the plan, since claiming it while the static budget was binding would contradict the recommendation above it. Measured on a congested pool granting 12,033 slots against a 30,000-rule compilation: **6,477 of 30,000 rules fit — *Core shield*, *Tracking & analytics* and *Consent & nags* stay on; *Ad networks* (23,523 rules) is dropped as larger than the whole budget on its own**, and 5,556 static slots stay free. The planner is pure — no `chrome.*`, no clock — so the recommendation and the sentence explaining it are both asserted in tests. **It is also the same planner the desktop hub and the CLI run.** The catalogue, Chrome's limits, the ruleset validator, the planner and the ledger attribution moved to `@blockingmachine/core` precisely so three surfaces could not answer the same question three ways: the popup against a live `getAvailableStaticRuleCount()`, the hub against the files it is about to ship, and the CLI against whatever is on disk. `computeTierPlan` is the one implementation the latter two share, and `blockingmachine tier-plan` and a new **Extension tier capacity** card in the hub's deploy view are thin wrappers over it — a hub panel and a CLI reporting different plans for the same files would be worse than having neither, because the disagreement would be invisible. Both can also ask the counterfactual the popup cannot: *what if the pool only granted this many slots?* The hub's card can be weighted by a ledger too, by pointing it at the export from the extension popup — the hub accumulates no measurement of its own, so that file is the only place the counts exist, and the choice is remembered rather than re-asked each launch. The ledger is matched to tiers **by host**, because the strings will not match — a tier ships `||host^` and a ledger may hold `|http://host^`, a hosts-file line or a `*.host` wildcard, and comparing them literally would report a tier as never having fired while it was the rule that fired; narrowing wildcards alone took the real hot list from 37 readable lines to 71, and the 6 still refused are `@@` exceptions, which are on the record because they *allowed* a request. A host two tiers both ship is credited to each and **counted**, since a ledger *line* records which rule fired but not which ruleset declared it — over-counting is reportable and dividing it would invent precision the data does not have. (The session export does carry the browser's own per-tier tally now, but it is the reviewing number, not the weighting input: it covers only sessions written since the axis existed, while the rule lines cover all of them.) A tier file that fails validation stops the plan rather than being charged for, because a plan recommending an unloadable ruleset is worse than no plan. **Ranking a tier by what it blocked cannot say whether it blocks anything the dynamic rules do not**, so `computeTierPlan` also takes the synced list itself and reports, per tier, how many of its rules those rules already cover — and names any tier that adds nothing at all. A ledger records traffic that happened, so a tier whose every host is already in the synced list is indistinguishable from a busy one by hit count alone; the hosts each side blocks are the only thing that answers it. The diff walks up the host labels, so a dynamic rule for `doubleclick.net` covers a tier's `ads.doubleclick.net` while the reverse does **not** hold — a static rule for `ads.doubleclick.net` leaves the apex and every sibling open, and treating that as coverage would let one narrow synced rule retire the broadest tier in the bundle. Exceptions are kept in their own set because `@@host^` is on the record for *allowing* a request: a list that excepts a host does not block it, and a tier shipping it is the only thing left blocking it. Rules scoped to a request type are refused rather than credited, because `||host^$script` blocks scripts and leaves images alone, so a tier shipping `||host^` blocks strictly more — `$important` and `$all` do count, since priority and a synonym for every resource type narrow nothing. That refusal is not a corner case: on the hub's real 13 MB `browser.txt`, **127,591 of 316,699 blockable lines name no whole domain**, and every run prints both halves of the read so a small redundancy figure is never mistaken for a complete one. Against the four tiers that ship curated rules the real list puts **Core shield 23 of 24 rules already blocked dynamically (95.8%), Ad networks 34 of 36 (94.4%), Tracking & analytics 27 of 36 (75.0%), Consent & nags 7 of 22 (31.8%)** — and none of them entirely redundant, which is why *how much* and *all of it* are reported separately: mostly duplicated is a different decision from adding nothing. Missing the list reports redundancy as unknown rather than as zero. **Redundant is not a synonym for useless** — a duplicated tier still costs static slots and buys that coverage back if the synced list drops a host — so the caveat is printed with the finding rather than left to be inferred.
- **The Vocabulary Is Derived From the Tiers, Not Written By Hand**: The disagreement between the shipped tier files and the embedded classifier used to be handled one host at a time — somebody read the pin, worked out which vendor a host was, and typed a token into the classifier's token list. That loop does not scale, and what it produces is unauditable: the token's only provenance is a commit message. It is now mechanised in `packages/core/src/ai/tierVocabularyDerivation.ts`, driven by `scripts/derive-tier-vocabulary.mjs` and shipped as `tierVocabulary.generated.ts`. The **seed corpus is the disagreement set itself**: every host a tier ships that the model cannot place, walked tier by tier. **The derivation cannot invent coverage** — a token only ever comes from a host a tier already ships, so it can name what the tiers contain and nothing more. Three things decide admission, and only the first is about the tiers. The **model has to move**: each candidate token is installed into the live lists and the host is classified again through `withTemporaryVocabulary`, so a token that looks like a name but is not the signal is refused rather than assumed to work. The **tier has to accept the family**: the same contract the agreement suite grades with is enforced here, so a token that puts a `tier_ads` host in telemetry has not placed it in the tier's sense. And the **independent labelled corpus has to hold**, evaluated per candidate rather than per run — so one wrong token is refused on its own instead of taking the whole vocabulary down with it — on a *new false positive on any clean domain by name*, on a clean domain called malware, and on accuracy, macro F1 or list-coverage gaps regressing. A vocabulary derived from the tiers and then graded against the tiers would prove nothing, which is why the third gate exists, why `--write` refuses to write when it fails, and why `tier_security` is not a source at all: its contents are the model's own verdicts, so learning from it would teach the classifier the answers it is graded on. The token rules are stated rather than implied: five characters minimum so an abbreviation that belongs to somebody else cannot become a block signal, function words and ordinary English refused (`privy` is a vendor and a word, and stays a gap), and compound labels judged as written so `privacy-mgmt` cannot become a `privacy` token that matches a hundred legitimate hosts. Everything a machine cannot honestly derive is still hand-written and says why: `fpjs` is four characters, and `ct.pinterest` and `business-api.tiktok` are endpoints on consumer platforms whose *brand* form the corpus refuses. **The provenance travels with the tokens** — the hand-written seed counts, how many hosts each tier contributed and how many it could not place, the corpus before and after, and the gate's own sentence — because a generated list without its measurement is a hand-written list with extra steps. And the failure mode that made all of this checkable: the first version seeded itself with the shipped vocabulary, so after a write the model already placed the hosts it had just derived tokens for, the seed set shrank, and `--check` failed on the file it had itself produced. It now seeds from the hand-written lists alone, installing them by *replacement*, which makes the derivation a fixed point — run it twice, get the same bytes — and a suite re-derives the file from the tier files in process and fails if the two differ. `npm run derive:vocabulary` rewrites it and `npm run check:vocabulary` refuses a stale one.
- **Per-Tier Block Attribution**: A tier toggle used to be a blind bet. The popup reported how many *rules* each tier shipped, which says nothing about whether those rules were doing anything — a tier carrying 23,523 rules that never matched once looked identical to one earning its slots, and the owner had no basis to drop it. The rule-hit ledger now records which **ruleset** produced each block, and because a tier's ruleset id *is* its tier id, that attribution is exact rather than inferred: no hostname guessing, and it works in a packed build too, where Chrome withholds the request URL but still names the ruleset. A match is credited to its tier even when the tier's rule file could not be read for the filter-level histogram, so the tier tally is deliberately the *more* complete of the two readings, and the two live side by side — the histogram stays keyed by filter line for `blockingmachine coverage --hits`, while a filter that ships in two tiers correctly lands in two tier entries and only one histogram entry. Each tier row now reports what it has actually blocked (`1,204 blocked · 62% of all tier blocks`), and once the ledger has enough traffic to mean something a tier that has still never fired is called out as **Never fired** with a one-click **Turn off** that frees its slots. The restraint is the whole point: a silent tier is reported as merely **unproven** — never idle — until the ledger has seen fifty matches, because a tier that was just switched on or happened to run through a quiet session has not been given a chance, and a tier that is *already off* is never called idle at all, since being off is precisely why it has no matches. Acting on a false idle verdict would switch off blocking that was working, which is the expensive direction to be wrong in. Switching a tier on clears its stale counts, so the verdict describes the window the tier has actually had rather than a match it once made months ago; re-applying a selection that leaves a tier enabled keeps its history intact, so applying a capacity plan does not wipe the attribution of every tier it keeps. The tier tally is persisted under its own storage key and only written once a tier has actually fired, so a ledger that has never seen a static block keeps the exact shape older builds read. Beside what a tier has fired, the card now reports what the tier would still *add*: the same redundancy diff the hub and CLI print — `readSyncedHosts`/`findTierRedundancy` — run over the dynamic rules the browser is actually holding rather than the list's source text, so a tier whose hosts the installed rules already carry is named as adding nothing, per row and as a finding above the list. The states are kept distinct the way the surfaces keep them: the browser refusing to list its rules renders as unknown rather than as a zero finding, and a redundant tier carries the caveat with it, because duplicated coverage is not absent coverage — it is what still blocks those hosts if the synced list drops them.
- **The Shipped Tiers Are Graded Against the Model That Ships With Them**: The extension carries two bodies of knowledge about what is worth blocking — a hand-curated static blocklist and the embedded Mini-AI classifier — and nothing stopped the two from drifting apart. When they drift, the result is a contradiction the user can see: the extension blocks a host while the AI Radar it also ships calls that same host clean. A new suite runs **every domain in the shipped tier files** through the classifier and fails on the disagreement. It passes today, and the shape of what it *tolerates* is the finding: across all 118 curated hosts the model **never contradicts a tier** — not one ad host called a tracker, not one tracker called malware — and instead leaves **3 of them** on the pin: 2 it declines to place at all (1 privacy and 1 annoyance host, always as `Clean`, under the 90% mark past which a clean verdict is an assertion rather than a shrug) and 1 it insists on under a stricter family — `onesignal.com`, which the model already knew as tracker infrastructure before the consent vocabulary existed and still files as `Telemetry/Analytics` rather than the annoyance facet the tier names. That was **46 until the classifier's vocabulary was derived from the tiers themselves**: the hosts the tiers ship and the model cannot place are now a *seed corpus*, and 43 of the 46 are placed by a token the derivation worked out from the host's own name — 12 ad, 10 tracker and 20 consent tokens, each recorded beside the host that justified it and the corpus gate that admitted it. `Ad networks` goes from **24 of 36 hosts recognised to 36 of 36**, `Tracking & analytics` from **23 of 36 to 35 of 36**, and `Consent & nags` from **1 of 22 to 21 of 22** — the last under a `Consent/Annoyance` category the model did not previously have, so a consent platform is now named what it is rather than tolerated as the nearest ad-tech file. The consumer platforms in that set are tokenised at the tracked *endpoint* (`ct.pinterest`, not `pinterest`) precisely so that Pinterest's and TikTok's own sites are still read as ordinary, and the derivation proves that rather than assuming it — the candidate that would have called `tiktok.com` an ad host is refused by the labelled corpus, and the refusal is on the record. The vocabulary grows without the false-positive budget moving: over the 217-domain evaluation corpus the derivation takes exact category accuracy **97.7% → 99.1%**, macro F1 **0.880 → 0.901** and list-coverage gaps **down to 2**, with **zero false positives on any of the 122 clean domains** and none of them called malware. The 3 that remain are two different kinds of gap, and the record says which is which: `business-api.tiktok.com` has a token and a raised telemetry probability (0.04 → 0.12) but is outranked by the infrastructure pass calling an `-api` zone on a major platform a verified endpoint — a precedence that is right, so the suite keeps recording it rather than tuning the token until the number turns green; `privy.com`, whose only label is an ordinary English word and is refused as a token however many consent vendors are called it; and `onesignal.com`, the one pinned disagreement that is not a clean miss at all — the model places it as `Telemetry/Analytics` because the hand-written tracker claim predates the consent axis, so the pin records the re-filing and the suite asserts the recorded family is the one the model still reports. The two clean misses sit in the same weak band the triage cascade escalates, so those hosts are that cascade's documented reason for existing rather than a flaw in the list. `Core shield` gets no such latitude, because it ships enabled: all 24 of its hosts are recognised, and a single gap fails the suite. `Consent & nags` used to be the vocabulary gap in its purest form — 21 of its 22 hosts had no word in the classifier's category set at all, because there was no "annoyance" category to have. The category exists now, and 20 of the 22 place under it through the consent vocabulary the tier itself seeded — `cookiebot`, `onetrust`, `iubenda`, `termly` and the rest as consent platforms rather than as the telemetry they happened to resemble. The two exceptions stay on the record by name: `privy.com`, whose only label is an ordinary English word no derivation may mint, and `onesignal.com`, whose older tracker claim honestly outranks the consent axis. The tier still ships disabled, because that is a decision about what a fresh install blocks rather than about what the model can account for. One tier is graded **inverted**, and it is the new *Threat & malware*: its contents are the model's own verdicts, so "the model agrees with it" is not a check — a host in it that the model calls `Clean` is the defect — which is why its allowed family is `Malware/Phishing` and the assertion is flipped rather than dropped. That makes it the one tier this suite cannot independently corroborate, which is a property of its provenance rather than a gap in the suite, and what is asserted is the direction that still means something: *Threat & malware* ships nothing the model does not call malware or phishing, and it ships off. The disagreements are **pinned rather than the assertion loosened**, and enforced in both directions: a host added to a tier the model cannot account for fails the suite, and so does a model that has learned a host it used to miss — a bug list that cannot go stale is a bug list nobody trusts. The pin is no longer typed into the test by hand either: it is the derivation's own refusal record, read out of the generated module, so a host can only be tolerated because the derivation tried to place it and wrote down why it could not. When the tier files are a hub compilation written by `npm run package:extension` the strict grading is reported as *skipped* rather than passing without having checked anything: the model's blind spot covers roughly a third of a real blocklist, so demanding agreement with an arbitrary slice of someone's list would fail for a reason nobody can act on, and the size-independent guarantees — the curated Core hosts are still recognised, and the always-on tier still ships nothing the model considers malicious — are asserted in its place.

### ⚙️ System Loopback DNS Proxy (`@blockingmachine/system-daemon`)

- **In-Memory Reversed-Label Trie**: Ultra-fast $O(k)$ suffix lookup trie matching DNS queries in nanoseconds regardless of list size (100k+ rules).
- **Service Configuration Generators**: One-click generation and installation of macOS `launchd` plist daemons and Linux `systemd` services with `CAP_NET_BIND_SERVICE`.
- **Precedence & Wildcards**: Full resolution of `$important` flags, whitelist exceptions (`@@`), and multi-level subdomain wildcards (`*.telemetry.example.com`).

### 🏠 Home Assistant Integration & HACS Hub

- **HACS Compliant Integration**: Native Home Assistant integration with standard configuration flow and automatic hub discovery.
- **Telemetry Mesh Sensors**: Publishes real-time browser and network protection metrics:
  - `sensor.blockingmachine_browser_blocked_today`
  - `sensor.blockingmachine_browser_cosmetic_hidden`
  - `sensor.blockingmachine_browser_active_defusers`
  - `binary_sensor.blockingmachine_browser_connected`
- **Remote Cosmetic Shield Toggles**: Enable or disable cosmetic hiding and scriptlet defusers directly from Home Assistant automations or Lovelace dashboards.

### 📱 Mobile Companion (`@blockingmachine/mobile`)

- **Three Ways to Pair**: scan the hub's QR code (Settings → Pair Mobile App — carries the feed URL and token), let mDNS discovery find the `_blockingmachine._tcp` advertisement the feed server publishes, or type the address by hand. A server advertising `token=required` prompts for the token before saving.
- **Live Dashboard**: rule counts (total / DNS / browser / quarantined), protection and daemon state, uptime, and the hub's own live-client count — streamed over `/v1/events` SSE, no polling.
- **Domain Check**: ask the hub whether a domain is covered by the compiled rules and see the covering rule and verdict.
- **Remote Control**: toggle protection, trigger a compile, flip the cosmetic shield, or reload the extension — server errors surface verbatim rather than being swallowed.
- **Secure by Default**: the feed token is stored in the device keychain (expo-secure-store), the server registry persists across restarts, and every request rides `Authorization: Bearer` when the hub has a token configured.
- **Same REST Contract**: speaks the identical `/v1/*` surface the HA integration and add-on implement — status, events, telemetry, check, protection, compile, and control endpoints work against either server.

### 🛡️ First-Party Curated Defense Modules (`⌘3`)

1. **Base Ad Shield**: Network-level blocking for major ad exchanges, programmatic bidding, and banner injection.
2. **Privacy Engine**: Web beacons, browser fingerprinting, and analytics telemetry neutralizer.
3. **Smart TV & IoT Shield**: Automatic Content Recognition (ACR) telemetry and ad blocker for Roku, Samsung Tizen, LG webOS, Fire TV, and smart appliances.
4. **Web Annoyances & Cookie Banners**: Eliminates GDPR cookie consent popups, CMP modals (OneTrust, Cookiebot), and overlay nags.
5. **Social Tracker Neutralizer**: Disables cross-site tracking beacons and pixels (Meta, TikTok, X, LinkedIn).
6. **Threat & Malicious Domain Defense**: Blocks drive-by payloads, phishing gateways, cryptominers, and known malware C2 nodes.
7. **URL Tracking Stripper**: Strips privacy-invasive tracking parameters (`fbclid`, `gclid`, `utm_*`, `twclid`).
8. **Unbreak & Safe Exceptions**: Hand-crafted allowlist rules (`@@`) preventing breakage for banking, SSO identity providers, and DRM streaming.

### 🚀 Deploy & Sync Hub (`⌘8`)

- **Pi-hole Integration**: Syncs compiled blocklists directly into Pi-hole gravity databases via API with instant connection testing.
- **AdGuard Home Integration**: Native integration supporting Direct (Port 3000), Home Assistant API (Port 8123), HA Webhooks, and Nabu Casa Cloud tunnels.
- **Custom Automation Webhooks**: Emits HTTP POST event payloads to Technitium DNS, pfSense, OPNsense, Blocky, or Node-RED upon every compilation.
- **Unbound DNS Application**: A first-class platform tab for resolvers that cannot subscribe to a remote blocklist at all. It serves the compiled export as a `local-zone` drop-in feed, and emits the three ingredients an Unbound user actually needs as copy-ready text: the `include:` directive, and a `curl … && unbound-control reload` refresh one-liner — with recipes for OPNsense/pfSense, Debian/Ubuntu/Raspberry Pi OS, and OpenWrt. While the export format is not Unbound the pane says so instead of showing a URL that would never resolve.
- **Unbound Reachability Check**: A correct recipe is not a working deployment, so the Unbound pane can verify the three things that fail independently — the hub is serving a usable drop-in, something on the resolver host has actually fetched it, and Unbound has reloaded it. The third is tested directly rather than assumed: the check takes a domain out of the very file the resolver was told to load, asks the resolver for it, and reads `always_nxdomain`'s NXDOMAIN as proof — with a control name to prove the answer is the resolver's opinion and not a dead server's silence. Verdicts name the fix (feed not answering, wrong format, nothing fetching, missing `include:`, stale copy), and the last confirmed-live time is remembered across launches.
- **Shadowrocket Rule Set Feed**: A first-class platform tab for the iOS/iPadOS client, which cannot read an AdGuard or hosts list at all. The export now emits a real Surge-style rule set — `DOMAIN-SUFFIX,host,REJECT` lines under the `[Rule]` section the app reads rules from — and the pane hands over the LAN feed URL with the numbered setup steps, a warning naming the current format when the configured export would write something else instead, and a note that a child bypass is emitted *before* the parent block it escapes because the rule set is first-match-wins. The pane offers the rule set a second time as a **Home Assistant add-on** URL, which is the one to use on a phone: the add-on is a service that answers whenever Home Assistant does, where a hub feed only answers while that process is running and that machine is awake.
- **Privoxy Action-File Feed**: A platform tab for the Privoxy filtering proxy, which reads a **section-based action file** rather than a list — every URL pattern belongs to the `{+block{…}}` block above it. The export emits that shape (host patterns with the leading dot that covers subdomains) and the pane hands over the feed URL with the `actionsfile` line to paste, the numbered steps, and the one property that is not obvious from a copy of the list: Privoxy applies the *last* matching action, so an allowed child is emitted in a `{-block}` section *after* the parent block it escapes.
- **BIND Response Policy Zone**: A platform tab for BIND, which has no remote blocklist feature and no per-domain zone list. The export is a real RPZ — one `CNAME` policy record per blocked name, plus the SOA a primary zone cannot load without — and the pane hands over the zone-stanza and `response-policy` lines `named.conf` needs, the `rndc` reload, and the honest note that this one is a local file to copy rather than a feed to subscribe. Each blocked domain is emitted as **two** records, the name and a wildcard, because a bare RPZ QNAME trigger matches that one name only: without the wildcard every subdomain of a blocked domain resolves, while the same rules sent to Unbound, dnsmasq or Shadowrocket block the whole subtree. Verified against BIND 9.20.29 rather than assumed.
- **BIND Shared Null Zone**: The same tab offers a second mechanism, for the case where the zone directory is managed by hand and `named.conf` is not. One 3-line file holding an SOA and an NS and nothing else can be loaded under *any* origin, so a single file blocks every domain on the list and never changes between compiles — what changes instead is the `named.conf` fragment, which is the inverse of the RPZ recipe and the thing the recipe says out loud. It is offered second, with its two real costs stated: a null zone has one behaviour, so an allowed subdomain has no stanza that could release it, and it answers NXDOMAIN for subdomains but NODATA at an apex. Both artifacts are validated against `named-checkzone` and `named-checkconf` in the test suite when BIND is installed.
- **Built-in Local Feed Server**: Serves compiled blocklists on your local network (e.g. `http://localhost:9191/rules.txt`, `/dns.txt`, `/browser.txt`, `/unbound.conf`) for automatic appliance polling. The same server hosts the `/v1/*` API the mobile companion and HA integration drive, and advertises the hub over mDNS (`_blockingmachine._tcp`) while it runs.

### 🔌 Unbound Reachability Check (`⌘8` → Unbound)

A recipe that is correct is not a deployment that works. Three things have to be true for Unbound to actually block, and they fail independently — the hub serves a usable drop-in, something on the resolver host fetches it, and Unbound reloads it. The pane's check reports which one is missing instead of leaving users to guess from an empty list.

| What is checked | How | What a failure means |
| :--- | :--- | :--- |
| **Served** | The hub fetches its own feed URL and parses the body | The address in the recipe answers nothing, or answers with a file that has no `local-zone` statements — an AdGuard export under a `.conf` name loads without error and blocks nothing |
| **Fetched** | The feed server records every 2xx serve of the drop-in, with peer and user agent | Nothing has requested the file since the hub started, so the scheduled `curl` is not running |
| **Reloaded** | A DNS query for a domain *taken from the drop-in the resolver was just served*, plus a control name and a reference resolver | The resolver answered normally for a name its own file blocks, so the `include:` line or the reload is missing |

Three details make the third check trustworthy rather than decorative. The canary is chosen from the served artifact — shortest registrable domain — so a pass cannot be an artefact of the wrong file. A control query (`example.com`) must resolve before any NXDOMAIN counts, so a resolver that refuses names that should resolve is reported as **inconclusive** rather than as a working blocklist, and a refused or timed-out connection is **unreachable** rather than "not loaded". And the canary is confirmed to **exist somewhere else** before its NXDOMAIN is read as proof, because a domain that was never registered answers identically to one the drop-in blocks — so the same name is looked up on a second resolver (this machine's own configured DNS by default, or an address you set; never the resolver under test). Without a reference, or with one that cannot answer, the verdict is **canary-unconfirmed** rather than live; if the reference shows the name resolves nowhere, it is **canary-nonexistent**. The reference is queried with the canary name once per check, which is the cost of the confirmation — leave it empty to keep every query local and accept an unconfirmed verdict.

Verdicts name the fix — feed not answering, wrong format, nothing fetching, `include`/reload missing, resolver unreachable, canary unconfirmed or nonexistent, or **stale**: blocking live with a copy older than the last compile. The last confirmed-live time and the newest known fetch are persisted, so opening the pane reports the deployment's history without firing a DNS query on tab switch. The probe identifies itself with a header, so its own fetch never counts as the evidence it is looking for.

**The check runs itself now, and a regression is announced.** A check whose value is noticing a change is useless if only a person can trigger it, so the hub re-runs it every 15 minutes for a deployment somebody has engaged with — an address they typed, or a verdict this hub has already produced — and raises a desktop notification when a deployment it has *already seen blocking* stops blocking: `live`/`stale` to `stale` or `not-loaded`. Silence is the common answer and it is load-bearing. A machine that never deployed Unbound hears nothing, ever; a first check has no history to have regressed from; the same finding twice is one finding, so a resolver left broken for a week does not notify every fifteen minutes. `resolver-unreachable` is deliberately not announced — that is what a suspended laptop reports on the next tick, and alerting on it teaches people to dismiss these. The alert quotes the pane's own `headline` and next step rather than its own wording, so the notification and the screen cannot describe one failure two ways. While the app is closed nothing is watched: the first check is a full interval after launch rather than at it, because firing DNS queries at a configured address before anyone has looked at the pane is a surprise nobody asked for.

The resolver address defaults to `127.0.0.1:53` — the instance the hub usually sits on — and a blank field falls back to it instead of refusing to check. That default is the common wrong answer too, so the pane names the alternative: whatever this machine already resolves through gets suggested as the address to enter when Unbound runs on a router or another host. A typo does not fall back — replacing `192.168.1.1:99999` with localhost would produce a confident verdict about a resolver the user never named, so it stays an error.

---

## Keyboard Shortcuts Matrix

| Shortcut | View                    | Purpose                                                                         |
| :------: | :---------------------- | :------------------------------------------------------------------------------ |
|   `⌘1`   | **Process & Stats**     | Dashboard, compile metrics, feed status, and instant compilation trigger        |
|   `⌘2`   | **Sources**             | Manage remote filter list subscriptions, feed toggles, and health checks        |
|   `⌘3`   | **Defense Modules**     | First-party curated shields (Smart TV, Telemetry, Annoyances, Privacy)          |
|   `⌘4`   | **Custom Rules**        | Custom domain blocks, whitelist exceptions (`@@`), and syntax validation        |
|   `⌘5`   | **Rule & AI Inspector** | Simultaneous filter rule matching and live AI heuristic threat analysis         |
|   `⌘6`   | **Rule Browser**        | Search, filter, and paginate through tens of thousands of active compiled rules |
|   `⌘7`   | **Bulk Import**         | Add multiple feed URLs simultaneously or import text files via drag-and-drop    |
|   `⌘8`   | **Deploy & Sync**       | Push compiled lists to Pi-hole, AdGuard Home, Unbound, and homelab webhooks     |
|   `⌘9`   | **AI Radar Hub**        | Homelab Sinkhole Scout, Web Canary Crawler, and Threat Quarantine Ledger        |
|   `⌘,`   | **Preferences**         | Output formats, directory paths, AI engines, Watchdog, and accent colors        |
|   `⌘R`   | **Compile Now**         | Global trigger to compile and deduplicate all active filter lists               |

---

## Monorepo Architecture

```
Blockingmachine/
├── packages/
│   ├── core/                    # @blockingmachine/core (Compiler, deduplicator, parsers, Mini-AI engine)
│   ├── cli/                     # @blockingmachine/cli (CLI binary, local feed server, diffing, doctor)
│   ├── electron-app/            # @blockingmachine/electron-app (Desktop suite, Deploy Hub, AI Radar)
│   ├── browser-extension/       # @blockingmachine/browser-extension (Manifest V3 WebExtension)
│   ├── system-daemon/           # @blockingmachine/system-daemon (Loopback DNS filtering proxy)
│   ├── homeassistant-addon/     # @blockingmachine/homeassistant-addon (Home Assistant Supervisor Add-on)
│   ├── homeassistant-integration/# HACS-compliant Home Assistant integration & Python tests
│   ├── mobile/                  # @blockingmachine/mobile (Expo/React Native companion app)
│   └── database/                # Snapshot rollback engine and audit logging schemas
├── custom_components/           # Root HACS custom component distribution directory
├── .github/workflows/           # GitHub Actions CI, CodeQL Analysis, and HACS Validation
├── .forgejo/workflows/          # Forgejo Actions CI and Forgejo Packages publishing
├── hacs.json                    # HACS repository metadata and compliance definition
├── SECURITY.md                  # Comprehensive vulnerability disclosure and security policy
├── package.json                 # Root npm workspaces configuration (Node.js >= 24.0.0)
└── README.md
```

---

## Supported Export Formats

| Format             | Syntax Example                             | Target Platform / Resolver                         |
| :----------------- | :----------------------------------------- | :------------------------------------------------- |
| **AdGuard Home**   | `\|\|example.com^`                          | AdGuard Home, AdGuard DNS, AdGuard apps          |
| **AdBlock Plus**   | `\|\|example.com^$third-party`              | uBlock Origin, Brave Browser, browser extensions |
| **Standard Hosts** | `0.0.0.0 example.com`                      | System `/etc/hosts`, Pi-hole, standard DNS         |
| **dnsmasq**        | `address=/example.com/0.0.0.0`             | OpenWrt, DD-WRT, pfSense, dnsmasq                  |
| **Unbound**        | `local-zone: "example.com" always_nxdomain` | OPNsense, pfSense, Unbound DNS resolvers           |
| **Privoxy**        | `.example.com` in a `{+block}` section     | The Privoxy filtering proxy (Linux, BSD, macOS, routers) |
| **BIND (RPZ)**     | `example.com CNAME .` + `*.example.com CNAME .` | BIND 9.8+ `named` — Response Policy Zone       |
| **BIND (null)**    | `zone "example.com" { type master; file "…"; }` | BIND 9.8+ `named` — one shared null zone file     |
| **Shadowrocket**   | `DOMAIN-SUFFIX,example.com,REJECT`         | Shadowrocket (iOS/iPadOS), Surge, Clash-style clients |
| **Plain Domains**  | `example.com`                              | Minimalist domain blocklists, Pi-hole domain lists |

---

## Prerequisites

- **Node.js**: `v24.0.0` or higher
- **npm**: `v10.0.0` or higher
- **Python**: `v3.10` or higher (for Home Assistant integration testing)
- **Git**: Installed and available in your system `PATH`
- **Build Tools**:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux (Ubuntu/Debian)**: `sudo apt-get install build-essential python3`
  - **Windows**: Visual Studio C++ Build Tools
- **Mobile app** (optional, `packages/mobile` only): JDK 21 + Android SDK (`ANDROID_HOME`) for the Android build, Xcode for iOS; native modules require an Expo dev-client build, not Expo Go

---

## Installation & Build Guide

### 1. Clone the Repository

```bash
git clone https://github.com/greigh/Blockingmachine.git
cd Blockingmachine
```

### 2. Install Dependencies

Install all workspace dependencies from the root directory:

```bash
npm ci
```

### 3. Build All Workspaces

Compile the core TypeScript engine, CLI binaries, browser extension, and Electron bundles:

```bash
npm run build
```

### 4. Launch Desktop Application

Run the Electron desktop suite in development mode:

```bash
npm start
```

### 5. Package for Distribution

Build native macOS, Linux, or Windows binaries:

```bash
npm run package --workspace=@blockingmachine/electron-app
```

---

## CLI Usage Guide

The `@blockingmachine/cli` binary provides full command-line access for headless homelab environments and CI/CD automation:

```bash
# Run CLI directly via npm workspace
npx --workspace=@blockingmachine/cli blockingmachine --help

# Or install globally from GitHub Packages
npm install -g @greigh/blockingmachine-cli --registry=https://npm.pkg.github.com

# Scan a suspect domain using the built-in Mini-AI classifier
blockingmachine ai-scan doubleclick.net

# Scan a domain using a local Ollama LLM
blockingmachine ai-scan tracking-bidder.biz --provider ollama --model llama3.2

# Triage cascade: screen locally, escalate only undecided candidates to the model
blockingmachine ai-scan tracking-bidder.biz --provider ollama --cascade --max-escalations 25

# Discovery mode: also escalate uncertain *clean* verdicts (finds what lists miss)
blockingmachine ai-scan comscore.com --provider ollama --cascade --escalate-clean

# Crawl a webpage for third-party ad beacons and trackers
blockingmachine ai-crawl https://example-news-site.com

# Verify whether a domain is blocked by your compiled filter list
blockingmachine test malware-c2-domain.com

# Compare rule differences between two compiled blocklist snapshots
blockingmachine diff baseline-rules.txt updated-rules.txt

# Launch local HTTP subscription feed server for network clients
blockingmachine serve --port 9191

# Measure how much of the compiled list real browsing actually matched.
# Capture with scripts/capture-request-trace.js so the trace keeps request paths —
# a hostname-only trace can decide zone blocks and nothing else.
blockingmachine coverage --trace requests.txt

# Same analysis from the browser's own rule-hit ledger (path- and type-aware)
blockingmachine coverage --hits rule-hits.txt

# Report which static tiers are worth keeping on, and at what capacity
blockingmachine tier-plan --rules-dir packages/browser-extension/rules

# The same plan under a congested pool, weighted by what the browser actually blocked
blockingmachine tier-plan --capacity 12033 --hits rule-hits.txt

# Which tiers the dynamic rules already cover, so they add nothing but still cost static slots
blockingmachine tier-plan --synced ~/Documents/Blockingmachine/browser.txt

# Run system diagnostic health check
blockingmachine doctor
```

---

## Measured List Coverage

A blocklist is judged by its size, but size is not the property that matters: what matters is how
many of its rules ever fire, and how much of the blocking a small head is responsible for. The
`coverage` command answers that from real traffic, either by replaying a captured request trace or
by reading the rule-hit ledger the extension keeps, and it reports the list's hit rate, its dead
weight, and the smallest head that reaches 95% and 99% of blocks.

It also reports the list *as the browser actually expresses it*, because a hit rate only means
something against rules the tool can decide. A compiled browser export is four kinds of blocking
rule: a blanket host block, an **initiator-scoped** rule (`$domain=`, compiled to DNR
`initiatorDomains`), a **path-preserving** rule (a host anchor with a path suffix, compiled to a URL
pattern), and a **request-scoped** rule (`$script`, `$popup`, `$replace=`, compiled to
`resourceTypes` or a response rewrite). The command reports all four counts and measures the hit
rate over the hostname-decidable bucket alone, which is the one set it evaluates exactly.

**A full request URL decides the path bucket**, and that is the difference between deciding a rule
and excluding it. Read from a hostname, a path-preserving rule is indistinguishable from a
blanket block of its zone, so a replay credited it with every request to that host or wrote it off
as undecidable — and the second failure runs in the flattering direction, because a rule nobody can
credit is a rule nobody can blame for being dead weight. Given a URL, the matcher matches the path
the request actually took, the path rule outranks the zone block for the requests it covers, and the
zone block keeps only the rest. On the shipped list **6,230 of the 7,628** path-scoped rules (81.7%)
are decidable this way; the 1,398 it refuses are `$replace=` / `$redirect=` response rewrites and
rules qualified by request type or initiator, where the answer genuinely is not in the URL. An
allowlist always wins over a path rule, because inventing a block the browser skipped is the one
mistake a report cannot walk back. Decided path fires are reported in their own bucket rather than
folded into the rate, since a path rule is decided for a fraction of the requests to its host and a
hostname rule for all of them. `npm run check:path-decidability` gates the share at 80% — a list
update that floods the bucket with undecidable shapes fails CI, not a review nobody ran.

Measured against the compiled browser export in this repository (**249,751 lines**: 118,379
hostname-decidable blocking rules, 4,224 initiator-scoped, 7,628 path-scoped, 1,855 request-scoped,
and 4,106 exceptions) across a real 11-page browsing session (Wikipedia, BBC News, GSMArena, The
Guardian, CNN, Allrecipes, IMDb, Stack Overflow, Speedtest, Forbes, MDN; 232 requests over 178
distinct hosts):

| Measure | Result |
| :--- | :--- |
| Rules that fired | **71 of 118,379** (0.060%) |
| Dead weight | **99.940%** of the hostname-decidable list never fired |
| Rules for 50% of blocks | 17 |
| Rules for 95% of blocks | **65** |
| Rules for 99% of blocks | **70** (0.059% of the list) |
| Distinct hosts blocked | 86 of 178 (48.3%) |

The split changes the answer rather than decorating it. The 71 are the hostname-decidable rules
the rate counts; beside them one path-scoped rule won on 5 requests a hostname cannot settle —
the scoped fire is reported next to the rate instead of inside it, and of the 133 blocked requests
five are those scoped wins, counted as blocked but out of the rule rate.

**And the session cannot currently exercise the URL path at all**, which the command now says
out loud rather than leaving to be inferred. The trace behind these figures records 232 bare
hostnames and no paths, because the capture kept only the host of each resource-timing entry — which
always handed back the full URL. So `Path-decided: 0` here, and the numbers are exactly what they
were before the matcher existed. Capturing with
[`scripts/capture-request-trace.js`](scripts/capture-request-trace.js) records URLs, at which point
the path bucket becomes measurable; adopting a hot set from a URL-bearing session is a separate
decision from gathering one, because a re-captured session is a different session.

The honest reading: against a six-figure list, a real browsing session touches a rounding error of
it — so the list is best understood as a hot set in the low tens of rules (71 here) plus ~118,000
lines of insurance. The one limit the tool cannot remove is stated rather than buried: **no replay,
URL or not, can see the page that made a request.** Whether a request was third-party, and which
domain initiated it, are facts about a page the trace does not carry — so 4,224 initiator-scoped
rules stay undecidable however good the capture gets, which is exactly why the extension records the
rule the browser *actually* matched and why `--hits` takes that ledger in preference to a replay.

**Read the numbers as a floor, not a constant.** The session is eleven pages from one machine — a
small, content-heavy sample — and the head of the list grows as coverage grows, so a longer or
busier session fires more rules and the derived set grows with it. What that growth buys in
coverage on traffic the set has not seen is a separate question — measured below, and it flattens.
The trace also records each request as
*attempted* rather than completed: the sandbox refused connections to several third-party hosts,
and a refused connection still counts, which is exactly what a network blocker sees. None of that
weakens the point the measurement makes — no single six-figure list can be right for every network —
but it does mean ~70 is the floor this session reached, not a figure to hold up against another
session or a busier one.

### The Trimmed Hot Set

`npm run build:hotlist` turns a measurement into a shippable list. It keeps the rules the
measurement saw *fire* — the head the coverage curve already identifies — plus the exception rules
that fired, so the trimmed list makes the same allow decisions the full one did, and writes
[hotlist.txt](packages/cli/filters/output/hotlist.txt) with a header stating what it cost.
`npm run check:hotlist` fails if the file drifts from a fresh derivation (CI runs it), and
`blockingmachine coverage --hot` measures the trimmed list instead of the full export.

The shipped `hotlist.txt` is derived from the four-session ledger in [`ledger/`](ledger/), so the
committed 11-page session is now a *held-out* measurement for it rather than the traffic it was
built on:

| List | Rules | Blocked | Allowlisted | Rules that fired |
| :--- | ---: | :--- | :--- | :--- |
| compiled export | 249,751 lines (118,379 decidable) | **133 requests on 86 hosts** | 4 hosts / 4 rules | 71 |
| `hotlist.txt` | **17 rules** | **19 requests on 9 hosts (14.3%)** | — | 6 of 17 |

On its own derivation traffic the hot set still holds no rule that did not fire — **0% dead
weight** — but "exact" is not the claim the header makes: the 17 rules carry **403 of the ledger's
1,733 measured blocks (23.3%)**, because 40 of the 57 rules the browser reported have no verbatim
line in the source list to ship as (the ledger's `||doubleclick.net^` is not the spelling the list
ships). And on a session it never saw it keeps 19 of 133 blocks; the 11 rules that stand silent
here are not dead, they are the ledger's traffic rather than this session's. What both gaps mean —
and why extra sessions of the same kind did not shrink the second — is measured two sections down.

### The Measurement Can Be Real Usage

A trace is one browsing session, sampled, from one machine. The better evidence is the matches the
browser itself applied, and the build already had a `--hits` path for it — the honest one, since
paths, request types and initiators were all resolved by the browser rather than replayed by us.
What was missing was anything that produced such a file, and any record of what it covered:

```bash
npm run ledger:merge -- --in export-1.json --in export-2.json --out ledger-hits.txt
node scripts/build-hot-list.mjs --hits ledger-hits.txt --write   # or: npm run build:hotlist
```

The extension writes one JSON file per browsing session — open the popup's *Hub* tab and click **Export ledger** — and `ledger:merge` reduces any number of them. What that reduction is allowed to claim is where the care went:

- **Durability is days, not hits.** One busy afternoon of one site can out-count a rule that quietly
  fires every day for a month, so each rule carries its hit count *and* the distinct UTC days it
  fired on, and `--min-days` is how you ask for rules that recur rather than rules that once
  spiked. A session that crosses midnight is split in two, because one date for hits on two days
  would understate the evidence.
- **An exception is never counted as a block.** An `@@` rule that fired *allowed* a request;
  tallying it with the blocks would build a hot set out of the rules that did the least work.
- **A match whose rule cannot be named is counted, not guessed at.** The filter text needs a shipped
  rule file loaded, which can fail — so those hits are reported as unattributable instead of being
  invented into the list.
- **The per-tier tally rides along on its own axis.** A session also reports which shipped tier each
  block came from — a tier is credited whenever the browser names the winning ruleset, even when the
  filter file could not be read, and one rule shipped in two tiers is one rule line and two tier
  entries. The merge writes the split into the ledger's *header* rather than as rule lines, because
  `tier_core 543` read back as a rule would be 543 rules named `tier_core`, and it says how many
  sessions carried a split at all — a tally measured in one export of six must not read as six.
- **Order must not matter.** The generated list is diff-checked, so the merge is commutative and
  sorted deterministically; a build whose output depended on the order it read its files would fail
  on the next machine.

The provenance travels in the ledger's header, so the generated hot list says what it is based on —
`12 sessions across 34 days (2026-08-01 to 2026-09-03)` — rather than leaving a reader to assume a
week of real browsing. A hand-written `<count> <rule>` file still works and reports, honestly, that
it carries no provenance.

### The Cut Is Re-Derived Weekly, From `ledger/`

Which 30,000 of the hub's 122,801 hosts the extension ships is the whole packaging decision, and
without evidence the compiler takes them in input order — which is a merged blocklist's
concatenation order, not anyone's traffic. So the evidence is accumulated into a dropbox and
re-derived on a schedule:

```
ledger/
  ledger-hits.txt      the accumulation — <count> <rule> plus the # Tiers: header, committed
  session-*.json       the exports it was merged from, so the committed file reproduces byte for byte
  session-*.meta.json  per-run provenance — the page list, the tier split, the same caveats
  README.md            what it holds, what it deliberately does not, how to add to it
  local-runner.plist   the optional launchd job that fills it from a downloads folder
```

```bash
npm run ledger:merge -- --from ~/Downloads      # merge a week of exports into the dropbox
npm run tiers:weekly                            # re-derive and verify, exactly as CI does
```

A weekly job (`.github/workflows/weekly-tier-compile.yml`, Mondays 04:17 UTC) re-runs that derivation,
verifies the hot set still matches the ledger it names, checks the compiled cut against Chrome's
rule budget, and opens a PR with the regenerated artifacts. It is one script rather than a workflow
of steps so that what CI runs weekly is what you run when a derivation looks wrong.

**The job cannot collect browsing data** — only the extension can, on someone's machine — so the
weekly run is a re-derivation and a guard rather than a generator: it proves every week that what
ships still matches the evidence, and opens the PR when the evidence moves. With an empty dropbox it
is a no-op that says so, which is the correct outcome rather than a failure.

The committed ledger is `<count> <rule>` — a blocklist rule and how often the browser blocked with
it. Not a browsing history: no URLs, titles, timestamps or initiators, because the merge reads rule
text and counts out of each export and drops the rest. Even so, a real ledger says something about a
person's browsing, so [`ledger/README.md`](ledger/README.md) also documents the local-only route.

**It is not a general blocklist, and the measurement says so.** Deriving a hot set from half the
session's pages and measuring it on the other half keeps only **38 of 93 blocks (40.9%)** — a
per-session hot set is exact for the traffic it came from and loses most of what it has not seen.
That is why it is chosen for a budget that cannot hold the full list, with the limitation printed in
the file's own header, rather than presented as a replacement for the full export.

**And the loss is only part sample size, which is the useful thing to know before collecting a
ledger.** `npm run measure:hotlist-generalisation` derives from the first *k* pages and holds out
the rest, for every split:

| derivation breadth | rules | held-out share |
| :--- | ---: | ---: |
| 1 page (2 hosts) | 0 | 0.0% |
| 3 pages | 19 | 28.3% |
| **5 pages (the pinned split)** | 34 | **40.9%** |
| 6 pages | 46 | 53.7% |
| 9 pages (widest worth reading) | 62 | 56.7% |

It rises steeply and then **flattens in the low-to-mid 50s**. Widening the derivation as far as
this one session allows recovers about **16 points** of the loss; the remainder is structural —
rules that fire *somewhere* are not rules that fire *here*, and no quantity of extra data changes
that.

**The multi-session measurement has now been made, and the page-split curve was not a floor — it
was an optimistic bound.** `ledger/ledger-hits.txt` holds four scripted sessions (158 pages on one
day), and `measure:hotlist-generalisation --hits` derives the shipped 17-rule set from it and holds
out this session whole: **14.3% (19 of 133 blocks)**, *below* the 40.9% a same-session split
predicts, because a hold-out that shares no traffic with the derivation is a harder question. And
the session axis is flat from the start: merging the ledger one session at a time grows it
53 → 56 → 57 fired rules while the held-out share stays **14.3% at every prefix** — sessions of the
same kind had stopped paying at the first one. The honest use of a ledger is breadth, not
completeness: it should replace the full export for a constrained device, and it should not be
sold as the same list, smaller.

Two caveats, both load-bearing. The *k* axis counts pages of **one** session and the ledger holds
four scripted sessions of **one day** — so what neither measurement can speak to is the breadth a
person's real browsing has, which is the remaining question the 40.9% is waiting on (open flag 16).
`measure:hotlist-generalisation --hits <ledger>` is still that measurement the moment a real one
lands: it derives from the browser's own ledger and holds out the whole session, which is a
stricter hold-out than the page split because the ledger shares no session with it.

### Choosing the rule source automatically

A client never picks between the full export and the hot set. `chooseRuleSource` in
[dnrManager.ts](packages/browser-extension/src/background/dnrManager.ts) decides from the budget
alone, and the rule is narrow enough to state in one sentence: **the full export when it fits, the
measured hot set when it does not.** There is no flag, no setting, and no configuration.

The alternative is not nothing — it is a trimmed full export: when the shipped tier files can rank
any of the list, the cut spends the budget on the hosts they can vouch for and drops the unmeasured
tail first; when they cannot, the cut is the file's own order, as before. The hot set keeps a
measured subset of the deployment's own traffic. Both are less than the full list, and the hot set
is the better answer because its loss is characterised rather than silent.

Which means this is the **default path, not an edge case**. The shipped export compiles to
**127,820** dynamic rules against Chrome's **30,000**-rule cap, so essentially every browser
overflows and every one of them now installs the hot set instead of a prefix:

| budget | source | installed | pruned from the export |
| :--- | :--- | ---: | ---: |
| 30,000 (Chrome's default cap) | hot | 17 | 97,820 |
| 1,500 (constrained client) | hot | 17 | 126,320 |
| 100 (very constrained client) | hot | 17 | 127,720 |
| — (no hot set served) | full, tier-trimmed | 1,500 | 126,320 |

The 17 measured ABP lines compile to 17 DNR rules — every one is a bare `||host^` zone block, so
nothing expands per-site. **The last row is what a deployment without a hot set gets** — and it is
not a prefix either. The cut is ordered by measured tier benefit: the hosts the shipped tier files
can vouch for keep their slots first, weighted by the deployment's own per-tier block tally
(`bm_tier_hits`) and by the evidence rank each host earned inside its tier file at compile time. A
deployment with no local measurement yet still gets the compiled order — the curated seeds and
evidence-ranked hosts are measured evidence the package already carries — which beats a merge-order
prefix that keeps whatever happened to be early in the file.

Two failure modes are handled rather than assumed away. If the hot set *also* overflows, the full
export is kept and pruned — the hot set would then be not a smaller list but a differently-shaped
one, and choosing it trades a truncation for a truncation. And when the full export fits, nothing is
logged about the hot set at all, so that the one message that matters is the one that gets read.

**Which list is running is a user-facing fact, not a log detail**: the popup's quota card carries a
*Rule source* row — `full export` or `measured hot set`, with the hot case naming the pruned count
it stands in for — read from the record the last successful apply left behind, so a rule count can
never be mistaken for an answer it cannot give (a pruned export and a measured set both fit the
quota). A browser that has not applied a list yet shows no row rather than guessing.

The same comparison is how a deployment catches a **stale hot set**. Every apply that is offered
one measures it against the full export it was served beside — its own budget standing, and the
count of rules the export no longer carries verbatim (the builder only ships rules the source
list contains, so a nonzero count means the served pair is out of step). A stale set is warned in
the log whichever source won, and the row shows `· N stale` alongside the source.

The hot set reaches the client from the feed. `blockingmachine serve` publishes it at
`/v1/hotlist.txt` beside the full list, and the extension fetches it alongside the rules — from
wherever the full list came from, with the filename swapped, so a deployment whose feed is not the
local default is not asked to configure it twice. **A deployment with no hot set is a normal state,
not a fault**: the endpoint answers `200` with an empty body, an unreachable one is skipped, and a
failed hot-set fetch never fails the sync. A client that cannot reach it gets the full export
trimmed by measured tier benefit, and it should not lose the full list to fix a resource that is
only ever consulted when the export overflows.

---

## Quality Assurance & Testing

Blockingmachine maintains a strict **100% test pass rate** with **0 ESLint errors and 0 warnings** across all monorepo packages:

```bash
# Run all ~2,900 automated tests across the monorepo (Jest workspaces + the HA Python suite)
npm test

# Run tests with open handle leak detection
npm test --workspace=@blockingmachine/core -- --detectOpenHandles

# Run linter across all workspaces
npm run lint

# Validate TypeScript typing across all packages
npm run type-check

# Compile the desktop Hub's active blocklist into the extension's static tier files
npm run compile:tiers

# Compile them with the browser-reported hit ledger deciding which hosts survive the 30,000 cut
node scripts/compile-tier-rulesets.mjs --hits ledger-hits.txt

# Compile them with each host placed by the hub's own per-category output instead of by its name
node scripts/compile-tier-rulesets.mjs --attribution ~/Documents/Blockingmachine/categories

# Fail a release whose static tiers are stale relative to the Hub blocklist
npm run check:tiers

# Verify Manifest V3 Chrome Web Store compliance, including the shipped static ruleset tiers
npm run verify:mv3
```

---

## Security Policy

We treat security as a first-class feature across all network proxies and extensions. For vulnerability disclosure procedures, supported versions, and architectural isolation guarantees, see our [SECURITY.md](SECURITY.md).

---

## Remotes & CI/CD Pipelines

Blockingmachine is concurrently mirrored and continuously tested across:

- **GitHub Repository**: [github.com/Greigh/Blockingmachine](https://github.com/Greigh/Blockingmachine)
- **Forgejo Repository**: [git.greighstudios.com/greighstudios/Blockingmachine](https://git.greighstudios.com/greighstudios/Blockingmachine)
- **GitHub Actions**: `.github/workflows/ci.yml`, `.github/workflows/codeql.yml`, `.github/workflows/hacs-validation.yml`
- **Forgejo Actions**: `.forgejo/workflows/ci.yml` and `.forgejo/workflows/publish.yml`

---

## Contributing

We welcome community contributions! Please adhere to the following guidelines:

1. Ensure all new features include unit test coverage in the corresponding `__tests__` directory.
2. Verify that `npm run lint` passes with **0 errors and 0 warnings**.
3. Ensure `npm test` passes with 100% success across all workspaces.

---

## License

This project is licensed under the **BSD-3-Clause License**. See the [LICENSE](LICENSE) file for details.

<div align="center">
  <sub>Designed and engineered by <a href="https://greighstudios.com/">Greigh Studios LLC</a>.</sub>
</div>
