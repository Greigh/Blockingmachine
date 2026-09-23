<div align="center">
  <img src="https://raw.githubusercontent.com/Greigh/Blockingmachine/main/assets/Blockingmachine.png" width="160" alt="Blockingmachine Logo" />

# Blockingmachine

[![License](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/Release-v1.0.0--rc.2-orange.svg)](https://github.com/greigh/Blockingmachine/releases)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24.0.0-339933.svg)](https://nodejs.org/)
[![Built with Electron](https://img.shields.io/badge/Built%20with-Electron%2044-47848F.svg)](https://www.electronjs.org/)
[![Written in TypeScript](https://img.shields.io/badge/Written%20in-TypeScript%205.8-3178C6.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-357%20Passing%20(100%25)-brightgreen.svg)](https://github.com/greigh/Blockingmachine/actions)
[![Code Quality](https://img.shields.io/badge/ESLint-0%20Warnings-blueviolet.svg)]()

_High-performance adblock compiler, DNS rule deduplicator, and AI-powered network defense suite for Pi-hole, AdGuard Home, and modern desktops._

</div>

---

## Overview

**Blockingmachine** is an advanced, production-grade monorepo engineered to unify high-speed adblock and DNS filter list compilation, homelab sinkhole synchronization, and machine-learning threat intelligence into a coherent, privacy-first desktop and CLI ecosystem.

Designed for network administrators, homelab enthusiasts, and privacy advocates, Blockingmachine processes millions of filter rules in milliseconds, eliminates redundant subdomains, detects zero-day algorithmic ad trackers through an embedded on-device neural classifier, and automatically deploys compiled blocklists directly to local DNS appliances.

### Monorepo Workspaces

- **Desktop Application (`@blockingmachine/electron-app`)**: Native macOS/Linux/Windows Electron application featuring the **Unified Rule & AI Inspector**, **AI Defense Radar**, **Deploy & Sync Hub**, **Defense Modules**, and **Compiled Rule Browser**.
- **Core Engine (`@blockingmachine/core`)**: High-performance, zero-dependency filter rule parser, hierarchy-aware subdomain deduplicator, multi-format export compiler, Shannon entropy analyzer, CNAME uncloaking resolver, and embedded Mini-AI classification engine.
- **Command Line Interface (`@blockingmachine/cli`)**: Autonomous CLI binary (`blockingmachine`) for CI/CD compilation pipelines, automated homelab cron tasks, local feed serving, diffing, and DNS diagnostics.
- **Audit & Database Layer (`blockingmachine-database`)**: Offline JSONL and MongoDB audit logging and rule snapshot rollback engine.

---

## Key Features

### 🔍 Unified Rule & AI Inspector (`⌘5`)
- **Simultaneous Static & AI Evaluation**: Instantly assesses any domain or URL against your active compiled filter lists while simultaneously running live AI threat heuristics.
- **Heuristic Threat Profiling**: Measures lexical Shannon entropy ($H(X)$), detects algorithmic Domain Generation Algorithms (DGA), resolves multi-hop CNAME cloaking aliases, and breaks down mathematical feature weights.
- **Multi-Format Rule Synthesizer**: Generates syntax-perfect blocking rules in Universal (`||domain^`), AdGuard (`||domain^$important`), Pi-hole regex, uBlock Origin, Unbound, or Hosts format.
- **1-Click Actions**: One-click **Add to Custom Rules**, **Whitelist (`@@`)**, rule clipboard copying, and Mini-AI feedback tuning (*Confirm Threat* / *Mark Safe*).

### 📡 AI Defense Radar Hub (`⌘9`)
- **Sinkhole Query Scout**: Connects directly to AdGuard Home or Pi-hole to inspect recent DNS query logs for anomalous, uncategorized ad beacons and tracking telemetry.
- **Subdomain Compaction Engine**: Collapses swarms of ephemeral subdomains into clean parent zone wildcard rules to prevent list bloat.
- **Web Canary Crawler**: Proactively crawls target URLs to audit and extract third-party trackers, beacons, and programmatic ad auctions before you visit them.
- **Threat Quarantine Ledger**: Centralized persistent ledger tracking intercepted threats with category filtering, batch exports (ABP, Hosts, JSON), and one-click firewall blocking.

### 🧠 Centralized AI Engine & Sentinel Watchdog (Preferences `⌘,`)
- **Built-in Mini-AI Classifier (Recommended)**: Embedded 25-feature mathematical neural network running completely on-device in **<0.05ms** with zero daemons, zero cloud telemetry, and zero network overhead.
- **Flexible Provider Support**:
  - **Local Heuristics**: Pure offline Shannon entropy, token decomposition, and CNAME uncloaking.
  - **Ollama Local LLM**: Air-gapped on-device neural models (`llama3.2`, `mistral`, `qwen2.5`, `deepseek-r1`).
  - **Google Gemini Flash**: Deep pattern reasoning via Gemini 2.0 Flash.
  - **OpenAI / Custom Server**: Full compatibility with OpenAI, Groq, LM Studio, OpenRouter, and custom endpoints.
- **Sentinel Watchdog Automation**: Automated background threat hunting that periodically sweeps homelab DNS logs at customizable intervals (15m to 24h) and populates the Quarantine Ledger.
- **Active Feedback Memory**: Tracks user corrections to refine heuristic weights over time, with one-click memory reset.

### 🛡️ First-Party Curated Defense Modules (`⌘3`)
Pre-packaged, modular filter list engine modeled after modern ad-blocking architecture:
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
- **Built-in Local Feed Server**: Serves compiled blocklists on your local network (e.g. `http://localhost:9191/rules.txt`) for automatic appliance polling.

---

## Keyboard Shortcuts Matrix

Blockingmachine provides seamless native navigation via macOS menu accelerators and sidebar shortcuts:

| Shortcut | View | Purpose |
| :---: | :--- | :--- |
| `⌘1` | **Process & Stats** | Dashboard, compile metrics, feed status, and instant compilation trigger |
| `⌘2` | **Sources** | Manage remote filter list subscriptions, feed toggles, and health checks |
| `⌘3` | **Defense Modules** | First-party curated shields (Smart TV, Telemetry, Annoyances, Privacy) |
| `⌘4` | **Custom Rules** | Custom domain blocks, whitelist exceptions (`@@`), and syntax validation |
| `⌘5` | **Rule & AI Inspector** | Simultaneous filter rule matching and live AI heuristic threat analysis |
| `⌘6` | **Rule Browser** | Search, filter, and paginate through tens of thousands of active compiled rules |
| `⌘7` | **Bulk Import** | Add multiple feed URLs simultaneously or import text files via drag-and-drop |
| `⌘8` | **Deploy & Sync** | Push compiled lists to Pi-hole, AdGuard Home, and homelab webhooks |
| `⌘9` | **AI Radar Hub** | Homelab Sinkhole Scout, Web Canary Crawler, and Threat Quarantine Ledger |
| `⌘,` | **Preferences** | Output formats, directory paths, AI engines, Watchdog, and accent colors |
| `⌘R` | **Compile Now** | Global trigger to compile and deduplicate all active filter lists |

---

## Monorepo Architecture

```
Blockingmachine/
├── packages/
│   ├── core/           # @blockingmachine/core (Compiler, deduplicator, parsers, Mini-AI engine)
│   ├── cli/            # @blockingmachine/cli (CLI binary, local feed server, diffing, doctor)
│   ├── electron-app/   # @blockingmachine/electron-app (Desktop suite, Deploy Hub, AI Radar)
│   └── database/       # Snapshot rollback engine and audit logging schemas
├── package.json        # Root npm workspaces configuration (Node.js >= 24.0.0)
└── README.md
```

---

## Supported Export Formats

| Format | Syntax Example | Target Platform / Resolver |
| :--- | :--- | :--- |
| **AdGuard Home** | `||example.com^` | AdGuard Home, AdGuard DNS, AdGuard apps |
| **AdBlock Plus** | `||example.com^$third-party` | uBlock Origin, Brave Browser, browser extensions |
| **Standard Hosts** | `0.0.0.0 example.com` | System `/etc/hosts`, Pi-hole, standard DNS |
| **dnsmasq** | `address=/example.com/0.0.0.0` | OpenWrt, DD-WRT, pfSense, dnsmasq |
| **Unbound** | `local-zone: "example.com" static` | OPNsense, pfSense, Unbound DNS resolvers |
| **Plain Domains** | `example.com` | Minimalist domain blocklists, Pi-hole domain lists |

---

## Prerequisites

To build and run Blockingmachine from source, ensure your environment meets the following requirements:

- **Node.js**: `v24.0.0` or higher
- **npm**: `v10.0.0` or higher
- **Git**: Installed and available in your system `PATH`
- **Build Tools**: Standard C/C++ compilation tools for native modules:
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
npm install
```

### 3. Build All Workspaces
Compile the core TypeScript engine, CLI binaries, and Electron Webpack bundles:
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

# Or link globally for system-wide access
cd packages/cli && npm link

# Scan a suspect domain using the built-in Mini-AI classifier
blockingmachine ai-scan doubleclick.net

# Scan a domain using a local Ollama LLM
blockingmachine ai-scan tracking-bidder.biz --provider ollama --model llama3.2

# Crawl a webpage for third-party ad beacons and trackers
blockingmachine ai-crawl https://example-news-site.com

# Verify whether a domain is blocked by your compiled filter list
blockingmachine test malware-c2-domain.com

# Compare rule differences between two compiled blocklist snapshots
blockingmachine diff baseline-rules.txt updated-rules.txt

# Launch local HTTP subscription feed server for network clients
blockingmachine serve --port 9191

# Run system diagnostic health check
blockingmachine doctor
```

---

## Quality Assurance & Testing

Blockingmachine maintains a strict **100% test pass rate** with **0 ESLint errors and 0 warnings** across all monorepo packages:

```bash
# Run all 185 automated tests across the monorepo
npm test

# Run tests with open handle leak detection
npm test --workspace=@blockingmachine/core -- --detectOpenHandles

# Run linter across all workspaces
npm run lint

# Validate TypeScript typing across all packages
npm run build
```

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
  <sub>Designed and engineered by <a href="https://danielhipskind.com/">Daniel Hipskind</a>.</sub>
</div>
