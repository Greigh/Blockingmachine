## Blockingmachine v1.0.0-rc.5

Fifth release candidate for Blockingmachine 1.0 featuring a comprehensive Principal Software Engineer security and production-readiness audit across the monorepo, in-place hardening against OS command injection, SSRF, path traversal, stream DoS, and CSRF attacks, cryptographic SHA-256 filter feed integrity verification, native crash diagnostics, Chromium OS sandboxing, and expanded test coverage (434 automated tests passing).

### Highlights since RC 4

- **Monorepo Security & Production Audit (`AUDIT.md`)**:
  - Completed an exhaustive 42-section Principal Software Engineer audit across all 8 workspaces (`@blockingmachine/core`, `@blockingmachine/cli`, `@blockingmachine/electron-app`, `@blockingmachine/system-daemon`, `@blockingmachine/browser-extension`, `database`, `homeassistant-addon`, and `homeassistant-integration`).
  - Audited for architectural boundaries, memory safety, concurrency, IPC security, error boundaries, and input sanitization, certifying **100% READY** for production release.
- **OS Command Injection Defense (`@blockingmachine/electron-app`)**:
  - Replaced unescaped shell `exec` invocations in `daemonManager.ts` with parameterized `execFileAsync` (`child_process.execFile`), completely bypassing shell interpreter expansion.
  - Added strict regex validation (`/^[a-zA-Z0-9_\- ]+$/`) on daemon service names to reject control characters and shell metacharacters.
  - Hardened async execution with structured `try...finally { clearTimeout(timeout); }` to prevent open timer leaks.
- **SSRF, Path Traversal & Feed Integrity Verification (`@blockingmachine/core`)**:
  - Enforced `redirect: "manual"` in filter fetch pipeline and validated HTTP redirect destinations against `isSafePublicWebUrl()`, neutralizing redirect-based SSRF.
  - Blocked path traversal into sensitive operating system files and directories (`/etc`, `/proc`, `/sys`, `~/.ssh`, `~/.aws`, `.env`) with 403 Forbidden responses.
  - Added SHA-256 checksum calculation and `expectedSha256` validation for downloaded filter feeds; rejects corrupted or tampered lists with 422 Unprocessable Entity.
- **CSRF, DoS & Stream Protection**:
  - Enforced strict `Origin` and `Host` validation across daemon, electron HTTP, and Home Assistant addon endpoints (`/v1/control/*`, `/v1/compile`, `/v1/telemetry/browser`), blocking cross-origin drive-by requests.
  - Enforced `POST` method requirement for state mutations on `/v1/compile`.
  - Added 1MB incoming stream caps across all HTTP servers, immediately destroying abusive or runaway request streams (`req.destroy()`).
  - Wrapped URI decoding operations across all route handlers in safe try/catch blocks, returning 400 Bad Request on malformed URI sequences.
  - Enforced RFC 1035 domain length checks (max 253 characters) across `/v1/check` and CLI serve endpoints.
  - Sanitized 500 Internal Server Error handlers to prevent leaking stack traces or internal environment variables to clients.
- **Desktop Application Hardening & Resilience (`@blockingmachine/electron-app`)**:
  - Enabled Chromium OS-level sandboxing (`sandbox: true`) on BrowserWindow instances alongside existing `contextIsolation: true` and `nodeIntegration: false`.
  - Installed a strict permission request handler rejecting unnecessary hardware access requests (camera, microphone, geolocation).
  - Implemented a persistent native crash boundary (`setupCrashBoundary`) capturing uncaught exceptions and unhandled promise rejections to timestamped log files in `userData/crash-logs`.
  - Enforced a 64-subscriber concurrency cap on Server-Sent Events (SSE) connections to prevent file descriptor exhaustion, with automatic idle cleanup on unref'd heartbeat timers.
- **Continuous Integration & Quality Assurance**:
  - Added regression test suites in `core`, `electron-app`, and `cli` packages.
  - Test suite expanded to **434 passing automated tests** (100% pass rate).
  - Zero TypeScript compiler diagnostics and zero ESLint errors across all packages.

### Downloads & Assets

| Asset | Description |
|---|---|
| [`Blockingmachine-1.0.0-rc.5-arm64.dmg`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.5/Blockingmachine-1.0.0-rc.5-arm64.dmg) | macOS Apple Silicon installer (Drag to Applications) |
| [`Blockingmachine-darwin-arm64-1.0.0-rc.5.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.5/Blockingmachine-darwin-arm64-1.0.0-rc.5.zip) | macOS Apple Silicon standalone zipped app |
| [`blockingmachine-core-1.0.0-rc.5.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.5/blockingmachine-core-1.0.0-rc.5.tgz) | Core library NPM package |
| [`blockingmachine-cli-1.0.0-rc.5.tgz`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.5/blockingmachine-cli-1.0.0-rc.5.tgz) | CLI executable NPM package |
| [`blockingmachine-chrome-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.5/blockingmachine-chrome-mv3-v1.0.0.zip) | Chrome Web Store Manifest V3 browser extension bundle |
| [`blockingmachine-firefox-mv3-v1.0.0.zip`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.5/blockingmachine-firefox-mv3-v1.0.0.zip) | Firefox Add-ons Manifest V3 browser extension bundle |
| [`SHA256SUMS.txt`](https://github.com/Greigh/Blockingmachine/releases/download/v1.0.0-rc.5/SHA256SUMS.txt) | SHA-256 verification checksums |
