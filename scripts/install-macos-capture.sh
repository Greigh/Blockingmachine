#!/usr/bin/env bash
#
# install-macos-capture.sh — install the macOS transparent-capture leg
# (design spec §5.8, P1 plan Task 3). Root required; the app invokes this
# via the repo's established `osascript … with administrator privileges`
# consent convention, or the operator runs `sudo` directly.
#
#   sudo scripts/install-macos-capture.sh <engineBundlePath> <engineRunner> [rulesPath]
#
#     <engineBundlePath>  the engine entry the launchd service execs —
#                         packages/https-filter/dist/main.js in dev, the
#                         packaged .webpack/main/filterProxy.cjs in the app.
#     <engineRunner>      the program that runs it — the Electron binary
#                         under ELECTRON_RUN_AS_NODE (env is set in the
#                         plist either way; inert for plain node) or a
#                         node binary.
#     [rulesPath]         optional compiled request-rules file; lands in
#                         the plist's BM_RULES_PATH.
#
#   Options (test/dev seams — no root needed):
#     --render-only DIR   write the anchor + both plists into DIR and stop;
#                         nothing is installed, started, or flushed.
#     --service-user NAME override the dedicated service account
#                         (default _blockingmachine).
#
# What it does, in order:
#   1. refuses unless EUID=0 (after arg parse, before any touch)
#   2. refuses if the main ruleset skips lo (`set skip on lo0` makes the
#      whole rdr-on-lo0 mechanism dead — loud failure beats silent capture)
#   3. creates the _blockingmachine group + user via dscl (idempotent;
#      UniqueID/GID chosen from the free 400s, /usr/bin/false shell,
#      /var/empty home — service-account convention, nothing writable)
#   4. creates the store dir /Users/Shared/Blockingmachine/https-filter
#      (0700, _blockingmachine-owned — CA + policy ledger root) and the
#      log dir /Library/Logs/Blockingmachine
#   5. installs the prebuilt natlook-helper AND pf-anchor.sh to
#      /Library/Application Support/Blockingmachine/ (root:wheel 0755) —
#      pf-anchor.sh is the shared anchor-arm sequence the helper calls at
#      startup for post-reboot re-arm (see FAILURE POSTURES)
#   6. writes /etc/pf.anchors/com.blockingmachine (rendered below)
#   7. writes both LaunchDaemon plists (rendered below, plutil -lint'd)
#   8. bootstraps com.blockingmachine.proxy (engine, as _blockingmachine)
#      then com.blockingmachine.natlook (helper, as root) — services BEFORE
#      the anchor so a redirect never meets a dead listener
#   9. arms the anchor via the installed pf-anchor.sh — the single
#      implementation of the sequence: record pf's pre-enable status in
#      /etc/blockingmachine-capture.state, `pfctl -a
#      com.apple/com.blockingmachine -f <anchor>`, then `pfctl -E` iff pf
#      is currently disabled, appending the returned token to the state
#      file for uninstall's -X release
#  10. verifies the anchor loaded and both services printed
#
# FAILURE POSTURES — asymmetric by design, documented here so nobody
# "fixes" the wrong half:
#   * ENGINE death is fail-OPEN: the helper's watchdog (2s bounded probes,
#     3 strikes, 10s boot grace) flushes the anchor — redirected flows
#     stop arriving, traffic flows direct. A real flush vetoes same-
#     process re-arm (a flapping engine must not oscillate rules); a
#     helper restart or an installer re-run is what restores capture.
#   * HELPER death is fail-CLOSED: rdr points at :9295 whether or not a
#     listener exists — a hard-killed helper leaves live rdr → RST on
#     :9295 → dead web until launchd KeepAlive restarts it (or uninstall,
#     or reboot — there is no watchdog for the watcher; KeepAlive is the
#     recovery path).
#   * REBOOT drops the anchor: pf's rules and enable state are per-boot —
#     after restart both daemons come up via KeepAlive over a silently
#     inert capture. The helper re-arms at startup when the state file
#     marks capture enabled AND the anchor is absent AND the engine
#     answers a probe — by invoking the installed pf-anchor.sh, never a
#     second copy of the pfctl logic.
#
# Idempotent: re-running refreshes every artifact and rebootstrap's both
# services — that is also the documented way to re-arm the anchor after
# the helper's fail-open watchdog flushed it (the helper's own startup
# re-arm covers the reboot case only).
#
# THE ANCHOR DESIGN — three deliberate facts live here:
#   a) The anchor path is com.apple/com.blockingmachine, nested under the
#      stock ruleset's ONLY wildcard attach points (rdr-anchor/anchor
#      "com.apple/*" in /etc/pf.conf). A top-level "com.blockingmachine"
#      anchor would load fine via pfctl -a but never be evaluated — the
#      main ruleset must not be edited (system file), so nesting is how
#      rules get evaluated at all.
#   b) macOS rdr fires only on INBOUND packets (verified against XNU's
#      pf_match_translation — outbound rdr matching covers the reply path
#      of an already-redirected flow, not new connections). Local egress
#      therefore needs `pass out route-to lo0` so flows arrive on lo0
#      inbound where `rdr on lo0` rewrites them to the helper — the same
#      mechanism sshuttle/mitmproxy ship on macOS.
#   c) The loop-break is `user != _blockingmachine` on the route-to rules:
#      pf allows user/group matching on FILTER rules only — `no rdr …
#      user` is not parseable pf syntax (rdr-rule grammar has no user
#      option, confirmed against pf.conf(5) on this machine). The `no rdr`
#      lines carry the residual exemption that IS legal in the rdr
#      ruleset: loopback-destined flows are never redirected, which also
#      closes the engine-dials-127.0.0.1:443 recursion case.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HELPER_PORT=9295
ENGINE_PORT=9294
CONTROL_PORT=9293
SERVICE_USER="_blockingmachine"
RENDER_ONLY=""

