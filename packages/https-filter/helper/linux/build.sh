#!/usr/bin/env bash
#
# Build the Linux redirect helper — the netfilter REDIRECT acceptor
# (P3 Task 2). Output lands beside this script at
# helper/linux/redirect-helper (gitignored); the installer copies it to
# /usr/local/libexec/blockingmachine/.
#
# Wired into `npm run build -w @blockingmachine/https-filter` via the
# `prebuild` script, which gates it through helper/build-if-linux.mjs —
# npm only invokes this on Linux. The helper itself is intentionally
# darwin-compilable (the SO_ORIGINAL_DST leg is __linux__-guarded and
# --selftest works through BM_HELPER_TEST_DST — see the portability
# note in redirect-helper.c), so this script does NOT refuse off-Linux;
# it just labels the binary selftest-only. That keeps helper-linux's
# compiled-test posture identical to helperCommon.test.ts wherever a
# C compiler exists.
#
#   helper/linux/build.sh           # build
#   helper/linux/build.sh clean     # remove the built binary
#
# Note: helper/linux/bm-anchor.sh is a SHELL script — nothing to compile;
# install-linux-capture.sh ships it from this directory.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/redirect-helper.c"
CORE="$HERE/../common/splice.c"
OUT="$HERE/redirect-helper"

if [[ "${1:-}" == "clean" ]]; then
  rm -f "$OUT"
  exit 0
fi

CC_BIN="${CC:-cc}"
if ! command -v "$CC_BIN" >/dev/null 2>&1; then
  echo "build.sh: no C compiler ($CC_BIN) — install gcc/clang" >&2
  exit 1
fi

"$CC_BIN" -std=c11 -O2 -Wall -Wextra -Werror -o "$OUT" "$SRC" "$CORE"
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "built $OUT (SELFTEST-ONLY on $(uname -s) — SO_ORIGINAL_DST is a Linux conntrack lookup; deployable binary must be built on Linux)" >&2
else
  echo "built $OUT" >&2
fi
