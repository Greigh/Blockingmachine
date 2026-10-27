/**
 * Upstream relay for terminated flows (design spec §5.3, plan Task 5).
 *
 * Each request that survives evaluation is dialed to the flow's upstream over
 * a fresh `tls.connect` — `rejectUnauthorized: true` always, full chain
 * verification against `tls.rootCertificates` (plus optional deployment CAs),
 * ALPN offering `h2` then `http/1.1`. The negotiated protocol picks the
 * client implementation: `h2` → `http2.connect` on the same socket,
 * anything else → `http.request` on it. Request and response bodies stream —
 * nothing buffers unboundedly on the proxy itself.
 *
 * Upstream failure is fail-closed (spec §7): a refused/broken/unverifiable
 * upstream answers the client `502` and destroys the socket — never a silent
 * blind-tunnel fallback, which would smuggle an uninspected flow past the
 * verdict that already ran.
 *
 * Every remote-controlled construct (`http.request`, `http2.connect`,
 * `session.request`, `res.begin`) sits behind try/catch — an upstream `101`,
 * a control-character `:path`, or a malformed `:authority` must degrade to
 * `502`+close, never an uncaughtException that kills the engine and every
 * in-flight flow with it. Objects that can emit 'error' independently
 * (`upRes`, the downstream `res`) get explicit listeners for the same reason.
 *
 * The plain-HTTP helpers at the bottom serve the data listener's
 * absolute-form path (Review Focus #3): bytes that classify as an HTTP
 * request rather than CONNECT/PROXY-v2/TLS get their request head parsed,
 * evaluated once, then forwarded verbatim to the resolved host.
 *
 * Task 6 wiring: the verdict seam lives one level up, in the proxy's
 * per-request handler — `evaluator.evaluate(url)` → blocked ⇒ `respond(403)`,
 * else ⇒ `applyRequestTransforms` on `req.url`/`req.headers`, then
 * `relayRequest`. This file only ever sees the already-transformed request.
 */

import http from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import http2 from 'node:http2';
import type { Readable } from 'node:stream';
import tls from 'node:tls';
import {
  BODY_CODECS,
  buildInjectionText,
  decideResponse,
  decodeBody,
  deleteHeaderValue,
  encodeBody,
  hasInjectableContent,
  injectHtml,
  looksLikeHtml,
  MAX_HTML_BUFFER,
  mergeCspAdditionsIntoHeaders,
  setHeaderValue,
  widenInjectionCspHeaders,
  type ResponseEvent,
  type ResponsePipelineInput,
  type ResponsePlan,
} from '../pipeline/response.js';
import type { RelayResponse, TerminatedRequest } from './terminate.js';

/** Where a terminated flow's requests are dialed. */
export interface UpstreamEndpoint {
  /** Dial address — CONNECT host or PROXY-v2 destination, not the SNI. */
  host: string;
  port: number;
  /** TLS SNI the upstream verifies against — the client's announced name. */
  servername: string;
}

export interface RelayOptions {
  /**
   * Extra PEM roots merged over `tls.rootCertificates` for upstream
   * verification — deployment/test hook, never a verification bypass:
   * `rejectUnauthorized` stays `true` either way. Semantics to know: passing
   * `ca` replaces Node's *whole* default trust list — including whatever
   * `NODE_EXTRA_CA_CERTS` contributed at process start — so a deployment
   * relying on env-provided roots must fold them into this list.
   */
  upstreamCaCerts?: string[];
  /** Upstream dial deadline override (default 15s) — test/deploy knob. */
  connectTimeoutMs?: number;
  /**
   * Upstream first-byte deadline override (default 30s) — bound on the wait
   * for the 'response' event once the request is fully sent, NOT on body
   * streaming in either direction.
   */
  responseTimeoutMs?: number;
  /**
   * The response-depth context — the request-side verdict, cosmetic index,
   * and typed re-eval seam that `decideResponse` consumes once the upstream
   * response head arrives (P2 Task 3). Absent → the relay is response-blind
   * and every body streams verbatim exactly as before.
   */
  response?: ResponsePipelineInput;
}

/** Upstream dial deadline — a blackholed target must not park fds. */
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;
/**
 * Upstream first-byte deadline — an upstream that handshakes then never
 * answers must not park the request (and the downstream client) until the
 * client gives up. Armed when the request is fully sent (the client's own
 * upload time is never charged to the upstream's window) and cleared the
 * instant 'response' fires; a long-running body streams unbounded below it.
 */
const UPSTREAM_RESPONSE_TIMEOUT_MS = 30_000;

