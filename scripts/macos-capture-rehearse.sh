#!/usr/bin/env bash
#
# macos-capture-rehearse.sh — end-to-end LIVE rehearsal of the macOS
# transparent HTTPS capture leg on THIS machine (P1 plan Task 3).
#
# THIS SCRIPT MUST BE RUN AS ROOT:
#
#     sudo scripts/macos-capture-rehearse.sh [--root-squat] <engineBundlePath> <engineRunner>
#
# It does not and will not self-escalate — no sudo/osascript wrappers are
# invoked from inside; an operator (or the app's administrator-privileges
# flow) runs it directly. It mutates real system state: pf rules, two
# LaunchDaemons, a service account, /etc + /Library files. Every mutation
# is exactly what install-macos-capture.sh performs; the EXIT trap below
# guarantees the machine is left with the anchor flushed and both daemons
# booted out on ANY exit path — success, failure, or interrupt.
#
# Rehearsed sequence (each step logged, first failure stops the run):
#   1. install (install-macos-capture.sh)
#   2. wait for the engine control API on 127.0.0.1:9293
#   3. fetch the engine CA from /v1/proxy/ca into a temp file (never the
#      keychain — curl --cacert only)
#   4. drop a one-line blocklist into the store dir, POST /v1/proxy/reload
#   5. transparent allow proof: curl https://example.com/ succeeds ONLY
#      trusting the engine CA — the minted leaf proves the flow crossed
#      rdr → natlook → engine MITM, not the real wire
#   6. transparent block proof: curl to the rehearsal-blocked SNI (pinned
#      to a reachable IP via --resolve) is refused AND the engine's own
#      flowsBlocked counter ticks — the refusal is provably the verdict,
#      not a dead pinned IP passing vacuously
#   7. re-arm proof: flush the anchor by hand, then `launchctl kickstart
#      -k` the helper — the state-file gate must reload it once the engine
#      answers a probe (the exact path a post-reboot helper boot takes;
#      pf's per-boot token drop is not rehearsed — no -E needed here
#      because the install's token still holds pf enabled)
#   8. engine death: launchctl bootout com.blockingmachine.proxy —
#      simulates a crash launchd gave up on; the helper watchdog must
#      flush the anchor within ~6–10 s (3 failed 2 s probes, grace long
#      past by this point)
#   9. fail-open proof: the same curl now succeeds WITHOUT the engine CA —
#      a publicly-rooted cert proves traffic flows direct upstream
#  10. uninstall (uninstall-macos-capture.sh), report PASS
#
# --root-squat variant (flag 103): proves the installer's squat refusal
# inside the REAL install path under root — the --preflight-only test seam
# drives port_preflight alone, without root; this leg binds a stub listener
# on :9294 and runs the actual installer under this script's root context,
# asserting all three honest outcomes:
#   * exit 1, naming the squatter ("an engine already listens on :9293/:9294")
#   * no _blockingmachine account or group created
#   * zero artifacts touched — anchor, both plists, state file, helper,
#     pf-anchor.sh, store/log/app-support dirs each absent-or-byte-identical
# It never proceeds to the rehearsal sequence, and its cleanup only reaps
# the squatter — it cannot flush/bootout/uninstall a real install the way
# the rehearsal's trap does by design. Same non-auto-run posture: a flag an
# operator passes under sudo, never invoked from inside anything.
#
# Env knobs (operator overrides; not secrets):
#   REHEARSE_ALLOWED_URL   default https://example.com/
#   REHEARSE_WAIT_ENGINE_S default 60
#   REHEARSE_WAIT_FLUSH_S  default 30
#   REHEARSE_CURL_MAX_S    default 15
#
# Exit: 0 on PASS, 1 on the first failed step, 2 on usage/root-check.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="$SCRIPT_DIR/install-macos-capture.sh"
UNINSTALL="$SCRIPT_DIR/uninstall-macos-capture.sh"

ANCHOR_NAME="com.apple/com.blockingmachine"
CONTROL="http://127.0.0.1:9293"
ENGINE_PORT=9294
STORE_DIR="/Users/Shared/Blockingmachine/https-filter"
RULES_FILE="$STORE_DIR/rehearsal-block.rules"
BLOCKED_HOST="rehearsal-block.example.com"

