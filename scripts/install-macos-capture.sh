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
#                         the plist's BM_RULES_PATH. Omitted → the canonical
#                         compile output next to savePath,
#                         ~/Documents/Blockingmachine/browser.txt ($SUDO_USER's
#                         home under sudo, not root's) — a missing file is a
#                         warning, not a failure: capture starts with 0 rules
#                         until a compile lands + reload.
#
#   Options (test/dev seams — no root needed):
#     --render-only DIR   write the anchor + both plists into DIR and stop;
#                         nothing is installed, started, or flushed.
#     --preflight-only    run only the port preflight and exit — the
#                         captureScripts suite drives it by squatting a port.
#     --service-user NAME override the dedicated service account
#                         (default _blockingmachine).
#     --quic-exempt LIST  comma-separated users/numeric uids exempt from
#                         the UDP/443 drop only (flag 122) — a pass rule
#                         renders ahead of the block for each; their
#                         tcp:{80,443} flows are still captured. Also
#                         readable from BM_QUIC_EXEMPT_UIDS.
#
# What it does, in order:
#   1. refuses unless EUID=0 (after arg parse, before any touch)
#   2. refuses when anything already listens on :9293/:9294/:9295 — an engine
#      squatting the capture ports means the launchd services would fail to
#      bind while pf redirects traffic at a dead listener
#   3. refuses if the main ruleset skips lo (`set skip on lo0` makes the
#      whole rdr-on-lo0 mechanism dead — loud failure beats silent capture)
#   4. creates the _blockingmachine group + user via dscl (idempotent;
#      UniqueID/GID chosen from the free 400s, /usr/bin/false shell,
#      /var/empty home — service-account convention, nothing writable)
#   5. creates the store dir /Users/Shared/Blockingmachine/https-filter
#      (0700, _blockingmachine-owned — CA + policy ledger root) and the
#      log dir /Library/Logs/Blockingmachine
#   6. installs the prebuilt natlook-helper AND pf-anchor.sh to
#      /Library/Application Support/Blockingmachine/ (root:wheel 0755) —
#      pf-anchor.sh is the shared anchor-arm sequence the helper calls at
#      startup for post-reboot re-arm (see FAILURE POSTURES)
#   7. writes /etc/pf.anchors/com.blockingmachine (rendered below)
#   8. writes both LaunchDaemon plists (rendered below, plutil -lint'd)
#   9. bootstraps com.blockingmachine.proxy (engine, as _blockingmachine)
#      then com.blockingmachine.natlook (helper, as root) — services BEFORE
#      the anchor so a redirect never meets a dead listener
#  10. arms the anchor via the installed pf-anchor.sh — the single
#      implementation of the sequence: record pf's pre-enable status in
#      /etc/blockingmachine-capture.state, `pfctl -a
#      com.apple/com.blockingmachine -f <anchor>`, then `pfctl -E` iff pf
#      is currently disabled, appending the returned token to the state
#      file for uninstall's -X release
#  11. verifies the anchor loaded, the helper printed, and — the real
#      proof — the engine answers /v1/proxy/status (launchd registration
#      is not health; a crash-looping bundle registers fine)
#
# FAILURE POSTURES — asymmetric by design, documented here so nobody
# "fixes" the wrong half:
#   * ENGINE death is fail-OPEN: the helper's watchdog (2s bounded probes,
#     3 strikes, 10s boot grace) flushes the anchor — redirected flows
#     stop arriving, traffic flows direct. A real flush vetoes same-
#     process re-arm (a flapping engine must not oscillate rules); a
#     helper restart or an installer re-run is what restores capture.
#   * HELPER death is fail-DEGRADED, not closed: the plist's Sockets
#     dict hands the :9295 listeners to launchd, so a hard-killed helper
#     leaves a live kernel socket — redirected flows handshake into the
#     accept backlog and the KeepAlive respawn drains them (connect
#     stall for the restart window, no RSTs). A job that never restarts
#     (bootout/uninstall) drops the listener with it; the uninstaller
#     flushes the anchor in the same pass.
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
PREFLIGHT_ONLY=0
# Flag 122 — extra identities exempt from the UDP/443 drop only.
QUIC_EXEMPT="${BM_QUIC_EXEMPT_UIDS:-}"

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
    --preflight-only     run only the port preflight and exit
    --service-user NAME  service account name (default _blockingmachine)
    --quic-exempt LIST   comma-separated users/uids exempt from the udp/443 drop
EOF
  exit 2
}

