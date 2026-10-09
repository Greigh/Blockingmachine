'use strict';

// Blockingmachine vendored fix for GHSA-vfj7-8cjw-p6xm: upstream braces ≤3.0.3
// recurses one stack frame per brace-nesting level with no depth bound, so a
// deeply-nested pattern under the 10,000-char MAX_LENGTH cap exhausts the call
// stack (RangeError) and crashes the process. The walkers below now pass a
// depth counter and throw this SyntaxError once a pattern nests past a bound
// far above any legitimate glob (real-world brace nesting is a handful of
// levels; upstream's PoC needed ~3,500) and far below the engine's stack limit.

const MAX_NESTING_DEPTH = 256;

class NestingDepthError extends SyntaxError {
  constructor(message) {
    super(message);
    this.name = 'NestingDepthError';
  }
}

module.exports = { MAX_NESTING_DEPTH, NestingDepthError };
