#!/usr/bin/env bash
#
# uninstall-macos-capture.sh — remove the macOS transparent-capture leg
# installed by scripts/install-macos-capture.sh (P1 plan Task 3).
#
#   sudo scripts/uninstall-macos-capture.sh
#
# What it does, in order (each step tolerant of "already gone" — partial
# installs and re-runs must both unwind cleanly):
#   1. refuses unless EUID=0 — nothing is touched before the check
#   2. flushes the capture anchor: pfctl -a com.apple/com.blockingmachine
#      -F all — FIRST, so pf stops delivering new flows before the
#      listeners die (in-flight splices finish naturally)
#   3. reads /etc/blockingmachine-capture.state: releases EVERY recorded
#      enable token (pfctl -X <token> per PF_TOKEN line — install and any
#      post-reboot helper re-arm each append one; stale ones fail -X
#      harmlessly) or, when pf was disabled before install and no token
#      released, falls back to pfctl -d; if pf was already enabled, leaves
#      it on — the uninstaller never turns off a firewall it didn't turn on
#   4. bootout's both LaunchDaemons (engine + helper)
#   5. removes both plists, the anchor file, the state file, and the
#      helper binary + pf-anchor.sh in
#      /Library/Application Support/Blockingmachine
#
# Deliberately KEPT on the machine (reinstall must find state intact):
#   - the _blockingmachine service account + group
#   - /Users/Shared/Blockingmachine/https-filter (CA + policy ledger —
#     deleting it would orphan issued certificates and re-mint the root)
#   - /Library/Logs/Blockingmachine (service logs)
#
# The app invokes this via the same administrator-privileges convention as
# the installer; the operator may also run `sudo` directly.

set -euo pipefail

ANCHOR_NAME="com.apple/com.blockingmachine"
ANCHOR_FILE="/etc/pf.anchors/com.blockingmachine"
STATE_FILE="/etc/blockingmachine-capture.state"
APP_SUPPORT_DIR="/Library/Application Support/Blockingmachine"
NATLOOK_PLIST="/Library/LaunchDaemons/com.blockingmachine.natlook.plist"
PROXY_PLIST="/Library/LaunchDaemons/com.blockingmachine.proxy.plist"

log() { printf '[uninstall] %s\n' "$*"; }
die() { printf '[uninstall] error: %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,33p' "$0"
  exit 0
fi

[[ $EUID -eq 0 ]] || die "must run as root (sudo scripts/uninstall-macos-capture.sh)"
[[ "$(uname -s)" == "Darwin" ]] || die "macOS only"

# --- 1. flush the anchor first: stop NEW redirects before listeners die ---
if pfctl -a "$ANCHOR_NAME" -F all 2>/dev/null; then
  log "flushed anchor $ANCHOR_NAME"
else
  log "anchor $ANCHOR_NAME already absent or unloadable — continuing"
fi

# --- 2. restore pf enable state ---
PF_WAS_ENABLED=""
TOKENS=()
if [[ -f "$STATE_FILE" ]]; then
  # state file is install-owned; parse the keys without sourcing it. More
  # than one PF_TOKEN can be recorded — the helper's post-reboot re-arm
  # appends a fresh token each time it -E's.
  PF_WAS_ENABLED="$(sed -n 's/^PF_WAS_ENABLED=//p' "$STATE_FILE" | head -1)"
  while IFS= read -r t; do TOKENS+=("$t"); done < <(sed -n 's/^PF_TOKEN=//p' "$STATE_FILE")
fi

released=0
for t in ${TOKENS[@]+"${TOKENS[@]}"}; do
  [[ "$t" =~ ^[0-9]+$ ]] || continue
  if pfctl -X "$t" >/dev/null 2>&1; then
    log "released pf enable token $t"
    released=$((released + 1))
  else
    log "pf token $t already released or stale — continuing"
  fi
done

if [[ $released -gt 0 ]]; then
  : # enable refcount balanced by the -X releases above
elif [[ "$PF_WAS_ENABLED" == "0" ]]; then
  if pfctl -d 2>/dev/null; then
    log "pf disabled (it was off before install)"
  else
    log "pfctl -d failed — pf may already be disabled; continuing"
  fi
else
  log "pf was enabled before install — leaving it enabled"
fi

# --- 3. bootout both daemons (tolerant: absent services return nonzero) ---
for label in com.blockingmachine.natlook com.blockingmachine.proxy; do
  if launchctl bootout "system/$label" 2>/dev/null; then
    log "booted out $label"
  else
    log "$label not loaded — skipping"
  fi
done

# --- 4. remove installed files ---
for f in "$NATLOOK_PLIST" "$PROXY_PLIST" "$ANCHOR_FILE" "$STATE_FILE" "$APP_SUPPORT_DIR/natlook-helper" "$APP_SUPPORT_DIR/pf-anchor.sh"; do
  if [[ -e "$f" ]]; then
    rm -f "$f"
    log "removed $f"
  fi
done
rmdir "$APP_SUPPORT_DIR" 2>/dev/null || true

# --- 5. kept state, reported ---
log "kept: _blockingmachine account, /Users/Shared/Blockingmachine/https-filter, /Library/Logs/Blockingmachine"
log "capture removed — traffic now flows direct (pf fail-open by construction)"
