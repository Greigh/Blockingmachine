/**
 * Request-side transforms — the piece of the pipeline between verdict and
 * upstream dial (design spec §5.5, plan Task 6).
 *
 * `applyRequestTransforms` consumes the `transforms` block of a
 * `RequestVerdict` and reshapes the request about to be relayed:
 *
 *  - `removeParams` names drop those query params out of the URL; `"all"`
 *    drops every param except the names in `keepParams`. Names compare
 *    literally against the raw `name` token (the text before `=`) — the same
 *    byte-level reading uBO/AdGuard give `$removeparam`, and what keeps a
 *    percent-encoded name from matching a rule that never named it.
 *  - `removeHeaders` names drop those request headers before forwarding —
 *    case-insensitive on both the rule name and the header key, so a
 *    hand-assembled `Referer` key dies just like a parsed `referer` one.
 *  - `csp` is collected by the evaluator but deliberately NOT applied here —
 *    it is a response-header rewrite, and the response side is P2.
 *
 * The URL's incoming form is preserved: an origin-form `/x?a=1` stays
 * origin-form, an absolute-form `https://h/x?a=1` stays absolute. Surviving
 * params are byte-preserved — the query is split on `&` and rejoined, never
 * run through `URLSearchParams`, so kept values are not decoded/re-encoded
 * (`sig=a%20b` must not come back `sig=a+b`; signed URLs live or die on the
 * exact query bytes). The fragment rides along untouched.
 *
 * Nothing mutates: inputs are returned as-is when no transform fires.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { RequestVerdict } from '@blockingmachine/core';

/**
 * `sec-fetch-dest` → the evaluator's ABP contentType tokens. The header is
 * client-declared fetch metadata — a lie buys a hostile client nothing an
 * absent header doesn't, so it is an honest hint for resource-type
 * modifiers. Only mappings with one reading are listed: `empty` (fetch,
 * XHR, beacons, EventSource all report it) is deliberately absent —
 * xmlhttprequest/ping/other are all live guesses, and wrong attribution is
 * worse than none.
 */
const SEC_FETCH_DEST_TYPES: Readonly<Record<string, string>> = {
  document: 'document',
  frame: 'subdocument',
  iframe: 'subdocument',
  fencedframe: 'subdocument',
  embed: 'object',
  object: 'object',
  image: 'image',
  imageset: 'image',
  script: 'script',
  // Workers and worklets are script fetches — Chromium's own webRequest
  // resource types classify them under 'script' the same way.
  worker: 'script',
  sharedworker: 'script',
  serviceworker: 'script',
  audioworklet: 'script',
  paintworklet: 'script',
  style: 'stylesheet',
  font: 'font',
  audio: 'media',
  video: 'media',
  track: 'media',
  websocket: 'websocket',
  // Declared dests outside the primary types are 'other' — exactly what
  // the token means in the ABP vocabulary.
  manifest: 'other',
  report: 'other',
  xslt: 'other',
};

/**
 * The evaluator's `contentType` context, inferred from what a terminated
 * request truthfully declares. `sec-fetch-dest` maps directly; the `accept`
 * fallback applies only where the client's most-preferred type admits one
 * reading (`image/*` → image, `text/css` → stylesheet) — ambiguous or
 * absent signals stay `undefined`, so a wrong guess can never fire an
 * `$image`-style rule that shouldn't. No `thirdParty` inference lives here:
 * a network-layer proxy sees no initiator, so first-/third-party stays
 * unanswerable by design.
 */
export function inferContentType(headers: IncomingHttpHeaders): string | undefined {
  const dest = headers['sec-fetch-dest'];
  const destValue = Array.isArray(dest) ? dest[0] : dest;
  if (typeof destValue === 'string') {
    const normalized = destValue.trim().toLowerCase();
    if (normalized === 'empty') {
      return undefined; // fetch/XHR/beacon/EventSource share it — no honest type
    }
    // A declared dest outside the known table still means "some resource
    // fetch" — 'other' is the vocabulary's catch-all for exactly that.
    return SEC_FETCH_DEST_TYPES[normalized] ?? 'other';
  }
  const accept = headers.accept;
  const acceptValue = Array.isArray(accept) ? accept[0] : accept;
  if (typeof acceptValue === 'string') {
    const first = acceptValue.split(',', 1)[0].split(';', 1)[0].trim().toLowerCase();
    if (first.startsWith('image/')) {
      return 'image';
    }
    if (first === 'text/css') {
      return 'stylesheet';
    }
  }
  return undefined;
}

/**
 * The `name` half of one `name[=value]` query entry — the raw text before the
 * first `=`. Value-less entries (`?flag`) name themselves.
 */
function paramName(entry: string): string {
  const eq = entry.indexOf('=');
  return eq < 0 ? entry : entry.slice(0, eq);
}

/**
 * The URL with its query filtered. Splits off the fragment, finds the first
 * `?` (a valid URL cannot contain an earlier one), and drops entries whose
 * name `keep(entry)` rejects. An emptied query drops the `?` entirely — the
 * bare-path form upstream engines produce.
 */
function stripQueryParams(url: string, keep: (name: string) => boolean): string {
  const hash = url.indexOf('#');
  const head = hash < 0 ? url : url.slice(0, hash);
  const fragment = hash < 0 ? '' : url.slice(hash);
  const q = head.indexOf('?');
  if (q < 0) {
    return url;
  }
  const entries = head.slice(q + 1).split('&');
  const surviving = entries.filter((entry) => keep(paramName(entry)));
  if (surviving.length === entries.length) {
    return url; // nothing named for removal was present
  }
  const base = head.slice(0, q);
  return surviving.length === 0
    ? `${base}${fragment}`
    : `${base}?${surviving.join('&')}${fragment}`;
}

/**
 * Apply the request-side half of a verdict's transforms. `removeParams` names
 * strip query params from `url` (`"all"` strips everything but `keepParams`);
 * `removeHeaders` strips request headers case-insensitively. Returns the
 * inputs untouched when nothing applies — pass-through is the common case.
 */
export function applyRequestTransforms(
  url: string,
  headers: IncomingHttpHeaders,
  t: RequestVerdict['transforms'],
): { url: string; headers: IncomingHttpHeaders } {
  let outUrl = url;
  if (t.removeParams === 'all') {
    const keep = new Set(t.keepParams);
    outUrl = stripQueryParams(url, (name) => keep.has(name));
  } else if (t.removeParams.length > 0) {
    const drop = new Set(t.removeParams);
    outUrl = stripQueryParams(url, (name) => !drop.has(name));
  }

  let outHeaders = headers;
  if (t.removeHeaders.length > 0) {
    const drop = new Set(t.removeHeaders.map((name) => name.toLowerCase()));
    const next: IncomingHttpHeaders = {};
    let removed = false;
    for (const [name, value] of Object.entries(headers)) {
      if (drop.has(name.toLowerCase())) {
        removed = true;
        continue;
      }
      next[name] = value;
    }
    // Only swap the reference when a strip actually fired — the identity
    // return keeps pass-through cheap and the "untouched" contract literal.
    if (removed) {
      outHeaders = next;
    }
  }

  return { url: outUrl, headers: outHeaders };
}