ANCHOR_NAME="com.apple/com.blockingmachine"
ANCHOR_FILE="/etc/pf.anchors/com.blockingmachine"
STATE_FILE="/etc/blockingmachine-capture.state"
APP_SUPPORT_DIR="/Library/Application Support/Blockingmachine"
HELPER_SRC="$REPO_ROOT/packages/https-filter/helper/macos/natlook-helper"
HELPER_DST="$APP_SUPPORT_DIR/natlook-helper"
STORE_DIR="/Users/Shared/Blockingmachine/https-filter"
LOG_DIR="/Library/Logs/Blockingmachine"
NATLOOK_PLIST="/Library/LaunchDaemons/com.blockingmachine.natlook.plist"
PROXY_PLIST="/Library/LaunchDaemons/com.blockingmachine.proxy.plist"

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
usage:
  install-macos-capture.sh [options] <engineBundlePath> <engineRunner> [rulesPath]
    --render-only DIR    write rendered anchor + plists into DIR, touch nothing
    --service-user NAME  service account name (default _blockingmachine)
EOF
  exit 2
}

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --render-only)   RENDER_ONLY="${2:?--render-only needs a dir}"; shift 2 ;;
    --service-user)  SERVICE_USER="${2:?--service-user needs a name}"; shift 2 ;;
    -h|--help)       usage ;;
    --)              shift; while [[ $# -gt 0 ]]; do POSITIONAL+=("$1"); shift; done ;;
    -*)              die "unknown option: $1" ;;
    *)               POSITIONAL+=("$1"); shift ;;
  esac
