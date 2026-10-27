/**
 * Response pipeline — P2 Task 3 (docs/https-filtering-p2-plan.md).
 *
 * The response side of the verdict seam: given a terminated flow's upstream
 * response head plus the request-side context (the verdict that already ran,
 * the URL/host/method it ran on, the cosmetic index and a typed re-evaluation
 * callback), decide what the relay does with the response:
 *
 *  - `passthrough` — stream verbatim (the `$csp` transform, when the verdict
 *    collected one, still appends to the enforcing CSP header — it is a
 *    header-level rewrite, not a body one).
 *  - `block` — a 403 synthetic, reusing the request-side blocked idiom. Fired
 *    by the content-type re-verdict: the request was evaluated UNTYPED (a
 *    client that sends no `sec-fetch-dest` declares nothing), so a response
 *    that arrives as `image/png` gets a second, typed verdict — and a typed
 *    `$image` block the untyped pass could never see now fires. Asymmetric by
 *    design, exactly like the request side's `sec-fetch-dest` double pass: a
 *    typed block TIGHTENS, a typed `@@` exception must never RELAX — the
 *    typed verdict is consulted for its action only when the original verdict
 *    was not already blocked, and a non-blocked typed verdict changes nothing
 *    (its transforms are ignored — the typed pass exists to catch mislabeled
 *    responses, not to grow rewrites).
 *  - `buffer-inject` — `text/html` + a non-empty cosmetic payload for the
 *    host: buffer the body (≤ {@link MAX_HTML_BUFFER}), splice the
 *    element-hiding `<style>` block and the scriptlet `<script>` block, widen
 *    any existing CSP to admit them, and send the rewritten head.
 *
 * Everything here is a pure decision/transform — no sockets, no streams — so
 * the whole matrix is unit-testable. The relay (`httpRelay.ts`) owns the
 * accumulation buffer and the backpressure.
 */

import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateSync,
} from 'node:zlib';
import type {
  CosmeticIndex,
  CosmeticPayload,
  RequestVerdict,
} from '@blockingmachine/core';
import { KNOWN_SCRIPTLETS, renderScriptletBlock } from './scriptlets.js';

/**
 * Bound on the buffered-HTML injection path — a `text/html` body larger than
 * this flushes through byte-identical rather than holding unbounded memory.
 * 512 KiB covers essentially all real pages.
 */
export const MAX_HTML_BUFFER = 512 * 1024;

/**
 * The headers the injection CSP widening targets — the enforcing header AND
 * the report-only one get the same treatment: a widened report-only policy
 * still lets a page observe the same policy surface the injection needs.
 * (`$csp` additions do NOT use this list — they are enforcement-intended
 * and apply to the enforcing header only: {@link mergeCspAdditionsIntoHeaders}.)
 */
export const CSP_HEADER_NAMES = [
  'content-security-policy',
  'content-security-policy-report-only',
] as const;

/** The context the typed re-verdict is evaluated with — the request's own. */
export interface TypedEvalContext {
  /** The absolute URL the request verdict ran on. */
  url: string;
  /** The verdict-judged authority (hostname — no port). */
  host: string;
  method: string;
  /** The ABP resource-type token mapped from the response `content-type`. */
  contentType: string;
}

/**
 * The typed re-evaluation seam — `evaluate` on the live evaluator with the
 * mapped content type. Wired by the caller (the evaluator is snapshotted per
 * flow); `undefined` disables the re-verdict entirely.
 */
export type EvaluateTyped = (ctx: TypedEvalContext) => RequestVerdict;

/**
 * Stats/audit events the relay emits — counters and `proxy_event` ledger
 * lines live with the caller (the proxy owns both). Hostnames only, never
 * URLs/paths/bodies — the learned-shadow privacy convention.
 */
export type ResponseEvent =
  | { kind: 'response-block'; host: string; rule: string | null }
  | {
      kind: 'html-inject';
      host: string;
      /** The `<style>` block was emitted. */
      style: boolean;
      /** Known scriptlet invocations in the emitted `<script>` block. */
      scriptlets: number;
      /** Scriptlets filtered out because the library knows no such name. */
      skippedScriptlets: number;
    }
  | { kind: 'csp-rewrite'; host: string; count: number }
  | {
      kind: 'inject-skip';
      host: string;
      /**
       * `busy` — the proxy-wide injection budget was exhausted;
       * `no-known-content` — the host's only payload entries were
       * unknown-name scriptlets (nothing to emit, but the skip still
       * carries the count so the card sees them);
       * `not-html` — the content-type was absent/`text/plain` and the
       * bounded sniff found no markup in the buffered prefix;
       * `attachment` — the response head marks the body a download
       * (`Content-Disposition: attachment` or a `filename=`-named
       * disposition), so a `.html` body meant for saving passes through
       * byte-identical rather than spliced.
       */
      reason:
        | 'overflow'
        | 'encoded'
        | 'error'
        | 'empty'
        | 'busy'
        | 'no-known-content'
        | 'not-html'
        | 'attachment';
      /** Unknown-name scriptlets the payload carried (`no-known-content`). */
      skippedScriptlets?: number;
    };

export type ResponseAction = 'passthrough' | 'block' | 'buffer-inject';

