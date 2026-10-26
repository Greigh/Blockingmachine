# HTTPS Filtering Engine — P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the MITM engine core — CA/leaf forge, a request evaluator in `core`, the loopback proxy listeners (CONNECT + PROXY-v2 transparent + SNI passthrough), the request-transform pipeline, the `/v1/proxy/*` control API, and CLI commands — all privilege-free and CI-testable, so P1 (macOS pf capture + CA trust install) plugs into a proven engine.

**Architecture:** New workspace `@blockingmachine/https-filter` (ESM, `tsc` → `dist/`, jest `ts-jest` ESM). One engine process on `127.0.0.1:9294` (data) + `:9293` (control), later spawned as `filterProxy.cjs` by `daemonManager` under `ELECTRON_RUN_AS_NODE`. Platform capture helpers arrive in P1+/P3+ — P0's explicit CONNECT mode exercises every engine path except transparent splicing.

**Tech Stack:** TypeScript 5.8 / Node ≥24 built-ins only (`net`, `tls`, `http`, `http2`, `crypto`) + vendored `node-forge` (`file:../../vendor/node-forge`) for x509. Zero new registry dependencies.

**Spec:** `docs/https-filtering-design.md` — §5.1–5.7 cover P0; §9 phasing marks what this plan owns.

## Global Constraints

- `"type": "module"` everywhere; all relative `.ts` imports use `.js` specifiers (tsc emits extension-preserved ESM that Node runs directly — repo convention).
- jest config: copy `packages/system-daemon/jest.config.cjs` verbatim (`ts-jest/presets/default-esm`, `extensionsToTreatAsEsm`, `.js`→strip `moduleNameMapper`, `testMatch: ["**/*.test.ts"]` under `src`).
- `tsconfig.json`/`tsconfig.test.json` mirror `packages/system-daemon/`'s pair exactly (target ES2022, NodeNext, `src/__tests__` excluded from emit; test config `noEmit` + root `typeRoots`) — adapt the `tsconfig.test.json` header comment, which currently references system-daemon's `dns-packet.d.ts`, to this package.
- Workspaces run `npm run test` as `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js`; `type-check` = `tsc --noEmit && tsc --noEmit -p tsconfig.test.json`; `lint` = `eslint .` (zero warnings is the repo bar).
- Ports: data `127.0.0.1:9294`, control `127.0.0.1:9293` — loopback bind only, never `0.0.0.0`.
- Control API mirrors `system-daemon/src/index.ts`'s guards verbatim: ACAO `*` + origin allowlist (no-origin / localhost / 127.0.0.1 / chrome-/moz-extension schemes only) → 403; every POST requires `Content-Type: application/json` → 415.
- Upstream `tls.connect` always `rejectUnauthorized: true` — fail closed, no bypass flag anywhere.
- Observability/logging: hostnames and rule IDs only — never bodies, headers, query strings, or decrypted content (learned-shadow privacy convention).
- Commits carry **no** `Generated with`/`Co-Authored-By`/agent trailers (AGENTS.md rule).
- Cert material: RSA-2048 via vendored `node-forge` only (spec §5.1, §10).

## Review Focus

Inputs the spec implies but no task test would otherwise exercise — each pinned to its owning task:

1. `CONNECT` to a **literal IP** (no SNI will ever arrive) → blind-tunnel, never a forge attempt (Task 4).
2. `CONNECT` followed by **non-TLS bytes** or silence (non-TLS port, scanner garbage) → bounded ClientHello peek, clean close, counted — never a hung socket (Task 4).
3. **Plain-HTTP absolute-form** requests (`GET http://h/x` with no CONNECT) on the data listener → evaluated and forwarded like a normal forward proxy (Task 5).
4. One keep-alive connection carrying requests for **two different Host headers** → per-request evaluation, not per-connection (Task 5/6).
5. **Invalid/empty SNI** (not a DNS name, trailing dot, >253 chars) → passthrough path, no malformed leaf minted (Tasks 1 + 4).

---

### Task 1: `https-filter` scaffold + `CertAuthority`

