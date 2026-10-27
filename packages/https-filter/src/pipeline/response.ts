/**
 * Response pipeline — P2 Task 3 (docs/https-filtering-p2-plan.md).
 *
 * The response side of the verdict seam: given a terminated flow's upstream
 * response head plus the request-side context (the verdict that already ran,
 * the URL/host/method it ran on, the cosmetic index and a typed re-evaluation
 * callback), decide what the relay does with the response:
 *
 *  - `passthrough` — stream verbatim (the `$csp` transform, when the verdict
 *    collected one, still merges into the CSP headers — it is a header-level
 *    rewrite, not a body one).
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
 * The headers a CSP rewrite can target. The report-only header gets the same
 * treatment as the enforcing one — a widened report-only policy still lets a
 * page observe the same policy surface the injection needs.
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
      reason: 'overflow' | 'encoded' | 'error' | 'empty';
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
   * Injection was eligible but skipped before buffering — counted by the
   * relay as an `inject-skip` event.
   */
  injectSkipped?: 'encoded';
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

/** A body the pipeline cannot safely rewrite — anything but absent/`identity`. */
function isEncoded(value: string | string[] | undefined): boolean {
  const values = Array.isArray(value) ? value : value !== undefined ? [value] : [];
  for (const raw of values) {
    for (const part of raw.split(',')) {
      const token = part.trim().toLowerCase();
      if (token !== '' && token !== 'identity') {
        return true;
      }
    }
  }
  return false;
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
 * Decide what the relay does with an upstream response head. Pure — the
 * caller owns sockets. Ordering: a `block` always beats injection (a
 * response the typed verdict blocks must never receive cosmetics), which is
 * why the re-verdict runs before the `text/html` check rather than after —
 * and why a `text/html` page on an injectable host still gets its typed
 * pass.
 */
export function decideResponse(input: {
  headers: IncomingHttpHeaders;
  verdict: RequestVerdict;
  url: string;
  host: string;
  method: string;
  requestContentType?: string;
  cosmeticIndex?: CosmeticIndex;
  evaluateTyped?: EvaluateTyped;
}): ResponsePlan {
  // `$csp` additions ride along independent of action — they are a
  // header-level transform and apply to whatever the response head becomes.
  const cspAdditions =
    input.verdict.transforms.csp !== undefined ? [input.verdict.transforms.csp] : [];

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

  if (mediaType === 'text/html') {
    const payload = input.cosmeticIndex?.forHost(input.host);
    if (payload !== undefined && hasInjectableContent(payload)) {
      if (isEncoded(input.headers['content-encoding'])) {
        // The request side forces `accept-encoding: identity` for injectable
        // hosts, but a non-compliant upstream can still compress — buffering
        // gzip bytes and splicing markup in would corrupt the body, so an
        // encoded response passes through (counted as a skipped injection).
        return {
          action: 'passthrough',
          cspAdditions,
          reason: 'encoded-body',
          injectSkipped: 'encoded',
        };
      }
      return {
        action: 'buffer-inject',
        cspAdditions,
        reason: 'cosmetic-payload',
        payload,
      };
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
 *    honoring the one ignores the other for elements;
 *  - with neither present but `default-src` restricting, the base directive
 *    is synthesized as a clone of `default-src` plus `'unsafe-inline'`;
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
 * Merge one policy's directives into another token-wise: for each directive
 * the addition names, append its tokens onto the same-named existing
 * directive (deduped) or append the directive itself. Note the `'none'`
 * edge: merged into a populated source list it is spec-ignored (CSP defines
 * `'none'` as void alongside other sources) — the prescribed token-merge
 * keeps that caveat rather than silently splitting policies.
 */
function mergePolicyDirectives(policy: string, addition: string): string {
  const directives = parsePolicy(policy);
  for (const add of parsePolicy(addition)) {
    const target = directives.find((dir) => dir.name === add.name);
    if (target === undefined) {
      directives.push(add);
      continue;
    }
    for (const token of add.tokens) {
      if (!target.tokens.includes(token)) {
        target.tokens.push(token);
      }
    }
  }
  return serializePolicy(directives);
}

/**
 * The `$csp` modifier path: serialize each collected addition onto the CSP.
 * Unlike the injection widening — which only ever widens — `$csp`
 * legitimately CREATES policy: an absent header gains the addition as its
 * first policy. An addition that is a directive list merges token-wise into
 * EVERY existing policy (all of them are enforced, so the restriction
 * applies uniformly); an addition that is itself a comma-separated policy
 * list merges each of its policies the same way. Returns the serialized
 * header value (`''` only when both sides are empty).
 */
export function applyCspAdditions(
  existing: string | string[] | undefined,
  additions: string[],
): string {
  const policies = collectPolicies(existing);
  for (const addition of additions) {
    for (const part of addition.split(',')) {
      const text = part.trim();
      if (text === '') {
        continue;
      }
      if (policies.length === 0) {
        // No existing policy — the addition is the policy, verbatim.
        policies.push(text);
      } else {
        for (let i = 0; i < policies.length; i++) {
          policies[i] = mergePolicyDirectives(policies[i], text);
        }
      }
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
 * Apply the verdict's `$csp` additions to the response's CSP headers. The
 * enforcing header is created when absent; the report-only header only ever
 * merges (synthesizing a report-only policy would report violations without
 * enforcing anything — the `$csp` intent is enforcement).
 */
export function mergeCspAdditionsIntoHeaders(
  headers: OutgoingHttpHeaders,
  additions: string[],
): void {
  if (additions.length === 0) {
    return;
  }
  setHeaderValue(
    headers,
    'content-security-policy',
    applyCspAdditions(getHeaderValue(headers, 'content-security-policy'), additions),
  );
  const reportOnly = getHeaderValue(headers, 'content-security-policy-report-only');
  if (reportOnly !== undefined) {
    setHeaderValue(
      headers,
      'content-security-policy-report-only',
      applyCspAdditions(reportOnly, additions),
    );
  }
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
      const idx = findTag(lowered, anchor.before, 0);
      if (idx >= 0) {
        return idx;
      }
    } else {
      const idx = findTag(lowered, anchor.afterOpen, 0);
      if (idx >= 0) {
        const end = openTagEnd(lowered, idx);
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
    parts.push(body.subarray(cursor, ins.at), Buffer.from(ins.text, 'latin1'));
    cursor = ins.at;
  }
  parts.push(body.subarray(cursor));
  return {
    body: Buffer.concat(parts),
    injected: { style: styleText !== '', script: scriptText !== '' },
  };
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