/**
 * RFC 7230 hop-by-hop fields — never forwarded in either direction.
 * `http2-settings` joins the fixed set: it is only legal inside an h2c
 * Upgrade handshake, and a hostile/forged one reaching the h2 compat
 * `writeHead` throws — the crash class this file's try/catch guards.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'http2-settings',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Response-only strips: `alt-svc` advertises an h3/QUIC escape the capture
 * layer cannot see (spec §2 — UDP 443 suppression is a P1 concern), so a
 * relayed response must not offer it.
 */
const RESPONSE_ONLY_STRIP = new Set(['alt-svc']);

/**
 * RFC 7230 §6.1: the `Connection` header *names* the hop-by-hop fields.
 * Names it lists are stripped alongside the fixed set — a proxy must not
 * forward "connection-marked" extensions it doesn't understand.
 */
function connectionListedHeaders(headers: IncomingHttpHeaders): Set<string> {
  const listed = new Set<string>();
  const raw = headers.connection;
  const values = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  for (const value of values) {
    for (const name of value.split(',')) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed !== '') {
        listed.add(trimmed);
      }
    }
  }
  return listed;
}

function failClosed(res: RelayResponse, destroy: () => void): void {
  if (!res.headersSent) {
    res.respond(502, { 'content-length': '0' });
  } else {
    res.destroy();
  }
  destroy();
}

/**
 * `onEvent` listener isolation (flag 113): events are diagnostics, never a
 * verdict — a throwing listener inside a stream 'end'/'response' handler
 * must not escape into the byte path. Wraps the sink once per callsite so
 * emits can stay placed post-mutation (accounting exact) AND a listener
 * failure can never wedge or 502 a flow. Log-and-swallow is the only honest
 * answer that keeps both.
 */
function emitEvent(
  emit: ((event: ResponseEvent) => void) | undefined,
  event: ResponseEvent,
): void {
  if (emit === undefined) {
    return;
  }
  try {
    emit(event);
  } catch (err) {
    console.warn('[httpRelay] response-event listener threw:', err);
  }
}

/** The absolute URL a verdict runs on — preserves absolute-form targets. */
export function absoluteRequestUrl(
  req: { url: string; host: string },
  scheme: 'http' | 'https',
): string {
  if (/^https?:\/\//i.test(req.url)) {
    return req.url;
  }
  return `${scheme}://${req.host}${req.url}`;
}

/**
 * h1 `path`/h2 `:path` for the upstream wire: absolute-form targets are
 * normalized to origin-form, everything else passes through verbatim
 * (including `OPTIONS *`).
 */
function originFormPath(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return '/';
    }
  }
  return url;
}

/**
 * The authority the verdict actually judged — the absolute-form target's
 * authority when present, else the Host/`:authority` header (origin-form is
 * self-consistent). Forwarded `Host`/`:authority` is rewritten to this so a
 * mismatched client header can't smuggle an unjudged name to a shared edge
 * (RFC 7230 §5.4).
 */
function requestAuthority(req: TerminatedRequest): string {
  if (/^https?:\/\//i.test(req.url)) {
    try {
      const parsed = new URL(req.url);
      if (parsed.host !== '') {
        return parsed.host;
      }
    } catch {
      // fall through to the header authority
    }
  }
  return req.host;
}

/**
 * Does this flow warrant a decodable `accept-encoding` upstream? Buffered
 * injection needs bytes the pipeline can read, so any request that COULD
 * produce a rewritten body gets its offer intersected to the codecs it
 * supports (flag 108): the host carries injectable cosmetics, or the client
 * itself asked for `text/html`. A `$csp`-only verdict no longer qualifies —
 * it is a response-HEAD transform untouched by body coding. This only ever
 * runs for terminated relays — CONNECT-tunnel and raw-SNI flows never reach
 * `requestHeaders`, so their encoding is untouched.
 */
function wantsDecodableEncoding(req: TerminatedRequest, ctx: ResponsePipelineInput): boolean {
  // A request that declared itself a non-document type (`sec-fetch-dest:
  // image`, `script`, …) can never receive an injection — decideResponse
  // gates the buffer path on exactly this predicate — so an image/script
  // fetch on an injectable host must not pay the narrow for nothing. An
  // `accept: text/html` offer from a typed image request names its error
  // pages, not a render context. `undefined` (untyped) stays eligible.
  if (
    ctx.requestContentType !== undefined &&
    ctx.requestContentType !== 'document' &&
    ctx.requestContentType !== 'subdocument'
  ) {
    return false;
  }
  // `ctx.url` hands the request path through so `:matches-path(…)`
  // scriptlet exceptions scope correctly (flag 107) — the same payload the
  // response side will resolve.
  const payload = ctx.cosmeticIndex?.forHost(ctx.host, ctx.url);
  if (payload !== undefined && hasInjectableContent(payload)) {
    return true;
  }
  const accept = req.headers.accept;
  const acceptValue = Array.isArray(accept) ? accept[0] : accept;
  return typeof acceptValue === 'string' && acceptValue.toLowerCase().includes('text/html');
}

