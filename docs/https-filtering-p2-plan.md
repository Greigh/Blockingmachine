# HTTPS filtering — P2 implementation plan (response depth: cosmetic inject + CSP + CT block)

Sibling to `https-filtering-p1-plan.md`; implements design-spec §11's P2 line — **content depth: response content-type blocking, HTML cosmetic injection + CSP rewrite.** Same conventions: implement → fresh-eyes review → fix → gate, separately committed, owner's dirty tree untouched, no agent trailers, one logical line per markdown block.

## Locked preconditions (from P0/P1, already true)

- Engine loads `browser.txt` line-array into `createRequestEvaluator` (`packages/https-filter/src/index.ts:131-153`); `browser.txt` already carries the full cosmetic layer — measured on the shipped artifact: **129,601 `##`/`#@#` lines, 5,658 `##+js` scriptlets**, multi-domain comma-lists, `~` exclusions, `*` entity wildcards, `#%#//scriptlet(...)` AdGuard syntax. Today every one is dead weight — the evaluator indexes only network rules.
- Relay seams: `relayOverH1` (`httpRelay.ts:243`) — `upRes.pipe(target)` after `res.begin(status, responseHeaders(headers))`; `relayOverH2` (`:318`) — `stream.pipe(target)` after the same begin. Both stream bodies raw; `responseHeaders()` already strips `alt-svc`/`Connection`-listed names. `res.begin` is the single choke-point where the response head crosses.
- `transforms.ts` collects `verdict.transforms.csp` but deliberately does NOT apply it ("response-header rewrite — the response side is P2" — its own comment).
- `verdict.transforms` also carries request-side `removeParams`/`removeHeaders` (applied); `evaluateRequest` accepts `ctx.contentType` for typed modifiers (`$image`, `$script`, …) — currently fed only from `sec-fetch-dest` (flag-96 inference, tightened-only).
- Selector safety exists in `browser-extension/src/shared/cosmeticRules.ts` (`checkSelectorSyntax`, `DANGEROUS_CHARS`, universal/bare-tag guards) — written for user/picker selectors; list-sourced rules need only the structural-escape half.
- `scriptletInjector.ts` (extension) is a hardcoded defuser set, not a named-scriptlet library — none exists anywhere in the repo.
- Terminated responses may arrive `content-encoding: gzip|br|deflate` — the relay forwards `Accept-Encoding` verbatim today. Buffered injection requires identity bytes or in-proxy recompression.
- Stats/ledger surface: `proxy.stats()` → `/v1/proxy/status|stats`; `policy`/event ledger writes via the proxy's event hook; `HttpsFilterCard` renders stats ribbon.

## Task 1 — cosmetic/scriptlet index (`core`)

`packages/core/src/cosmetic/` — new dir, exported via `index.ts`. Two files:

