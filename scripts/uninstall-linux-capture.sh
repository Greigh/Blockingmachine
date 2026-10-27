#!/usr/bin/env bash
#
# uninstall-linux-capture.sh — remove the Linux transparent-capture leg
# installed by scripts/install-linux-capture.sh (P3 plan Task 2).
#
#   sudo scripts/uninstall-linux-capture.sh
#
# What it does, in order (each step tolerant of "already gone" — partial
# installs and re-runs must both unwind cleanly):
#   1. refuses unless EUID=0 — nothing is touched before the check
#   2. flushes the capture rules via the installed bm-anchor.sh —
#      FIRST, so netfilter stops delivering new flows before the
#      listeners die (in-flight splices finish naturally)
#   3. stops + disables all three units (proxy, helper, capture-rules —
#      stopping capture-rules fires its ExecStop=flush-only, a second
#      flush for free)
#   4. flushes AGAIN — the helper's startup re-arm can fire between the
#      first flush and its own stop (a Restart=always'd helper that saw
#      rules absent with a live engine reloads them, and loaded rules
#      outlive the process that loaded them — the P1 race lesson,
#      identical mechanism to the macOS second pfctl flush)
#   5. removes the unit files, the state file, and the installed
#      helper + bm-anchor.sh from /usr/local/libexec/blockingmachine
#   6. daemon-reload
#
# Deliberately KEPT on the machine (reinstall must find state intact):
#   - the `blockingmachine` service account
#   - /var/lib/blockingmachine/https-filter (CA + policy ledger —
#     deleting it would orphan issued certificates and re-mint the root)
#
# The app invokes this via the same consent convention as the installer;
# the operator may also run `sudo` directly.

set -euo pipefail

LIBEXEC_DIR="/usr/local/libexec/blockingmachine"
ANCHOR_DST="$LIBEXEC_DIR/bm-anchor.sh"
HELPER_DST="$LIBEXEC_DIR/redirect-helper"
STATE_FILE="/etc/blockingmachine-capture-linux.state"
UNIT_DIR="/etc/systemd/system"
UNITS=(blockingmachine-proxy.service blockingmachine-helper.service blockingmachine-capture-rules.service)

log() { printf '[uninstall] %s\n' "$*"; }
die() { printf '[uninstall] error: %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,29p' "$0"
  exit 0
fi

[[ $EUID -eq 0 ]] || die "must run as root (sudo scripts/uninstall-linux-capture.sh)"
[[ "$(uname -s)" == "Linux" ]] || die "Linux only"

# --- 1. flush the rules first: stop NEW redirects before listeners die ---
# The installed shared script replays the state file's recorded
# mechanism; falls back to detection on a partial install; tolerant of
# already-absent rules.
if [[ -x "$ANCHOR_DST" ]]; then
  "$ANCHOR_DST" flush-only || true
  log "flushed capture rules via bm-anchor.sh"
else
  # Partial install (libexec already gone): nothing sane to replay
  # through — a raw nft/iptables probe is the best-effort fallback.
  nft delete table ip blockingmachine_nat >/dev/null 2>&1 || true
  nft delete table ip6 blockingmachine_nat >/dev/null 2>&1 || true
  iptables -t nat -D OUTPUT -p tcp -m multiport --dports 80,443 -j REDIRECT --to-ports 9295 >/dev/null 2>&1 || true
  log "bm-anchor.sh absent — best-effort direct flush done"
fi

# --- 2. stop + disable the units (tolerant: absent units return nonzero) ---
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop "${UNITS[@]}" >/dev/null 2>&1 || true
  # stopping capture-rules fires ExecStop=flush-only — a second flush
  systemctl disable "${UNITS[@]}" >/dev/null 2>&1 || true
  log "stopped + disabled ${UNITS[*]}"
else
  log "systemctl absent — units already can't run; continuing"
fi

# --- 3. flush the rules a second time ---
# The helper can re-arm between the first flush and its own stop — and
# loaded rules outlive the process that loaded them. The second flush
# closes that race; with all units dead nothing exists to re-arm a
# third time.
if [[ -x "$ANCHOR_DST" ]]; then
  "$ANCHOR_DST" flush-only || true
  log "re-flushed capture rules (post-stop)"
fi

# --- 4. remove installed files ---
for f in "$UNIT_DIR/blockingmachine-proxy.service" \
         "$UNIT_DIR/blockingmachine-helper.service" \
         "$UNIT_DIR/blockingmachine-capture-rules.service" \
         "$HELPER_DST" "$ANCHOR_DST" "$STATE_FILE"; do
  if [[ -e "$f" ]]; then
    rm -f "$f"
    log "removed $f"
  fi
done
rmdir "$LIBEXEC_DIR" 2>/dev/null || true

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi

# --- 5. kept state, reported ---
log "kept: blockingmachine account, /var/lib/blockingmachine/https-filter"
log "capture removed — traffic now flows direct (fail-open by construction)"
