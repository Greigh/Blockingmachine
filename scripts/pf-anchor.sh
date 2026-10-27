#!/usr/bin/env bash
#
# pf-anchor.sh — the single implementation of the capture-anchor arm
# sequence (design spec §5.8, P1 plan Task 3). Two callers, one code path:
#
#   * install-macos-capture.sh runs it once at install time (as the
#     step-9 arm, after both LaunchDaemons are up).
#   * natlook-helper runs the INSTALLED copy (beside itself in
#     /Library/Application Support/Blockingmachine/) at startup when pf's
#     state did not survive a reboot — pf drops its rules and enable state
#     at boot while the anchor file, the state file, and the LaunchDaemons
#     all persist, so the capture is administratively on but silently
#     inert until something reloads the anchor. The helper is the root
#     process alive to notice; it gates the call on the state file
#     existing and the engine answering a probe, so a dead engine never
#     gets a blackhole re-armed.
#
#   pf-anchor.sh load
#
# The sequence is identical for both callers:
#   1. record pf's pre-enable status in /etc/blockingmachine-capture.state
#      — FIRST writer wins, so the file always describes pf as it was
#      before Blockingmachine first touched it (uninstall's restore
#      contract). Appended enable tokens accumulate across installs and
#      reboot re-arms; uninstall releases each.
#   2. pfctl -a com.apple/com.blockingmachine -f <anchor file>
#   3. pfctl -E ONLY when pf is currently disabled — an -E against an
#      already-enabled pf would take an unneeded token and inflate the
#      enable refcount. The token is appended to the state file so
#      uninstall's -X release stays balanced across reboot arms too.
#
# Root required (pfctl); exits nonzero loudly on the first failure — the
# caller decides what that means (installer dies, helper logs and runs
# on fail-open).

set -euo pipefail

ANCHOR_NAME="com.apple/com.blockingmachine"
ANCHOR_FILE="/etc/pf.anchors/com.blockingmachine"
STATE_FILE="/etc/blockingmachine-capture.state"

log() { printf '[pf-anchor] %s\n' "$*" >&2; }
die() { printf '[pf-anchor] error: %s\n' "$*" >&2; exit 1; }

[[ "${1:-}" == "load" ]] || die "usage: pf-anchor.sh load"
[[ "$(uname -s)" == "Darwin" ]] || die "macOS only — this script is the pf capture leg"
[[ $EUID -eq 0 ]] || die "must run as root (pfctl)"

[[ -f "$ANCHOR_FILE" ]] || die "anchor file missing: $ANCHOR_FILE — capture was never installed or was uninstalled"

# --- 1. state file: first writer records the honest pre-enable status ---
if [[ ! -f "$STATE_FILE" ]]; then
  PF_WAS_ENABLED=0
  if pfctl -s info 2>/dev/null | grep -q '^Status: Enabled'; then
    PF_WAS_ENABLED=1
  fi
  printf 'PF_WAS_ENABLED=%s\n' "$PF_WAS_ENABLED" > "$STATE_FILE"
  chmod 0600 "$STATE_FILE"
  log "recorded pre-enable pf status was_enabled=$PF_WAS_ENABLED"
fi

# --- 2. load the anchor ruleset ---
pfctl -a "$ANCHOR_NAME" -f "$ANCHOR_FILE" || die "pfctl anchor load failed (check: sudo pfctl -nf $ANCHOR_FILE)"

# --- 3. ensure pf enabled, recording every token we take ---
if pfctl -s info 2>/dev/null | grep -q '^Status: Enabled'; then
  log "anchor loaded; pf already enabled (no token taken)"
else
  PF_TOKEN="$(pfctl -E 2>/dev/null | sed -n 's/^Token : //p' | tr -d '[:space:]')"
  if [[ -n "$PF_TOKEN" ]]; then
    printf 'PF_TOKEN=%s\n' "$PF_TOKEN" >> "$STATE_FILE"
    log "anchor loaded; pf enabled (token=$PF_TOKEN recorded)"
  else
    # Enabled but unparseable token — capture is live; uninstall's
    # PF_WAS_ENABLED=0 path restores the pre-install posture via pfctl -d.
    log "anchor loaded; pf enabled (no token parsed — uninstall falls back to -d)"
  fi
fi