export interface ResponsePlan {
  action: ResponseAction;
  /**
   * The `$csp` transforms the request-side verdict collected — carried
   * regardless of action (independent of whether the body is touched).
   */
  cspAdditions: string[];
  /** Why the decision came out this way — diagnostics, never wire data. */
  reason: string;
  /** The blocking rule that produced a `block` (the typed verdict's), when known. */
  blockRule?: string | null;
  /** The resolved host payload on `buffer-inject` — the relay renders it. */
  payload?: CosmeticPayload;
  /**
   * The single supported `content-encoding` the upstream applied — the
   * relay decodes before splicing and re-encodes the same codec on success
   * (flag 108). `undefined` means the bytes are already identity.
   */
  contentEncoding?: BodyCodec;
  /**
   * The content-type was absent or `text/plain` — injection rides on the
   * bounded markup sniff of the buffered prefix (flag 109), not the label.
   */
  sniffHtml?: boolean;
  /**
   * Injection was eligible but skipped before buffering — counted by the
   * relay as an `inject-skip` event.
   */
  injectSkipped?: 'encoded' | 'busy' | 'no-known-content' | 'attachment';
  /** Unknown-name scriptlets riding a `no-known-content` skip. */
  skippedScriptlets?: number;
}

/**
 * Proxy-wide bound on concurrent injection buffers. The relay holds up to
 * {@link MAX_HTML_BUFFER} bytes per `buffer-inject` plan while it accumulates
 * a body, so an unbounded count of simultaneous HTML responses is an
 * unbounded memory surface — a hostile or simply busy upstream could park
 * arbitrarily many half-buffered pages at once. `decideResponse` takes a
 * slot when it returns `buffer-inject` (`inflight++`) and the relay's
 * bufferer releases it on EVERY terminal path (injected, flushed, errored);
 * a full budget answers `passthrough` + `inject-skip` `busy` instead.
 */
export interface InjectionBudget {
  /** Slots currently held by live injection buffers. */
  inflight: number;
  /** The cap — `inflight >= max` makes the next eligible response skip `busy`. */
  readonly max: number;
}

/** Everything the response pipeline needs from the request side. */
export interface ResponsePipelineInput {
  /** The request-side verdict — its `transforms.csp` and block state. */
  verdict: RequestVerdict;
  /** The absolute URL the verdict ran on — the typed re-eval's input. */
  url: string;
  /** The verdict-judged authority — cosmetic lookup + ledger hostname. */
  host: string;
  method: string;
  /** The client-declared type (`sec-fetch-dest` inference) — subdocument asymmetry. */
  requestContentType?: string;
  /** The cosmetic index — absent disables injection (and the identity strip). */
  cosmeticIndex?: CosmeticIndex;
  /** The proxy's shared injection slot counter — absent means unbounded. */
  injectionBudget?: InjectionBudget;
  evaluateTyped?: EvaluateTyped;
  onEvent?: (event: ResponseEvent) => void;
}

/**
 * The base media type of a `content-type` header value — parameters (`;
 * charset=…`) stripped, case-folded. Array header values take the first
 * element (a repeated `content-type` is malformed anyway; the first wins is
 * the conventional reading).
 */
function baseMediaType(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.split(';', 1)[0].trim().toLowerCase() : '';
}

/**
 * A content-coding the pipeline can decompress→inject→recompress (flag
 * 108). `br` is brotli; `deflate` is zlib-wrapped deflate — the forms Node's
 * `zlib` pairs with named functions.
 */
export type BodyCodec = 'gzip' | 'deflate' | 'br';

/** The codec set {@link decodableEncodingOffer} intersects client offers against. */
export const BODY_CODECS: ReadonlySet<string> = new Set(['gzip', 'deflate', 'br']);

export type ContentEncoding = 'identity' | BodyCodec | 'unsupported';

/**
 * Classify a `content-encoding` header: absent/`identity`-only → 'identity'
 * (bytes are spliceable as-is); exactly one non-identity coding we decode →
 * that codec; anything else → 'unsupported' (a coding we cannot read, or a
 * layered `gzip, br` chain — rare and intentionally not unrolled). A bare
 * `identity` alongside a real coding (`gzip, identity` — legal, equivalent
 * to the coding alone) folds to the coding.
 */
export function parseContentEncoding(
  value: string | string[] | undefined,
): ContentEncoding {
  const values = Array.isArray(value) ? value : value !== undefined ? [value] : [];
  const codings: string[] = [];
  for (const raw of values) {
    for (const part of raw.split(',')) {
      const token = part.trim().toLowerCase();
      if (token !== '' && token !== 'identity') {
        codings.push(token);
      }
    }
  }
  if (codings.length === 0) {
    return 'identity';
  }
  if (codings.length === 1 && BODY_CODECS.has(codings[0])) {
    return codings[0] as BodyCodec;
  }
  return 'unsupported';
}

/**
 * Decompress `body` under `codec`, bounded to {@link MAX_HTML_BUFFER} of
 * decoded output — a small compressed body can expand past the buffer cap
 * and the same bound must hold. zlib throws `ERR_BUFFER_TOO_LARGE` past the
 * cap and a `Z_*`/format error on corrupt input; callers treat either as a
 * pass-the-bytes-through signal, never a rewrite.
 */