**Files:**
- Create: `packages/https-filter/package.json`, `tsconfig.json`, `tsconfig.test.json`, `jest.config.cjs`
- Create: `packages/https-filter/src/ca/certAuthority.ts`
- Test: `packages/https-filter/src/__tests__/certAuthority.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LeafMaterial { certPem: string; keyPem: string }
  export class CertAuthority {
    static open(opts: { storeDir: string }): Promise<CertAuthority>;
    readonly caCertPem: string;
    forgeLeaf(sni: string): LeafMaterial;   // LRU-capped at 500
    rotate(): Promise<void>;                // new CA + clears leaf cache
  }
  export function isValidSni(sni: string): boolean;
  ```
- `package.json`: name `@blockingmachine/https-filter`, `version` `1.0.1`, `"type": "module"`, `main`/`types` → `./dist/index.*`, scripts matching system-daemon plus `"lint": "eslint ."`; deps `"@blockingmachine/core": "^1.0.1"`, `"node-forge": "file:../../vendor/node-forge"`; devDeps `@types/jest`, `@types/node`, `@types/node-forge`, `rimraf`, `typescript@~5.8.3`. Root `package.json` needs no workspace-glob change; root `build`/`test`/`lint` pick it up via `--workspaces`.

- [ ] **Step 1: Write the failing test** — `certAuthority.test.ts`: `CertAuthority.open({storeDir: tmpdir})` writes `ca.pem` + `ca.key.pem`; `statSync(key).mode & 0o777 === 0o600`; `forgeLeaf("cdn.example.com")` → `forge.pki.certificateFromPem` shows SAN `dns:cdn.example.com`, issuer == CA subject, `caCert.verify(leaf)` true; second `forgeLeaf` same SNI returns identical `certPem` (LRU); `forgeLeaf("")`/`forgeLeaf("not a host!")` throws; `rotate()` yields a different `caCertPem`.
- [ ] **Step 2: Run to fail** — `npm run test -w @blockingmachine/https-filter` → fails (module absent).
- [ ] **Step 3: Implement** — RSA-2048 CA (`basicConstraints cA:true pathlen:0`, `keyUsage keyCertSign+cRLSign`, sha256 self-sign, 10-yr), RSA-2048 leaves (30-day, SAN dns=[sni], `serverAuth` EKU, `crypto.randomBytes` serial). Key file `0600`, dir `0700`. `isValidSni`: per-label `[a-z0-9-]` (case-insensitive), total ≤253, at least one dot or literal `localhost`. LRU: `Map` with delete-oldest on insert past 500.
- [ ] **Step 4: Run to pass** + `npm run type-check -w @blockingmachine/https-filter` + `npm run lint -w @blockingmachine/https-filter` — all green.
- [ ] **Step 5: Commit** — `git add packages/https-filter` → `feat(https-filter): scaffold package with per-device CA + leaf forge`.

### Task 2: `evaluateRequest` in `@blockingmachine/core`

**Files:**
- Create: `packages/core/src/evaluateRequest.ts`
- Modify: `packages/core/src/index.ts` (export block)
- Test: `packages/core/src/__tests__/evaluateRequest.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RequestContext { thirdParty?: boolean; method?: string; contentType?: string }
  export interface RequestVerdict {
    action: "blocked" | "exception" | "allowed";
    coveringRule: string | null;
    transforms: { removeParams: string[] | "all"; removeHeaders: string[]; csp?: string };
  }
  export interface RequestEvaluator { evaluate(url: string, ctx?: RequestContext): RequestVerdict; readonly size: number }
  export function createRequestEvaluator(rawRules: string[]): RequestEvaluator;
  ```