done
[[ ${#POSITIONAL[@]} -ge 2 && ${#POSITIONAL[@]} -le 3 ]] || usage
BUNDLE_PATH="${POSITIONAL[0]}"
ENGINE_RUNNER="${POSITIONAL[1]}"
RULES_PATH="${POSITIONAL[2]:-}"

# --service-user lands raw in the anchor's `user !=` filter rules and in
# dscl paths — restrict it to a real login-name shape or the anchor dies
# at pfctl with a confusing syntax error (or worse, parses as pf grammar).
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid --service-user '$SERVICE_USER' — must match [a-z_][a-z0-9_-]*"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

# ------------------------------------------------------------------ #
# Rendered artifacts — single source for install AND tests             #
# ------------------------------------------------------------------ #

render_anchor() {
  cat <<EOF
# Blockingmachine transparent HTTPS capture (see docs/https-filtering-design.md
# §5.8 + scripts/install-macos-capture.sh for the design notes — rendered at
# install time, do not hand-edit).
#
# Loaded as anchor "${ANCHOR_NAME}" — nested under the stock ruleset's only
# wildcard attach points.

# --- rdr ruleset (evaluated inbound on lo0) ---
# Loopback-destined flows are never redirected — keeps local services honest
# and closes the engine-dials-loopback recursion case (pf has no user match
# in rdr rules; the user-based exemption lives on the route-to below).
no rdr on lo0 inet proto tcp from any to 127.0.0.0/8 port { 80, 443 }
no rdr on lo0 inet6 proto tcp from any to ::1 port { 80, 443 }
# Local outbound flows route-to'd onto lo0 arrive here and get rewritten to
# the natlook helper, which recovers the original destination via DIOCNATLOOK
# and splices to the engine. The helper binds both loopback families.
rdr pass on lo0 inet proto tcp from any to any port { 80, 443 } -> 127.0.0.1 port ${HELPER_PORT}
rdr pass on lo0 inet6 proto tcp from any to any port { 80, 443 } -> ::1 port ${HELPER_PORT}

# --- filter ruleset (evaluated on outbound) ---
# Detour local tcp:{80,443} onto lo0 so the rdr above can see it (rdr only
# fires on inbound packets). user != exempts the engine's own egress — the
# loop-break this whole design leans on. Forwarded packets have user
# "unknown" and pf matches them ONLY against rules that name unknown
# (pf.conf(5)) — so routed traffic is never captured either; this leg is
# scoped to locally-originated flows by construction.
pass out quick route-to lo0 inet proto tcp from any to any port { 80, 443 } user != ${SERVICE_USER} keep state
pass out quick route-to lo0 inet6 proto tcp from any to any port { 80, 443 } user != ${SERVICE_USER} keep state
# QUIC suppression (spec §10 helper-side decision): UDP/443 is invisible to
# TCP capture — drop it so clients fall back to TCP/443 which rdr can see.
block drop out quick proto udp from any to any port 443
EOF
}

render_natlook_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.blockingmachine.natlook</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(xml_escape "$HELPER_DST")</string>
        <string>${HELPER_PORT}</string>
        <string>127.0.0.1</string>
        <string>${ENGINE_PORT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/natlook-helper.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/natlook-helper.err</string>
</dict>
</plist>
EOF
}

render_proxy_plist() {
  # BM_KEYWRAP=off pins the CA key-wrap off explicitly: _blockingmachine
  # is a service account with no login keychain, so keystore auto-resolve
  # would degrade to plaintext anyway — pin it and keep the posture
  # deterministic rather than discovered.
  local rules_env=""
  if [[ -n "$RULES_PATH" ]]; then
    rules_env=$'\n'"        <key>BM_RULES_PATH</key>"$'\n'"        <string>$(xml_escape "$RULES_PATH")</string>"
  fi
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.blockingmachine.proxy</string>
    <key>UserName</key>
    <string>$(xml_escape "$SERVICE_USER")</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(xml_escape "$ENGINE_RUNNER")</string>
        <string>$(xml_escape "$BUNDLE_PATH")</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>BM_STORE_DIR</key>
        <string>$(xml_escape "$STORE_DIR")</string>
        <key>BM_DATA_PORT</key>
        <string>${ENGINE_PORT}</string>
        <key>BM_CONTROL_PORT</key>
        <string>${CONTROL_PORT}</string>
        <key>BM_KEYWRAP</key>
        <string>off</string>
        <key>ELECTRON_RUN_AS_NODE</key>
        <string>1</string>${rules_env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/https-filter.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/https-filter.err</string>
</dict>
</plist>
EOF
}

# ------------------------------------------------------------------ #
# --render-only: emit artifacts for the test suite, touch nothing      #
# ------------------------------------------------------------------ #

if [[ -n "$RENDER_ONLY" ]]; then
  mkdir -p "$RENDER_ONLY"
  render_anchor > "$RENDER_ONLY/com.blockingmachine.anchor"
  render_natlook_plist > "$RENDER_ONLY/com.blockingmachine.natlook.plist"
  render_proxy_plist > "$RENDER_ONLY/com.blockingmachine.proxy.plist"
  log "rendered anchor + plists into $RENDER_ONLY"
  exit 0
fi

# ------------------------------------------------------------------ #
# Real install — root only from here                                   #
# ------------------------------------------------------------------ #

[[ $EUID -eq 0 ]] || die "must run as root (sudo scripts/install-macos-capture.sh …)"

[[ "$(uname -s)" == "Darwin" ]] || die "macOS only — this script is the pf capture leg"

# A skipped lo0 makes every lo0 rule dead — detect rather than deploy a
# silent no-op capture.
if pfctl -s Interfaces -i lo -v 2>/dev/null | grep -qw skip; then
  die "main ruleset has 'set skip on lo0' — the rdr-on-lo0 capture mechanism cannot work; remove the skip and retry"
fi

[[ -x "$HELPER_SRC" ]] || die "helper binary missing: $HELPER_SRC — run packages/https-filter/helper/macos/build.sh first"

# --- dedicated user + group (idempotent) ---
next_free_id() {
  # first unused NumericID >= 400 in a DirectoryServices node ($1 = /Users|/Groups, $2 = attr)
  local node="$1" attr="$2"
  dscl . -list "$node" "$attr" 2>/dev/null | awk -v base=400 '
    { ids[$2]=1 }
    END { for (i=base; ; i++) if (!(i in ids)) { print i; exit } }'
}

if ! dscl . -read "/Groups/$SERVICE_USER" >/dev/null 2>&1; then
  GID="$(next_free_id /Groups PrimaryGroupID)"
  log "creating group $SERVICE_USER gid=$GID"
  dscl . -create "/Groups/$SERVICE_USER"
  dscl . -create "/Groups/$SERVICE_USER" PrimaryGroupID "$GID"
else
  GID="$(dscl . -read "/Groups/$SERVICE_USER" PrimaryGroupID 2>/dev/null | awk '{print $2}')"
fi

if ! dscl . -read "/Users/$SERVICE_USER" >/dev/null 2>&1; then
  UID_NUM="$(next_free_id /Users UniqueID)"
  log "creating user $SERVICE_USER uid=$UID_NUM"
  dscl . -create "/Users/$SERVICE_USER"
  dscl . -create "/Users/$SERVICE_USER" UserShell /usr/bin/false
  dscl . -create "/Users/$SERVICE_USER" RealName "Blockingmachine HTTPS filter"
  dscl . -create "/Users/$SERVICE_USER" UniqueID "$UID_NUM"
  dscl . -create "/Users/$SERVICE_USER" PrimaryGroupID "$GID"
  dscl . -create "/Users/$SERVICE_USER" NFSHomeDirectory /var/empty
  dscl . -create "/Users/$SERVICE_USER" Password '*'
else
  log "user $SERVICE_USER already exists — leaving as-is"
fi

# --- directories ---
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$STORE_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$LOG_DIR"
install -d -o root -g wheel -m 0755 "$APP_SUPPORT_DIR"

# --- helper binary + the shared anchor-arm script it re-arms through ---
install -o root -g wheel -m 0755 "$HELPER_SRC" "$HELPER_DST"
install -o root -g wheel -m 0755 "$SCRIPT_DIR/pf-anchor.sh" "$APP_SUPPORT_DIR/pf-anchor.sh"
log "installed $HELPER_DST and $APP_SUPPORT_DIR/pf-anchor.sh"

# --- anchor ---
render_anchor > "$ANCHOR_FILE"
chown root:wheel "$ANCHOR_FILE"
chmod 0644 "$ANCHOR_FILE"
log "wrote $ANCHOR_FILE (anchor $ANCHOR_NAME)"

# --- plists ---
render_natlook_plist > "$NATLOOK_PLIST"
render_proxy_plist > "$PROXY_PLIST"
chown root:wheel "$NATLOOK_PLIST" "$PROXY_PLIST"
chmod 0644 "$NATLOOK_PLIST" "$PROXY_PLIST"
plutil -lint "$NATLOOK_PLIST" >/dev/null || die "$NATLOOK_PLIST failed plutil -lint"
plutil -lint "$PROXY_PLIST" >/dev/null || die "$PROXY_PLIST failed plutil -lint"
log "wrote $NATLOOK_PLIST and $PROXY_PLIST"

# --- services before anchor: a redirect must never meet a dead listener ---
boot_or_fresh() {
  local plist="$1" label="$2"
  launchctl bootout "system/$label" 2>/dev/null || true
  launchctl bootstrap "system" "$plist" || die "launchctl bootstrap $label failed"
}
boot_or_fresh "$PROXY_PLIST" com.blockingmachine.proxy
boot_or_fresh "$NATLOOK_PLIST" com.blockingmachine.natlook
log "bootstrapped com.blockingmachine.proxy (as $SERVICE_USER) and com.blockingmachine.natlook"

# --- arm the anchor through the installed shared sequence ---
# (records the pre-enable status + token ledger in the state file, loads
# the anchor, -E's iff pf is currently disabled — the helper's startup
# re-arm invokes this exact script, so the pfctl logic exists once)
"$APP_SUPPORT_DIR/pf-anchor.sh" load
log "anchor loaded; pf enabled (state: $STATE_FILE)"

# --- verify ---
if ! pfctl -a "$ANCHOR_NAME" -s rules 2>/dev/null | grep -q 'rdr pass on lo0'; then
  die "anchor loaded but rdr rules not visible — pf state inconsistent; run scripts/uninstall-macos-capture.sh"
fi
launchctl print "system/com.blockingmachine.natlook" >/dev/null 2>&1 || die "natlook service not running after bootstrap"
launchctl print "system/com.blockingmachine.proxy" >/dev/null 2>&1 || die "proxy service not running after bootstrap"

log "capture installed: tcp:{80,443} → 127.0.0.1:${HELPER_PORT} (helper) → 127.0.0.1:${ENGINE_PORT} (engine)"
log "verify: curl --cacert <ca.pem from http://127.0.0.1:${CONTROL_PORT}/v1/proxy/ca> https://example.com/"
log "remove: sudo scripts/uninstall-macos-capture.sh"
