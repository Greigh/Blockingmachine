/**
 * Index-walked scans for the spots a `/x+$/` trim, an `x.*$` cut or a `(\w+)\s+(\d+)`
 * split would otherwise do with regex backtracking. On a hostile run of marker
 * characters — a filter line that is a thousand `|`s, a ledger line of spaces — the
 * regex engine rescans the run at every start position, which is quadratic. These
 * walks are linear, and they mirror the regex they replace exactly (same anchors,
 * same greed) so a caller can swap without re-deriving edge cases.
 */

/** True when `ch` is a single JavaScript `\s`-class character. */
export function isSpaceChar(ch: string): boolean {
  return ch.trim().length === 0;
}

function isDigitChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

/** First index of any character in `chars`, or -1 — a `/[chars]/` search without the regex. */
export function firstIndexOfAny(value: string, chars: string): number {
  for (let i = 0; i < value.length; i += 1) {
    if (chars.indexOf(value[i]) >= 0) return i;
  }
  return -1;
}

/** `/[chars]+$/` as one backward scan — strips the trailing run of characters in `chars`. */
export function stripTrailingChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.indexOf(value[end - 1]) >= 0) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/**
 * `/^(\d+)\s+(.+)$/` as a forward scan: `123 ||rule^` → `{ count: 123, rest: '||rule^' }`.
 *
 * The regex edge is kept — on an all-whitespace tail the greedy `\s+` gives back one
 * character for `.+`, so `rest` is the final whitespace character rather than empty.
 */
export function leadingCountSplit(line: string): { count: number; rest: string } | null {
  let i = 0;
  while (i < line.length && isDigitChar(line[i])) i += 1;
  if (i === 0) return null;
  let j = i;
  while (j < line.length && isSpaceChar(line[j])) j += 1;
  if (j === i) return null;
  const rest = j < line.length ? line.slice(j) : line.slice(j - 1);
  return { count: Number(line.slice(0, i)), rest };
}

/**
 * `/^(.+?)\s+(\d+)$/` as a backward scan: `||rule^ 4` → `{ head: '||rule^', count: 4 }`.
 * The lazy head means the split always lands on the *last* whitespace-then-digits run,
 * which is what scanning digits back from the end finds directly.
 */
export function trailingCountSplit(line: string): { head: string; count: number } | null {
  let i = line.length;
  while (i > 0 && isDigitChar(line[i - 1])) i -= 1;
  if (i === line.length) return null;
  let j = i;
  while (j > 0 && isSpaceChar(line[j - 1])) j -= 1;
  if (j === i || j === 0) return null;
  return { head: line.slice(0, j), count: Number(line.slice(i)) };
}