export function decodeBody(codec: BodyCodec, body: Buffer): Buffer {
  const opts = { maxOutputLength: MAX_HTML_BUFFER };
  switch (codec) {
    case 'gzip':
      return gunzipSync(body, opts);
    case 'deflate':
      return inflateSync(body, opts);
    case 'br':
      return brotliDecompressSync(body, opts);
  }
}

/** Re-encode the spliced body under the codec the upstream actually sent. */
export function encodeBody(codec: BodyCodec, body: Buffer): Buffer {
  switch (codec) {
    case 'gzip':
      return gzipSync(body);
    case 'deflate':
      return deflateSync(body);
    case 'br':
      return brotliCompressSync(body);
  }
}

/**
 * Map the response's real `content-type` onto the evaluator's ABP resource
 * tokens — the typed re-verdict's context. Only mappings with one honest
 * reading are listed: `image/*` → image, `*javascript*`/`*ecmascript*` →
 * script, `text/css` → stylesheet, `video/*`/`audio/*` → media, `*font*` →
 * font, `text/html`/`application/xhtml+xml` → document-or-subdocument (the
 * `subdocument` reading holds only when the REQUEST declared itself
 * `subdocument` — a full page fetch typed by its response is `document`).
 * `json`/`xml`/`text/plain` land on `other` rather than `xmlhttprequest`:
 * an xhr reading would need an xhr-ish request-side context this layer
 * cannot see, and `other` is the vocabulary's honest catch-all for "some
 * fetch that isn't the typed kind a rule named". Anything else returns
 * `undefined` and the re-verdict never runs — a wrong guess is worse than
 * none (the `sec-fetch-dest` table's own posture).
 */
function mapResponseContentType(
  mediaType: string,
  requestContentType: string | undefined,
): string | undefined {
  if (mediaType === '') {
    return undefined;
  }
  if (mediaType.startsWith('image/')) {
    return 'image';
  }
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
    return requestContentType === 'subdocument' ? 'subdocument' : 'document';
  }
  if (mediaType.includes('javascript') || mediaType.includes('ecmascript')) {
    return 'script';
  }
  if (mediaType === 'text/css') {
    return 'stylesheet';
  }
  if (mediaType.startsWith('video/') || mediaType.startsWith('audio/')) {
    return 'media';
  }
  if (mediaType.startsWith('font/') || mediaType.includes('font')) {
    return 'font';
  }
  if (
    mediaType.includes('json') ||
    mediaType.includes('xml') ||
    mediaType === 'text/plain'
  ) {
    return 'other';
  }
  return undefined;
}

/**
 * Does a resolved payload actually produce injected bytes? A host whose only
 * rules are unknown-name scriptlets (or payloads emptied by exceptions) must
 * not qualify as injectable — otherwise the relay strips `accept-encoding`
 * for nothing.
 */
export function hasInjectableContent(payload: CosmeticPayload): boolean {
  return (
    payload.hide.length > 0 ||
    payload.styles.length > 0 ||
    payload.scriptlets.some((call) => KNOWN_SCRIPTLETS.has(call.name))
  );
}

/**
 * May this response carry a body at all? 1xx/204/205/304 answer "no body
 * follows" by definition (RFC 9110: a 205 is terminated by the end of the
 * header section — it cannot contain content), and a `HEAD` answer
 * carries none regardless of status. Buffering such a response for
 * injection would fabricate DATA on a status that forbids it (an h2 DATA
 * frame on a 304 is a protocol violation) and re-stamp a content-length
 * the status doesn't own.
 */
function statusAllowsBody(status: number): boolean {
  return status >= 200 && status !== 204 && status !== 205 && status !== 304;
}

/**
 * Does this response head deliver its body as a download, not a render
 * context? `Content-Disposition: attachment` is the explicit signal — the
 * body is meant to be SAVED, and a `.html` file the user keeps must never
 * carry injected markup. A `filename=`/`filename*=` parameter is the same
 * download intent under any disposition (`inline; filename="x.html"`
 * still names a saved artifact — spliced bytes would persist into the
 * file). Absent, bare `inline`, and unrelated dispositions are render
 * contexts.
 */
function isDownloadDisposition(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') {
    return false;
  }
  if (baseMediaType(raw) === 'attachment') {
    return true;
  }
  return /(?:^|;)\s*filename\*?\s*=/i.test(raw);
}

/**
 * Decide what the relay does with an upstream response head. Pure — the
 * caller owns sockets. Ordering: a `block` always beats injection (a
 * response the typed verdict blocks must never receive cosmetics), which is
 * why the re-verdict runs before the `text/html` check rather than after —
 * and why a `text/html` page on an injectable host still gets its typed
 * pass.
 */