/**
 * The `accept-encoding` forwarded on injectable flows (flag 108): the
 * client's offer intersected with the codecs the response pipeline can
 * decompress — `gzip`/`deflate`/`br` plus `identity` — `q=0`-refused
 * entries dropped (forwarding a refusal would lie). An offer left with
 * nothing usable collapses to `identity`: still honest (identity is always
 * acceptable) and the only way the body stays decodable when the client's
 * codecs are ones the pipeline can't read.
 */
function decodableEncodingOffer(headers: IncomingHttpHeaders): string {
  const raw = headers['accept-encoding'];
  const values = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  const offered: string[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      const token = part.trim();
      if (token === '') {
        continue;
      }
      const semi = token.indexOf(';');
      const name = (semi < 0 ? token : token.slice(0, semi)).trim().toLowerCase();
      // `q=0` (or `q=0.0`) refuses the coding — it must not count as offered.
      // The `q` must open a parameter (start-of-params or `;`-boundary,
      // case-insensitive like every parameter name): `fooq=0` is a
      // differently-named parameter, not a refusal. Anything this strict
      // pattern cannot parse — `q=abc`, `q=`, `q=00`, `q=0x` — keeps the
      // coding offered: real clients ignore malformed qvalues and treat
      // the coding as acceptable, so a malformed q must never read as a
      // refusal we invented.
      const params = semi < 0 ? '' : token.slice(semi);
      if (/(?:^|;)\s*q\s*=\s*0(?:\.0+)?(?:\s*;|\s*$)/i.test(params)) {
        continue;
      }
      if (name === 'identity' || BODY_CODECS.has(name)) {
        offered.push(token);
      }
    }
  }
  return offered.length > 0 ? offered.join(', ') : 'identity';
}

/**
 * Request headers for the upstream dial: pseudo-headers (`:authority` etc.),
 * hop-by-hop fields, and `Connection`-listed names removed. The forwarded
 * authority is rewritten to the evaluated one — see {@link requestAuthority}.
 * When the response pipeline could rewrite the body (injectable host /
 * html-accepting client), `accept-encoding` collapses to the decodable
 * subset — the existing key is skipped whatever its case so the dict never
 * carries two.
 */
function requestHeaders(
  req: TerminatedRequest,
  upstreamH2: boolean,
  response?: ResponsePipelineInput,
): OutgoingHttpHeaders {
  const decodable = response !== undefined && wantsDecodableEncoding(req, response);
  const connectionListed = connectionListedHeaders(req.headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith(':') ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      connectionListed.has(lower) ||
      lower === 'host' || // authority rewritten below — never copied verbatim
      (decodable && lower === 'accept-encoding') // replaced below
    ) {
      continue;
    }
    out[name] = value as string | string[];
  }
  if (decodable) {
    out['accept-encoding'] = decodableEncodingOffer(req.headers);
  }
  const authority = requestAuthority(req);
  if (upstreamH2) {
    out[':method'] = req.method;
    out[':path'] = originFormPath(req.url);
    out[':scheme'] = 'https';
    if (authority !== '') {
      out[':authority'] = authority;
    }
  } else if (authority !== '') {
    out['host'] = authority;
  }
  return out;
}

/**
 * Response headers for the downstream side: pseudo-headers, hop-by-hop
 * fields, `Connection`-listed names, and response-only strips (`alt-svc`).
 */
function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const connectionListed = connectionListedHeaders(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith(':') ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      RESPONSE_ONLY_STRIP.has(lower) ||
      connectionListed.has(lower)
    ) {
      continue;
    }
    out[name] = value as string | string[];
  }
  return out;
}

/**
 * The synthetic 403 the verdict paths share — the same shape the request-side
 * block in `filterProxy.ts` emits (`X-Blockingmachine-Rule` names the covering
 * rule when one exists, CR/LF-stripped because it lands on a header).
 */
function respondBlocked(res: RelayResponse, coveringRule: string | null): void {
  const headers: OutgoingHttpHeaders = { 'content-length': '0' };
  if (coveringRule !== null && coveringRule !== '') {
    headers['X-Blockingmachine-Rule'] = coveringRule.replace(/[\r\n]/g, '');
  }
  res.respond(403, headers);
}

/**
 * Bound on the buffered-injection accumulation phase, as a multiple of the
 * upstream first-byte deadline: a chunked `text/html` body dripping forever
 * under {@link MAX_HTML_BUFFER} would otherwise show the client nothing
 * until 'end'. On expiry the buffered prefix flushes through verbatim — the
 * same path overflow takes, never a partial injection.
 */
