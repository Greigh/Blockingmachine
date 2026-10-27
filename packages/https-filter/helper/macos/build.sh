#!/usr/bin/env bash
#
# Build the macOS natlook helper — the pf-capture acceptor (P1 Task 2).
# Output lands beside this script at helper/macos/natlook-helper (gitignored);
# the installer copies it to /Library/Application Support/Blockingmachine/.
#
# Wired into `npm run build -w @blockingmachine/https-filter` via the
# `prebuild` script, which gates it through helper/build-if-darwin.mjs —
# this script itself is invoked unconditionally on every platform, so it
# refuses cleanly rather than failing on a missing SDK.
#
#   helper/macos/build.sh           # build (darwin only; warns+exits elsewhere)
#   helper/macos/build.sh clean     # remove the built binary

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/natlook-helper.c"
CORE="$HERE/../common/splice.c"
OUT="$HERE/natlook-helper"

if [[ "${1:-}" == "clean" ]]; then
  rm -f "$OUT"
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build.sh: natlook-helper is a macOS-only target — skipping on $(uname -s)" >&2
  exit 0
fi

if ! command -v clang >/dev/null 2>&1; then
  echo "build.sh: clang not found — install Xcode command line tools" >&2
  exit 1
fi

clang -std=c11 -O2 -Wall -Wextra -Werror -o "$OUT" "$SRC" "$CORE"
echo "built $OUT" >&2
