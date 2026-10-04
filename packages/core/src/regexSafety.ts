/**
 * A structural precheck for downloaded regular expressions.
 *
 * A blocklist line like `/^(a+)+$/` compiles without complaint and then spends unbounded
 * backtracking time on every string it is tested against. `RegExp` has no step budget, so the
 * only honest in-process answer is to refuse the shapes that *provably* exhibit it — refusal,
 * with the reason named, rather than a timeout nobody can implement.
 *
 * Three shapes are refused:
 *
 *  - **Nested repetition** — a quantifier applied to a group whose body already carries a
 *    quantifier: `(a+)+`, `(\w{2,8})*`, `(.*)*`. The classic exponential family: the inner
 *    repeat and the outer repeat can partition the same input arbitrarily many ways.
 *  - **Nullable group under repetition** — `(a?)*`, `(|x)+`, `()*`: a group that can match the
 *    empty string, quantified, leaves the engine an unbounded number of zero-width splits to
 *    explore.
 *  - **Ambiguous alternation under repetition** — `(a|aa)+`, `(ab|a)+`: two branches that can
 *    begin on the same character, repeated — the same exponential family reached another way.
 *
 * The check is deliberately one-directional: it can say *no* with a reason, and anything it
 * cannot prove it still admits — disjoint alternations like `(ab|ac)+` and anchored prefixes
 * like `(?:^|\.)` are normal list vocabulary and pass. The cost of a wrong "no" is a skipped
 * rule recorded for the caller to show; the cost of a wrong "yes" is the hang this module
 * exists to prevent.
 */

/** Beyond this, a pattern is refused on length alone — the same bound `coverage.ts` applies. */
export const MAX_REGEX_PATTERN_LENGTH = 2000;

interface GroupFrame {
  /** Body contained a repetition operator somewhere inside the group. */
  hasRepeat: boolean;
  /** Body contained a top-level `|`. */
  hasAlternation: boolean;
  /** At least one top-level branch could match the empty string. */
  anyBranchNullable: boolean;
  /** The branch currently being scanned could still match the empty string. */
  branchNullable: boolean;
}

/**
 * Skip a `(?…)` group-type prefix and return the index just past it.
 *
 * `?` here is syntax — `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>`, `(?P<name>` — not a
 * quantifier, and the scanner must not record it as one. Returns the index of the first body
 * char, or -1 when the prefix is malformed (in which case `new RegExp` fails as it does today).
 */
function skipGroupPrefix(pattern: string, openParen: number): number {
  if (pattern[openParen + 1] !== '?') return openParen + 1;
  const marker = pattern[openParen + 2];
  if (marker === ':' || marker === '=' || marker === '!') return openParen + 3;
  if (marker === '<' && (pattern[openParen + 3] === '=' || pattern[openParen + 3] === '!')) {
    return openParen + 4;
  }
  // `(?<name>…` and `(?P<name>…` run to the closing `>` of the name.
  const nameStart = marker === 'P' ? openParen + 3 : openParen + 2;
  if (marker === '<' || marker === 'P') {
    const close = pattern.indexOf('>', nameStart + (marker === 'P' ? 1 : 0));
    return close > 0 ? close + 1 : -1;
  }
  return -1;
}

/** Whether `{…}` at `i` is an interval quantifier (`{2}`, `{2,}`, `{2,8}`) — not a literal. */
function intervalQuantifierEnd(pattern: string, i: number): number {
  let j = i + 1;
  while (j < pattern.length && /\d/.test(pattern[j])) j += 1;
  if (pattern[j] === ',') {
    j += 1;
    while (j < pattern.length && /\d/.test(pattern[j])) j += 1;
  }
  return j > i + 1 && pattern[j] === '}' ? j : -1;
}

/**
 * Whether the quantifier starting at `i` can match zero times (`*`, `?`, `{0,…}`).
 * `i` must already point at a quantifier — `*`, `?`, or a `{` that begins an interval.
 */
function isOptionalQuantifier(pattern: string, i: number): boolean {
  const ch = pattern[i];
  if (ch === '*' || ch === '?') return true;
  if (ch !== '{') return false;
  const end = intervalQuantifierEnd(pattern, i);
  return end > i && pattern[i + 1] === '0';
}

