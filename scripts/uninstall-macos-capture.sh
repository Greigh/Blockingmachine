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
#   5. flushes the anchor a SECOND time — the helper can re-arm between the
#      first flush and its own bootout, and a loaded ruleset outlives the
#      processes that loaded it
#   6. removes both plists, the anchor file, the state file, and the
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

# --- 4. flush the anchor a second time ---
# The helper's startup re-arm (and any watchdog re-arm it may still hold
# from an in-flight startup) can fire between the first flush and its own
# bootout — a KeepAlive'd helper that saw the anchor absent with a live
# engine reloads it, and a ruleset pf has loaded outlives the process that
# loaded it. The second flush closes that race; with both daemons dead,
# nothing exists to re-arm a third time.
if pfctl -a "$ANCHOR_NAME" -F all 2>/dev/null; then
  log "re-flushed anchor $ANCHOR_NAME (post-bootout)"
fi

# --- 5. remove installed files ---
for f in "$NATLOOK_PLIST" "$PROXY_PLIST" "$ANCHOR_FILE" "$STATE_FILE" "$APP_SUPPORT_DIR/natlook-helper" "$APP_SUPPORT_DIR/pf-anchor.sh"; do
  if [[ -e "$f" ]]; then
    rm -f "$f"
    log "removed $f"
  fi
done
rmdir "$APP_SUPPORT_DIR" 2>/dev/null || true

# --- 6. CA handoff (flag 100): pass the service CA into the console user's
# app-engine store when that store has none — the trusted identity the
# launchd engine minted keeps answering once the user-context engine takes
# over, instead of a fresh mint the system has never seen. The service store
# is pinned BM_KEYWRAP=off so the pair is a plain copy; the receiving engine
# re-wraps under the user's own keystore on first open. Only when the user
# store lacks ca.pem — an established app-engine CA is never overwritten.
STORE_DIR="/Users/Shared/Blockingmachine/https-filter"
CONSOLE_USER="${SUDO_USER:-$(stat -f %Su /dev/console 2>/dev/null || true)}"
if [[ -n "$CONSOLE_USER" && "$CONSOLE_USER" != "root" && -f "$STORE_DIR/ca.pem" && -f "$STORE_DIR/ca.key.pem" ]]; then
  USER_HOME="$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  USER_STORE="$USER_HOME/Library/Application Support/Blockingmachine/https-filter"
  if [[ -n "$USER_HOME" && ! -f "$USER_STORE/ca.pem" ]]; then
    install -d -o "$CONSOLE_USER" -g staff -m 0700 "$USER_STORE"
    install -o "$CONSOLE_USER" -g staff -m 0600 "$STORE_DIR/ca.pem" "$USER_STORE/ca.pem"
    install -o "$CONSOLE_USER" -g staff -m 0600 "$STORE_DIR/ca.key.pem" "$USER_STORE/ca.key.pem"
    log "handed service CA to $CONSOLE_USER's app-engine store — trust carries across the boundary (flag 100)"
  fi
fi

# --- 7. kept state, reported ---
log "kept: _blockingmachine account, /Users/Shared/Blockingmachine/https-filter, /Library/Logs/Blockingmachine"
log "capture removed — traffic now flows direct (pf fail-open by construction)"
