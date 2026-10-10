# AI Connection Security Review

Date: 2026 (Pass 4). Covers `test-ai-connection` (Electron main,
`packages/electron-app/src/index.ts`) and `AiDetectorService`
(`packages/core/src/ai/AiDetectorService.ts`) — the fetch paths that reach
Ollama, Gemini and OpenAI-compatible providers. Filter-source fetching
(`packages/core/src/fetch.ts`) is covered separately in `REMAINING_RISKS.md`
(DNS-rebinding section) — resolver-pinned agents landed in the prior pass.

## Design boundary

LAN AI endpoints are a *feature*: Ollama on `192.168.x.x`, a colleague's GPU box,
loopback llama.cpp. The policy therefore rejects only destination classes where
no legitimate AI server lives — never private space as a whole.

## Implemented controls

1. **`isSafeLanEndpointUrl`** (`core/utils/urlSafety.ts`, exported): http(s) only;
   rejects malformed URLs, unspecified (`0.0.0.0`/`::`), link-local
   (`169.254.0.0/16`, `fe80::/10` — the cloud-metadata block 169.254.169.254
   included), multicast, reserved/benchmark/documentation ranges, and non-IP
   non-DNS host spellings already covered by the lexical guard. Loopback and
   RFC1918 **pass** — deliberate.

2. **Bounded response bodies — `readBoundedJson`** (`core/fetch.ts`, exported):
   reads the stream chunk-wise with a byte ceiling (default 512 KB; Ollama
   `/api/tags` uses 256 KB) and fails *before* `JSON.parse` on overflow.
   Previously every provider path called `res.json()` unbounded — a hostile or
   broken endpoint could pin main-process memory. Applied to Ollama tags,
   Gemini `generateContent`, OpenAI `chat/completions` + models listing, in both
   `test-ai-connection` and `AiDetectorService`.

3. **`redirect: 'manual'`** on every provider fetch: a 3xx is a typed failure,
   never followed — so the Authorization-bearing request can never be re-aimed
   at a second origin (credential-forwarding class closed structurally).

4. **Timeouts**: AbortController budgets (5 s connectivity test, 12 s detector
   probes) — verified behaviorally: a hung local server trips the abort and the
   IPC resolves to a clean failure, not a pending handler.

5. **Pre-existing bounds retained**: Ollama model echo ≤ 50 names × 120 chars,
   non-strings dropped (F-07 regression suite green).

6. **Credential pairing** (prior pass, re-verified): the stored API key is sent
   only to the endpoint it was stored with; renderer endpoint overrides can't
   borrow it (`mergeAiOverride`, `test-ai-connection` pairing rule). No endpoint,
   key or response body is written to logs — errors are typed summaries.

## Behavioral evidence (`ipcBehavioral.test.ts`)

- Ollama 3xx → refused, not followed.
- Oversized `/api/tags` body → rejected pre-parse.
- `http://169.254.169.254/...` → refused *without a request being made*.
- Loopback Ollama stub + RFC1918-class endpoint validation → still work;
  hung-server → abort-bounded clean failure.

## Accepted risks / unverified

- **Plain-HTTP LAN credentials**: `http://` endpoints send the API key in cleartext
  on the wire — inherent to LAN providers; documented, not fixable locally.
- **Hostname-based endpoints** (`http://gpu-box.lan:11434`): lexical host checks
  pass them; DNS resolves at connect time *without* the fetch.ts pinning (that
  pinning is scoped to public filter sources where private targets are never
  legitimate — an AI endpoint legitimately may be). A `*.lan` name resolving to a
  link-local address is a theoretical residual; the LAN threat model accepts it.
- **Streaming chat responses** are not implemented anywhere — if a future
  provider path streams, it needs its own byte ceiling (flagged in code comment).
- HTTPS certificate validation follows Node defaults (public CA) — self-signed
  LAN HTTPS will fail handshake; that is a UX limitation, not a bypass.

## Not done (and why)

- **Known-path allowlists** (`/api/tags` only): rejected — custom OpenAI-compat
  servers legitimately mount other paths; speculative restriction.
- **Loopback-only default**: rejected — would break the primary Ollama use case.
- Port restrictions: rejected — providers run on arbitrary ports.