/**
 * Whether the quantifier at `i` can apply its atom *more than once* — `*`, `+`, `{m,}`, or
 * `{m,n}` with `n > 1`. This is the property that turns a group into a loop: `(a+)?` applies
 * the inner repeat at most once and is benign, while `(a+)+` is the exponential family. The
 * refusals key on this, not on quantification alone.
 */
function isRepeatingQuantifier(pattern: string, i: number): boolean {
  const ch = pattern[i];
  if (ch === '*' || ch === '+') return true;
  if (ch !== '{') return false;
  const end = intervalQuantifierEnd(pattern, i);
  if (end <= i) return false;
  const spec = pattern.slice(i + 1, end);
  const comma = spec.indexOf(',');
  if (comma < 0) return parseInt(spec, 10) > 1;
  if (comma === spec.length - 1) return true; // {m,} is unbounded
  return parseInt(spec.slice(comma + 1), 10) > 1;
}

function isQuantifierAt(pattern: string, i: number): boolean {
  const ch = pattern[i];
  return ch === '*' || ch === '+' || ch === '?' || (ch === '{' && intervalQuantifierEnd(pattern, i) > i);
}

/** The index one past the quantifier at `i`, or `i` itself when there is none. */
function skipQuantifier(pattern: string, i: number): number {
  const ch = pattern[i];
  if (ch === '*' || ch === '+' || ch === '?') return i + 1;
  if (ch === '{') {
    const end = intervalQuantifierEnd(pattern, i);
    if (end > i) return end + 1;
  }
  return i;
}

/**
 * Advance past one atom starting at `i` and return `{ end }` — the index of the character
 * after the atom — so the caller can inspect the token that follows it.
 *
 * Returns null where the pattern is malformed in a way the scan cannot read; the caller
 * degrades to admitting nothing rather than trusting a half-parsed structure.
 */
function atomEnd(pattern: string, i: number, openParenIsGroup: boolean): number | null {
  const ch = pattern[i];
  if (ch === '\\') return i + 2 <= pattern.length ? i + 2 : null;
  if (ch === '[') {
    let j = i + 1;
    if (pattern[j] === '^') j += 1; // negation marker is part of the class
    if (pattern[j] === ']') j += 1; // a literal `]` in first position
    while (j < pattern.length && pattern[j] !== ']') {
      j += pattern[j] === '\\' ? 2 : 1;
    }
    return j < pattern.length ? j + 1 : null;
  }
  if (ch === '(' && openParenIsGroup) {
    let depth = 0;
    let inClass = false;
    for (let j = i; j < pattern.length; j += 1) {
      const c = pattern[j];
      if (c === '\\') { j += 1; continue; }
      if (inClass) { if (c === ']') inClass = false; continue; }
      if (c === '[') { inClass = true; continue; }
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
    }
    return null;
  }
  return i + 1;
}

/** Split a group body on top-level `|` and return the branch texts. */
function topLevelBranches(body: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\') { i += 1; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === '|' && depth === 0) {
      branches.push(body.slice(start, i));
      start = i + 1;
    }
  }
  branches.push(body.slice(start));
  return branches;
}

/** The member characters of each shorthand class — `\d`, `\w`, `\s` — used for overlap. */
const SHORTHAND_CHARS: Record<string, string> = {
  d: '0123456789',
  w: 'abcdefghijklmnopqrstuvwxyz0123456789_',
  s: ' \t\n\r\f\v',
};

/**
 * The characters one branch can begin matching on.
 *
 * Zero-width atoms (anchors, lookarounds) are walked past; an optional atom contributes its
 * own first characters and lets the scan continue into the next atom, since it may be absent.
 * Shorthand classes are recorded as their escape symbol and expanded at compare time; `.` is a
 * wildcard that overlaps everything; literals are lowercased because callers compile with `i`.
 * Nested groups contribute their own branches' firsts recursively — bounded, since a group is
 * always shorter than the branch that holds it.
 *
 * Complements are modeled honestly rather than approximated as wildcards: a negated class or an
 * uppercase shorthand (`\D`, `\W`, `\S`) is emitted as a `[^<excluded>` token — "every character
 * except these" — so `[^a]` overlaps a `b` branch and stays disjoint from an `a` one, which is
 * exactly the pair of facts the ambiguity check needs. A negated class whose exclusions are
 * themselves complements or unbounded ranges (`[^\D…]`, `[^\x00-\uFFFF…]`) contributes nothing:
 * it matches almost nothing, so it cannot partition input ambiguously either way.
 */