ALLOWED_URL="${REHEARSE_ALLOWED_URL:-https://example.com/}"
WAIT_ENGINE_S="${REHEARSE_WAIT_ENGINE_S:-60}"
WAIT_FLUSH_S="${REHEARSE_WAIT_FLUSH_S:-30}"
CURL_MAX="${REHEARSE_CURL_MAX_S:-15}"

step=0
log() { printf '[rehearse %02d] %s\n' "$step" "$*"; }
fail() { printf '[rehearse %02d] FAIL: %s\n' "$step" "$*" >&2; exit 1; }
begin() { step=$((step + 1)); log "$*"; }

# json_int <file> <key> — first-level integer field out of a control-API
# response (python3 when present, sed otherwise; the responses are flat).
json_int() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get(sys.argv[2], 0)))' "$1" "$2"
  else
    sed -n "s/.*\"$2\":\(-\?[0-9][0-9]*\).*/\1/p" "$1" | head -1
  fi
}

WORK=""
CLEANUP_DONE=0
SQUAT_PID=""
# --root-squat is detected BEFORE the trap installs: cleanup must know the
# mode on every exit path, including arg-parse failures. (Detected here so
# cleanup's squat branch is correct even if we die before the arg shift.)
ROOT_SQUAT=0
for _a in "$@"; do
  if [[ "$_a" == "--root-squat" ]]; then ROOT_SQUAT=1; fi