const BUFFER_FLUSH_FACTOR = 2;

/**
 * The buffered half of `serveResponse`: accumulate body bytes up to
 * {@link MAX_HTML_BUFFER} (and at most `bufferDeadlineMs` wall-clock), then
 * splice the cosmetic payload and send the rewritten head. Overflow,
 * deadline expiry, and injector failure all flush the buffered bytes
 * THROUGH verbatim — never a partial injection — and count `inject-skip`;
 * injection is an enhancement and never a reason to 502. `res.begin`
 * failures still degrade to 502 + teardown (the fail-closed contract every
 * other path in this file honors).
 */
function bufferAndInject(
  res: RelayResponse,
  status: number,
  headers: IncomingHttpHeaders,
  body: Readable,
  kill: () => void,
  plan: ResponsePlan,
  pipeline: ResponsePipelineInput,
  bufferDeadlineMs: number,
): void {
  const emit = pipeline.onEvent;
  const chunks: Buffer[] = [];
  let buffered = 0;
  let flushed = false;
  // The injection-budget slot `decideResponse` took on this plan is released
  // at EVERY terminal path — injected, verbatim-flushed, errored — or the
  // shared counter leaks toward the cap and every later page goes `busy`.
  let slotReleased = false;
  const releaseSlot = () => {
    if (!slotReleased) {
      slotReleased = true;
      if (pipeline.injectionBudget !== undefined) {
        pipeline.injectionBudget.inflight--;
      }
    }
  };

  const flushRaw = () => {
    clearTimeout(bufferDeadline);
    if (flushed) {
      return;
    }
    flushed = true;
    releaseSlot();
    body.off('data', onData);
    // The head never crossed — `$csp` additions still apply (they are a
    // header transform, honest on untouched bytes), and content-length stays
    // upstream's because the body passes through byte-identical.
    const head = responseHeaders(headers);
    const cspChanged = mergeCspAdditionsIntoHeaders(head, plan.cspAdditions);
    let target;
    try {
      target = res.begin(status, head);
    } catch {
      body.destroy();
      failClosed(res, kill);
      return;
    }
    for (const chunk of chunks) {
      target.write(chunk);
    }
    body.pipe(target);
    if (cspChanged > 0) {
      emitEvent(emit, { kind: 'csp-rewrite', host: pipeline.host, count: cspChanged });
    }
  };

  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    buffered += chunk.length;
    if (buffered > MAX_HTML_BUFFER) {
      emitEvent(emit, { kind: 'inject-skip', host: pipeline.host, reason: 'overflow' });
      flushRaw();
    }
  };

  // Armed at buffer start — a response that never completes (and never
  // overflows) owes the client the bytes it already has, not silence.
  const bufferDeadline = setTimeout(flushRaw, bufferDeadlineMs);
  bufferDeadline.unref();

  body.on('data', onData);
  body.once('end', () => {
    clearTimeout(bufferDeadline);
    if (flushed) {
      return;
    }
    flushed = true; // 'end' wins — no 'data' can follow it.
    // Emits stay OUTSIDE the mutation try AND ride through emitEvent's
    // try/catch (flag 113): the catch counts `inject-skip`, so a listener
    // throw after a delivered injection would miscount as a spurious skip
    // inside the try — and unwrapped it could escape the stream's 'end'
    // handler into the byte path entirely.
    let outcome: 'injected' | 'empty' | 'overflow' | 'not-html' | 'failed' = 'failed';
    let cspChanged = 0;
    let text: ReturnType<typeof buildInjectionText> | undefined;
    let injected: { style: boolean; script: boolean } | undefined;
    try {
      // Inside the try: a concat failure (alloc) is an injector error like
      // any other — outside it, it would escape the handler uncaught.
      const wire = Buffer.concat(chunks, buffered);
      // The codec path (flag 108): a supported content-coding decodes
      // before the splice and re-encodes under the same codec on success.
      // A decode past the buffer cap or any codec error throws — the
      // untouched wire bytes flush below, byte-identical.
      const whole =
        plan.contentEncoding !== undefined ? decodeBody(plan.contentEncoding, wire) : wire;
      if (plan.sniffHtml === true && !looksLikeHtml(whole)) {
        // Absent/`text/plain` label and the buffered prefix isn't markup —
        // the sniff gates the splice so a mislabeled binary or genuinely
        // plain-text body passes through untouched (flag 109).
        outcome = 'not-html';
      } else {
        text = buildInjectionText(plan.payload as NonNullable<ResponsePlan['payload']>);
        const result = injectHtml(whole, {
          styleText: text.styleText,
          scriptText: text.scriptText,
        });
        if (!result.injected.style && !result.injected.script) {
          outcome = 'empty';
        } else {
          const out =
            plan.contentEncoding !== undefined
              ? encodeBody(plan.contentEncoding, result.body)
              : result.body;
          // The head has not crossed — mutate the fresh `responseHeaders()`
          // dict before `res.begin` copies it onto the wire: widen existing
          // CSP to admit the injected markup (only ever a widening, ledgered
          // per change), merge any `$csp` additions, and re-publish the
          // honest content-length. `content-encoding` rides through
          // verbatim — the same codec wraps the new bytes.
          const head = responseHeaders(headers);
          const widened = widenInjectionCspHeaders(head);
          const merged = mergeCspAdditionsIntoHeaders(head, plan.cspAdditions);
          deleteHeaderValue(head, 'content-length');
          setHeaderValue(head, 'content-length', String(out.length));
          let target;
          try {
            target = res.begin(status, head);
          } catch {
            // Still a terminal path — the slot must go back before the
            // fail-closed teardown or the counter leaks toward the cap.
            releaseSlot();
            failClosed(res, kill);
            return;
          }
          target.end(out);
          cspChanged = widened + merged;
          injected = result.injected;
          outcome = 'injected';
        }
      }
    } catch (err) {
      // A decompress past the buffer cap is the overflow bound landing on
      // the decoded size; any other throw is an injector/codec error.
      outcome =
        (err as { code?: string } | null | undefined)?.code === 'ERR_BUFFER_TOO_LARGE'
          ? 'overflow'
          : 'failed';
    }
    if (outcome !== 'injected') {
      // The payload resolved to nothing emittable (defensive — the plan
      // gate already checks), the body wasn't markup after all, or the
      // injector/codec threw: injection is an enhancement — its failure
      // flushes the untouched body, never a 502 for a page the upstream
      // served fine. The 'end' latch must be released first — `flushed`
      // was set above — or flushRaw() no-ops and the client hangs with
      // the head unsent.
      emitEvent(emit, {
        kind: 'inject-skip',
        host: pipeline.host,
        reason:
          outcome === 'empty'
            ? 'empty'
            : outcome === 'overflow'
              ? 'overflow'
              : outcome === 'not-html'
                ? 'not-html'
                : 'error',
      });
      flushed = false;
      flushRaw();
      return;
    }
    if (cspChanged > 0) {
      emitEvent(emit, { kind: 'csp-rewrite', host: pipeline.host, count: cspChanged });
    }
    emitEvent(emit, {
      kind: 'html-inject',
      host: pipeline.host,
      style: (injected as NonNullable<typeof injected>).style,
      scriptlets: (text as NonNullable<typeof text>).scriptletCount,
      skippedScriptlets: (text as NonNullable<typeof text>).skippedScriptlets,
    });
    releaseSlot();
  });
  body.once('error', () => {
    clearTimeout(bufferDeadline);
    releaseSlot();
    res.destroy();
    kill();
  });
  body.once('aborted', () => {
    clearTimeout(bufferDeadline);
    releaseSlot();
    res.destroy();
  });
}