function firstSetOf(branch: string): Set<string> {
  const firsts = new Set<string>();
  let i = 0;
  while (i < branch.length) {
    const ch = branch[i];
    if (ch === '^' || ch === '$' || ch === '|') { i += 1; continue; }
    if (ch === '\\') {
      const esc = (branch[i + 1] || '');
      const lower = esc.toLowerCase();
      // An uppercase shorthand is the complement of its class — model it as one rather
      // than folding it to the class itself, which reads the exact opposite set.
      if (esc !== lower && SHORTHAND_CHARS[lower] !== undefined) {
        firsts.add(`[^${SHORTHAND_CHARS[lower]}`);
      } else {
        firsts.add(`\\${lower}`);
      }
      i += 2;
    } else if (ch === '[') {
      const end = atomEnd(branch, i, false);
      if (end === null) return firsts;
      const negated = branch[i + 1] === '^';
      const excluded = new Set<string>();
      // For a negated class the scan collects what it *excludes*; an exclusion that is
      // itself a complement or an unbounded range means the class matches almost nothing
      // and contributes no firsts at all.
      let unbounded = false;
      for (let j = i + 1 + (negated ? 1 : 0); j < end - 1; j += 1) {
        if (branch[j] === '\\') {
          const esc = branch[j + 1] || '';
          const lower = esc.toLowerCase();
          const shorthand = SHORTHAND_CHARS[lower];
          if (shorthand === undefined) {
            if (negated) excluded.add(lower);
            else firsts.add(`\\${lower}`);
          } else if (esc === lower) {
            if (negated) {
              for (const c of shorthand) excluded.add(c);
            } else {
              firsts.add(`\\${lower}`);
            }
          } else if (negated) {
            // `[^\D…]` — an uppercase shorthand inside a negated class excludes the
            // complement, i.e. matches only the shorthand's own members.
            for (const c of shorthand) firsts.add(c);
          } else {
            firsts.add(`[^${shorthand}`);
          }
          j += 1;
        } else if (
          branch[j] === '-' &&
          j > i + 1 + (negated ? 1 : 0) &&
          j < end - 2 &&
          branch[j + 1] !== '\\'
        ) {
          // A bounded range is expanded — `[a-z]` really does start on `m`, and stopping at
          // the endpoints would admit the ambiguity the check exists to catch. Anything wider
          // than a couple of hundred chars is effectively `.` for this purpose — or, under
          // negation, effectively "excludes everything".
          const lo = branch.charCodeAt(j - 1);
          const hi = branch.charCodeAt(j + 1);
          if (hi - lo <= 256) {
            for (let c = lo; c <= hi; c += 1) {
              if (negated) excluded.add(String.fromCharCode(c).toLowerCase());
              else firsts.add(String.fromCharCode(c).toLowerCase());
            }
          } else if (negated) {
            unbounded = true;
          } else {
            firsts.add('.');
          }
        } else {
          if (negated) excluded.add(branch[j].toLowerCase());
          else firsts.add(branch[j].toLowerCase());
        }
      }
      if (negated && !unbounded) {
        // `[^]` is "any character" in JavaScript — the one negated class that is a wildcard.
        if (excluded.size === 0) firsts.add('.');
        else firsts.add(`[^${[...excluded].sort().join('')}`);
      }
      i = end;
    } else if (ch === '(') {
      const end = atomEnd(branch, i, true);
      if (end === null) return firsts;
      const bodyStart = skipGroupPrefix(branch, i);
      if (bodyStart < 0) return firsts;
      const marker = branch[i + 1] === '?' ? branch[i + 2] : '';
      if (marker === '=' || marker === '!' || (marker === '<' && (branch[i + 3] === '=' || branch[i + 3] === '!'))) {
        i = end; // lookarounds consume nothing — the next atom still answers the question
      } else {
        for (const inner of topLevelBranches(branch.slice(bodyStart, end - 1))) {
          for (const c of firstSetOf(inner)) firsts.add(c);
        }
        i = end;
      }
    } else if (ch === '.') {
      firsts.add('.');
      i += 1;
    } else {
      firsts.add(ch.toLowerCase());
      i += 1;
    }
    // The atom just read is optional — and the scan continues — iff the token after it
    // repeats it from zero.
    if (i < branch.length && isQuantifierAt(branch, i) && isOptionalQuantifier(branch, i)) {
      i = skipQuantifier(branch, i);
      continue;
    }
    i = skipQuantifier(branch, i);
    return firsts;
  }
  return firsts;
}

