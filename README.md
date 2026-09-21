<div align="center">
  <img src="https://raw.githubusercontent.com/Greigh/Blockingmachine/main/assets/Blockingmachine.png" width="180" alt="Blockingmachine Logo" />

# Blockingmachine

[![License](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](LICENSE)
[![Release](https://img.shields.io/badge/Release-v1.0.0--beta.9-orange.svg)](https://github.com/greigh/Blockingmachine/releases)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24.0.0-339933.svg)](https://nodejs.org/)
[![Built with Electron](https://img.shields.io/badge/Built%20with-Electron-47848F.svg)](https://www.electronjs.org/)
[![Written in TypeScript](https://img.shields.io/badge/Written%20in-TypeScript-3178C6.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-173%20Passing-brightgreen.svg)]()

_Next-generation network-level ad blocking, telemetry defense, and AI-powered filter synthesis for homelabs and desktops._

</div>

---

## Overview

**Blockingmachine** is a modern, modular monorepo that unifies high-performance filter list compilation, homelab sinkhole deployment (AdGuard Home, Pi-hole), and machine-learning heuristic ad/telemetry discovery into an integrated ecosystem:

- **Desktop Application (`@blockingmachine/electron-app`)**: A cross-platform Electron + React desktop suite featuring the **AI Defense Radar**, **Deploy Hub**, **Defense Modules [Beta]**, and **Rule Browser**.
- **Core Engine (`@blockingmachine/core`)**: Zero-dependency filter rule parser, hierarchy-aware subdomain deduplicator, ABP/AdGuard/Hosts export formatters, Shannon entropy analyzer, and CNAME uncloaker.
- **CLI (`@blockingmachine/cli`)**: Production command-line tool (`blockingmachine`) for automated CI/CD pipelines, local feed servers, diffing, and DNS diagnostics.
- **Database & Audit Layer (`blockingmachine-database`)**: Offline JSONL and MongoDB audit logging and rule snapshot rollback engine.

---

## Monorepo Architecture

```
Blockingmachine/
├── packages/
│   ├── core/           # @blockingmachine/core (Rule engine, parsers, AI heuristic engine)
│   ├── cli/            # @blockingmachine/cli (CLI binary, local server, diffing, diagnostics)
│   ├── electron-app/   # @blockingmachine/electron-app (Desktop GUI, Deploy Hub, AI Radar)
│   └── database/       # Database schemas, scripts, and snapshot management
├── package.json        # Root npm workspaces configuration (Node.js >= 24.0.0)
└── README.md
```

---

## Key Features

### 📡 AI Defense Radar [Beta] (⌘9)
- **Autonomous Ad & Tracker Discovery**: Combines Shannon entropy calculation ($H(X)$), DGA machine-generated hostname detection, CNAME cloaking unmasking, and multi-provider LLM reasoning (local offline Ollama, Google Gemini, OpenAI).
- **False Positive Guard**: Built-in whitelist protection for essential infrastructure (Cloudflare, CDNs, GitHub, Google/Apple identity providers) and custom user allowlists.
- **AI Sentinel Watchdog**: Periodic background query scout that silently inspects unblocked queries from your homelab sinkhole and quarantines emerging ad bidding hosts.
- **Threat Quarantine Ledger**: Persistent ledger with category filtering, batch exports (ABP, Hosts, JSON), 1-click blocking, and false-positive whitelisting.
- **Web Canary Crawler**: Crawls web pages to identify and flag third-party ad networks and telemetry beacons before you browse them.
- **SSRF Hardened & Memory Safe**: Strict RFC 1918, loopback, and metadata address blocking with response stream limits to prevent resource exhaustion.

### 🛡️ The 8-Part First-Party Defense Suite [Beta] (⌘8)
Modular, curated blocking profiles synchronized across desktop, core, and CLI:
1. **Base Ad Shield**: Network blocking for major ad exchanges, programmatic bidding, and banner injection.
2. **Privacy Engine**: Web beacons, browser fingerprinting, and analytics telemetry neutralizer.
3. **Smart TV & IoT Shield**: ACR telemetry and ad blocker for Roku, Samsung Tizen, LG webOS, Fire TV, and smart speakers.
4. **Web Annoyances & Cookie Banners**: Eliminates GDPR cookie prompts, CMP modals (OneTrust, Cookiebot), and floating nags.
5. **Social Tracker Neutralizer**: Cross-site tracking beacons and pixels (Meta, TikTok, X, LinkedIn).
6. **Threat & Malicious Domain Defense**: Malicious drive-by payloads, phishing gateways, and cryptominers.
7. **URL Tracking Stripper**: Strips link tracking parameters (`fbclid`, `gclid`, `utm_*`, `twclid`).
8. **Unbreak & Safe Exceptions**: Hand-crafted allowlist rules (`@@`) for banking, SSO logins, and DRM streaming playback.

### 🚀 Deploy Hub (⌘6)
- **AdGuard Home Integration**: Push compiled blocklists directly to AdGuard Home instances via REST API with live status checks.
- **Pi-hole Integration**: Sync blocklists directly to Pi-hole gravity databases via API.
- **High-Availability (HA) SSH Sync**: Synchronize secondary or redundant Pi-hole / AdGuard nodes over SSH with automated gravity updates.
- **Custom Webhook Dispatch**: Trigger router updates or CI/CD pipelines via HMAC-signed webhooks.
- **Built-in Local Feed Server**: Host your compiled rules on `http://localhost:9191/rules.txt` for automatic router updates.

### 🔍 Rule Browser & Inspector (⌘7)
- Search through tens of thousands of active rules with instant filtering.
- Visual breakdown of blocking, exception (`@@`), and cosmetic (`##`) rules.
- **Live Domain Diagnostic**: Test any domain to see whether it is blocked, allowed by an exception, or unblocked, with the exact matching rule highlighted.

---

## Prerequisites

To build and run Blockingmachine from source, ensure your machine has:

- **Node.js**: `v24.0.0` or higher (required by `package.json` engines)
- **npm**: `v10.0.0` or higher
- **Git**: Installed and available in your `PATH`
- **Build Tools**: Standard C/C++ compilation tools (for native node modules like `@parcel/watcher`):
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux (Ubuntu/Debian)**: `sudo apt-get install build-essential python3`
  - **Windows**: Visual Studio C++ Build Tools or `windows-build-tools`

---

## Installing & Building From Scratch

### 1. Clone the Repository
```bash
git clone https://github.com/greigh/Blockingmachine.git
cd Blockingmachine
```

### 2. Install Monorepo Dependencies
Install all workspace dependencies from the root directory:
```bash
npm install
```

### 3. Build All Packages
Compile the TypeScript core, CLI tools, and Electron Webpack bundles:
```bash
npm run build
```

### 4. Run the Desktop Application
Launch the Electron desktop application in development mode:
```bash
npm start
```

### 5. Run the CLI Tool
Link or run the CLI command directly from the monorepo:
```bash
# Direct execution via npm workspace
npx --workspace=@blockingmachine/cli blockingmachine --help

# Or link globally
cd packages/cli
npm link
blockingmachine --help
```

---

## CLI Usage Guide

The `@blockingmachine/cli` provides full command-line access to all features:

```bash
# Scan a domain with AI Radar (local heuristics)
blockingmachine ai-scan doubleclick.net

# Scan using local Ollama LLM
blockingmachine ai-scan suspicious-bidder.com --provider ollama --model llama3.2

# Crawl a webpage for outbound ad trackers and beacons
blockingmachine ai-crawl https://example-news.com

# Inspect if a domain is blocked by your compiled filter list
blockingmachine test malware-domain.com

# Compare changes between two filter list snapshots
blockingmachine diff baseline-rules.txt updated-rules.txt

# Start local HTTP subscription feed server
blockingmachine serve --port 9191

# Run system diagnostic health check
blockingmachine doctor
```

---

## Testing & Quality Assurance

Blockingmachine maintains a strict 100% pass rate with zero ESLint warnings across all workspaces:

```bash
# Run all 173 automated tests across the monorepo
npm test

# Run tests with open handle detection (verifies 0 leaks)
npm test --workspace=@blockingmachine/core -- --detectOpenHandles

# Run linter across all workspaces
npm run lint

# Build production packages
npm run build
```

---

## Supported Export Formats

| Format | Syntax Example | Primary Target |
| :--- | :--- | :--- |
| **AdGuard Home** | `\|\|example.com^` | AdGuard Home, AdGuard DNS |
| **AdBlock Plus** | `\|\|example.com^$third-party` | uBlock Origin, Brave, ABP |
| **Standard Hosts** | `0.0.0.0 example.com` | System `/etc/hosts`, Pi-hole |
| **dnsmasq** | `address=/example.com/0.0.0.0` | OpenWrt, DD-WRT, dnsmasq |
| **Unbound** | `local-zone: "example.com" static` | OPNsense, pfSense, Unbound |
| **Domains List** | `example.com` | Plain domain sinkholes |

---

## Optional Integrations

- **Local AI (Ollama)**: Install [Ollama](https://ollama.ai/) (`ollama pull llama3.2`) for 100% offline private LLM reasoning.
- **Homelab Sinkholes**: Connect [AdGuard Home](https://adguard.com/adguard-home.html) or [Pi-hole](https://pi-hole.net/) via the Deploy Hub.
- **Cloud AI**: Optional Google Gemini or OpenAI API keys can be entered in AI Radar Settings.

---

## Contributing

We welcome contributions! Please ensure:
1. All changes include tests in the appropriate `__tests__` directory.
2. Code passes `npm run lint` with **0 errors and 0 warnings**.
3. Code compiles with `npm run build`.

---

## License

This project is licensed under the **BSD-3-Clause License**. See the [LICENSE](LICENSE) file for details.

<div align="center">
  <sub>Engineered with precision by <a href="https://danielhipskind.com/">Daniel Hipskind</a>.</sub>
</div>