/**
 * The single seam where an upstream response head crosses to the client —
 * both the h1 and h2 legs converge here so the response-depth verdict runs
 * once. `passthrough` streams verbatim (with `$csp` header merges when the
 * verdict collected them); `block` answers the synthetic 403 and drains the
 * unwanted body; `buffer-inject` hands the stream to the bounded bufferer.
 */
function serveResponse(
  res: RelayResponse,
  status: number,
  headers: IncomingHttpHeaders,
  body: Readable,
  kill: () => void,
  pipeline: ResponsePipelineInput | undefined,
  responseTimeoutMs: number,
): void {
  const plan =
    pipeline === undefined
      ? ({ action: 'passthrough', cspAdditions: [], reason: 'no-pipeline' } as ResponsePlan)
      : decideResponse({
          headers,
          status,
          verdict: pipeline.verdict,
          url: pipeline.url,
          host: pipeline.host,
          method: pipeline.method,
          requestContentType: pipeline.requestContentType,
          cosmeticIndex: pipeline.cosmeticIndex,
          injectionBudget: pipeline.injectionBudget,
          evaluateTyped: pipeline.evaluateTyped,
        });
  const emit = pipeline?.onEvent;

  if (plan.action === 'block') {
    respondBlocked(res, plan.blockRule ?? null);
    emitEvent(emit, {
      kind: 'response-block',
      host: pipeline?.host ?? '',
      rule: plan.blockRule ?? null,
    });
    // Drain the unwanted body — the client already has its answer; the
    // upstream socket is per-request and dies when the stream resolves.
    body.resume();
    body.once('end', kill);
    body.once('error', kill);
    body.once('aborted', kill);
    return;
  }

  if (plan.injectSkipped !== undefined) {
    emitEvent(emit, {
      kind: 'inject-skip',
      host: pipeline?.host ?? '',
      reason: plan.injectSkipped,
      skippedScriptlets: plan.skippedScriptlets,
    });
  }

  if (plan.action === 'buffer-inject' && plan.payload !== undefined && pipeline !== undefined) {
    bufferAndInject(
      res,
      status,
      headers,
      body,
      kill,
      plan,
      pipeline,
      responseTimeoutMs * BUFFER_FLUSH_FACTOR,
    );
    return;
  }

  const head = responseHeaders(headers);
  const cspChanged = mergeCspAdditionsIntoHeaders(head, plan.cspAdditions);
  let target;
  try {
    // A status the downstream protocol can't express (101 on h2) or an
    // upstream header the compat layer rejects throws synchronously here.
    target = res.begin(status, head);
  } catch {
    body.destroy();
    failClosed(res, kill);
    return;
  }
  body.once('error', () => {
    res.destroy();
    kill();
  });
  body.once('aborted', () => res.destroy());
  body.pipe(target);
  if (cspChanged > 0) {
    emitEvent(emit, { kind: 'csp-rewrite', host: pipeline?.host ?? '', count: cspChanged });
  }
}