/**
 * The leading literal characters of a branch, and whether a non-literal atom continues it.
 *
 * Ambiguity under repetition needs more than a shared first character: `(ab|ac)+` diverges
 * deterministically on the second char and is linear, while `(a|aa)+` can partition the same
 * run of `a`s either way and is exponential. The distinguishing property is a *prefix*
 * relationship between the branches' literal prefixes — `a` is a prefix of `aa`, `ab` and
 * `ac` are not prefixes of each other — or equal prefixes that continue into constructs the
 * literal walk cannot compare (`a\w` vs `a[0-9]`).
 */
function literalPrefixOf(branch: string): { prefix: string; continuesNonLiteral: boolean } {
  let prefix = '';
  let i = 0;
  while (i < branch.length) {
    const ch = branch[i];
    if (ch === '^' || ch === '$') { i += 1; continue; }
    // Anything that is not a plain literal char — an escape, a class, a group, `.`, a
    // quantifier — ends the comparable prefix and is remembered as the continuation.
    if (ch === '\\' || ch === '[' || ch === '(' || ch === '.') {
      return { prefix, continuesNonLiteral: true };
    }
    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') break; // quantifier on the last literal
    prefix += ch.toLowerCase();
    i += 1;
  }
  return { prefix, continuesNonLiteral: false };
}
function firstSetsOverlap(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false; // an empty branch proves nothing here
  if (a.has('.') || b.has('.')) return true;
  const isComplement = (token: string) => token.startsWith('[^');
  const aComplements = [...a].filter(isComplement);
  const bComplements = [...b].filter(isComplement);
  // Two complements always intersect — `[^a]` and `[^b]` share every third character.
  if (aComplements.length > 0 && bComplements.length > 0) return true;
  const expands = (set: Set<string>): Set<string> => {
    const out = new Set<string>();
    for (const token of set) {
      if (isComplement(token)) continue; // handled against the other side's expanded set below
      if (token === '\\d') for (const d of SHORTHAND_CHARS.d) out.add(d);
      else if (token === '\\w') for (const c of SHORTHAND_CHARS.w) out.add(c);
      else if (token === '\\s') for (const c of SHORTHAND_CHARS.s) out.add(c);
      else if (token.length === 2 && token.startsWith('\\')) out.add(token[1]);
      else out.add(token);
    }
    return out;
  };
  const ea = expands(a);
  const eb = expands(b);
  // A complement overlaps the other side iff that side can start on any character the
  // complement does not exclude.
  for (const token of aComplements) {
    const excluded = new Set(token.slice(2));
    for (const ch of eb) if (!excluded.has(ch)) return true;
  }
  for (const token of bComplements) {
    const excluded = new Set(token.slice(2));
    for (const ch of ea) if (!excluded.has(ch)) return true;
  }
  for (const ch of ea) if (eb.has(ch)) return true;
  return false;
}

interface QuantifiedGroup {
  /** Index of the group's closing `)`. */
  bodyEnd: number;
}

/**
 * Why a pattern is refused, or null when its structure does not exhibit a provably
 * backtracking shape.
 *
 * One pass reads the pattern left to right, tracking a group stack; a second pass, run only
 * over quantified alternation groups, compares branch first-sets. Both are linear in the
 * pattern — the analysis itself cannot be the thing that hangs.
 */