`cosmeticIndex.ts`:
```ts
export interface CosmeticPayload {
  hide: string[];            // validated selectors for <style> el {display:none!important}
  styles: string[];          // #$# raw CSS declaration bodies
  scriptlets: { name: string; args: string[] }[];  // normalized name + parsed args
  skippedScriptlets: number; // unknown/unsupported names — counted, never run
}
export interface CosmeticIndex {
  forHost(host: string): CosmeticPayload | undefined;  // undefined → caller skips all work
  size(): { selectors: number; exceptions: number; scriptlets: number; styles: number };
}
export function createCosmeticIndex(lines: string[]): CosmeticIndex;
```
- Syntaxes parsed (RuleProcessor.ts:270-290 is the classification reference): `[domains]##sel`, `[domains]#@#sel` (exception), `[domains]##+js(name, arg, …)`, `[domains]#+js(...)` variant, `[domains]#%#//scriptlet('name', 'arg')` + `#@%#` (scriptlet exception — drops the same-named rule), `[domains]#$#{ decl }` + `#@$#` (style exception), `[domains]#?#sel`/`#@?#` extended-css → parse-and-skip with a stat (out of scope this phase).
- Domain prefix: comma-separated list; each token `~excl.com`, `plain.com`, or `entity.*` (`sony.*` → `sony.` suffix on the public part); no prefix = global (applies to every host). Match = suffix-equal on the host walk (`sub.example.com` hits `example.com`), `~` token vetoes its own rule only. Host input arrives already lower-normalized trailing-dot-free (the proxy's normalization — the index normalizes defensively anyway).
- Selector hygiene: apply ONLY `DANGEROUS_CHARS`-equivalent structural check (reject `{`,`}`,`;`,`@`,`/*`, `<` in the selector — injection-vector chars), NOT the specificity/bare-tag/universal guards — those exist to stop a *user's* bad picker click; list authors legitimately ship broad selectors and uBO/AdGuard apply them raw. Rationale comment mandatory.
- `#@#` exception semantics (uBO-correct): an exception for selector S on host H removes S — whether S came from a global rule or a domain rule; exceptions do NOT cancel whole hosts. A `#@#` whose selector was never injected is a no-op. Exception selectors are matched literally (string equality — same as uBO's map).
- Scriptlet arg parsing: `##+js(name, a, b)` → comma-split respecting the rule's own quoting is NOT present in `+js` syntax (args are raw, may contain `\,` escapes — handle backslash-escaped commas); `#%#//scriptlet('n','a','b')` → JS-string-literal parse (single/double quotes, `\'` escapes). Name normalization table maps AdGuard↔uBO aliases onto ONE canonical name set (`abort-on-property-read` ⇄ `aopr`, `prevent-fetch` ⇄ `no-fetch-if`, `set-constant` ⇄ `setConstant`, …) — the library in Task 2 consumes canonical names only.
- `#@+js(...)` / `#@%#` scriptlet exceptions cancel the same name+args-or-name-only occurrence for that host.
- Build performance: 130k cosmetic lines → index build must stay well under the evaluator's own build cost (single pass, selector-keyed global/doma in maps, no per-rule regex in the hot path).
`selectorSafety.ts` — the structural check shared with the extension (see below).
Extension reuse (`no fork` per spec §4): `browser-extension/src/shared/cosmeticRules.ts` re-exports the structural half from `@blockingmachine/core` (its full validator stays — picker path unchanged); core's copy is the single source for `DANGEROUS_CHARS`. Update extension imports to `import { checkSelectorSyntax } from …` where the file is already an internal module — keep the extension's public API identical (it re-exports).
Tests (`core/src/__tests__/cosmeticIndex.test.ts`): multi-domain comma-lists, `~` exclusion beats inclusion on same rule, `*` entity (`sony.*` hits `sony.pl` not `sonyplc.com`), suffix walk, exception removes global-sourced selector on matching host only, exception unknown-selector no-op, `#$#` style bodies collected verbatim, both scriptlet syntaxes + alias normalization + escaped commas/quotes, scriptlet exception cancels, `#?#` skipped with stat, malformed lines skipped not fatal, a selector containing `{` rejected, `##body` allowed (list semantics, documented), empty input → empty index, `forHost` returns `undefined` when nothing matches (the hot-path skip).

## Task 2 — scriptlet library (`https-filter`)

`packages/https-filter/src/pipeline/scriptlets.ts` — self-contained; emits the injectable IIFE. No dependency on a DOM framework — the injected code is ES5-ish vanilla.
- Exported: `scriptletRuntimeSource(): string` (the library, minified-by-hand single string, ~4–8 KB) and `scriptletCallSource(invocations: {name, args}[]): string` (emits `(window.__bm_sc||function(){})(name, args)` per entry, each wrapped in its own try/catch — one bad scriptlet never kills the rest; unknown names counted via a runtime no-op + `__bm_sc.unknown(name)` hook that exists only when a debug flag is set — keep the payload quiet in production).
- Curated set (the names that cover >90% of real list usage; canonical names after Task-1 aliasing): `set-constant` (dotted-path assign, resolver for `undefinedValue`/`null`/`true`/`false`/numbers/`noopFunc`/`trueFunc`/`emptyObj`/`emptyArr`/`""` special values, retries via defineProperty on the parent chain), `abort-on-property-read`, `abort-on-property-write`, `abort-current-inline-script`, `abort-on-stack-trace`, `prevent-setTimeout`, `prevent-setInterval`, `adjust-setTimeout`, `adjust-setInterval`, `prevent-fetch`, `prevent-xhr`, `prevent-addEventListener`, `prevent-window-open`, `nowebrtc`, `json-prune`, `remove-attr`, `remove-class`, `set-local-storage-item`, `set-session-storage-item`, `remove-local-storage-item`, `href-sanitizer`, `spoof-css`, `prevent-eval-if`, `no-protected-audience`. Pattern args are `/regex/` or substring — implement the uBO matcher: leading/trailing `/` → regex, `/.` prefix → substring, plain → substring.
- Anti-detection property the repo cares about (parity with the extension's defusers philosophy): scriptlets must not be enumerable/detectable — `Object.defineProperty(window,'__bm_sc',{enumerable:false})`, function `.toString` spoofing is out of scope (flag it).
- Security boundary: the runtime NEVER evals rule-provided strings; args are data to the scriptlet implementations only. `prevent-eval-if` is the sole scriptlet that wraps eval — itself wrapped in try/catch and feature-detect.
Tests: jsdom is likely absent — test `scriptletCallSource` emission (escaping: an arg containing `'`/`</script>`/`\\` must not break the emitted JS — pin `</script` → `<\/script` escaping everywhere a string crosses into script text) + a node `new Function(runtime+call)` smoke for the top-5 scriptlets against a fake `window`/`document` harness (vitest-compatible, no jsdom needed — hand-roll the 20-line harness). Assert `</script>`-in-arg can't terminate the script block (the classic XSS-in-payload hole).

## Task 3 — response pipeline (`httpRelay.ts` + new `pipeline/response.ts`)

`packages/https-filter/src/pipeline/response.ts` — pure decision+transform module, unit-testable without sockets:
- `decideResponse(headers, verdict, host, cosmetics): ResponsePlan` → `{action:'passthrough'|'block'|'buffer-inject', reason, csp?: string[]}`:
  - verdict.transform `csp[]` → plan carries `cspRewrite: 'merge'` (Task applies to whatever CSP lands, add if absent — one canonical serialization, comment notes multi-policy responses merge into the first header per Fetch spec).
  - `content-type` starts `text/html` + `cosmetics.forHost(host)` non-empty → `buffer-inject` (style+script payload).
  - Response-CT re-verdict: map actual `content-type` → ABP token (`image/*`→image, `script`/ecmascript→script, `video|audio`→media, `font`→font, `text/html`→subdocument when ctx was subdocument else document…) → re-run the evaluator typed pass ONLY (untyped already ran at request time — a typed block can tighten; typed `@@` must NOT relax, same asymmetry as sec-fetch-dest). New verdict blocked → action `block` + drain upstream.
  - Everything else → passthrough.
- `injectHtml(body: Buffer, payload): {body, injected: {style:boolean,script:boolean}}` — byte-level anchor search (ASCII-safe regardless of charset): first `</head` wins; else `<head` end; else `<body` end; else `</body`/`</html`; else append. Emits `<style id="bm-c">…selectors{display:none!important}…rawstyles…</style>` + `<script>(scriptletRuntime)(calls)</script>`; style injected at head-end only, script at earliest head point (document-start parity with extension). `</script`/`<!--` escaping in all interpolated strings.
- `rewriteCsp(existing: string|undefined, opts): string` — admit injection: ensure `script-src`/`style-src` (or their `default-src` fallthrough) contain `'unsafe-inline'`; preserve everything else verbatim; when absent entirely and injection ran → synthesize nothing (no CSP = already permissive — the rewrite is only ever a *widening* of existing headers; comment this explicitly + ledger event).
- Buffer seam in `httpRelay.ts`:
  - Request side: `requestHeaders()` rewrites `accept-encoding` → `identity` when the host could be injectable (cosmetic index `forHost` non-empty) OR the verdict carries csp transforms OR `accept:` header contains `text/html` — comment the upstream-bandwidth trade (AdGuard/mitmproxy normalize the same way; zstd/br/gzip support is flag-worthy). Never strip on CONNECT-tunnel or sni flows — terminated only.
  - Response side (both h1+h2 legs, shared helper): on response-head event → `decideResponse`. `passthrough` → current pipe verbatim. `block` → 403 synthetic (reuse the existing blocked-response helper — check `filterProxy.ts`'s synthetic-403 idiom) + `upRes.resume()` drain. `buffer-inject` → accumulate ≤ `MAX_HTML_BUFFER` (pin 512 KiB) → overflow → passthrough-bytes-already-buffered must FLUSH THROUGH untouched (buffer then re-emit raw — no partial injection ever) + stat `injectionsSkipped`; else `injectHtml` + `rewriteCsp` + `res.begin(status, headers-minus-content-length-minus-csp-plus-rewrites, {contentLength: newLen})`.
  - `res.begin` signature check: it may take headers only — if it can't express "same headers except these three", extend `RelayResponse` with a `beginTransformed(status, headers)` or rewrite the header dict before `begin` — the head hasn't crossed yet at decision time so rewriting `responseHeaders()`'s output is the honest seam.
- Threading: `FilterProxyConfig` gains `cosmeticIndex` + `scriptletInjector` deps; `filterProxy.ts` passes them into terminate → relay (check how `policy`/`evaluator` are threaded today — same path); `index.ts` builds `createCosmeticIndex(rules)` alongside `createRequestEvaluator`, rebuilt in `reload`.
- Stats: `responsesBlocked`, `htmlInjected`, `scriptletsInvoked`, `injectionsSkipped`, `cspRewrites` counters in `proxy.stats()` + `/v1/proxy/status` payload + `proxy_event` ledger lines for block/inject/csp-rewrite (hostnames + counts only — never URLs/paths/bodies, same convention as existing ledger).
Tests:
- `response.test.ts` (unit): decideResponse matrix (passthrough/block/inject/csp-merge, typed-exception-must-not-relax, missing content-type), injectHtml anchor precedence + over-cap flush + `<script`-in-selector escaping, rewriteCsp additive widening (`script-src 'self'` → `'self' 'unsafe-inline'`; `default-src`-only → adds `script-src` clone; `sandbox`/`frame-ancestors`/`require-trusted-types-for` untouched; already-unsafe-inline → unchanged).
- `filterProxy.mitm.test.ts` (e2e, existing harness): HTML origin + cosmetic rule → injected style+script bytes in body, content-length correct; gzipped-Accept-Encoding request → upstream sees `identity`; blocked-CT response → 403; over-cap page → byte-identical passthrough; `@@csp` exception → CSP header carries the rule's value; `$csp=script-src 'none'` verdict → response has the merged header; h2 leg: same inject parity test on an h2 upstream.
- Perf sanity: an e2e assert that a 10MB non-html download streams without buffering (mark by timing/memory — keep it simple: assert the byte stream starts within the first-byte deadline).

## Task 4 — UI + flags

`HttpsFilterCard`: stats ribbon gains injected/blocked-response counts when non-zero (keep the strip uncluttered — tooltip carries detail); a collapsed "content filtering" line showing cosmetic index size (`cosmeticRulesLoaded`) so "0 rules" and "loaded but not injecting" are distinguishable states.
`docs/open-flags.md`: new flags for deferred items discovered during T1–T3 reviews (scriptlet coverage gaps, extended-css `#?#`, toString-spoofing, gzip-recompress instead of identity, per-host inject toggle).

## Sequencing

T1 (core index) ∥ T2 (scriptlet lib — disjoint files, needs only the canonical-name contract from T1's interface block above → pin that contract in both prompts) → T3 (integrates both) → T4. Review gate after every task; a consolidated review at the end like the P1 pass.

## Carried-forward / explicit non-goals

- Extended CSS (`#?#`, `:has`, `:contains`, procedural selectors) — parsed-and-skipped; real support is its own phase (needs a selector-engine port).
- `webrtc`/permissions/cookie/`$redirect`/`$replace` modifiers — untouched.
- Response-body `replace=` rules — spec lists them under future depth, not P2.
- `thirdParty` (flag 96) stays open — no initiator signal yet.
- Injecting into non-`text/html` (JSON-API cosmetic, SVG) — out.
- Compression pass-through trade accepted: injectable-eligible flows go identity upstream; a gzip/brotli recompress path is a flag, not a P2 blocker.