/** h1 upstream: `http.request` rides the pre-connected socket (no `agent` key —
 * that is the only spot where Node honors `createConnection`). */
function relayOverH1(
  req: TerminatedRequest,
  res: RelayResponse,
  sock: tls.TLSSocket,
  responseTimeoutMs: number,
  pipeline?: ResponsePipelineInput,
): void {
  let upstream: http.ClientRequest;
  try {
    // `path` with a control character throws ERR_UNESCAPED_CHARACTERS — a
    // hostile client header must degrade to 502, not an uncaughtException.
    upstream = http.request({
      method: req.method,
      path: originFormPath(req.url),
      headers: requestHeaders(req, false, pipeline),
      createConnection: () => sock,
    });
  } catch {
    failClosed(res, () => sock.destroy());
    return;
  }
  // First-byte deadline (flag 99): armed when the request is fully SENT —
  // 'finish' fires once the client's whole upload is flushed to the kernel —
  // not at dispatch. Armed at dispatch, a >30s legitimate upload would burn
  // the upstream's answer window before the window could even start and 502
  // mid-pipe. A body that never finishes sending stays bounded by the
  // socket's own teardown (downstream death kills the dial — see
  // res.onClose/req.body error below). Cleared the moment 'response' fires;
  // a streaming response body is unaffected.
  let responseDeadline: NodeJS.Timeout | undefined;
  let answered = false;
  upstream.once('finish', () => {
    if (answered) {
      return; // upstream answered before the upload completed — nothing to arm
    }
    responseDeadline = setTimeout(
      () => failClosed(res, () => sock.destroy()),
      responseTimeoutMs,
    );
    responseDeadline.unref();
  });
  upstream.once('response', (upRes) => {
    answered = true;
    clearTimeout(responseDeadline);
    serveResponse(
      res,
      upRes.statusCode ?? 502,
      upRes.headers,
      upRes,
      () => sock.destroy(),
      pipeline,
      responseTimeoutMs,
    );
  });
  // Forwarded headers strip Upgrade/Connection, so a 101 should surface as
  // 'response' — but a protocol-correct client can't rely on hostile bytes:
  // anything routed here is still an uninspectable switch → fail closed.
  upstream.once('upgrade', () => {
    answered = true;
    clearTimeout(responseDeadline);
    failClosed(res, () => sock.destroy());
  });
  upstream.once('error', () => {
    clearTimeout(responseDeadline);
    failClosed(res, () => sock.destroy());
  });
  req.body.pipe(upstream);
}

/** h2 upstream: `http2.connect` adopts the pre-connected socket; one request
 * per session — the session closes with its stream. */