export function decideResponse(input: {
  headers: IncomingHttpHeaders;
  /** The upstream response status — injection gates on bodied statuses. */
  status: number;
  verdict: RequestVerdict;
  url: string;
  host: string;
  method: string;
  requestContentType?: string;
  cosmeticIndex?: CosmeticIndex;
  injectionBudget?: InjectionBudget;
  evaluateTyped?: EvaluateTyped;
}): ResponsePlan {
  // `$csp` additions ride along independent of action — they are a
  // header-level transform and apply to whatever the response head becomes.
  const cspAdditions = input.verdict.transforms.csp ?? [];

  // A verdict that was already blocked never reaches the relay in practice
  // (the request handler answered 403 before dialing) — but the pure
  // function stays honest: blocked stays blocked, and the typed pass must
  // never run where it could relax it.
  if (input.verdict.action === 'blocked') {
    return {
      action: 'block',
      cspAdditions,
      reason: 'request-verdict',
      blockRule: input.verdict.coveringRule,
    };
  }

  const mediaType = baseMediaType(input.headers['content-type']);

  // Response-CT re-verdict: the request may have been evaluated untyped (no
  // sec-fetch-dest), so the body's real type earns a second, typed pass.
  // Only a `blocked` outcome tightens — an 'allowed'/'exception' typed
  // verdict is advisory and relaxes nothing (the asymmetry rule). When the
  // content-type maps to no honest token the eval is skipped entirely.
  const token = mapResponseContentType(mediaType, input.requestContentType);
  if (token !== undefined && input.evaluateTyped !== undefined) {
    const typed = input.evaluateTyped({
      url: input.url,
      host: input.host,
      method: input.method,
      contentType: token,
    });
    if (typed.action === 'blocked') {
      return {
        action: 'block',
        cspAdditions,
        reason: `content-type-block:${token}`,
        blockRule: typed.coveringRule,
      };
    }
  }

  // `text/html` declares markup outright; absent or `text/plain` labels get
  // the same eligibility but carry `sniffHtml` — the buffered prefix must
  // still open like markup before any splice lands (flag 109). Declared
  // binary types (`application/octet-stream` et al.) are never sniffed.
  const markupGate = mediaType === 'text/html' || mediaType === 'text/plain' || mediaType === '';
  if (
    markupGate &&
    // Bodiless statuses/methods never buffer — there is no body to splice
    // into (see {@link statusAllowsBody}; `method` is case-insensitive —
    // the wire spells it `HEAD` but a client header is client bytes).
    statusAllowsBody(input.status) &&
    input.method.toUpperCase() !== 'HEAD' &&
    // A sec-fetch-dest-typed request that isn't a document/subdocument
    // context getting markup back is a dead context — nothing renders it,
    // so injection is wasted CPU on bytes nobody consumes.
    // `undefined` (untyped request) stays eligible.
    (input.requestContentType === undefined ||
      input.requestContentType === 'document' ||
      input.requestContentType === 'subdocument')
  ) {
    // The URL rides along so `:matches-path(…)` scriptlet exceptions apply
    // only on the paths the list scoped them to (flag 107).
    const payload = input.cosmeticIndex?.forHost(input.host, input.url);
    if (payload !== undefined) {
      if (hasInjectableContent(payload)) {
        // A download is not a render context: an `attachment` body (or any
        // filename-named disposition) is meant to be SAVED — a `.html`
        // download on an injectable host must pass through byte-identical
        // rather than carry spliced markup into a kept file.
        if (isDownloadDisposition(input.headers['content-disposition'])) {
          return {
            action: 'passthrough',
            cspAdditions,
            reason: 'download-body',
            injectSkipped: 'attachment',
          };
        }
        const encoding = parseContentEncoding(input.headers['content-encoding']);
        if (encoding === 'unsupported') {
          // A layered or unknown coding can't be spliced — buffering
          // and injecting would corrupt the body, so an unreadably
          // encoded response passes through (counted as a skipped
          // injection). Supported codecs take the decode→inject→
          // re-encode path instead of skipping.
          return {
            action: 'passthrough',
            cspAdditions,
            reason: 'encoded-body',
            injectSkipped: 'encoded',
          };
        }
        const budget = input.injectionBudget;
        if (budget !== undefined && budget.inflight >= budget.max) {
          // Every live slot is a half-buffered page — a full budget streams
          // this response verbatim rather than queueing unbounded memory.
          return {
            action: 'passthrough',
            cspAdditions,
            reason: 'injection-budget',
            injectSkipped: 'busy',
          };
        }
        // The slot is held from this decision until the bufferer resolves —
        // decideResponse cannot roll it back on a later event, so the
        // relay's bufferAndInject owns the matching decrement on every exit.
        if (budget !== undefined) {
          budget.inflight++;
        }
        return {
          action: 'buffer-inject',
          cspAdditions,
          reason: 'cosmetic-payload',
          payload,
          contentEncoding: encoding === 'identity' ? undefined : encoding,
          sniffHtml: mediaType !== 'text/html',
        };
      }
      if (payload.skippedScriptlets > 0) {
        // Every payload entry was an unknown-name scriptlet — nothing to
        // emit, but the skipped count must still reach the stats/card or
        // unknown-scriptlet coverage reads as zero rather than partial.
        return {
          action: 'passthrough',
          cspAdditions,
          reason: 'no-known-content',
          injectSkipped: 'no-known-content',
          skippedScriptlets: payload.skippedScriptlets,
        };
      }
    }
  }

  return { action: 'passthrough', cspAdditions, reason: 'default' };
}

/* ------------------------------------------------------------------ */
/* CSP serialization primitives.                                       */
/* ------------------------------------------------------------------ */

/**
 * Split a CSP header's value into its policy list. Per Fetch's serialized-CSP
 * reading (and RFC 7230 list syntax), `CSP: P1` + `CSP: P2` and one
 * `CSP: P1, P2` are the SAME set of co-equal policies — several headers merge
 * into one serialized header by joining on `, `, which is why the rewrite
 * collects every value into a single list before rewriting each policy.
 */
