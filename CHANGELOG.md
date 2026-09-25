# Changelog

All notable changes to the **Blockingmachine** monorepo are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0-rc.5] - 2026-09-24

### Security & Hardening
- **OS Command Injection Defense (`@blockingmachine/electron-app`)**:
  - Replaced shell `exec` in `daemonManager.ts` with `execFileAsync` (`child_process.execFile`) using structured argument arrays, eliminating shell expansion vulnerabilities.
  - Implemented strict validation regex (`/^[a-zA-Z0-9_\- ]+$/`) on daemon service names.
  - Guaranteed clearance of execution timeout handles within `try...finally` blocks.
- **SSRF & Path Traversal Prevention (`@blockingmachine/core`)**:
  - Enforced `redirect: "manual"` in filter fetch pipeline and validated redirect target locations against `isSafePublicWebUrl()`.
  - Blocked directory traversal into critical operating system directories and files (`/etc`, `/proc`, `/sys`, `~/.ssh`, `~/.aws`, `.env`) with 403 status.
  - Added SHA-256 integrity calculation and `expectedSha256` verification, rejecting mismatched filter feeds with 422 Unprocessable Entity.
- **CSRF, DoS & Request Stream Protection**:
  - Enforced strict origin validation (`isSafeClientOrigin` / `isSafeOrigin`) across `/v1/control/*`, `/v1/compile`, and `/v1/telemetry/browser` on both the electron app and system daemon.
  - Enforced `POST` method requirement for compilation endpoints.
  - Implemented 1MB request stream caps across all HTTP servers, terminating oversized streams immediately.
  - Wrapped URI decoding operations across all route handlers in safe `try...catch` blocks returning 400 Bad Request on malformed inputs.
  - Enforced RFC 1035 domain length checks (max 253 characters) across `/v1/check` and CLI serve commands.
  - Sanitized 500 error responses across servers to prevent leaking stack traces or internal environment variables.
- **Desktop Application Hardening (`@blockingmachine/electron-app`)**:
  - Enabled Chromium OS-level sandboxing (`sandbox: true`) on browser windows.
  - Added permission handler rejecting unneeded device access (camera, microphone, geolocation).
  - Implemented global native crash boundary (`setupCrashBoundary`) persisting uncaught exceptions and unhandled promise rejections to timestamped logs in `userData/crash-logs`.
  - Capped Server-Sent Events (SSE) connections at 64 concurrent subscribers and ensured unref'd heartbeat timer cleanup on client disconnect.

### Added
- Comprehensive 42-section Principal Software Engineer audit report (`AUDIT.md`) certifying production readiness across all 8 monorepo workspaces.
- New automated regression tests for command injection prevention, path traversal rejection, SHA-256 checksum verification, and HTTP parameter boundaries (expanding test suite to 434 tests).

---

## [1.0.0-rc.4] - 2026-09-24

### Security
- **100% Dependabot Alert Remediation**:
  - Eliminated all 31 GitHub Dependabot alerts across all repository dependencies.
  - Upgraded dependencies across `fast-uri`, `qs`, `uuid`, `@xmldom/xmldom`, `js-yaml`, and `extract-zip`.
- **CodeQL & Security Policy**:
  - Integrated automated CodeQL scanning workflow (`.github/workflows/codeql.yml`) for JavaScript and TypeScript.
  - Established formal `SECURITY.md` defining supported versions and responsible disclosure procedures.

### Changed
- Modernized runtime environment targeting Node.js `>=24.0.0`.
- Upgraded Jest to `^30.5.2`, ESLint to `^10.11.0`, and TypeScript to `^5.8.0`.
- Packaged production Manifest V3 extensions for Chrome Web Store and Firefox Add-ons with compliance verification script (`scripts/verify-mv3-compliance.mjs`).
- Isolated daemon test suites to prevent port contention and hardened IPC event variable scoping.

---

## [1.0.0-rc.3] - 2026-09-23

### Added
- **AI Threat Heuristics & Type Centralization**:
  - Centralized AI verdict types, heuristic models, and schemas in `packages/core/src/ai/types.ts`.
  - Added base64 chunk pattern detection, subdomain segment analysis, and bigram transition anomaly scoring.
- **Rule Synthesizer & Exception Handling**:
  - Added automatic `$badfilter` rule generation to neutralize conflicting upstream rules.
  - Synthesized procedural scriptlet defusers (`##+js(...)`, `#%#//scriptlet(...)`).
  - Added recursive depth limits and loop detection to CNAME cloaking analysis.

### Changed
- Refined Shannon entropy scoring thresholds to prevent false positives on legitimate UUIDs and CDN hashes.
- Enhanced desktop Deploy Hub and AI Radar indicators.

---

## [1.0.0-rc.2] - 2026-09-22

### Added
- Rule precedence and `$important` modifier resolution across trie lookups.
- Procedural anti-circumvention defusers for Admiral and Google Funding Choices.
- Reverse-label suffix trie in `@blockingmachine/system-daemon` for sub-microsecond $O(k)$ lookups.

### Fixed
- Fixed compound ccTLD subdomain matching (e.g. `.co.uk`, `.com.au`).
- Hardened IPC channel validation and message envelope serialization.

---

## [1.0.0-rc.1] - 2026-09-20

### Added
- Initial 1.0 Release Candidate across all 8 monorepo workspaces.
- Embedded Mini-AI neural classifier for zero-day tracker detection.
- Home Assistant HACS integration and Add-on container.
- Manifest V3 browser extension with dynamic `declarativeNetRequest` compilation.
- Multi-format filter export (AdGuard, uBlock Origin, DNS Hosts, Unbound, Dnsmasq).
