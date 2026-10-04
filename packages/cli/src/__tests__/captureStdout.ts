/**
 * Capture what a command writes to stdout, where a machine consumer reads it.
 *
 * The defect this exists for: every `--json` payload in this CLI used to leave through whichever
 * door its command happened to use, and one of those doors was the winston console transport —
 * which prefixes a timestamp and wraps the whole message in ANSI colour. `JSON.parse` of that
 * output failed on the timestamp, not on the payload, so a machine consumer had no way around it
 * and a human reader would never have noticed. The fix was `writeJson`, but a fix nothing tests
 * is a fix that can be undone one `console.log` at a time, which is why each `--json` command
 * asserts against this capture rather than against the `data` it also returns.
 *
 * Asserting on the returned data passes either way — that was the first version of the
 * `tier-plan` test, and it is why the original defect survived it. The stream is the contract.
 */

/** Runs `fn`, returning everything written to stdout while it ran. */
export async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  const writes: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return writes.join("");
}

/** The escape byte a colourised log wraps its payload in. */
export const ANSI_ESCAPE = "\u001b";

/**
 * Parse captured stdout as the JSON document a caller piped it for.
 *
 * Asserts the two properties together, because either alone is insufficient: a payload can be
 * free of colour and still arrive with a log line around it, and it can parse while carrying
 * escapes that a terminal renders as nothing at all.
 */
export function parseJsonStdout<T = Record<string, unknown>>(output: string): T {
  if (output.includes(ANSI_ESCAPE)) {
    throw new Error(
      `--json output carried a colour escape, so the payload is inside a log line:\n${output.slice(0, 400)}`,
    );
  }
  if (output.trim().length === 0) {
    throw new Error("--json wrote nothing to stdout");
  }
  return JSON.parse(output) as T;
}