function collectPolicies(existing: string | string[] | undefined): string[] {
  const values = Array.isArray(existing) ? existing : existing !== undefined ? [existing] : [];
  const policies: string[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (trimmed !== '') {
        policies.push(trimmed);
      }
    }
  }
  return policies;
}

interface ParsedDirective {
  /** Lower-cased directive name (`script-src`, `default-src`, …). */
  name: string;
  /** Source-list tokens, verbatim. */
  tokens: string[];
}

/** `name token token …; name …` → ordered directive list. Empty segments drop. */
function parsePolicy(policy: string): ParsedDirective[] {
  const directives: ParsedDirective[] = [];
  for (const segment of policy.split(';')) {
    const trimmed = segment.trim();
    if (trimmed === '') {
      continue;
    }
    const spaceAt = trimmed.search(/\s/);
    if (spaceAt < 0) {
      directives.push({ name: trimmed.toLowerCase(), tokens: [] });
      continue;
    }
    directives.push({
      name: trimmed.slice(0, spaceAt).toLowerCase(),
      tokens: trimmed.slice(spaceAt).trim().split(/\s+/).filter((t) => t !== ''),
    });
  }
  return directives;
}

function serializePolicy(directives: ParsedDirective[]): string {
  return directives
    .map((dir) => (dir.tokens.length > 0 ? `${dir.name} ${dir.tokens.join(' ')}` : dir.name))
    .join('; ');
}

const UNSAFE_INLINE = "'unsafe-inline'";

/**
 * Widen one element-context chain (`elem` → `base` → `default-src`) so the
 * injected inline `<script>`/`<style>` elements are admitted:
 *
 *  - every PRESENT directive on the chain that could govern the context gets
 *    `'unsafe-inline'` appended — `script-src-elem` (CSP3 element level) and
 *    `script-src` (CSP2's only script gate) are both covered, since a browser
 *    honoring the one ignores the other for elements. When the directive
 *    carries `'strict-dynamic'` the append is inert under CSP3 (that
 *    keyword makes the engine ignore `'unsafe-inline'` along with every
 *    host source) — it still goes in, because CSP2 engines don't know
 *    `'strict-dynamic'` and DO honor `'unsafe-inline'`: skipping it would
 *    deny exactly the engines the widen can still reach;
 *  - with neither present but `default-src` restricting, the base directive
 *    is synthesized as a clone of `default-src` plus `'unsafe-inline'` —
 *    including when the clone inherits `'strict-dynamic'`: under CSP3 that
 *    keyword makes the engine ignore `'unsafe-inline'` anyway, so the
 *    carried token is inert noise there, while a CSP2-level engine (which
 *    knows `'unsafe-inline'` but not `'strict-dynamic'`) gets the only
 *    admit it can honor (flag 110). Skipping the clone denied the widen to
 *    exactly the engines it could still reach;
 *  - with nothing on the chain at all, the context is already free — nothing
 *    is added.
 *
 * Only `'unsafe-inline'` is ever appended, and only to script/style element
 * contexts — `sandbox`, `frame-ancestors`, `require-trusted-types-for`,
 * `trusted-types`, `upgrade-insecure-requests`, `block-all-mixed-content`,
 * `report-uri`, `report-to`, `*-src-attr` (we emit no inline attributes or
 * event handlers), and every unrelated directive pass through verbatim. This
 * is deliberately only ever a WIDENING of an existing header — a response
 * with no CSP needs nothing (no policy = already permissive), and no new
 * restriction is ever synthesized.
 */
function widenChain(
  directives: ParsedDirective[],
  elemName: string,
  baseName: string,
): boolean {
  let changed = false;
  const elem = directives.find((dir) => dir.name === elemName);
  const base = directives.find((dir) => dir.name === baseName);
  const fallback = directives.find((dir) => dir.name === 'default-src');
  for (const dir of [elem, base]) {
    if (dir !== undefined && !dir.tokens.includes(UNSAFE_INLINE)) {
      dir.tokens.push(UNSAFE_INLINE);
      changed = true;
    }
  }
  if (fallback !== undefined && base === undefined) {
    // The base level is synthesized whenever a restrictive default-src
    // remains the effective source: (a) nothing governs the context at all,
    // or (b) only `-elem` exists — CSP2-level engines skip `-elem` entirely
    // and fall straight to `default-src`, which would still refuse inline.
    const tokens = fallback.tokens.includes(UNSAFE_INLINE)
      ? [...fallback.tokens]
      : [...fallback.tokens, UNSAFE_INLINE];
    directives.push({ name: baseName, tokens });
    changed = true;
  }
  return changed;
}

/**
 * Admit the injected markup: ensure every policy in the existing CSP header
 * allows `'unsafe-inline'` for script and style ELEMENT contexts. Returns
 * `{value, changed}` so the caller ledgers (`csp_rewrite`) only on an actual
 * change. `existing` may be several header values; they merge into ONE
 * serialized header — see {@link collectPolicies} for why that preserves the
 * policy set exactly.
 *
 * `existing === undefined` produces `{value: undefined, changed: false}` —
 * the rewrite only ever widens an EXISTING header; a response without one is
 * already permissive and gets nothing appended.
 */