function relayOverH2(
  req: TerminatedRequest,
  res: RelayResponse,
  sock: tls.TLSSocket,
  responseTimeoutMs: number,
  pipeline?: ResponsePipelineInput,
): void {
  let session: http2.ClientHttp2Session;
  try {
    // A malformed evaluated authority throws ERR_INVALID_URL here. The
    // session authority is the same name the verdict judged — the stream's
    // :authority is set to it in requestHeaders() too.
    session = http2.connect(`https://${requestAuthority(req) || req.host || 'upstream'}`, {
      createConnection: () => sock,
    });
  } catch {
    failClosed(res, () => sock.destroy());
    return;
  }
  const kill = () => {
    session.close();
    sock.destroy();
  };
  session.once('error', () => failClosed(res, kill));
  let stream: http2.ClientHttp2Stream;
  try {
    // session.request validates header names/values — hostile bytes throw.
    stream = session.request(requestHeaders(req, true, pipeline) as http2.OutgoingHttpHeaders);
  } catch {
    failClosed(res, kill);
    return;
  }
  // First-byte deadline (flag 99) — same posture as the h1 path: armed when
  // the outbound side of the stream finishes ('finish' — the request's
  // endStream went out, so the client's own upload time never counts against
  // the upstream's window), cleared at 'response' or on any teardown that
  // already resolved the request. Body streaming is unaffected below it.
  let responseDeadline: NodeJS.Timeout | undefined;
  let responded = false;
  stream.once('finish', () => {
    if (responded) {
      return;
    }
    responseDeadline = setTimeout(() => failClosed(res, kill), responseTimeoutMs);
    responseDeadline.unref();
  });
  stream.once('response', (headers) => {
    responded = true;
    clearTimeout(responseDeadline);
    serveResponse(
      res,
      Number((headers as IncomingHttpHeaders)[':status'] ?? 502),
      headers as IncomingHttpHeaders,
      stream,
      kill,
      pipeline,
      responseTimeoutMs,
    );
  });
  stream.once('error', () => {
    clearTimeout(responseDeadline);
    failClosed(res, kill);
  });
  stream.once('aborted', () => {
    clearTimeout(responseDeadline);
    failClosed(res, kill);
  });
  stream.once('close', () => {
    clearTimeout(responseDeadline);
    session.close();
    // A stream that dies without ever producing a response (graceful GOAWAY,
    // reset) still owes the client an honest failure — not a hang.
    if (!responded) {
      failClosed(res, () => sock.destroy());
    }
  });
  req.body.pipe(stream);
}

/**
 * Dial the upstream and stream `req`/`res` across. Per-request connection —
 * a keep-alive client connection may carry different Hosts, and pooling by
 * destination is Task 6+ bookkeeping, not P0 correctness.
 */
export function relayRequest(
  req: TerminatedRequest,
  res: RelayResponse,
  upstream: UpstreamEndpoint,
  options?: RelayOptions,
): void {
  const ca =
    options !== undefined && options.upstreamCaCerts !== undefined && options.upstreamCaCerts.length > 0
      ? [...tls.rootCertificates, ...options.upstreamCaCerts]
      : undefined;
  const sock = tls.connect({
    host: upstream.host,
    port: upstream.port,
    servername: upstream.servername,
    rejectUnauthorized: true, // mandatory — no bypass flag exists (spec §5.3)
    ALPNProtocols: ['h2', 'http/1.1'],
    ...(ca !== undefined ? { ca } : {}),
  });
  const connectTimeout = options?.connectTimeoutMs ?? UPSTREAM_CONNECT_TIMEOUT_MS;
  const responseTimeout = options?.responseTimeoutMs ?? UPSTREAM_RESPONSE_TIMEOUT_MS;
  // A blackholed dial owes the client a 502, not a silent destroy — the
  // downstream request must never park until some distant default timeout.
  sock.setTimeout(connectTimeout, () => failClosed(res, () => sock.destroy()));
  sock.once('error', () => failClosed(res, () => sock.destroy()));
  req.body.once('error', () => sock.destroy());
  // Downstream death kills the upstream dial — no orphaned connections.
  res.onClose(() => sock.destroy());
  sock.once('secureConnect', () => {
    sock.setTimeout(0);
    try {
      if (sock.alpnProtocol === 'h2') {
        relayOverH2(req, res, sock, responseTimeout, options?.response);
      } else {
        // false (no ALPN) and 'http/1.1' both mean the h1 path.
        relayOverH1(req, res, sock, responseTimeout, options?.response);
      }
    } catch {
      failClosed(res, () => sock.destroy());
    }
  });
}

/* ------------------------------------------------------------------ */
/* Plain-HTTP absolute-form path (Review Focus #3).                    */
/* ------------------------------------------------------------------ */

export type HttpProbe = 'no' | 'possible' | 'yes';

const HTTP_METHOD_TOKEN = /^[A-Z][A-Z0-9_-]{0,15}$/;

/**
 * First-bytes probe for the dispatch 'reject' branch: could this buffer be an
 * HTTP request line? 'possible' while it is still a prefix of `METHOD SP`;
 * 'yes' once a method token and a plausible target opener (`/`, `*`, or the
 * `http://` scheme prefix) have arrived; 'no' for anything else — garbage
 * must still close promptly, so a space followed by a non-URL token answers
 * 'no' immediately.
 */
