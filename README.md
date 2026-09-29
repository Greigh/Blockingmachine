<div align="center">
  <img src="https://raw.githubusercontent.com/Greigh/Blockingmachine/main/assets/Blockingmachine.png" width="160" alt="Blockingmachine Logo" />

# Blockingmachine

[![License](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/Release-v1.0.0--rc.6-orange.svg)](https://github.com/greigh/Blockingmachine/releases/tag/v1.0.0-rc.5)
[![GitHub Packages](https://img.shields.io/badge/GitHub_Packages-v1.0.0--rc.5-2ea44f.svg)](https://github.com/users/Greigh/packages?repo_name=Blockingmachine)
[![Forgejo](https://img.shields.io/badge/Forgejo-git.greighstudios.com-ff6600.svg)](https://git.greighstudios.com/greighstudios/Blockingmachine)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24.0.0-339933.svg)](https://nodejs.org/)
[![Built with Electron](https://img.shields.io/badge/Built%20with-Electron%2044-47848F.svg)](https://www.electronjs.org/)
[![Written in TypeScript](https://img.shields.io/badge/Written%20in-TypeScript%205.8-3178C6.svg)](https://www.typescriptlang.org/)
[![Tests](<https://img.shields.io/badge/Tests-434%20Passing%20(100%25)-brightgreen.svg>)](https://github.com/greigh/Blockingmachine/actions/workflows/ci.yml)
[![CI](https://github.com/greigh/Blockingmachine/actions/workflows/ci.yml/badge.svg)](https://github.com/greigh/Blockingmachine/actions/workflows/ci.yml)
[![CodeQL Analysis](https://github.com/greigh/Blockingmachine/actions/workflows/codeql.yml/badge.svg)](https://github.com/greigh/Blockingmachine/actions/workflows/codeql.yml)
[![HACS Validation](https://github.com/greigh/Blockingmachine/actions/workflows/hacs-validation.yml/badge.svg)](https://github.com/greigh/Blockingmachine/actions/workflows/hacs-validation.yml)
[![Security Policy](https://img.shields.io/badge/Security_Policy-Active-green.svg)](SECURITY.md)

_A modern network defense suite and filter list compiler for AdGuard, uBlock Origin & EasyList. Features an Electron desktop app, MV3 extension, loopback DNS daemon, Home Assistant hub, and embedded Mini-AI classification with intelligent rule deduplication, multi-format exports, and 100% local processing._

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
- **Home Assistant Hub (`@blockingmachine/homeassistant-addon` & integration)**: HACS-compliant Home Assistant integration and local Add-on container providing a bidirectional telemetry mesh (`sensor.blockingmachine_browser_*`), live rule distribution via Server-Sent Events (`/v1/events`), and remote cosmetic shield toggles.
- **Audit & Database Layer (`blockingmachine-database`)**: Offline JSONL and MongoDB audit logging and rule snapshot rollback engine.

---

## 📦 Downloads & Installation

### Desktop Application (macOS Apple Silicon)

The latest pre-release desktop application is cryptographically signed with an Apple Developer ID (`Greigh Studios LLC (365KR8NF53)`):

| Package / Installer                        | Architecture                | Download                                                                                                                               |
| ------------------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Apple Silicon Disk Image (`.dmg`)**      | macOS `arm64` (M1/M2/M3/M4) | [Download `.dmg`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.5/Blockingmachine-1.0.0-rc.5-arm64.dmg)        |
| **Standalone Application Bundle (`.zip`)** | macOS `arm64` (M1/M2/M3/M4) | [Download `.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.5/Blockingmachine-darwin-arm64-1.0.0-rc.5.zip) |
| **SHA-256 Checksums**                      | All Platforms               | [Download `SHA256SUMS.txt`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.5/SHA256SUMS.txt)                    |

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
npm install @greigh/blockingmachine-core@1.0.0-rc.5 --registry=https://npm.pkg.github.com

# CLI Tool
npm install -g @greigh/blockingmachine-cli@1.0.0-rc.5 --registry=https://npm.pkg.github.com
```

#### From Forgejo Package Registry (`git.greighstudios.com`)

```bash
# Core Library
npm install @blockingmachine/core@1.0.0-rc.5 --registry=https://git.greighstudios.com/api/packages/greighstudios/npm/

# CLI Tool
npm install -g @blockingmachine/cli@1.0.0-rc.5 --registry=https://git.greighstudios.com/api/packages/greighstudios/npm/
```

Direct tarballs are also attached to [Release v1.0.0-rc.5](https://github.com/Greigh/Blockingmachine/releases/tag/v1.0.0-rc.5):

- `blockingmachine-core-1.0.0-rc.5.tgz`
- `blockingmachine-cli-1.0.0-rc.5.tgz`

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

  The most instructive result is that the golden benign set **had to become an allowlist**. 11 of 67 hand-curated benign domains (SSO logins, CDNs — `fonts.gstatic.com` scores 0.99) look exactly like trackers *lexically*: compare it with `cm.g.doubleclick.net` — same depth, same token hit, similar entropy. No lexical model can separate them, so the fix is structural rather than a tuning patch: [ai-weights/allowlist.json](packages/core/ai-weights) (67 domains) is checked **before the model scores**, the same philosophy as the existing `@@` whitelist rules. That is a feature-coverage limit stated honestly, not a threshold to nudge. The v2 behavioral features are the corresponding honest negative: HTTP-level observations (redirects, cookies, TLS) produced **no real lift** (test AP 0.9745 vs 0.9747), because a tracker pixel and a benign endpoint look identical over plain HTTP — the signals that would separate them need JS-execution traces from the daemon. v2 stays experimental and unshipped. The loader validates format, `feature_version` **and feature order** (a reordered list throws instead of silently misrouting weights), and the model **never fails open into blocking**: missing or mismatched weights mean lists-only mode.
- **Second AI Surface — On-Device DOM Element Classifier**: The same embedded engine now classifies **page elements**, not just hostnames, labelling each candidate *Ad*, *Tracker*, *Annoyance* or *Content*. Verdicts are built from independent evidence families (ad markup, ad delivery attributes, ad-network sources, ad ancestors, tracking-pixel geometry, consent/nag markers, social embeds, overlay shape, ad-like sizes, third-party frames) and then **gated by corroboration**: definitive evidence hides (98%), two independent signals hide (84%), one non-shape signal can only *suggest*, and **shape alone never names anything** — a 300×250 rectangle, a third-party frame or the word `banner` is never a fact on its own. A content shield means it never destroys article copy: long text with no definitive evidence is left alone, and an anti-adblock wall is only suggested. Its identifier tokenizer splits camelCase and punctuation, so `admonition`, `adapter`, `download`, `header` and `admin` are never misread as `ad`. The model's **statistical head is fit from the corpus rather than hand-written** (`src/ai/elementWeightFitting.ts`, regenerated with `npm run fit:element-weights`): full-batch Adam on soft-target cross-entropy, with the original hand-tuned table kept as the *centre of a Gaussian prior* — which is what makes fitting 104 parameters from 77 elements safe rather than absurd, and what lets the fit be compared against the thing it replaced. On a deterministic 77/40 stratified split, the fit never sees the held-out cases and still beats the reference on all three head metrics: **accuracy 0.90 → 0.95, cross-entropy 0.2528 → 0.1443, Brier 0.128 → 0.0745, two cases won and zero regressions**. Brier is the one that matters most, being a proper scoring rule on the full label distribution — it cannot be improved by getting more confident without getting more right. The one hyperparameter that matters (prior strength) is selected by *5-fold cross-validation over the training cases* — a single inner split measured the fit's starvation rather than the prior's value, and replacing it moved the chosen strength from 5 to **1** — the accuracy improvement survives the entire prior grid from 1 to 50, and an unregularised fit is clearly the worst candidate under cross-validation (mean fold logLoss 1.0929 against 0.5813), which is how the prior earns its place. A test re-fits the table in-process and fails if the checked-in numbers drift from the corpus, naming the offending weight.

What the fit cost is recorded beside what it bought: a sharper head is better at ranking and slightly less conservative in the confidence it reports, so action-level ECE moves **0.0424 → 0.0444** on the cases where the model acts. Getting that number to mean anything required fixing the metric first — the old form read a `leave` verdict's *class* confidence as a probability that acting would have been right, which is why a `< 0.1` bar had become a knife-edge that no re-fit could beat. It now averages only the **63 of 117** cases where the model acts, restraint is measured by `missedHides` and the action mix, and the guarantee is stated as a regression bound against the hand-tuned reference. Measured on a **117-case** labelled corpus: **100% class accuracy, macro F1 0.967 — zero content destroyed, zero missed hides**. Growing the corpus from 67 cases is what found four rules that were wrong rather than merely untested. The *tag* was never part of the identifier vocabulary, so `<amp-ad>` — an element that exists to serve ads — was read as nothing but a 300×250 rectangle. A compound class scored exactly the same as a bare one, so `class="video-ad"` was only ever suggested while `adunit` hid outright; a compound identifier that **leads or ends** with `ad`/`ads` now names an ad, and position is the guard, because `no-ads-subscription` names an upsell rather than an ad. Push-notification prompts had no marker at all, so a pinned OneSignal opt-in was reported as page copy. And the destructive one: the article-length shield was bypassed by *any* vocabulary match, so `#advertising-policy` and a `sponsored-article-body` were **hidden at 98%, prose and all** — a page about advertising wears the same class word as an ad slot. Only a resource the page cannot be made of (an ad delivery attribute, an ad-network frame) can now overrule long-form prose, and a pinned overlay is exempt from the shield, because a modal is not the page it covers. Running the shipping scanner over five live pages (MDN, the Guardian front page, github.com, nytimes.com, Wikipedia) found five more defects a synthetic corpus had not — a zero-area box read as a 1×1 beacon (33 hides, including Wikipedia's own logo), a path-relative URL parsed as a hostname, a React-generated id named `ad`, and an analytics attribute weighted as strongly as the word `tracker` — and took actionable verdicts on those pages from **109 to 53** with every real detection kept.
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
- **Decision Manager**: The Hub tab lists every paused site and allowed domain with one-click restore, repaired defensively on load so corrupt storage can't wedge the shield.
- **Rule Hit Ledger**: Every request the browser blocks is attributed back to the filter line that produced it — resolving dynamic rules from the live list and static tier rules from the shipped ruleset files — and counted per rule in a bounded, batched ledger that survives service-worker restarts. It is the only measurement of list efficiency that reflects real path- and type-aware matching rather than a hostname approximation, and it is exported ready for `blockingmachine coverage --hits`. It works on a packed install too: Chrome exposes the live `onRuleMatchedDebug` event to *unpacked* extensions only, so a packed build is reconciled through `getMatchedRules` instead — on demand when the popup asks for a tab's telemetry (opening the popup is a user gesture, which both grants `activeTab` for that tab and exempts the call from Chrome's 20-calls-per-10-minutes quota) and on a budgeted background tick. Because that API withholds the request URL, a match is attributed there to the tab and the rule that fired, with the blocked host inferred from that rule's own anchor; when the extension is unpacked, the live event still supplies exact URLs and initiators.
- **Static Tiers Compiled From Your Own Blocklist at Package Time**: Left alone the tier files carry a ~118-rule hand-curated baseline, so a release shipped ~118 static rules while the Hub on the same machine had already compiled a six-figure blocklist. `npm run package:extension` now runs `scripts/compile-tier-rulesets.mjs` first and compiles the Hub's active blocklist into the tier files, so a packaged build carries the synced list. The budget is the whole problem: MV3 guarantees an extension only **30,000 static rules across its *enabled* rulesets**, and the Hub's list is **122,801 distinct hosts**, so "ship everything" is not achievable and a script that pretended otherwise would either drop most of the input silently or produce an extension Chrome refuses to load. The compiler therefore fills the four tiers to a shared 30,000-rule ceiling — keeping the invariant that *any* combination of enabled tiers still installs — **redistributes unspent capacity in proportion** to what each tier is still holding (serving tiers in order instead poured every freed slot into the first tier and starved the other three), and reports exactly what shipped and what overflowed on every run. In practice it compiles **743,634 lines → 122,801 hosts → 30,000 rules shipped, 92,811 omitted**, with the overflow stated rather than hidden. Point `--input tier_ads=list.txt` at a source to attribute a whole list to a tier exactly instead of classifying it, and `--residual <tier>` to choose where hosts matching no vocabulary land — the default is an *opt-in* tier on purpose, because most of a merged blocklist matches nothing and parking thousands of unclassified hosts in the default-on tier would silently change what every user blocks. Curated hosts are read from the files already on disk and are never lost or re-tiered, so compiling is purely additive; `--check` fails a release whose tiers are stale, and `--skip-tiers` ships the baseline instead. The real counts are written into the bundle, so the popup's "slots free" readout stays truthful after packaging instead of reporting the baseline.
- **Static Rule Tiers**: The extension carries rules in both forms Manifest V3 allows. Synced lists feed the **dynamic** ruleset (subject to the 30,000 dynamic quota the sync pipeline watermarks against); a curated baseline ships as **static** rulesets declared in the manifest, which the browser loads from disk and which the user can switch on and off at runtime — *Core shield*, *Ad networks*, *Tracking & analytics*, and *Consent & nags*, each with its own rule count and a live "slots free" readout in the Hub tab. The point is capacity: a disabled tier consumes no rule budget at all, so the extension's reach is the dynamic quota **plus** whichever tiers are on, and a tier adds blocking the quota has no room for. Every tier ships only bottom-priority **block** rules, which is what guarantees a synced exception (priority 2), a site pause (1000), or your own allowance (500) always outranks anything a tier ships — a shipped ruleset can never override your decision. Both halves matter: static rules lose priority *ties* to dynamic and session rules, but priorities are compared across every match, so a static `allow` parked at priority 2 would still beat a dynamic block at 1 and let a shipped list override the extension's own blocking. A test walks the shipped tier files for both properties, and the MV3 compliance script re-checks them on the bytes Chrome actually parses, so a bad tier fails the release rather than shipping. Toggling a tier writes the new selection to storage and then reconciles it against the browser's own enabled-rulesets state, which is read on every service-worker start, on every rule application, and before every pause or resume — so the choice survives restarts and, more importantly, **repairs itself**: an extension update puts the browser back on the manifest defaults, and reconciling by reading the browser rather than blindly re-issuing is what turns those tiers back on instead of leaving the popup reporting tiers that are actually switched off; **Pause everywhere** silences every tier as well as the dynamic rules (your selection is remembered and returns on resume) while pausing a single site already outranks the tiers through its `allowAllRequests` rule.
- **Capacity-Aware Tier Planner**: "Enable everything" is only the right answer while the browser grants the whole static budget, and that is not guaranteed — Chrome's 30,000 static rules is a *floor* drawn from a pool shared with every other installed extension, so a congested browser grants less than the extension ships and the tiers have to compete for what remains. `planTierSelection` in `src/shared/tierPlanner.ts` makes that choice. It derives live capacity from `getAvailableStaticRuleCount()`, which reports what can still be *added*, so capacity is what is already enabled **plus** that figure — and it falls back to the guaranteed 30,000 when the browser declines to answer, which is the figure the tier files are compiled against. It then enumerates every subset of the tiers exactly rather than greedily by benefit density: measured in the suite, a 600-rule tier worth 500 benefit beats two 500-rule tiers worth 490 each, and a greedy pass loses to it — the same ordering bug the packaging compiler's redistribution once had. Ties break toward *fewer rules used*, so a plan leaves static headroom for the next compilation instead of sitting flush against the ceiling, and then by catalogue order so the same input always yields the same plan. Benefit defaults to coverage, because for a blocklist a rule is a host and a host is blocking; a caller holding measured evidence (the rule-hit ledger attributes real blocks to the rules that fired) can supply a `benefit` per tier instead. The two bases are never blended — a blend would silently make an unmeasured tier look worthless — and the plan states which one it used. Pinned tiers are a user decision, not a suggestion, so they are honoured even when they overshoot, with the overshoot surfaced rather than quietly discarded. The popup renders a **Recommended plan** card with the one-line summary, an *Apply* button that appears only when the plan differs from the current selection, and the tradeoff explained in prose: which budget is binding, why each excluded tier lost, and how many slots stay free. The explanation distinguishes two failures that read as nonsense when conflated — a tier larger than the entire budget *on its own* is unfixable rather than unlucky ("23,523 rules against 12,033 slots"), while a tier that fits alone but not alongside what was kept reports its exact shortfall — and it only calls the dynamic budget "the tight one" when the dynamic budget is what actually forced the plan, since claiming it while the static budget was binding would contradict the recommendation above it. Measured on a congested pool granting 12,033 slots against a 30,000-rule compilation: **6,477 of 30,000 rules fit — *Core shield*, *Tracking & analytics* and *Consent & nags* stay on; *Ad networks* (23,523 rules) is dropped as larger than the whole budget on its own**, and 5,556 static slots stay free. The planner is pure — no `chrome.*`, no clock — so the recommendation and the sentence explaining it are both asserted in tests.
- **Per-Tier Block Attribution**: A tier toggle used to be a blind bet. The popup reported how many *rules* each tier shipped, which says nothing about whether those rules were doing anything — a tier carrying 23,523 rules that never matched once looked identical to one earning its slots, and the owner had no basis to drop it. The rule-hit ledger now records which **ruleset** produced each block, and because a tier's ruleset id *is* its tier id, that attribution is exact rather than inferred: no hostname guessing, and it works in a packed build too, where Chrome withholds the request URL but still names the ruleset. A match is credited to its tier even when the tier's rule file could not be read for the filter-level histogram, so the tier tally is deliberately the *more* complete of the two readings, and the two live side by side — the histogram stays keyed by filter line for `blockingmachine coverage --hits`, while a filter that ships in two tiers correctly lands in two tier entries and only one histogram entry. Each tier row now reports what it has actually blocked (`1,204 blocked · 62% of all tier blocks`), and once the ledger has enough traffic to mean something a tier that has still never fired is called out as **Never fired** with a one-click **Turn off** that frees its slots. The restraint is the whole point: a silent tier is reported as merely **unproven** — never idle — until the ledger has seen fifty matches, because a tier that was just switched on or happened to run through a quiet session has not been given a chance, and a tier that is *already off* is never called idle at all, since being off is precisely why it has no matches. Acting on a false idle verdict would switch off blocking that was working, which is the expensive direction to be wrong in. Switching a tier on clears its stale counts, so the verdict describes the window the tier has actually had rather than a match it once made months ago; re-applying a selection that leaves a tier enabled keeps its history intact, so applying a capacity plan does not wipe the attribution of every tier it keeps. The tier tally is persisted under its own storage key and only written once a tier has actually fired, so a ledger that has never seen a static block keeps the exact shape older builds read.
- **The Shipped Tiers Are Graded Against the Model That Ships With Them**: The extension carries two bodies of knowledge about what is worth blocking — a hand-curated static blocklist and the embedded Mini-AI classifier — and nothing stopped the two from drifting apart. When they drift, the result is a contradiction the user can see: the extension blocks a host while the AI Radar it also ships calls that same host clean. A new suite runs **every domain in the shipped tier files** through the classifier and fails on the disagreement. It passes today, and the shape of what it *tolerates* is the finding: across all 118 curated hosts the model **never contradicts a tier** — not one ad host called a tracker, not one tracker called malware — and instead fails to place 46 of them (12 ad, 13 privacy and 21 annoyance hosts), always as `Clean` and always at 74–88%, under the 90% mark past which a clean verdict is an assertion rather than a shrug. That is the same weak band the triage cascade escalates, so those hosts are that cascade's documented reason for existing rather than a flaw in the list. `Core shield` gets no such latitude, because it ships enabled: all 24 of its hosts are recognised, and a single gap fails the suite. `Consent & nags` is the vocabulary gap in its purest form — 21 of its 22 hosts have no word in the classifier's category set at all, because there is no "annoyance" category to have, which is precisely why that tier ships disabled. The disagreements are **pinned rather than the assertion loosened**, and enforced in both directions: a host added to a tier the model cannot account for fails the suite, and so does a model that has learned a host it used to miss — a bug list that cannot go stale is a bug list nobody trusts. When the tier files are a hub compilation written by `npm run package:extension` the strict grading is reported as *skipped* rather than passing without having checked anything: the model's blind spot covers roughly a third of a real blocklist, so demanding agreement with an arbitrary slice of someone's list would fail for a reason nobody can act on, and the size-independent guarantees — the curated Core hosts are still recognised, and the always-on tier still ships nothing the model considers malicious — are asserted in its place.

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
- **Shadowrocket Rule Set Feed**: A first-class platform tab for the iOS/iPadOS client, which cannot read an AdGuard or hosts list at all. The export now emits a real Surge-style rule set — `DOMAIN-SUFFIX,host,REJECT` lines under the `[Rule]` section the app reads rules from — and the pane hands over the LAN feed URL with the numbered setup steps, a warning naming the current format when the configured export would write something else instead, and a note that a child bypass is emitted *before* the parent block it escapes because the rule set is first-match-wins.
- **Privoxy Action-File Feed**: A platform tab for the Privoxy filtering proxy, which reads a **section-based action file** rather than a list — every URL pattern belongs to the `{+block{…}}` block above it. The export emits that shape (host patterns with the leading dot that covers subdomains) and the pane hands over the feed URL with the `actionsfile` line to paste, the numbered steps, and the one property that is not obvious from a copy of the list: Privoxy applies the *last* matching action, so an allowed child is emitted in a `{-block}` section *after* the parent block it escapes.
- **BIND Response Policy Zone**: A platform tab for BIND, which has no remote blocklist feature and no per-domain zone list. The export is a real RPZ — one `CNAME` policy record per blocked name, plus the SOA a primary zone cannot load without — and the pane hands over the zone-stanza and `response-policy` lines `named.conf` needs, the `rndc` reload, and the honest note that this one is a local file to copy rather than a feed to subscribe.
- **Built-in Local Feed Server**: Serves compiled blocklists on your local network (e.g. `http://localhost:9191/rules.txt`, `/dns.txt`, `/browser.txt`, `/unbound.conf`) for automatic appliance polling.

### 🔌 Unbound Reachability Check (`⌘8` → Unbound)

A recipe that is correct is not a deployment that works. Three things have to be true for Unbound to actually block, and they fail independently — the hub serves a usable drop-in, something on the resolver host fetches it, and Unbound reloads it. The pane's check reports which one is missing instead of leaving users to guess from an empty list.

| What is checked | How | What a failure means |
| :--- | :--- | :--- |
| **Served** | The hub fetches its own feed URL and parses the body | The address in the recipe answers nothing, or answers with a file that has no `local-zone` statements — an AdGuard export under a `.conf` name loads without error and blocks nothing |
| **Fetched** | The feed server records every 2xx serve of the drop-in, with peer and user agent | Nothing has requested the file since the hub started, so the scheduled `curl` is not running |
| **Reloaded** | A DNS query for a domain *taken from the drop-in the resolver was just served*, plus a control name and a reference resolver | The resolver answered normally for a name its own file blocks, so the `include:` line or the reload is missing |

Three details make the third check trustworthy rather than decorative. The canary is chosen from the served artifact — shortest registrable domain — so a pass cannot be an artefact of the wrong file. A control query (`example.com`) must resolve before any NXDOMAIN counts, so a resolver that refuses names that should resolve is reported as **inconclusive** rather than as a working blocklist, and a refused or timed-out connection is **unreachable** rather than "not loaded". And the canary is confirmed to **exist somewhere else** before its NXDOMAIN is read as proof, because a domain that was never registered answers identically to one the drop-in blocks — so the same name is looked up on a second resolver (this machine's own configured DNS by default, or an address you set; never the resolver under test). Without a reference, or with one that cannot answer, the verdict is **canary-unconfirmed** rather than live; if the reference shows the name resolves nowhere, it is **canary-nonexistent**. The reference is queried with the canary name once per check, which is the cost of the confirmation — leave it empty to keep every query local and accept an unconfirmed verdict.

Verdicts name the fix — feed not answering, wrong format, nothing fetching, `include`/reload missing, resolver unreachable, canary unconfirmed or nonexistent, or **stale**: blocking live with a copy older than the last compile. The last confirmed-live time and the newest known fetch are persisted, so opening the pane reports the deployment's history without firing a DNS query on tab switch. The probe identifies itself with a header, so its own fetch never counts as the evidence it is looking for.

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
| **BIND**           | `example.com CNAME .` (RPZ record)         | BIND 9.8+ `named` — Response Policy Zone          |
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

# Measure how much of the compiled list real browsing actually matched
blockingmachine coverage --trace requests.txt

# Same analysis from the browser's own rule-hit ledger (path- and type-aware)
blockingmachine coverage --hits rule-hits.txt

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
`resourceTypes` or a response rewrite). Only the first is decidable from a hostname. The command
reports all four counts, measures the hit rate over the hostname-decidable bucket alone, and in a
replay keeps the other three out of *both* the numerator and the denominator, listing what they
fired as their own tallies. That is what stops the figure from being an upper bound: a path-scoped
rule read as a zone-wide block used to be credited with a hit it had not earned.

Measured against the compiled browser export in this repository (**249,751 lines**: 118,379
hostname-decidable blocking rules, 4,224 initiator-scoped, 7,628 path-scoped, 1,855 request-scoped,
and 4,106 exceptions) across a real 11-page browsing session (Wikipedia, BBC News, GSMArena, The
Guardian, CNN, Allrecipes, IMDb, Stack Overflow, Speedtest, Forbes, MDN; 232 requests over 178
distinct hosts):

| Measure | Result |
| :--- | :--- |
| Rules that fired | **70 of 118,379** (0.059%) |
| Dead weight | **99.941%** of the hostname-decidable list never fired |
| Rules for 50% of blocks | 17 |
| Rules for 95% of blocks | **64** |
| Rules for 99% of blocks | **69** (0.058% of the list) |
| Distinct hosts blocked | 85 of 178 (47.8%) |

The split changes the answer rather than decorating it. The session fired 71 rules when a
path-scoped rule counted as a host block; one of those was a path rule that won on 5 requests while
its path was never checked, so the honest figure is 70 hostname-decidable rules — the excluded fire
is reported beside the rate instead of inside it.

The honest reading: against a six-figure list, a real browsing session touches a rounding error of
it — so the list is best understood as a hot set in the low tens of rules (70 here) plus ~118,000
lines of insurance. The one limit the tool cannot remove is stated rather than buried: a domain-only
replay cannot see redirects or initiators at all, which is exactly why the extension records the
rule the browser *actually* matched, and why `--hits` takes that ledger in preference to a replay.

**Read the numbers as a floor, not a constant.** The session is eleven pages from one machine — a
small, content-heavy sample — and the head of the list grows as coverage grows, so a longer or
busier session fires more rules and adds more hot rules. The trace also records each request as
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

Measured against the same 11-page session, the two lists are indistinguishable on the traffic the
hot set was derived from:

| List | Rules | Blocked | Allowlisted | Rules that fired |
| :--- | ---: | :--- | :--- | :--- |
| compiled export | 249,751 lines (118,379 decidable) | **132 requests on 85 hosts** | 11 hosts / 6 rules | 70 |
| `hotlist.txt` | **77 rules** | **132 requests on 85 hosts** | 11 hosts / 6 rules | **70 of 70 (100%)** |

Same hosts, same requests, same allow decisions — and the trimmed list holds no rule that did not
earn its place: **0% dead weight** against 99.941%. The 77 rules are a floor as well: they are the
winners of one short session, so a longer one adds hot rules rather than removing them (the
page-split check below is what keeps that from being taken on faith).

**It is not a general blocklist, and the measurement says so.** Deriving a hot set from half the
session's pages and measuring it on the other half keeps only **38 of 93 blocks (40.9%)** — a
per-session hot set is exact for the traffic it came from and loses most of what it has not seen.
That is why it ships as an opt-in trimmed default for a budget that cannot hold the full list, with
the limitation printed in the file's own header, rather than as a replacement for the full export.
Deriving it from a browser-reported ledger aggregated across many sessions is what would move that
number; the page split is the check that keeps the claim honest until then.

---

## Quality Assurance & Testing

Blockingmachine maintains a strict **100% test pass rate** with **0 ESLint errors and 0 warnings** across all monorepo packages:

```bash
# Run all 1,248 automated tests across the monorepo (67 Jest suites + the HA Python suite)
npm test

# Run tests with open handle leak detection
npm test --workspace=@blockingmachine/core -- --detectOpenHandles

# Run linter across all workspaces
npm run lint

# Validate TypeScript typing across all packages
npm run type-check

# Compile the desktop Hub's active blocklist into the extension's static tier files
npm run compile:tiers

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