export function refusedRegexReason(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return `pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters`;
  }

  const stack: GroupFrame[] = [];
  const quantifiedAlternations: QuantifiedGroup[] = [];
  let inClass = false;

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      // An escape is one atom: nullable only if the token after it repeats it from zero.
      i += 1;
      const frame = stack[stack.length - 1];
      if (frame) {
        const next = i + 1;
        if (isQuantifierAt(pattern, next)) {
          frame.hasRepeat = true;
          if (!isOptionalQuantifier(pattern, next)) frame.branchNullable = false;
        } else {
          frame.branchNullable = false;
        }
      }
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      const frame = stack[stack.length - 1];
      if (frame) {
        const end = atomEnd(pattern, i, false);
        const next = end === null ? i + 1 : end;
        if (isQuantifierAt(pattern, next)) {
          frame.hasRepeat = true;
          if (!isOptionalQuantifier(pattern, next)) frame.branchNullable = false;
        } else {
          frame.branchNullable = false;
        }
      }
      continue;
    }
    if (ch === '(') {
      stack.push({ hasRepeat: false, hasAlternation: false, anyBranchNullable: false, branchNullable: true });
      const bodyStart = skipGroupPrefix(pattern, i);
      if (bodyStart < 0) return null; // malformed — `new RegExp` reports it the same as today
      i = bodyStart - 1;
      continue;
    }
    if (ch === '|') {
      const frame = stack[stack.length - 1];
      if (frame) {
        frame.hasAlternation = true;
        if (frame.branchNullable) frame.anyBranchNullable = true;
        frame.branchNullable = true;
      }
      continue;
    }
    if (ch === ')') {
      const frame = stack.pop();
      if (!frame) return null; // unbalanced — leave it to `new RegExp`
      if (frame.branchNullable) frame.anyBranchNullable = true;
      const next = i + 1;
      const quantified = isQuantifierAt(pattern, next);
      const repeating = quantified && isRepeatingQuantifier(pattern, next);
      if (repeating) {
        // Nullable first — a loop that can match nothing is the worse of the two hangs.
        if (frame.anyBranchNullable) return 'a quantified group can match the empty string';
        if (frame.hasRepeat) return 'a quantified group contains a quantifier (nested repetition)';
        if (frame.hasAlternation) {
          quantifiedAlternations.push({ bodyEnd: i });
        }
      }
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.hasRepeat = parent.hasRepeat || frame.hasRepeat || repeating;
        // A required (unquantified or non-optional) non-nullable group settles the parent's
        // nullable question; an optional or nullable group leaves it open.
        const optional = quantified && isOptionalQuantifier(pattern, next);
        if (!optional && !frame.anyBranchNullable) parent.branchNullable = false;
      }
      continue;
    }
    if (isQuantifierAt(pattern, i)) {
      const frame = stack[stack.length - 1];
      if (frame) {
        frame.hasRepeat = true;
        // A required repetition means the atom before it must match — the branch was already
        // marked non-nullable when the atom was read, so nothing more is owed here.
      }
      i = skipQuantifier(pattern, i) - 1;
      continue;
    }
    // Any other consuming atom — a literal, `.`, a non-quantified construct. Anchors `^`/`$`
    // are zero-width and leave the nullable question open.
    const frame = stack[stack.length - 1];
    if (frame && ch !== '^' && ch !== '$') {
      const next = i + 1;
      if (isQuantifierAt(pattern, next)) {
        frame.hasRepeat = true;
        if (!isOptionalQuantifier(pattern, next)) frame.branchNullable = false;
      } else {
        frame.branchNullable = false;
      }
    }
  }

  // Second pass: each quantified alternation group gets the ambiguity check — the branch
  // first-sets must overlap AND the literal prefixes must nest, because a shared first
  // character alone (`ab|ac`) diverges deterministically and is linear, while a prefix
  // relationship (`a|aa`) is what lets the engine partition one run of input two ways.
  for (const group of quantifiedAlternations) {
    const body = groupBodyAt(pattern, group.bodyEnd);
    if (body === null) return null;
    const branches = topLevelBranches(body);
    const sets = branches.map(firstSetOf);
    const prefixes = branches.map(literalPrefixOf);
    for (let a = 0; a < branches.length; a += 1) {
      for (let b = a + 1; b < branches.length; b += 1) {
        if (!firstSetsOverlap(sets[a], sets[b])) continue;
        const pa = prefixes[a];
        const pb = prefixes[b];
        const nests =
          pa.prefix.startsWith(pb.prefix) ||
          pb.prefix.startsWith(pa.prefix) ||
          (pa.prefix === pb.prefix && pa.prefix !== '');
        if (nests) {
          return 'a quantified alternation has branches that can partition the same input';
        }
      }
    }
  }
  return null;
}

/** The text inside the group whose `)` sits at `closeIndex`, or null when it cannot be found. */
function groupBodyAt(pattern: string, closeIndex: number): string | null {
  // The flat scan did not record the group's opening paren — recover it by walking forward
  // with a stack of unclosed `(` and taking the one this `)` closes.
  let inClass = false;
  const opens: number[] = [];
  for (let i = 0; i <= closeIndex; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') { i += 1; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') opens.push(i);
    else if (ch === ')') {
      const open = opens.pop();
      if (i === closeIndex) {
        return open === undefined ? null : pattern.slice(skipGroupPrefix(pattern, open), i);
      }
    }
  }
  return null;
}