export function probePlainHttp(buf: Buffer): HttpProbe {
  const text = buf.toString('latin1');
  const space = text.indexOf(' ');
  if (space < 0) {
    return HTTP_METHOD_TOKEN.test(text) ? 'possible' : 'no';
  }
  if (!HTTP_METHOD_TOKEN.test(text.slice(0, space))) {
    return 'no';
  }
  const rest = text.slice(space + 1);
  if (rest.length === 0) {
    return 'yes';
  }
  const lower = rest.toLowerCase();
  if (lower.startsWith('http://') || 'http://'.startsWith(lower)) {
    return 'yes';
  }
  return rest.startsWith('/') || rest === '*' ? 'yes' : 'no';
}

export interface PlainHttpTarget {
  method: string;
  /** Absolute `http://` URL the verdict runs on. */
  url: string;
  /** Resolved dial target. */
  host: string;
  port: number;
  /** The raw `Host` header value when present — the second authority. */
  hostHeader: string | null;
  /**
   * An absolute-form request line and a `Host` header that disagree on
   * authority (RFC 7230 §5.4). Forwarding the pair would let
   * `GET http://allowed/x` + `Host: blocked` evade the verdict on the Host
   * name — callers evaluate both and reject.
   */
  authorityMismatch: boolean;
}

/** `host:port` / `[v6]:port` / bare host → `{host, port}` with `defPort`. */
export function splitHostPort(
  authority: string,
  defPort: number,
): { host: string; port: number } | null {
  const trimmed = authority.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close < 0) {
      return null;
    }
    const portText = trimmed.slice(close + 1);
    if (portText === '') {
      return { host: trimmed.slice(1, close), port: defPort };
    }
    if (portText[0] !== ':' || !/^\d{1,5}$/.test(portText.slice(1))) {
      return null;
    }
    return { host: trimmed.slice(1, close), port: Number(portText.slice(1)) };
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon < 0) {
    return { host: trimmed, port: defPort };
  }
  const portText = trimmed.slice(colon + 1);
  if (!/^\d{1,5}$/.test(portText)) {
    return null;
  }
  return { host: trimmed.slice(0, colon), port: Number(portText) };
}

/** First `Host:` header value in a latin1 head block, or null when absent. */
function hostHeaderValue(head: string, lineEnd: number): string | null {
  for (const line of head.slice(lineEnd + 2).split('\r\n')) {
    const sep = line.indexOf(':');
    if (sep > 0 && line.slice(0, sep).trim().toLowerCase() === 'host') {
      return line.slice(sep + 1).trim();
    }
  }
  return null;
}

/**
 * Parse a complete request head (up to CRLFCRLF) into a forwardable target.
 * Absolute-form `http://h[:port]/x` takes its host from the request line and
 * must agree with the `Host` header when one is present (`authorityMismatch`);
 * origin-form/asterisk targets take it from `Host` outright. Port defaults
 * to 80. Returns null for anything that isn't a routable plain-HTTP request
 * (https absolute-form included — that is a CONNECT's job).
 */
export function parsePlainHttpTarget(buf: Buffer): PlainHttpTarget | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  const head = buf.subarray(0, headEnd < 0 ? buf.length : headEnd).toString('latin1');
  const lineEnd = head.indexOf('\r\n');
  const requestLine = lineEnd < 0 ? head : head.slice(0, lineEnd);
  const match = /^([A-Z][A-Z0-9_-]{0,15})\s+(\S+)\s+HTTP\/\d+(?:\.\d+)?$/.exec(requestLine);
  if (match === null) {
    return null;
  }
  const [, method, target] = match;
  const hostHeader = hostHeaderValue(head, lineEnd);

  if (/^http:\/\//i.test(target)) {
    try {
      const parsed = new URL(target);
      const port = parsed.port === '' ? 80 : Number(parsed.port);
      let authorityMismatch = false;
      if (hostHeader !== null) {
        const declared = splitHostPort(hostHeader, 80);
        authorityMismatch =
          declared === null ||
          declared.host.toLowerCase() !== parsed.hostname.toLowerCase() ||
          declared.port !== port;
      }
      return {
        method,
        url: target,
        host: parsed.hostname,
        port,
        hostHeader,
        authorityMismatch,
      };
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    return null; // a scheme this listener does not carry (https absolute-form)
  }

  // Origin-form / asterisk-form — the Host header is the authority.
  if (hostHeader === null) {
    return null;
  }
  const resolved = splitHostPort(hostHeader, 80);
  if (resolved === null) {
    return null;
  }
  return {
    method,
    url: `http://${hostHeader}${target}`,
    ...resolved,
    hostHeader,
    authorityMismatch: false,
  };
}
