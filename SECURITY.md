# Security Policy

The Blockingmachine team takes the security and integrity of our software, network proxies, browser extensions, and user privacy extremely seriously. We appreciate the efforts of security researchers and community members in helping us maintain a robust security posture across all components of the ecosystem.

---

## 1. Supported Versions

We actively provide security updates, vulnerability patches, and dependency overrides for the following versions:

| Version                    | Supported | Security Maintenance Status                    |
| :------------------------- | :-------: | :--------------------------------------------- |
| **`1.0.x` / `1.0.0-rc.*`** |    ✅     | **Actively Supported** (Latest release line)   |
| `< 1.0.0`                  |    ❌     | End of Life (Upgrade to `1.0.0-rc.4` or later) |

Security patches will be backported to active release branches and tagged immediately upon verification.

---

## 2. Reporting a Vulnerability

**Please do NOT disclose vulnerabilities publicly in GitHub Issues, Discussions, Pull Requests, or social media until they have been reviewed and addressed.**

### Preferred Reporting Method

If you believe you have found a security vulnerability in Blockingmachine, please report it privately through **GitHub Security Advisories**:

👉 **[Submit a Private Vulnerability Report](https://github.com/Greigh/Blockingmachine/security/advisories/new)**

### Alternative Reporting via Email

If you prefer email or cannot use GitHub Security Advisories, contact our security lead directly:

- **Email**: [daniel@greighstudios.com](mailto:daniel@greighstudios.com)
- **Subject**: `[SECURITY VULNERABILITY] Blockingmachine - <Short Description>`

### What to Include in Your Report

To help us investigate, triage, and patch the issue quickly, please provide:

1. **Affected Subsystem**: Specify whether the vulnerability affects:
   - `@blockingmachine/core` (Rule parsing, Mini-AI classification, compilation engine)
   - `@blockingmachine/cli` (CLI tooling, feed compilation, MongoDB/daemon sync)
   - `@blockingmachine/electron-app` (Desktop UI, IPC bridges, sinkhole synchronization)
   - `@blockingmachine/browser-extension` (Manifest V3 extension, content scriptlets, defusers)
   - `@blockingmachine/system-daemon` (Loopback DNS filtering proxy, system service)
   - `@blockingmachine/homeassistant-addon` / Integration (Home Assistant bridge, REST/SSE)
2. **Vulnerability Type**: (e.g., DNS spoofing/cache poisoning, Remote Code Execution, Privilege Escalation, Context Isolation bypass, CSRF, DOM-based XSS, denial-of-service).
3. **Reproduction Steps**: Detailed step-by-step instructions or a minimal Proof of Concept (PoC).
4. **Impact Assessment**: The potential blast radius, required privileges, and attack vector.
5. **Mitigation / Suggested Fix**: If you have identified a potential patch or override.

---

## 3. Vulnerability Response Timeline

Our coordinated vulnerability disclosure process follows these milestones:

- **Initial Acknowledgment**: Within **48 hours** of receiving your report, confirming receipt and assigning an internal tracking reference.
- **Triage & Assessment**: Within **5 business days**, confirming whether the issue is reproducible and determining its CVSS severity score.
- **Remediation & Patching**: A targeted security fix will be developed in a private branch, verified against test suites, and audited against Dependabot/npm audit requirements.
- **Coordinated Disclosure**: We aim to release a patched release within **30 days** (or sooner for critical RCE / privilege escalation issues). Public advisories and CVE numbers will be published simultaneously, providing full researcher attribution.

---

## 4. Component-Specific Security Model

Blockingmachine operates across several privilege tiers, each enforcing strict architectural boundaries:

### 1. Loopback DNS Filtering Daemon (`@blockingmachine/system-daemon`)

- **Interface Binding**: By default, the DNS loopback proxy binds strictly to `127.0.0.1` and `[::1]`. It should **never** be exposed to untrusted external interfaces (`0.0.0.0`) without explicit authentication to prevent open recursive resolver misuse and DNS amplification attacks.
- **Privilege Separation**: Requires minimal POSIX capabilities (`CAP_NET_BIND_SERVICE` on Linux) to bind low ports (UDP/TCP 53) and drops superuser privileges where feasible.

### 2. Desktop Application (`@blockingmachine/electron-app`)

- **Context Isolation**: Always enforced (`contextIsolation: true`).
- **Node Integration Disabled**: Renderer processes run with `nodeIntegration: false`.
- **Preload IPC Bridges**: Explicit, sanitized `ipcRenderer` function exposure via `contextBridge`. IPC channels validate sender frames and payload types before execution.

### 3. Manifest V3 Browser Extension (`@blockingmachine/browser-extension`)

- **No Dynamic Code Execution**: Zero usage of `eval()`, `new Function()`, or dynamic remote script injection.
- **Sandboxed Defusers**: Defuser scriptlets execute within isolated browser extension environments, manipulating only client DOM nodes without exposing browser APIs to hostile web scripts.

### 4. Home Assistant Bridge & Local APIs

- **Access Control**: Local API and Server-Sent Events (`/v1/events`) endpoints require token-based authentication and validate `Origin` and `Host` headers to mitigate Cross-Site Request Forgery (CSRF).

---

## 5. Scope & Exclusions

### In-Scope

- Vulnerabilities in code maintained directly in this repository.
- Privilege escalation from unprivileged local processes via IPC or daemon sockets.
- Remote code execution (RCE) via untrusted filter list inputs or DNS response parsing.
- Sandbox escapes or Electron context bridge compromises.
- Logic errors permitting network traffic leaking past the active blocking engine when enabled.

### Out-of-Scope

- Attacks requiring physical device access or pre-existing root/administrator compromise of the host OS.
- Denial-of-Service attacks against external upstream DNS resolvers (e.g. Cloudflare, Quad9, Google).
- Social engineering attacks targeting project maintainers.
- Vulnerabilities in third-party filter list content feeds (e.g., false positives/negatives in community adblock lists).

---

## 6. Security Acknowledgements

We believe in recognizing researchers and contributors who invest their time to improve open source security. If you responsibly disclose a valid security issue, we will happily:

- Credit you in our release notes and GitHub Security Advisory.
- Link to your GitHub profile, website, or preferred handle upon publication.