export function rewriteCspForInjection(
  existing: string | string[] | undefined,
): { value: string | undefined; changed: boolean } {
  const policies = collectPolicies(existing);
  if (policies.length === 0) {
    return { value: undefined, changed: false };
  }
  let changed = false;
  const rewritten = policies.map((policy) => {
    const directives = parsePolicy(policy);
    // `||` would short-circuit the second chain when the first widened —
    // script and style are independent contexts; both must always run.
    const widenedScript = widenChain(directives, 'script-src-elem', 'script-src');
    const widenedStyle = widenChain(directives, 'style-src-elem', 'style-src');
    const widened = widenedScript || widenedStyle;
    if (widened) {
      changed = true;
    }
    return serializePolicy(directives);
  });
  return { value: rewritten.join(', '), changed };
}

/**
 * The `$csp` modifier path: serialize each collected addition onto the CSP
 * as its OWN co-equal policy, appended to the serialized list. Policies in
 * a CSP header AND — every member of the `,`-joined list is enforced
 * independently — so an appended policy restricts exactly as written and an
 * existing policy can neither absorb nor be weakened by it. Token-merging
 * into an existing directive is wrong in BOTH directions: `'none'` unioned
 * into a live source list is spec-void (CSP ignores `'none'` alongside
 * other sources — the restriction silently dies), and live sources unioned
 * into a `'none'` list revive it (the stricter policy is widened). A
 * Each `additions` member is exactly ONE policy text: a `,` inside a `$csp`
 * modifier can never survive `splitRule`'s tail split (the comma starts the
 * next modifier), so no per-addition comma handling is needed here — and a
 * stray comma that somehow arrived would still serialize identically
 * through the final `join(', ')` either way. Returns the serialized header
 * value (`''` only when both sides are empty).
 */
export function applyCspAdditions(
  existing: string | string[] | undefined,
  additions: string[],
): string {
  const policies = collectPolicies(existing);
  for (const addition of additions) {
    const text = addition.trim();
    if (text !== '') {
      policies.push(text);
    }
  }
  return policies.join(', ');
}

/* ------------------------------------------------------------------ */
/* Header-dict helpers — the relay mutates `responseHeaders()`'s fresh    */
/* dict before `res.begin` crosses the head. Node lowercases parsed       */
/* header names on both h1 and h2, but lookups stay case-insensitive.     */
/* ------------------------------------------------------------------ */

export function getHeaderValue(
  headers: OutgoingHttpHeaders,
  name: string,
): string | string[] | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key] as string | string[];
    }
  }
  return undefined;
}

export function setHeaderValue(
  headers: OutgoingHttpHeaders,
  name: string,
  value: string | string[],
): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      headers[key] = value;
      return;
    }
  }
  headers[lower] = value;
}

export function deleteHeaderValue(headers: OutgoingHttpHeaders, name: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      delete headers[key];
    }
  }
}

/**
 * Widen the response's CSP headers to admit injected markup — the enforcing
 * header AND the report-only one get the same treatment. Never creates a
 * header (no policy = already permissive). Returns how many headers changed
 * so the caller can ledger/stat `csp_rewrite` per change.
 */
export function widenInjectionCspHeaders(headers: OutgoingHttpHeaders): number {
  let rewrites = 0;
  for (const name of CSP_HEADER_NAMES) {
    const existing = getHeaderValue(headers, name);
    if (existing === undefined) {
      continue;
    }
    const rewritten = rewriteCspForInjection(existing);
    if (rewritten.changed && rewritten.value !== undefined) {
      setHeaderValue(headers, name, rewritten.value);
      rewrites++;
    }
  }
  return rewrites;
}

/**
 * Apply the verdict's `$csp` additions to the response's enforcing CSP
 * header — created when absent, each addition appended as a co-equal
 * policy (see {@link applyCspAdditions} for why a token-merge is corrupt
 * in both directions). The report-only header is deliberately untouched:
 * `$csp` is enforcement-intended text (uBO's own posture is to touch the
 * enforcing header only) — a report-only policy holding it would log
 * violations the page never actually enforced.
 *
 * Returns the changed-count for the caller's `csp-rewrite` ledger — the
 * number of header values written (`0` or `1`: only the enforcing header
 * is ever touched).
 */
export function mergeCspAdditionsIntoHeaders(
  headers: OutgoingHttpHeaders,
  additions: string[],
): number {
  if (additions.length === 0) {
    return 0;
  }
  const merged = applyCspAdditions(
    getHeaderValue(headers, 'content-security-policy'),
    additions,
  );
  if (merged === '') {
    return 0;
  }
  setHeaderValue(headers, 'content-security-policy', merged);
  return 1;
}

/* ------------------------------------------------------------------ */
/* HTML injection — byte-level anchor search (ASCII-safe regardless of    */
/* the page's declared charset; a latin1 decode keeps byte offsets exact  */
/* because multi-byte UTF-8 sequences can never alias ASCII tag bytes).   */
/* ------------------------------------------------------------------ */

/** Characters that legitimately terminate a tag name (`<head` vs `<header`). */
const TAG_NAME_END = new Set(['>', '/', ' ', '\t', '\r', '\n', '\f']);

