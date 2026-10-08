/**
 * Turns thrown errors into user-facing copy: a plain-language `title` that says
 * what happened and what to try, plus an optional `detail` carrying the
 * technical string (status code, native message) for support — rendered muted
 * and small rather than as the headline.
 */

import { ApiError } from './api/client';

export interface FriendlyError {
  title: string;
  detail?: string;
}

/** A thrown error whose message is already written for users — it headlines
 *  as-is instead of being replaced by a generic title. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** Technical details worth keeping — trimmed so they never run long. */
function detailOf(err: unknown): string | undefined {
  if (err instanceof ApiError) {
    // The hub's own error string is often the useful part ("DNS daemon is not
    // running") — keep it when it isn't just an HTTP status restated.
    const m = err.message;
    if (err.status) return m && !/^HTTP \d+/.test(m) ? m : `Error ${err.status}`;
    return m || undefined; // "Timed out after 5000ms", "Network request failed"
  }
  if (err instanceof Error) {
    const m = err.message.trim();
    // Native exception strings ("IllegalStateException: …") help support but
    // shouldn't headline — they ride the detail line.
    return m ? (m.length > 90 ? `${m.slice(0, 87)}…` : m) : undefined;
  }
  return undefined;
}

export function describeError(err: unknown): FriendlyError {
  if (err instanceof UserError) {
    return { title: err.message };
  }
  if (err instanceof ApiError) {
    switch (err.kind) {
      case 'unreachable':
        return {
          title:
            'Can\u2019t reach the server — make sure the hub is running and both devices are on the same network.',
          detail: detailOf(err),
        };
      case 'unauthorized':
        return {
          title: 'This server is locked — add its feed token in Settings.',
          detail: detailOf(err),
        };
      case 'forbidden':
        return {
          title: 'The server refused that request — check the feed token is correct.',
          detail: detailOf(err),
        };
      case 'server': {
        // Hub-provided error strings are usually human already ("DNS daemon is
        // not running") — prefer them to a generic line.
        const m = err.message;
        const human = m && !/^HTTP \d+/.test(m) ? m : null;
        return {
          title: human ?? 'The server hit a problem — try again in a moment.',
          detail: human ? (err.status ? `Error ${err.status}` : undefined) : detailOf(err),
        };
      }
      case 'bad_response':
        return {
          title:
            'The server\u2019s answer didn\u2019t make sense — it may not be a Blockingmachine hub.',
          detail: detailOf(err),
        };
    }
  }
  return {
    title: 'Something went wrong — try again.',
    detail: detailOf(err),
  };
}

/** Convenience for inline error lines: `${context} — ${title}` reads naturally. */
export function describeActionError(context: string, err: unknown): FriendlyError {
  const { title, detail } = describeError(err);
  return { title: `${context}: ${title}`, detail };
}
