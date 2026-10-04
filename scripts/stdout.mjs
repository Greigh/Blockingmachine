/**
 * The scripts/ side of the single machine-readable output contract: **stdout is a JSON document
 * and nothing else, and every `--json` path leaves through this writer.**
 *
 * It exists because the contract had one writer and one exception — the CLI's `writeJson` in
 * `packages/cli/src/lib/logger.ts` wrote `JSON.stringify(payload, null, 2)` plus a newline for
 * every command, while `compile-tier-rulesets.mjs --json` rolled its own `console.log` of the
 * same shape. Two writers that happen to agree today are a contract that drifts tomorrow, and the
 * compiler's version was the one a machine consumer would notice: a `console.log` route is where
 * a `console.log`-decorated payload grows back.
 *
 * The bytes are deliberately identical to the CLI's writer — a pretty-printed document and a
 * trailing newline — because a pipe cannot tell which side of the repo wrote them and should not
 * have to. The two cannot share the module: scripts are plain `.mjs` that must run without a
 * build step (the compiler runs in CI before `dist/` exists), while the CLI's writer lives behind
 * a compiled package boundary. One contract, one writer per runtime it can reach, and a shared
 * stdout-parsing test (`jsonOutput.test.ts`) that reads both.
 */

/**
 * Writes a machine-readable result to stdout — the JSON document, a newline, and nothing else.
 *
 * Anything meant for a human goes to stderr (`console.error`) or the script's normal log, never
 * here: a line beside the document is a document that does not parse.
 */
export function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