/**
 * Case-insensitive, name-boundary-aware tag search — `<head` must not match
 * `<header` (the next char must end the name), and the needle is already
 * lowercase against a pre-lowered haystack.
 */
function findTag(lowered: string, tag: string, from: number): number {
  let idx = lowered.indexOf(tag, from);
  while (idx >= 0) {
    const next = lowered[idx + tag.length];
    if (next === undefined || TAG_NAME_END.has(next)) {
      return idx;
    }
    idx = lowered.indexOf(tag, idx + 1);
  }
  return -1;
}

/** The `>` closing an open tag — quotes inside attributes can't end it early. */
function openTagEnd(lowered: string, openIdx: number): number {
  let quote = '';
  for (let i = openIdx; i < lowered.length; i++) {
    const ch = lowered[i];
    if (quote !== '') {
      if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/** `tag` matches at `idx` — literal hit plus the name boundary (`<head` ≠ `<header`; EOS counts). */
function tagAt(lowered: string, tag: string, idx: number): boolean {
  if (!lowered.startsWith(tag, idx)) {
    return false;
  }
  const next = lowered[idx + tag.length];
  return next === undefined || TAG_NAME_END.has(next);
}

/**
 * Text-context tag search (flag 111): the first `tag` occurrence that is
 * NOT inside a `<script>…</script>` body, an `<!-- -->` comment, or a tag's
 * quoted attribute region — the contexts where a literal `</head` is
 * script-string or comment text, not markup. A bounded linear scan, not a
 * parser:
 *
 *  - `<!--` skips to `-->` (unclosed → the rest is comment, scan ends);
 *  - `<script` skips the open tag, then the element body to the first
 *    `</script` — which is exactly where a real HTML parser ends script
 *    text too, JS string quoting notwithstanding;
 *  - every other `<x`/`</x` skips to its tag end via {@link openTagEnd},
 *    quotes honored — `"</head>"` inside `<div title="…">` is attribute
 *    text, never an anchor;
 *  - anything else advances one char (`<` not opening a tag is inert text).
 *
 * An unterminated construct ends the scan unfound — the caller falls back
 * to the first literal match in that ambiguous case (the pre-flag posture,
 * never worse).
 */
function findTagInText(lowered: string, tag: string, from: number): number {
  let i = from;
  while (i < lowered.length) {
    if (lowered[i] !== '<') {
      i++;
      continue;
    }
    if (lowered.startsWith('<!--', i)) {
      const end = lowered.indexOf('-->', i + 4);
      if (end < 0) {
        return -1; // unterminated comment — ambiguous tail
      }
      i = end + 3;
      continue;
    }
    const isEnd = lowered[i + 1] === '/';
    const nameAt = isEnd ? i + 2 : i + 1;
    const first = lowered[nameAt];
    if (first === undefined || first < 'a' || first > 'z') {
      i++; // `<!doctype`, `<?`, `< `, a stray `<` — not a tag open
      continue;
    }
    // A real tag open — the needle is a tag, so check before skipping.
    if (tagAt(lowered, tag, i)) {
      return i;
    }
    const tagEnd = openTagEnd(lowered, i);
    if (tagEnd < 0) {
      return -1; // unterminated tag — ambiguous tail
    }
    if (!isEnd && tagAt(lowered, '<script', i)) {
      const close = findTag(lowered, '</script', tagEnd + 1);
      if (close < 0) {
        return -1; // unclosed script — the rest is script text
      }
      const closeEnd = openTagEnd(lowered, close);
      i = closeEnd < 0 ? close + '</script'.length : closeEnd + 1;
      continue;
    }
    i = tagEnd + 1;
  }
  return -1;
}

type Anchor = { before: string } | { afterOpen: string };

/**
 * Insertion chains, resolved in order — style needs head-or-later so its
 * rules precede any body parse; script prefers the EARLIEST head point so
 * its payload runs before the page's own scripts (document-start parity
 * with the extension's inject-time defusers). Both fall back to appending.
 */
const STYLE_ANCHORS: ReadonlyArray<Anchor> = [
  { before: '</head' },
  { afterOpen: '<head' },
  { before: '</body' },
  { before: '</html' },
];
const SCRIPT_ANCHORS: ReadonlyArray<Anchor> = [
  { afterOpen: '<head' },
  { before: '</head' },
  { before: '</body' },
  { before: '</html' },
];

function resolveAnchor(lowered: string, anchors: ReadonlyArray<Anchor>): number {
  for (const anchor of anchors) {
    if ('before' in anchor) {
      // Prefer the first occurrence in TEXT context; when the context scan
      // finds none (the only hit lives inside a script/comment/attribute,
      // or the tail is ambiguous), fall back to the first literal match —
      // the pre-flag behavior, never worse.
      const idx = findTagInText(lowered, anchor.before, 0);
      const chosen = idx >= 0 ? idx : findTag(lowered, anchor.before, 0);
      if (chosen >= 0) {
        return chosen;
      }
    } else {
      const idx = findTagInText(lowered, anchor.afterOpen, 0);
      const chosen = idx >= 0 ? idx : findTag(lowered, anchor.afterOpen, 0);
      if (chosen >= 0) {
        const end = openTagEnd(lowered, chosen);
        if (end >= 0) {
          return end + 1;
        }
      }
    }
  }
  return lowered.length;
}

/**
 * Escape the two sequences that could break out of a `<style>` context:
 * `</` would terminate the element (the selectors came from rules — the
 * index already structurally rejects `<`, this is belt-and-suspenders) and
 * `<!--` opens a comment state a later `</style>` hides inside. `<\/` and
 * `<\!--` are valid CSS escapes producing the same literal text. The script
 * half's strings are escaped at emission (`emitArg` in scriptlets.ts); on
 * top of that the whole block still gets a `</script` → `<\/script` pass —
 * defense in depth. It cannot corrupt the code: `</script` inside a JS
 * string or regex reads identically with the `\/`, `emitArg`'s own
 * `<\/script` output no longer matches the pattern (the `\` follows `<`),
 * and `</script` in raw code position is a syntax error anyway.
 */
export function injectHtml(
  body: Buffer,
  payload: { styleText?: string; scriptText?: string },
): { body: Buffer; injected: { style: boolean; script: boolean } } {
  const styleText = payload.styleText ?? '';
  const scriptText = payload.scriptText ?? '';
  if (styleText === '' && scriptText === '') {
    return { body, injected: { style: false, script: false } };
  }
  // latin1 decode: 1 byte ↔ 1 char, so string indices ARE byte offsets and
  // multi-byte UTF-8 never aliases the ASCII tag names being searched.
  const lowered = body.toString('latin1').toLowerCase();

  const inserts: { at: number; order: number; text: string }[] = [];
  if (styleText !== '') {
    const safe = styleText.replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
    inserts.push({
      at: resolveAnchor(lowered, STYLE_ANCHORS),
      order: 0,
      text: `<style id="bm-c">${safe}</style>`,
    });
  }
  if (scriptText !== '') {
    const safeScript = scriptText.replace(/<\/script/gi, '<\\/script');
    inserts.push({
      at: resolveAnchor(lowered, SCRIPT_ANCHORS),
      order: 1,
      text: `<script>${safeScript}</script>`,
    });
  }
  // Ascending insert order; equal points splice style first then script.
  inserts.sort((a, b) => a.at - b.at || a.order - b.order);
  const parts: Buffer[] = [];
  let cursor = 0;
  for (const ins of inserts) {
    // The inserted text is UTF-8 — selectors/scriptlet args may carry
    // non-ASCII text that a latin1 encode would mojibake; `ins.at` offsets
    // remain latin1-decoded byte positions into `body`, unaffected.
    parts.push(body.subarray(cursor, ins.at), Buffer.from(ins.text, 'utf8'));
    cursor = ins.at;
  }
  parts.push(body.subarray(cursor));
  return {
    body: Buffer.concat(parts),
    injected: { style: styleText !== '', script: scriptText !== '' },
  };
}

/**
 * Bounded markup sniff for mislabeled/absent content-types (flag 109):
 * scan only the first ≤4 KiB — a NUL byte anywhere in the window means
 * binary; leading whitespace and `<!-- -->` comments are skipped; then the
 * body must open with `<!doctype html`, `<html`, `<head`, or `<body`
 * (case-insensitive, name-bounded — `<header` is not `<head`). Only ever
 * consulted when the host carries an injectable payload; declared binary
 * types never reach it.
 */
const HTML_SNIFF_LIMIT = 4096;

export function looksLikeHtml(body: Buffer): boolean {
  const window = body.subarray(0, Math.min(body.length, HTML_SNIFF_LIMIT));
  if (window.includes(0)) {
    return false;
  }
  const text = window.toString('latin1').toLowerCase();
  let i = 0;
  for (;;) {
    while (
      i < text.length &&
      (text[i] === ' ' ||
        text[i] === '\t' ||
        text[i] === '\r' ||
        text[i] === '\n' ||
        text[i] === '\f')
    ) {
      i++;
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) {
        return false; // a comment to EOF — no markup token follows
      }
      i = end + 3;
      continue;
    }
    break;
  }
  const opensWith = (token: string): boolean =>
    text.startsWith(token, i) &&
    (text[i + token.length] === undefined || TAG_NAME_END.has(text[i + token.length]));
  return (
    opensWith('<!doctype html') ||
    opensWith('<html') ||
    opensWith('<head') ||
    opensWith('<body')
  );
}

/**
 * Render a resolved cosmetic payload into the two injectable texts: the
 * `<style>` body (all hide selectors folded into one
 * `{display:none!important}` rule, then the `#$#` raw style bodies verbatim)
 * and the `<script>` body (`renderScriptletBlock` over the known-name
 * invocations — unknown names are filtered out and counted, never emitted).
 */
export function buildInjectionText(payload: CosmeticPayload): {
  styleText: string;
  scriptText: string | undefined;
  scriptletCount: number;
  skippedScriptlets: number;
} {
  const hideRule =
    payload.hide.length > 0 ? `${payload.hide.join(',')}{display:none!important}` : '';
  const styleText = hideRule + payload.styles.join('');
  const known = payload.scriptlets.filter((call) => KNOWN_SCRIPTLETS.has(call.name));
  return {
    styleText,
    scriptText: renderScriptletBlock(known),
    scriptletCount: known.length,
    skippedScriptlets: payload.scriptlets.length - known.length,
  };
}