# One engine, ever — a listener already on the control/data/helper ports is
# an engine (user-context, stale launchd, foreign) that would own the ports
# the launchd services then fail to take, leaving pf redirecting at a dead
# listener. lsof names the squatter in the error so the operator can stop it.
port_preflight() {
  command -v lsof >/dev/null 2>&1 || { log "lsof unavailable — port preflight skipped"; return 0; }
  local occupied
  # With socket activation (Sockets.Listeners in the natlook plist) launchd
  # — not the helper — holds :9295 while the job is loaded, so a re-install
  # sees launchd's own listener here. Exclude :9295 when the job is loaded;
  # an unloaded job cannot hold the socket, so :9295 stays checked then.
  if launchctl print "system/com.blockingmachine.natlook" >/dev/null 2>&1; then
    occupied="$(lsof -nP -iTCP:${CONTROL_PORT} -iTCP:${ENGINE_PORT} -sTCP:LISTEN 2>/dev/null || true)"
  else
    occupied="$(lsof -nP -iTCP:${CONTROL_PORT} -iTCP:${ENGINE_PORT} -iTCP:${HELPER_PORT} -sTCP:LISTEN 2>/dev/null || true)"
  fi
  if [[ -n "$occupied" ]]; then
    printf '%s\n' "$occupied" >&2
    die "an engine already listens on :${CONTROL_PORT}/:${ENGINE_PORT} — stop it before installing capture"
  fi
}

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --render-only)   RENDER_ONLY="${2:?--render-only needs a dir}"; shift 2 ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --service-user)  SERVICE_USER="${2:?--service-user needs a name}"; shift 2 ;;
    --quic-exempt)   QUIC_EXEMPT="${2:?--quic-exempt needs a value}"; shift 2 ;;
    -h|--help)       usage ;;
    --)              shift; while [[ $# -gt 0 ]]; do POSITIONAL+=("$1"); shift; done ;;
    -*)              die "unknown option: $1" ;;
    *)               POSITIONAL+=("$1"); shift ;;
  esac
done

# --preflight-only runs the port check alone — no root, no mutations, no
# positional args required; the captureScripts suite squats a port and
# expects the die.
if [[ "$PREFLIGHT_ONLY" -eq 1 ]]; then
  port_preflight
  log "port preflight clean — nothing listens on :${CONTROL_PORT}/:${ENGINE_PORT}/:${HELPER_PORT}"
  exit 0
fi