done
cleanup() {
  local rc=$?
  if [[ $CLEANUP_DONE -eq 1 ]]; then return; fi
  CLEANUP_DONE=1
  trap - EXIT INT TERM
  if [[ $ROOT_SQUAT -eq 1 ]]; then
    # The variant installs nothing — the only thing to reap is the
    # squatter. Deliberately NOT the rehearsal's flush/bootout/uninstall:
    # a real install on this machine must survive a --root-squat run
    # untouched.
    echo "[rehearse] cleanup: killing squat listener (rc=$rc)"
    if [[ -n "$SQUAT_PID" ]]; then kill "$SQUAT_PID" 2>/dev/null || true; fi
    if [[ -n "$WORK" && -d "$WORK" ]]; then rm -rf "$WORK"; fi
    return
  fi
  echo "[rehearse] cleanup: flushing anchor + booting out daemons (rc=$rc)"
  pfctl -a "$ANCHOR_NAME" -F all >/dev/null 2>&1 || true
  launchctl bootout system/com.blockingmachine.natlook >/dev/null 2>&1 || true
  launchctl bootout system/com.blockingmachine.proxy >/dev/null 2>&1 || true
  # Full uninstall only when install actually completed — removes plists,
  # anchor file, state file, helper binary; keeps user/store by design.
  if [[ $rc -eq 0 || -f /Library/LaunchDaemons/com.blockingmachine.natlook.plist ]]; then
    bash "$UNINSTALL" >/dev/null 2>&1 || true
  fi
  if [[ -n "$WORK" && -d "$WORK" ]]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT INT TERM

usage() {
  sed -n '2,8p' "$0"
  exit 2
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; fi
if [[ "${1:-}" == "--root-squat" ]]; then shift; fi
[[ $# -ge 2 ]] || usage
[[ $EUID -eq 0 ]] || { echo "[rehearse] must run as root: sudo $0 <engineBundlePath> <engineRunner>" >&2; exit 2; }
[[ "$(uname -s)" == "Darwin" ]] || { echo "[rehearse] macOS only" >&2; exit 2; }

BUNDLE_PATH="$1"
ENGINE_RUNNER="$2"
# The variant passes these argv straight to the installer — which dies at
# its own port preflight long before the bundle path is read, so a real
# file is required for the full rehearsal only.
if [[ $ROOT_SQUAT -eq 0 ]]; then
  [[ -f "$BUNDLE_PATH" ]] || { echo "[rehearse] engine bundle not found: $BUNDLE_PATH" >&2; exit 2; }
fi
command -v curl >/dev/null || { echo "[rehearse] curl required" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/bm-rehearse.XXXXXX")"
chmod 0755 "$WORK" # _blockingmachine must traverse to read nothing here, but keep it sane
CA_PEM="$WORK/engine-ca.pem"

# ------------------------------------------------------------------ #
# --root-squat: prove the installer's squat refusal under root (flag 103)
# ------------------------------------------------------------------ #

if [[ $ROOT_SQUAT -eq 1 ]]; then
  # Everything the real install path would mutate — fingerprinted so the
  # post-run assertion is "absent or byte-identical", never "looks fine".
  ARTIFACTS=(
    "/etc/pf.anchors/com.blockingmachine"
    "/etc/blockingmachine-capture.state"
    "/Library/LaunchDaemons/com.blockingmachine.natlook.plist"
    "/Library/LaunchDaemons/com.blockingmachine.proxy.plist"
    "/Library/Application Support/Blockingmachine/natlook-helper"
    "/Library/Application Support/Blockingmachine/pf-anchor.sh"
    "/Library/Application Support/Blockingmachine"
    "$STORE_DIR"
    "/Library/Logs/Blockingmachine"
  )

  # fingerprint <path> — "ABSENT", "DIR:<mtime>", or
  # "FILE:<sha256>:<mtime>:<size>"; a same-path rewrite still counts as a
  # touch, and a refused installer writes nothing at all.
  fingerprint() {
    local p="$1"
    if [[ ! -e "$p" ]]; then echo "ABSENT"; return; fi
    if [[ -d "$p" ]]; then echo "DIR:$(stat -f '%m' "$p")"; return; fi
    echo "FILE:$(shasum -a 256 "$p" | awk '{print $1}'):$(stat -f '%m:%z' "$p")"
  }
  user_exists() { dscl . -read "/Users/_blockingmachine" >/dev/null 2>&1; }
  group_exists() { dscl . -read "/Groups/_blockingmachine" >/dev/null 2>&1; }

  begin "squat leg — snapshot pre-state, then bind a stub listener on :$ENGINE_PORT"
  pre_user=0; if user_exists; then pre_user=1; fi
  pre_group=0; if group_exists; then pre_group=1; fi
  : > "$WORK/before.tsv"
  for p in "${ARTIFACTS[@]}"; do
    printf '%s\t%s\n' "$p" "$(fingerprint "$p")" >> "$WORK/before.tsv"
  done

  # The stub squatter: python3 (always a bound socket, no client needed),
  # nc fallback. The lsof gate below is the SAME probe the installer runs —
  # if the kernel does not see a listener, the refusal asserts vacuously.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$ENGINE_PORT" <<'PY' &
import os, socket, sys, time
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1])))
s.listen(1)
# Hold the port only as long as the leg needs it — every scripted exit
# path kills $SQUAT_PID, and a rehearsal killed before its trap could run
# orphans us: reparented to launchd, getppid() flips to 1 and the squatter
# exits rather than holding the port on some fixed sleep bound.
while os.getppid() != 1:
    time.sleep(1)
PY
    SQUAT_PID=$!
  elif command -v nc >/dev/null 2>&1; then
    nc -k -l 127.0.0.1 "$ENGINE_PORT" >/dev/null 2>&1 &
    SQUAT_PID=$!
  else
    fail "need python3 or nc to hold the squat listener on :$ENGINE_PORT"
  fi
  sleep 1
  lsof -nP -iTCP:"$ENGINE_PORT" -sTCP:LISTEN >/dev/null 2>&1 \
    || fail "squat listener never bound :$ENGINE_PORT"
  log "squatter bound :$ENGINE_PORT (pid $SQUAT_PID)"

  begin "install under squat — must exit 1 naming the squatter"
  rc=0
  install_out="$(bash "$INSTALL" "$BUNDLE_PATH" "$ENGINE_RUNNER" 2>&1)" || rc=$?
  [[ $rc -eq 1 ]] || fail "installer exited $rc under a squatted :$ENGINE_PORT (want 1) — output: $install_out"
  [[ "$install_out" == *"an engine already listens on :9293/:9294"* ]] \
    || fail "installer died without the squat refusal — output: $install_out"
  log "installer refused, naming the squatter"

  begin "post-state — no new account/group, zero touched artifacts"
  if [[ $pre_user -eq 0 ]] && user_exists; then
    fail "installer created the _blockingmachine user despite refusing"
  fi
  if [[ $pre_group -eq 0 ]] && group_exists; then
    fail "installer created the _blockingmachine group despite refusing"
  fi
  while IFS=$'\t' read -r p fp; do
    now="$(fingerprint "$p")"
    [[ "$now" == "$fp" ]] || fail "installer touched $p — was '$fp', now '$now'"
  done < "$WORK/before.tsv"

  kill "$SQUAT_PID" 2>/dev/null || true
  SQUAT_PID=""
  echo "[rehearse] PASS — install under a squatted :${ENGINE_PORT} died cleanly: named the squatter, wrote nothing, created no account"
  exit 0
fi

# ------------------------------------------------------------------ #

begin "install — $INSTALL"
bash "$INSTALL" "$BUNDLE_PATH" "$ENGINE_RUNNER" "$RULES_FILE" || fail "install script failed"

begin "wait for engine control API on $CONTROL (≤${WAIT_ENGINE_S}s)"
engine_up=0
for _ in $(seq 1 "$WAIT_ENGINE_S"); do
  if curl -sf --max-time 2 "$CONTROL/v1/proxy/status" > "$WORK/status.json" 2>/dev/null; then
    engine_up=1
    break
  fi
  sleep 1
done
[[ $engine_up -eq 1 ]] || fail "engine never answered /v1/proxy/status"
log "engine status: $(tr -d '\n ' < "$WORK/status.json" | head -c 200)"

begin "fetch engine CA from /v1/proxy/ca (temp file only — never keychain)"
curl -sf --max-time 5 "$CONTROL/v1/proxy/ca" > "$WORK/ca.json" || fail "GET /v1/proxy/ca failed"
if command -v python3 >/dev/null 2>&1; then
  python3 -c 'import json,sys; sys.stdout.write(json.load(open(sys.argv[1]))["certPem"])' "$WORK/ca.json" > "$CA_PEM"
else
  sed -n 's/.*"certPem":"\([^"]*\)".*/\1/p' "$WORK/ca.json" | sed 's/\\n/\n/g' > "$CA_PEM"
fi
grep -q 'BEGIN CERTIFICATE' "$CA_PEM" || fail "no PEM in /v1/proxy/ca response"
log "engine CA: $(openssl x509 -in "$CA_PEM" -noout -subject -fingerprint -sha256 2>/dev/null | tr '\n' ' ')"

begin "write block rule for $BLOCKED_HOST into store + POST /v1/proxy/reload"
printf '||%s^\n' "$BLOCKED_HOST" > "$RULES_FILE"
chown _blockingmachine:_blockingmachine "$RULES_FILE" 2>/dev/null || chown _blockingmachine "$RULES_FILE"
chmod 0644 "$RULES_FILE"
curl -sf --max-time 5 -X POST "$CONTROL/v1/proxy/reload" > "$WORK/reload.json" || fail "reload failed"
log "reload: $(tr -d '\n ' < "$WORK/reload.json")"

begin "allow proof — curl $ALLOWED_URL trusting ONLY the engine CA"
allow_out="$(curl -sv --cacert "$CA_PEM" --max-time "$CURL_MAX" -o "$WORK/allowed.body" -w '%{http_code}' "$ALLOWED_URL" 2> "$WORK/allowed.verbose")" || fail "allowed-domain curl failed: $(tail -3 "$WORK/allowed.verbose")"
[[ "$allow_out" =~ ^(200|301|302|304|403)$ ]] || fail "unexpected HTTP status $allow_out (want 2xx/3xx/403-from-site)"
grep -q 'subject.*CN' "$WORK/allowed.verbose" || true
log "allowed fetch HTTP $allow_out through engine MITM (engine CA trusted the minted leaf)"

begin "block proof — curl $BLOCKED_HOST must be refused AND counted by the engine"
block_ip="$(dscacheutil -q host -a name example.com 2>/dev/null | awk '/ip_address:/{print $2; exit}')"
[[ -n "$block_ip" ]] || block_ip="93.184.216.34"
# The robust signal is the engine's own counter, not curl's exit: a dead
# pinned IP fails curl vacuously without the flow ever reaching a verdict.
curl -sf --max-time 5 "$CONTROL/v1/proxy/stats" > "$WORK/stats-before.json" || fail "GET /v1/proxy/stats (before) failed"
blocked_before="$(json_int "$WORK/stats-before.json" flowsBlocked)"
[[ "$blocked_before" =~ ^[0-9]+$ ]] || fail "no flowsBlocked in /v1/proxy/stats response"
if curl -s --cacert "$CA_PEM" --resolve "$BLOCKED_HOST:443:$block_ip" --max-time "$CURL_MAX" -o "$WORK/blocked.body" "https://$BLOCKED_HOST/" 2> "$WORK/blocked.verbose"; then
  fail "blocked domain was NOT refused — the rule never reached the engine"
fi
curl -sf --max-time 5 "$CONTROL/v1/proxy/stats" > "$WORK/stats-after.json" || fail "GET /v1/proxy/stats (after) failed"
blocked_after="$(json_int "$WORK/stats-after.json" flowsBlocked)"
[[ "$blocked_after" =~ ^[0-9]+$ ]] || fail "no flowsBlocked in /v1/proxy/stats response"
[[ $blocked_after -gt $blocked_before ]] || fail "blocked fetch was refused but flowsBlocked did not tick ($blocked_before→$blocked_after) — refusal was not the engine's verdict"
log "blocked fetch refused AND counted by the engine (flowsBlocked $blocked_before→$blocked_after)"

begin "re-arm proof — flush the anchor, kickstart the helper, assert it reloads"
# Simulates the post-reboot state: capture administratively enabled (state
# file persists) but the anchor rules gone (pf state is per-boot). The
# restarted helper must re-arm through pf-anchor.sh once the engine probe
# answers — ~10 s boot grace + one probe tick.
pfctl -a "$ANCHOR_NAME" -F all || fail "manual anchor flush failed"
launchctl kickstart -k system/com.blockingmachine.natlook || fail "helper kickstart failed"
rearmed=0
for _ in $(seq 1 "$WAIT_FLUSH_S"); do
  if pfctl -a "$ANCHOR_NAME" -s rules 2>/dev/null | grep -q 'rdr pass on lo0'; then
    rearmed=1
    break
  fi
  sleep 1
done
[[ $rearmed -eq 1 ]] || fail "restarted helper did not re-arm the anchor within ${WAIT_FLUSH_S}s — post-reboot capture would stay silently inert"
log "anchor re-armed by the restarted helper (state-file gate + engine probe)"

begin "engine death — launchctl bootout com.blockingmachine.proxy"
launchctl bootout system/com.blockingmachine.proxy || fail "bootout proxy failed"

begin "watchdog — anchor must auto-flush within ${WAIT_FLUSH_S}s"
flushed=0
for _ in $(seq 1 "$WAIT_FLUSH_S"); do
  if ! pfctl -a "$ANCHOR_NAME" -s rules 2>/dev/null | grep -q .; then
    flushed=1
    break
  fi
  sleep 1
done
[[ $flushed -eq 1 ]] || fail "anchor still loaded ${WAIT_FLUSH_S}s after engine death — watchdog did not fire"
log "anchor flushed by the helper watchdog (fail-open armed)"

begin "fail-open proof — $ALLOWED_URL succeeds WITHOUT the engine CA"
open_out="$(curl -sv --max-time "$CURL_MAX" -o "$WORK/open.body" -w '%{http_code}' "$ALLOWED_URL" 2> "$WORK/open.verbose")" || fail "fail-open curl failed — traffic did NOT flow direct: $(tail -3 "$WORK/open.verbose")"
[[ "$open_out" =~ ^(200|301|302|304|403)$ ]] || fail "unexpected HTTP status $open_out on direct path"
if grep -q 'issuer.*Blockingmachine\|subject.*Blockingmachine' "$WORK/open.verbose" 2>/dev/null; then
  fail "direct-path fetch still saw the engine CA — anchor may not be flushed"
fi
log "direct fetch HTTP $open_out with the publicly-trusted chain — traffic flows upstream again"

begin "uninstall — $UNINSTALL"
rm -f "$RULES_FILE" # rehearsal artifact; the CA + ledger stay by design
bash "$UNINSTALL" || fail "uninstall script failed"

begin "post-checks"
[[ ! -f /etc/pf.anchors/com.blockingmachine ]] || fail "anchor file still present after uninstall"
if pfctl -a "$ANCHOR_NAME" -s rules 2>/dev/null | grep -q .; then
  fail "anchor still has rules after uninstall"
fi
if launchctl print system/com.blockingmachine.natlook >/dev/null 2>&1; then
  fail "natlook daemon still loaded"
fi
if launchctl print system/com.blockingmachine.proxy >/dev/null 2>&1; then
  fail "proxy daemon still loaded"
fi
log "no anchor rules, no daemons, no installed files"

echo "[rehearse] PASS — install → MITM'd allow → rule block → watchdog flush → fail-open → uninstall"
exit 0
