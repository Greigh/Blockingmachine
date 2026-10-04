/**
 * The argv parser shared by the scripts in this directory, built on one refusal contract:
 * **a named value is honoured or refused, never silently replaced.**
 *
 * The shape it replaced parsed `--flag value` pairs loosely — a flag followed by nothing, or by
 * another flag, quietly became a bare flag and the script ran on the default; a typo'd flag
 * (`--chcek`, `--residul`) parsed as a flag nobody ever read and did nothing; a stray positional
 * was skipped. Every one of those is a question the operator asked, answered by a different one —
 * the same failure `--residual` in `compile-tier-rulesets.mjs` refuses with a name it cannot map.
 *
 * parseArgv(argv, { values, flags, positionals })
 *
 *   values      — flags that must carry a value: `--in file` or `--in=file`. A value flag at the
 *                 end of argv, or followed by another `--flag`, is missing its value: refused.
 *                 `--in=` is an empty value, not a missing one: refused.
 *   flags       — boolean flags that take no value: `--check`. `--check=yes` is refused — a flag
 *                 that absorbs a value is where an intended positional disappears.
 *   positionals — how many bare arguments the caller accepts (default 0 — a positional most
 *                 scripts never asked for is usually a value separated from its flag by a typo).
 *
 * Anything else — an unknown `--flag`, a `-x` that was never declared, a positional over the
 * limit — throws, naming the argument. Callers wrap the throw or let it propagate; either way the
 * process exits non-zero instead of running on a guess.
 */

export class ArgvError extends Error {}

/**
 * @param {string[]} argv            process.argv.slice(2)
 * @param {{ values?: readonly string[], flags?: readonly string[], positionals?: number }} spec
 * @returns {{ values: Map<string, string[]>, flags: Set<string>, positional: string[] }}
 */
export function parseArgv(argv, spec) {
  const valueFlags = new Set(spec.values ?? []);
  const booleanFlags = new Set(spec.flags ?? []);
  const maxPositionals = spec.positionals ?? 0;

  const values = new Map();
  const flags = new Set();
  const positional = [];

  const known = [...valueFlags, ...booleanFlags].sort().join(', ');
  const hint = known ? ` This script takes: ${known}.` : ' This script takes no arguments.';
  const fail = (message) => {
    throw new ArgvError(message + hint);
  };

  let options = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (!options || !arg.startsWith('-')) {
      positional.push(arg);
      if (positional.length > maxPositionals) {
        fail(`Unexpected argument ${JSON.stringify(arg)}.`);
      }
      continue;
    }

    // `--name=value` splits here; a bare `--name` asks the next argument to be the value.
    const separator = arg.indexOf('=');
    const name = separator > 0 ? arg.slice(0, separator) : arg;

    if (valueFlags.has(name)) {
      if (separator > 0) {
        const inline = arg.slice(separator + 1);
        if (inline === '') fail(`${name} needs a value — a bare ${name}= is not one.`);
        values.set(name, [...(values.get(name) ?? []), inline]);
        continue;
      }
      const next = argv[i + 1];
      // A flag-shaped next argument is a missing value, not a value: `--in --check` meant
      // `--in <something>` and `--check`, and honouring `--check` as a filename would lose both.
      // Single-dash tokens count too (`-h`, `-x`) — none of these scripts take a value that
      // legitimately starts with a dash.
      if (next === undefined || (next !== '-' && next.startsWith('-'))) {
        fail(`${name} needs a value.`);
      }
      values.set(name, [...(values.get(name) ?? []), next]);
      i += 1;
      continue;
    }

    if (booleanFlags.has(name)) {
      if (separator > 0) fail(`${name} takes no value — remove the ${JSON.stringify(arg.slice(separator))}.`);
      flags.add(name);
      continue;
    }

    fail(`Unknown flag ${JSON.stringify(arg)}.`);
  }

  return { values, flags, positional };
}

/** The last value a flag carried, or `undefined` — for flags that make no sense repeated. */
export function lastValue(values, name) {
  return values.get(name)?.at(-1);
}

/**
 * `parseArgv` for the top of a script: a refusal is a usage error, so it prints the message and
 * exits 2 rather than surfacing as an uncaught stack. Non-argv failures still propagate.
 */
export function parseArgvOrExit(argv, spec) {
  try {
    return parseArgv(argv, spec);
  } catch (error) {
    if (error instanceof ArgvError) {
      console.error(`\n${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}