[[ ${#POSITIONAL[@]} -ge 2 && ${#POSITIONAL[@]} -le 3 ]] || usage
BUNDLE_PATH="${POSITIONAL[0]}"
ENGINE_RUNNER="${POSITIONAL[1]}"
RULES_PATH="${POSITIONAL[2]:-}"

# The omitted-rulesPath default is the canonical compiled output — the same
# join(dirname(savePath), 'browser.txt') the manager/engine resolve, where
# savePath's own default is ~/Documents/Blockingmachine/processed_rules.txt.
# Under sudo the operator's home is SUDO_USER's, never root's.
if [[ -z "$RULES_PATH" ]]; then
  rules_home="$HOME"
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    resolved_home="$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
    [[ -n "$resolved_home" ]] && rules_home="$resolved_home"
  fi
  RULES_PATH="$rules_home/Documents/Blockingmachine/browser.txt"
  log "rulesPath not given — defaulting to $RULES_PATH"
fi
if [[ ! -f "$RULES_PATH" ]]; then
  log "warning: $RULES_PATH does not exist — capture will start with 0 rules until a compile lands + reload"
fi

# --service-user lands raw in the anchor's `user !=` filter rules and in
# dscl paths — restrict it to a real login-name shape or the anchor dies
# at pfctl with a confusing syntax error (or worse, parses as pf grammar).
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid --service-user '$SERVICE_USER' — must match [a-z_][a-z0-9_-]*"

# Flag 122 — each exempt identity lands inside a pf `user =` clause in the
# anchor; same login-name/numeric contract as --service-user so a config
# string can never inject pf grammar.
for _qe in ${QUIC_EXEMPT//,/ }; do
  [[ "$_qe" =~ ^[0-9]+$ || "$_qe" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid --quic-exempt entry '$_qe' — numeric uid or login-name shape"
done
unset _qe

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
# Same "user !=" scoping as the route-to rules: the service account's egress
# is exempt, and forwarded packets (user "unknown") never match a user
# clause — an unscoped drop would also kill routed LAN clients' QUIC.
# Flag-122 per-user opt-outs render as "user =" pass lines ahead of the
# drop — "quick" makes the first match win, so a configured uid keeps
# QUIC while its tcp:{80,443} flows still ride the route-to capture.
EOF
  local _qe
  for _qe in ${QUIC_EXEMPT//,/ }; do
    printf 'pass out quick proto udp from any to any port 443 user = %s\n' "$_qe"
  done
  cat <<EOF
block drop out quick proto udp from any to any port 443 user != ${SERVICE_USER}
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
    <key>Sockets</key>
    <dict>
        <key>Listeners</key>
        <array>
            <dict>
                <key>SockNodeName</key>
                <string>127.0.0.1</string>
                <key>SockServiceName</key>
                <string>${HELPER_PORT}</string>
                <key>SockType</key>
                <string>stream</string>
                <key>SockFamily</key>
                <string>IPv4</string>
            </dict>
            <dict>
                <key>SockNodeName</key>
                <string>::1</string>
                <key>SockServiceName</key>
                <string>${HELPER_PORT}</string>
                <key>SockType</key>
                <string>stream</string>
                <key>SockFamily</key>
                <string>IPv6</string>
            </dict>
        </array>
    </dict>
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

# The squat check — before the account, directories, helper, anchor, plists
# or services are touched. An engine already on the capture ports would make
# the launchd services fail to bind while pf redirects traffic at a dead
# listener — the failure only showing in logs.
port_preflight

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

# --- CA handoff (flag 100): adopt the invoking user's app-engine CA into a
# FRESH service store so installing capture doesn't mint a second CA identity
# under an already-trusted root. Only when the service store has no ca.pem —
# an established service CA is never overwritten — and only when the user's
# app store has one. The export runs under the USER'S account: its keystore
# is the only thing that can unwrap a ca.key.enc envelope. The receiving
# engine re-wraps under its own backend on first open (BM_KEYWRAP=off here
# pins plaintext), and certAuthority's orphan rules keep the PEM inert.
CONSOLE_USER="${SUDO_USER:-$(stat -f %Su /dev/console 2>/dev/null || true)}"
USER_STORE=""
if [[ -n "$CONSOLE_USER" && "$CONSOLE_USER" != "root" ]]; then
  USER_HOME="$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  [[ -n "$USER_HOME" ]] && USER_STORE="$USER_HOME/Library/Application Support/Blockingmachine/https-filter"
fi
if [[ -n "$USER_STORE" && ! -f "$STORE_DIR/ca.pem" && -f "$USER_STORE/ca.pem" ]]; then
  CA_STAGE="$(mktemp -d /tmp/bm-ca-adopt.XXXXXX)"
  chown "$CONSOLE_USER" "$CA_STAGE"
  if sudo -u "$CONSOLE_USER" env BM_STORE_DIR="$USER_STORE" "$ENGINE_RUNNER" "$BUNDLE_PATH" --export-ca "$CA_STAGE" >/dev/null 2>&1 \
     && [[ -f "$CA_STAGE/ca.pem" && -f "$CA_STAGE/ca.key.pem" ]]; then
    install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 "$CA_STAGE/ca.pem" "$STORE_DIR/ca.pem"
    install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 "$CA_STAGE/ca.key.pem" "$STORE_DIR/ca.key.pem"
    log "adopted $CONSOLE_USER's app-engine CA into $STORE_DIR — existing trust carries across the boundary (flag 100)"
  else
    log "CA adoption skipped — export produced no pair; the service engine mints fresh (drift detection will flag a CA swap)"
  fi
  rm -rf "$CA_STAGE"
fi

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
# launchctl print proves REGISTRATION, not health — a crash-looping engine
# prints fine. The real check is the engine's own control answer, polled
# with the same bounded-patience loop the rehearsal script uses (the engine
# mints its CA on first boot — RSA keygen can take several seconds).
engine_up=0
for _ in $(seq 1 30); do
  if curl -sf --max-time 2 "http://127.0.0.1:${CONTROL_PORT}/v1/proxy/status" >/dev/null 2>&1; then
    engine_up=1
    break
  fi
  sleep 1
done
[[ "$engine_up" -eq 1 ]] || die "com.blockingmachine.proxy never answered /v1/proxy/status on :${CONTROL_PORT} — the service is bootstrapped but the engine is not healthy; check ${LOG_DIR}/https-filter.err"

log "capture installed: tcp:{80,443} → 127.0.0.1:${HELPER_PORT} (helper) → 127.0.0.1:${ENGINE_PORT} (engine)"
log "verify: curl --cacert <ca.pem from http://127.0.0.1:${CONTROL_PORT}/v1/proxy/ca> https://example.com/"
log "remove: sudo scripts/uninstall-macos-capture.sh"