- Consumes: `RuleStore`/`RuleProcessor` for classification — the evaluator feeds `rawRules` through them, then builds its own lookup index (suffix map for `||domain^` host rules — same structure as `packages/mobile/src/filter/matcher.ts`'s `bySuffix`; list-scan for path/regex rules). Modifier values (`removeparam`, `removeheader`, `csp`, `important`, `third-party`) are read from each raw rule's `$`-suffix, not from `variants`.

- [ ] **Step 1: Write the failing test** — pin the semantics: `||tracker.example^` blocks `https://tracker.example/x` **and** `https://a.b.tracker.example/`; `@@||cdn.tracker.example^` → `action:"exception"` for that host only; `||ads.example^$important` beats `@@||ads.example^`; `||x.com/ads/*` blocks only matching paths; `||x.com^$removeparam=utm_source` yields `transforms.removeParams:["utm_source"]` on a `blocked` verdict; bare `$removeparam` → `removeParams:"all"`; `||x.com^$removeheader=referer` → `removeHeaders:["referer"]`; `||x.com^$third-party` with `ctx.thirdParty:true` blocks, `false` allows; `@@||x.com^$removeparam=token` excepts **and still carries the transform**.
- [ ] **Step 2: Run to fail** — `npm run test -w @blockingmachine/core` → new suite fails.
- [ ] **Step 3: Implement** — precedence: `exception` > `blocked` > `allowed`, except `$important` blocking rules outrank exceptions; transforms collected from **all** matching rules regardless of action.
- [ ] **Step 4: Run to pass** + core `type-check`/`lint`.
- [ ] **Step 5: Commit** — `feat(core): runtime URL request evaluator for proxy/mobile consumers`.

### Task 3: `policy/` — pin + bypass store

**Files:**
- Create: `packages/https-filter/src/policy/policyStore.ts`
- Test: `packages/https-filter/src/__tests__/policyStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PolicyEntry { ts: number; host: string; action: "pin" | "bypass" | "remove"; reason?: string }
  export class PolicyStore {
    static open(path: string): Promise<PolicyStore>;
    isPinned(host: string): boolean;
    learnPin(host: string, reason: string): void;
    isBypassed(host: string): boolean;
    addBypass(host: string): void;
    remove(host: string): void;
    list(): PolicyEntry[];
  }
  ```
- `isPinned || isBypassed` ⇒ the proxy blind-tunnels the host — Task 4 consumes exactly that predicate pair.

- [ ] **Step 1: Write the failing test** — `learnPin` → `isPinned` true; close + reopen → persists; `remove(host)` → both false; a corrupt trailing JSONL line is skipped and counted, not fatal; file is append-only `{ts, host, action, reason?, prevHash}` with each line's `prevHash` = sha256 of the previous line (`blockingmachine-database` JSONL convention — read `packages/database/src` for the exact field order before writing the first entry shape).
- [ ] **Step 2: Run to fail.** **Step 3: Implement.** **Step 4: Run to pass** + type-check/lint.
- [ ] **Step 5: Commit** — `feat(https-filter): JSONL pin/bypass policy store`.

### Task 4: Proxy listeners — dispatch, SNI peek, blind tunnel, blocked CONNECT

**Files:**
- Create: `packages/https-filter/src/proxy/proxyProtocol.ts`, `src/proxy/sniPeek.ts`, `src/proxy/filterProxy.ts`
- Test: `packages/https-filter/src/__tests__/filterProxy.listeners.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function parseProxyV2(buf: Buffer): { dstHost: string; dstPort: number } | null;
  export function peekClientHello(socket: net.Socket, timeoutMs: number): Promise<{ head: Buffer; sni: string | null; isTls: boolean }>;
  export interface ProxyStats { flowsTotal: number; flowsBlocked: number; flowsTunneled: number; flowsTerminated: number; pinsLearned: number }
  export interface RunningProxy { readonly port: number; close(): Promise<void>; stats(): ProxyStats; reload(rawRules: string[]): void }
  export function startProxy(opts: {
    bindHost: string; dataPort: number;
    authority: CertAuthority; evaluator: RequestEvaluator; policy: PolicyStore;
  }): Promise<RunningProxy>;
  ```
- Consumes: `CertAuthority` (Task 1 — unused until Task 5), `RequestEvaluator` (Task 2), `PolicyStore` (Task 3).
- First-bytes dispatch on :9294: PROXY-v2 magic `\r\n\r\n\x00\r\nQUIT\n` → transparent flow (original dst from header); ASCII `CONNECT ` → explicit proxy; else → direct TLS ClientHello (helper-spliced flow) or plain HTTP (`GET http://` absolute-form — Task 5).
- Host verdict at CONNECT/SNI time = `evaluator.evaluate("https://<host>/")` — pathless synthetic URL; `blocked` ⇒ `HTTP/1.1 403` + `Content-Length: 0` + `X-Blockingmachine-Rule`; allowed ⇒ tunnel (termination arrives Task 5). `policy.isPinned/isBypassed` ⇒ blind tunnel regardless.
- `peekClientHello`: consume first chunk with a timeout, return it as `head` so the caller can replay it into whichever socket takes over (blind upstream, or `TLSSocket` next task).

- [ ] **Step 1: Failing test** — `parseProxyV2` round-trips a hand-built v2 header (`93.184.216.34:443`); rejects garbage.
- [ ] **Step 2: Failing test** — `peekClientHello` against a real local `tls.createServer` + `tls.connect({servername:"peek.example"})` returns `{sni:"peek.example", isTls:true}` and the returned `head` replays into a passthrough socket that completes the handshake.
- [ ] **Step 3: Failing integration** — start proxy with evaluator `[ "||blocked.example^" ]`: `CONNECT blocked.example:443` → `403`; `CONNECT good.example:443` → `200` + bytes echo through a blind-tunneled local TCP echo server (termination off until Task 5, so allowed CONNECTs tunnel). Literal-IP `CONNECT 93.184.216.34:443` → tunnels; `CONNECT` + garbage bytes → socket closes within the peek timeout, `flowsTotal` counted.
- [ ] **Step 4: Implement** the three paths + `RunningProxy.stats()` counters.
- [ ] **Step 5: Run to pass** + type-check/lint.
- [ ] **Step 6: Commit** — `feat(https-filter): proxy listeners — PROXY v2, SNI peek, CONNECT, blind tunnel`.

### Task 5: TLS termination + upstream + plain-HTTP forwarding

**Files:**
- Create: `packages/https-filter/src/proxy/terminate.ts`, `src/proxy/httpRelay.ts`
- Modify: `packages/https-filter/src/proxy/filterProxy.ts` (allowed CONNECT/SNI flows now terminate instead of tunnel, unless pinned/bypassed)
- Test: `packages/https-filter/src/__tests__/filterProxy.mitm.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function terminateToHttp(socket: net.Socket, authority: CertAuthority, onRequest: HttpHandler): Promise<void>;
  export type HttpHandler = (req: { method: string; url: string; host: string; headers: IncomingHttpHeaders }, res: RelayResponse) => void;
  ```
- Termination: `new tls.TLSSocket(plainSock, { isServer: true, secureContext: <forged-leaf>, ALPNProtocols: ["h2","http/1.1"] })`; attach to `http2.createSecureServer({ allowHTTP1: true })` via `server.emit("connection", tlsSock)` — h1 requests surface on `"request"` (compat), h2 on `"stream"`; relay upstream over `tls.connect({ servername, rejectUnauthorized: true, ALPNProtocols })` picking `http2.connect` or `http.request` by negotiated ALPN.
- Pin learning: handshake `'error'`/early `'close'` before first request → `policy.learnPin(sni, "handshake-abort")` (Task 3) → subsequent flows tunnel.
- Plain-HTTP path: absolute-form `GET http://h/x` parses host from the request line/`Host` header, evaluates, forwards over port 80 — Review Focus #3.

- [ ] **Step 1: Failing flagship test** — local `https.createServer` origin; proxy with fresh `CertAuthority`; client does CONNECT → `tls.connect` with `ca: authority.caCertPem`, `servername:"app.example"` → `GET /` → proxied origin response end-to-end.
- [ ] **Step 2: Implement** termination + relay.
- [ ] **Step 3: Failing tests** — plain-HTTP absolute-form forward (local `http` origin); keep-alive connection with `Host: a.example` then `Host: b.example` → both evaluated (b blocked → 403 while a's request succeeded); client connecting then aborting mid-handshake → `policy.isPinned(sni)` true.
- [ ] **Step 4: Implement** those paths.
- [ ] **Step 5: Run to pass** + type-check/lint.
- [ ] **Step 6: Commit** — `feat(https-filter): TLS termination, upstream relay, pin learning`.

### Task 6: `pipeline/` — request transforms + synthetic block responses

**Files:**
- Create: `packages/https-filter/src/pipeline/transforms.ts`
- Modify: `packages/https-filter/src/proxy/httpRelay.ts` (handler consults evaluator per request)
- Test: `packages/https-filter/src/__tests__/transforms.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function applyRequestTransforms(url: string, headers: IncomingHttpHeaders, t: RequestVerdict["transforms"]): { url: string; headers: IncomingHttpHeaders };
  ```
- Blocked ⇒ `403` + `Content-Length: 0` + `X-Blockingmachine-Rule: <coveringRule>` — before any upstream connection.

- [ ] **Step 1: Failing test** — `?utm_source=x&keep=1` + `removeParams:["utm_source"]` → `?keep=1`; `removeParams:"all"` → bare path; `removeHeaders:["referer"]` strips the header, leaves others; pass-through untouched when `action:"allowed"`.
- [ ] **Step 2: Wire the verdict** — in the relay handler: `evaluate(url, {thirdParty})` → block ⇒ synthetic 403 (assert covering-rule header lands); exception ⇒ transforms applied then forwarded (assert upstream sees the stripped param).
- [ ] **Step 3: Run to pass** + type-check/lint.
- [ ] **Step 4: Commit** — `feat(https-filter): request pipeline — verdicts, removeparam/removeheader, block responses`.

### Task 7: `control/` + `startFilterProxy` entrypoint

**Files:**
- Create: `packages/https-filter/src/control/controlApi.ts`, `packages/https-filter/src/index.ts`
- Test: `packages/https-filter/src/__tests__/controlApi.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FilterProxyConfig { bindHost?: string; dataPort?: number; controlPort?: number; storeDir: string; rulesPath?: string }
  export function startFilterProxy(config: FilterProxyConfig): Promise<{ proxy: RunningProxy; control: http.Server; authority: CertAuthority }>;
  ```
- Routes on `:9293` (spec §5.7, P0 subset): `GET /v1/proxy/status`, `GET /v1/proxy/stats`, `POST /v1/proxy/toggle`, `POST /v1/proxy/reload` (re-reads `rulesPath` → `reload(rawRules)`), `GET /v1/proxy/ca` (PEM + fingerprint + notAfter), `POST /v1/proxy/ca/rotate`, `GET /v1/proxy/pins`. Origin allowlist + POST-content-type guards copied from the daemon's control server (Global Constraints).
- `toggle` semantics mirror the daemon: paused ⇒ all flows blind-tunnel (protection off, connectivity never breaks).

- [ ] **Step 1: Failing test** — boot `startFilterProxy` on ephemeral ports; `GET /v1/proxy/status` shape; `POST` without `application/json` → `415`; `Origin: http://evil.example` → `403`; `reload` round-trip changes `size` of the evaluator (assert via a blocked CONNECT before/after).
- [ ] **Step 2: Implement** + `index.ts` wiring (also the future `filterProxy.cjs` webpack entry point — export stays a function, entry wiring lands in P1).
- [ ] **Step 3: Run to pass** + type-check/lint.
- [ ] **Step 4: Commit** — `feat(https-filter): /v1/proxy control API + startFilterProxy entry`.

### Task 8: CLI `proxy` + `cert` commands

**Files:**
- Create: `packages/cli/src/commands/ProxyCommand.ts`, `packages/cli/src/commands/CertCommand.ts`
- Modify: `packages/cli/src/cli.ts` (imports + `program.command(...)` registration, commander pattern already there)
- Test: `packages/cli/src/__tests__/proxyCommand.test.ts`, `certCommand.test.ts`

**Interfaces:**
- `blockingmachine proxy status|stats|toggle|reload` → `GET`/`POST http://127.0.0.1:9293/v1/proxy/*`, prints the JSON payload; `blockingmachine cert status|export [path]` → `/v1/proxy/ca` (+ writes PEM for `export`).
- Both extend `BaseCommand` (constructor `{config, logger}`, `execute(): Promise<CommandResult>`).

- [ ] **Step 1: Failing test** — stub `global.fetch` per existing command-test style; assert URL/method mapping and `CommandResult` success/failure on 500/non-JSON.
- [ ] **Step 2: Implement** + register in `cli.ts`.
- [ ] **Step 3: Run** — `npm run test -w @blockingmachine/cli` + type-check + lint.
- [ ] **Step 4: Commit** — `feat(cli): proxy/cert commands for the HTTPS filter control API`.

---

## Post-P0 handoff (not this plan)

P1 (macOS pf helper + CA trust install + Deploy Hub pane), P2 (response/content depth + cosmetic injection + CSP rewrite), P3 (Win/Linux capture), P4 (Android TCP reassembly), P5 (NE sysex) each get their own plan when queued — the spec's §9 phasing is the queue.
