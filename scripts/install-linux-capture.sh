#!/usr/bin/env bash
#
# install-linux-capture.sh — install the Linux transparent-capture leg
# (design spec §5.8, P3 plan Task 2). Root required; the app invokes the
# platform's installer through the same consent convention as macOS, or
# the operator runs `sudo` directly.
#
#   sudo scripts/install-linux-capture.sh <engineBundlePath> <engineRunner> [rulesPath]
#
#     <engineBundlePath>  the engine entry the systemd service execs —
#                         packages/https-filter/dist/main.js in dev, the
#                         packaged filterProxy.cjs in the app.
#     <engineRunner>      the program that runs it — a node binary (or the
#                         Electron binary under ELECTRON_RUN_AS_NODE; the
#                         unit exports it either way, inert for plain node).
#     [rulesPath]         optional compiled request-rules file; lands in
#                         the unit's BM_RULES_PATH. Omitted → the canonical
#                         compile output ~/Documents/Blockingmachine/
#                         browser.txt under $SUDO_USER's home (not root's) —
#                         a missing file is a warning, not a failure.
#
#   Options (test/dev seams — no root needed):
#     --render-only DIR   write the units/init scripts + rendered rules
#                         into DIR and stop; nothing is installed or
#                         started.
#     --preflight-only    run only the port preflight and exit — the
#                         captureScripts suite drives it by squatting a port.
#     --service-user NAME override the dedicated service account
#                         (default blockingmachine).
#     --quic-exempt LIST  comma-separated users/numeric uids exempt from
#                         the UDP/443 drop only (flag 122) — also readable
#                         from BM_QUIC_EXEMPT_UIDS. Lands in the arm call
#                         every supervisor path makes.
#
# SUPERVISORS (flag 118) — the persistent-services design is no longer
# systemd-only. Detection order: systemctl → openrc (rc-service) →
# sysvinit (/etc/init.d + start-stop-daemon) → an honest die that names
# what it found. All three install the same proxy/helper/rules trio and
# preserve the same posture contract:
#   * systemd   — the original three units (Restart=always, oneshot arm).
#   * openrc    — /etc/init.d/blockingmachine-{proxy,helper,capture-rules}
#                 openrc-run scripts; proxy+helper run under
#                 supervise-daemon (respawn_delay/respawn_max — restart-
#                 on-death), capture-rules is a start/stop arm+flush.
#   * sysvinit  — LSB init.d scripts for the same trio; proxy+helper are
#                 started via start-stop-daemon --make-pidfile --background
#                 --startas bm-supervise.sh — the shipped respawn loop that
#                 holds the Restart=always semantics sysvinit lacks.
#
# What it does, in order:
#   1. refuses unless EUID=0 (after arg parse, before any touch)
#   2. refuses off-Linux, then detects the supervisor (above) — an
#      unknown init is a named refusal, never a silent partial install
#   3. refuses when anything already listens on :9293/:9294/:9295 — an
#      engine squatting the capture ports means the services would fail
#      to bind while netfilter redirects traffic at a dead listener
#   4. creates the `blockingmachine` system user (useradd -r -s nologin,
#      idempotent) — the skuid/--uid-owner exemption the whole design
#      leans on
#   5. creates /var/lib/blockingmachine/https-filter (0700, service-user
#      owned — CA + policy ledger root)
#   6. installs redirect-helper + bm-anchor.sh + bm-supervise.sh to
#      /usr/local/libexec/blockingmachine/ — bm-anchor.sh is the shared
#      rules-arm sequence every supervisor ExecStarts/starts and the
#      helper's watchdog flushes/re-arms through (see FAILURE POSTURES —
#      same single-implementation contract as pf-anchor.sh)
#   7. writes the service trio into /etc/systemd/system or /etc/init.d
#   8. enables + starts in order: proxy (engine, as blockingmachine) →
#      helper (root) → capture-rules arm — services BEFORE the rules so
#      a redirect never meets a dead listener or a dead engine
#   9. verifies the rules loaded (bm-anchor.sh status), the helper is
#      running, and — the real proof — the engine answers
#      /v1/proxy/status (service start is not health; a crash-looping
#      bundle "starts" fine)
#
# FAILURE POSTURES — asymmetric by design, same shape as macOS:
#   * ENGINE death is fail-OPEN: the helper watchdog (2s bounded probes,
#     3 strikes, 10s grace) flushes the rules via bm-anchor.sh — traffic
#     flows direct. A real flush vetoes same-process re-arm; a helper
#     restart or installer re-run restores capture.
#   * HELPER death is fail-CLOSED: REDIRECT points at :9295 whether or
#     not a listener exists — a hard-killed helper leaves RSTs until the
#     supervisor's restart path (Restart=always / supervise-daemon /
#     bm-supervise loop) brings it back (no watchdog for the watcher).
#   * REBOOT drops the rules: nft/iptables state is per-boot while the
#     service trio and the state file persist. The capture-rules leg is
#     the arm (systemd oneshot ExecStart=load/ExecStop=flush-only; the
#     openrc/sysvinit services run the same bm-anchor.sh pair); the
#     helper's own startup re-arm (state present + rules absent + engine
#     live) is the belt.
#
# Idempotent: re-running refreshes every artifact, re-creates the user
# only if absent, restarts all three units, and re-arms the rules —
# that is also the documented way to restore capture after the helper's
# fail-open watchdog flushed it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HELPER_PORT=9295
ENGINE_PORT=9294
CONTROL_PORT=9293
SERVICE_USER="blockingmachine"
RENDER_ONLY=""
PREFLIGHT_ONLY=0
# Flag 122 — extra identities exempt from the UDP/443 drop only; also the
# config channel for the anchor arm line (bm-anchor.sh reads the same env).
QUIC_EXEMPT="${BM_QUIC_EXEMPT_UIDS:-}"

LIBEXEC_DIR="/usr/local/libexec/blockingmachine"
ANCHOR_SRC="$REPO_ROOT/packages/https-filter/helper/linux/bm-anchor.sh"
ANCHOR_DST="$LIBEXEC_DIR/bm-anchor.sh"
HELPER_SRC="$REPO_ROOT/packages/https-filter/helper/linux/redirect-helper"
HELPER_DST="$LIBEXEC_DIR/redirect-helper"
SUPERVISE_SRC="$REPO_ROOT/packages/https-filter/helper/linux/bm-supervise.sh"
SUPERVISE_DST="$LIBEXEC_DIR/bm-supervise.sh"
STATE_FILE="/etc/blockingmachine-capture-linux.state"
STORE_ROOT="/var/lib/blockingmachine"
STORE_DIR="$STORE_ROOT/https-filter"
UNIT_DIR="/etc/systemd/system"
PROXY_UNIT="$UNIT_DIR/blockingmachine-proxy.service"
HELPER_UNIT="$UNIT_DIR/blockingmachine-helper.service"
RULES_UNIT="$UNIT_DIR/blockingmachine-capture-rules.service"
INITD_DIR="/etc/init.d"
PROXY_INITD="$INITD_DIR/blockingmachine-proxy"
HELPER_INITD="$INITD_DIR/blockingmachine-helper"
RULES_INITD="$INITD_DIR/blockingmachine-capture-rules"

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
usage:
  install-linux-capture.sh [options] <engineBundlePath> <engineRunner> [rulesPath]
    --render-only DIR    write rendered units/init scripts + rules into DIR, touch nothing
    --preflight-only     run only the port preflight and exit
    --service-user NAME  service account name (default blockingmachine)
    --quic-exempt LIST   comma-separated users/uids exempt from the udp/443 drop
EOF
  exit 2
}

# One engine, ever — a listener already on the control/data/helper ports
# is an engine (user-context, stale unit, foreign) that would own the
# ports the services then fail to take, leaving netfilter redirecting at
# a dead listener. `ss` names/prints the row; the /proc/net/tcp fallback
# matches the hex ports for minimal images without iproute2.
port_preflight() {
  local occupied=""
  if command -v ss >/dev/null 2>&1; then
    occupied="$(ss -ltnH 2>/dev/null | awk -v re=":(${CONTROL_PORT}|${ENGINE_PORT}|${HELPER_PORT})\$" '$4 ~ re')"
  else
    local h4 h5 h3
    h3="$(printf '%04X' "$CONTROL_PORT")"
    h4="$(printf '%04X' "$ENGINE_PORT")"
    h5="$(printf '%04X' "$HELPER_PORT")"
    occupied="$(awk -v a="$h3" -v b="$h4" -v c="$h5" '
      NR>1 && $4=="0A" {
        split($2,p,":");
        if (p[2]==a||p[2]==b||p[2]==c) print FILENAME": "$2
      }' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)"
  fi
  if [[ -n "$occupied" ]]; then
    printf '%s\n' "$occupied" >&2
    die "an engine already listens on :${CONTROL_PORT}/:${ENGINE_PORT} — stop it before installing capture"
  fi
}

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --render-only)    RENDER_ONLY="${2:?--render-only needs a dir}"; shift 2 ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --service-user)   SERVICE_USER="${2:?--service-user needs a name}"; shift 2 ;;
    --quic-exempt)    QUIC_EXEMPT="${2:?--quic-exempt needs a value}"; shift 2 ;;
    -h|--help)        usage ;;
    --)               shift; while [[ $# -gt 0 ]]; do POSITIONAL+=("$1"); shift; done ;;
    -*)               die "unknown option: $1" ;;
    *)                POSITIONAL+=("$1"); shift ;;
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
# Under sudo the operator's home is SUDO_USER's, never root's — resolved
# through NSS (getent) so an LDAP/AD account still lands correctly.
if [[ -z "$RULES_PATH" ]]; then
  rules_home="$HOME"
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    resolved_home="$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6)"
    [[ -n "$resolved_home" ]] && rules_home="$resolved_home"
  fi
  RULES_PATH="$rules_home/Documents/Blockingmachine/browser.txt"
  log "rulesPath not given — defaulting to $RULES_PATH"
fi
if [[ ! -f "$RULES_PATH" ]]; then
  log "warning: $RULES_PATH does not exist — capture will start with 0 rules until a compile lands + reload"
fi

# --service-user lands raw in useradd and as the rules' skuid match —
# restrict it to a real login-name shape (same [a-z_][a-z0-9_-]* the mac
# installer pins and NAME_REGEX enforces).
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid --service-user '$SERVICE_USER' — must match [a-z_][a-z0-9_-]*"

# Flag 122 — each exempt identity lands inside the arm line's
# --quic-exempt argument and inside rendered rules; same login-name/
# numeric contract as --service-user (bm-anchor.sh re-validates too).
for _qe in ${QUIC_EXEMPT//,/ }; do
  [[ "$_qe" =~ ^[0-9]+$ || "$_qe" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid --quic-exempt entry '$_qe' — numeric uid or login-name shape"
done
unset _qe
QUIC_ARM_ARGS=()
[[ -n "$QUIC_EXEMPT" ]] && QUIC_ARM_ARGS=(--quic-exempt "$QUIC_EXEMPT")

# systemd Environment= needs the value side quote-safe — single-quote
# each whole assignment; paths with spaces still parse as one value.
env_line() { printf 'Environment="%s=%s"\n' "$1" "$2"; }

# ------------------------------------------------------------------ #
# Rendered artifacts — single source for install AND tests             #
# ------------------------------------------------------------------ #

render_proxy_unit() {
  # BM_KEYWRAP=off pins the CA key-wrap off explicitly: a system service
  # account has no login session secrets context, so keystore
  # auto-resolve would degrade to plaintext anyway — pin it and keep the
  # posture deterministic rather than discovered (same reasoning as the
  # macOS plist).
  local rules_env=""
  if [[ -n "$RULES_PATH" ]]; then
    rules_env="$(env_line BM_RULES_PATH "$RULES_PATH")"
  fi
  cat <<EOF
[Unit]
Description=Blockingmachine HTTPS filter engine (transparent capture)
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
$(env_line BM_STORE_DIR "$STORE_DIR")
$(env_line BM_DATA_PORT "$ENGINE_PORT")
$(env_line BM_CONTROL_PORT "$CONTROL_PORT")
$(env_line BM_KEYWRAP off)
$(env_line ELECTRON_RUN_AS_NODE 1)
${rules_env}
ExecStart=${ENGINE_RUNNER} ${BUNDLE_PATH}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
}

render_helper_unit() {
  cat <<EOF
[Unit]
Description=Blockingmachine transparent-capture redirect helper
After=blockingmachine-proxy.service

[Service]
Type=simple
ExecStart=${HELPER_DST} ${HELPER_PORT} ${ENGINE_PORT}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
}

render_rules_unit() {
  # The reboot re-arm (pf-anchor.sh's caller-of-record analog): nft/
  # iptables state is per-boot, so every boot re-renders+loads through
  # the installed shared script. ExecStop flushes — `systemctl stop`
  # (or the uninstaller stopping the unit) IS a rules flush.
  # Ordered after the services that must be alive when traffic starts
  # redirecting; Wants (not Requires) — a missing helper must not wedge
  # boot, the helper's own re-arm is the belt below this.
  # --uid carries the NAME: bm-anchor.sh resolves it at load time, so a
  # renumbered service account can never leave stale skuid rules behind.
  cat <<EOF
[Unit]
Description=Blockingmachine transparent-capture netfilter rules (boot re-arm)
Wants=blockingmachine-proxy.service blockingmachine-helper.service
After=blockingmachine-proxy.service blockingmachine-helper.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${ANCHOR_DST} load --uid ${SERVICE_USER} --helper-port ${HELPER_PORT}${QUIC_ARM_ARGS:+ ${QUIC_ARM_ARGS[*]}}
ExecStop=${ANCHOR_DST} flush-only

[Install]
WantedBy=multi-user.target
EOF
}

# ------------------------------------------------------------------ #
# openrc renders (flag 118) — openrc-run scripts for /etc/init.d. The   #
# proxy + helper run under supervise-daemon so a dead process respawns  #
# (respawn_delay/respawn_max are the openrc names for systemd's         #
# Restart=/RestartSec pair); capture-rules is a start/stop arm+flush.   #
# ------------------------------------------------------------------ #

render_openrc_proxy() {
  cat <<EOF
#!/sbin/openrc-run
# Blockingmachine HTTPS filter engine — rendered by
# scripts/install-linux-capture.sh; do not hand-edit.
description="Blockingmachine HTTPS filter engine (transparent capture)"
supervisor="supervise-daemon"
command="${ENGINE_RUNNER}"
command_args="${BUNDLE_PATH}"
command_user="${SERVICE_USER}"
pidfile="/run/\${RC_SVCNAME}.pid"
# Restart=always/RestartSec=2 equivalents — respawn forever, 2s between.
respawn_delay=2
respawn_max=0
respawn_period=0

depend() {
    need net
    after firewall
}

start_pre() {
    export BM_STORE_DIR="${STORE_DIR}"
    export BM_DATA_PORT="${ENGINE_PORT}"
    export BM_CONTROL_PORT="${CONTROL_PORT}"
    export BM_KEYWRAP="off"
    export ELECTRON_RUN_AS_NODE="1"
EOF
  if [[ -n "$RULES_PATH" ]]; then
    printf '    export BM_RULES_PATH="%s"\n' "$RULES_PATH"
  fi
  cat <<EOF
}
EOF
}

render_openrc_helper() {
  cat <<EOF
#!/sbin/openrc-run
# Blockingmachine redirect helper — rendered by
# scripts/install-linux-capture.sh; do not hand-edit.
description="Blockingmachine transparent-capture redirect helper"
supervisor="supervise-daemon"
command="${HELPER_DST}"
command_args="${HELPER_PORT} ${ENGINE_PORT}"
pidfile="/run/\${RC_SVCNAME}.pid"
respawn_delay=2
respawn_max=0
respawn_period=0

depend() {
    need net
    after blockingmachine-proxy
}
EOF
}

render_openrc_rules() {
  cat <<EOF
#!/sbin/openrc-run
# Blockingmachine netfilter capture rules — the boot re-arm. Runs
# bm-anchor.sh load on start and flush-only on stop, the same pair the
# systemd oneshot unit Execs (flag 118).
description="Blockingmachine transparent-capture netfilter rules (boot re-arm)"

depend() {
    after blockingmachine-proxy blockingmachine-helper
    want blockingmachine-proxy blockingmachine-helper
}

start() {
    ebegin "Arming Blockingmachine capture rules"
    ${ANCHOR_DST} load --uid ${SERVICE_USER} --helper-port ${HELPER_PORT}${QUIC_ARM_ARGS:+ ${QUIC_ARM_ARGS[*]}}
    eend \$?
}

stop() {
    ebegin "Flushing Blockingmachine capture rules"
    ${ANCHOR_DST} flush-only
    eend \$?
}
EOF
}

# ------------------------------------------------------------------ #
# sysvinit renders (flag 118) — LSB init.d scripts. sysvinit supervises #
# nothing, so the proxy + helper daemons are started via                #
# start-stop-daemon --make-pidfile --background --startas               #
# bm-supervise.sh — the shipped respawn loop preserves the              #
# Restart=always posture (stop kills the supervisor, which forwards     #
# TERM to the child). capture-rules stays a plain arm+flush script.     #
# ------------------------------------------------------------------ #

render_sysvinit_proxy() {
  cat <<EOF
#!/bin/sh
### BEGIN INIT INFO
# Provides:          blockingmachine-proxy
# Required-Start:    \$network \$remote_fs
# Required-Stop:     \$network \$remote_fs
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: Blockingmachine HTTPS filter engine (transparent capture)
# Description:       engine process supervised by bm-supervise.sh —
#                    restart-on-death preserved (flag 118)
### END INIT INFO

PIDFILE=/run/blockingmachine-proxy.pid
SUPERVISOR=${SUPERVISE_DST}

start_engine() {
    start-stop-daemon --start --quiet --pidfile "\$PIDFILE" --make-pidfile \\
        --background --chuid ${SERVICE_USER} --startas "\$SUPERVISOR" -- \\
        proxy -- env BM_STORE_DIR="${STORE_DIR}" BM_DATA_PORT="${ENGINE_PORT}" \\
        BM_CONTROL_PORT="${CONTROL_PORT}" BM_KEYWRAP=off ELECTRON_RUN_AS_NODE=1 \\
EOF
  if [[ -n "$RULES_PATH" ]]; then
    printf '        BM_RULES_PATH="%s" \\\n' "$RULES_PATH"
  fi
  cat <<EOF
        ${ENGINE_RUNNER} ${BUNDLE_PATH}
}

case "\$1" in
  start)
    echo "Starting blockingmachine-proxy"
    start_engine
    ;;
  stop)
    echo "Stopping blockingmachine-proxy"
    start-stop-daemon --stop --quiet --pidfile "\$PIDFILE" --retry=TERM/10/KILL/5
    rm -f "\$PIDFILE"
    ;;
  restart|force-reload)
    "\$0" stop
    "\$0" start
    ;;
  status)
    if [ -f "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null; then
      echo "blockingmachine-proxy running (supervisor pid \$(cat "\$PIDFILE"))"
      exit 0
    fi
    echo "blockingmachine-proxy not running"
    exit 3
    ;;
  *)
    echo "usage: \$0 {start|stop|restart|status}" >&2
    exit 3
    ;;
esac
EOF
}

render_sysvinit_helper() {
  cat <<EOF
#!/bin/sh
### BEGIN INIT INFO
# Provides:          blockingmachine-helper
# Required-Start:    \$network \$remote_fs blockingmachine-proxy
# Required-Stop:     \$network \$remote_fs
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: Blockingmachine transparent-capture redirect helper
# Description:       helper process supervised by bm-supervise.sh —
#                    restart-on-death preserved (flag 118)
### END INIT INFO

PIDFILE=/run/blockingmachine-helper.pid
SUPERVISOR=${SUPERVISE_DST}

start_helper() {
    start-stop-daemon --start --quiet --pidfile "\$PIDFILE" --make-pidfile \\
        --background --startas "\$SUPERVISOR" -- \\
        helper -- ${HELPER_DST} ${HELPER_PORT} ${ENGINE_PORT}
}

case "\$1" in
  start)
    echo "Starting blockingmachine-helper"
    start_helper
    ;;
  stop)
    echo "Stopping blockingmachine-helper"
    start-stop-daemon --stop --quiet --pidfile "\$PIDFILE" --retry=TERM/10/KILL/5
    rm -f "\$PIDFILE"
    ;;
  restart|force-reload)
    "\$0" stop
    "\$0" start
    ;;
  status)
    if [ -f "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null; then
      echo "blockingmachine-helper running (supervisor pid \$(cat "\$PIDFILE"))"
      exit 0
    fi
    echo "blockingmachine-helper not running"
    exit 3
    ;;
  *)
    echo "usage: \$0 {start|stop|restart|status}" >&2
    exit 3
    ;;
esac
EOF
}

render_sysvinit_rules() {
  cat <<EOF
#!/bin/sh
### BEGIN INIT INFO
# Provides:          blockingmachine-capture-rules
# Required-Start:    \$network \$remote_fs blockingmachine-proxy blockingmachine-helper
# Required-Stop:     \$network \$remote_fs
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: Blockingmachine netfilter capture rules (boot re-arm)
# Description:       arms via bm-anchor.sh load on start, flushes on
#                    stop — the same pair the systemd oneshot Execs (flag 118)
### END INIT INFO

case "\$1" in
  start)
    echo "Arming Blockingmachine capture rules"
    ${ANCHOR_DST} load --uid ${SERVICE_USER} --helper-port ${HELPER_PORT}${QUIC_ARM_ARGS:+ ${QUIC_ARM_ARGS[*]}}
    ;;
  stop)
    echo "Flushing Blockingmachine capture rules"
    ${ANCHOR_DST} flush-only
    ;;
  restart|force-reload)
    "\$0" stop
    "\$0" start
    ;;
  status)
    ${ANCHOR_DST} status
    ;;
  *)
    echo "usage: \$0 {start|stop|restart|status}" >&2
    exit 3
    ;;
esac
EOF
}

# ------------------------------------------------------------------ #
# --render-only: emit artifacts for the test suite, touch nothing      #
# ------------------------------------------------------------------ #

if [[ -n "$RENDER_ONLY" ]]; then
  mkdir -p "$RENDER_ONLY"
  render_proxy_unit > "$RENDER_ONLY/blockingmachine-proxy.service"
  render_helper_unit > "$RENDER_ONLY/blockingmachine-helper.service"
  render_rules_unit > "$RENDER_ONLY/blockingmachine-capture-rules.service"
  # flag-118 renders: every supervisor's trio, so the structural suite
  # diff-asserts the bytes that would land under either init scheme.
  mkdir -p "$RENDER_ONLY/openrc" "$RENDER_ONLY/sysvinit"
  render_openrc_proxy > "$RENDER_ONLY/openrc/blockingmachine-proxy"
  render_openrc_helper > "$RENDER_ONLY/openrc/blockingmachine-helper"
  render_openrc_rules > "$RENDER_ONLY/openrc/blockingmachine-capture-rules"
  render_sysvinit_proxy > "$RENDER_ONLY/sysvinit/blockingmachine-proxy"
  render_sysvinit_helper > "$RENDER_ONLY/sysvinit/blockingmachine-helper"
  render_sysvinit_rules > "$RENDER_ONLY/sysvinit/blockingmachine-capture-rules"
  # The rule renders come from bm-anchor.sh itself — the tested bytes
  # are the deployed bytes. --uid takes the name when the account
  # doesn't exist on this host (bm-anchor resolves names; a numeric
  # --service-user also passes through).
  uid="$(id -u "$SERVICE_USER" 2>/dev/null || printf '%s' "$SERVICE_USER")"
  bash "$ANCHOR_SRC" render "$RENDER_ONLY" --uid "$uid" --helper-port "$HELPER_PORT" ${QUIC_ARM_ARGS:+"${QUIC_ARM_ARGS[@]}"}
  log "rendered units + init scripts + rules into $RENDER_ONLY"
  exit 0
fi

# ------------------------------------------------------------------ #
# Real install — root only from here                                   #
# ------------------------------------------------------------------ #

[[ $EUID -eq 0 ]] || die "must run as root (sudo scripts/install-linux-capture.sh …)"

[[ "$(uname -s)" == "Linux" ]] || die "Linux only — this script is the netfilter capture leg"

# Supervisor detection (flag 118) — the install branches on the service
# manager actually present: systemd units, openrc-run scripts, or LSB
# sysvinit scripts. Anything else is a named refusal that says what the
# probe found, never a silent partial install.
INIT_SYSTEM=""
detect_init_system() {
  if command -v systemctl >/dev/null 2>&1; then
    INIT_SYSTEM="systemd"
  elif command -v rc-service >/dev/null 2>&1; then
    INIT_SYSTEM="openrc"
  elif [[ -d "$INITD_DIR" ]] && command -v start-stop-daemon >/dev/null 2>&1; then
    INIT_SYSTEM="sysvinit"
  else
    local found=()
    [[ -d "$INITD_DIR" ]] && found+=("/etc/init.d present but no start-stop-daemon")
    command -v busybox >/dev/null 2>&1 && found+=("busybox (alpine-style init)")
    die "no supported service supervisor — looked for systemctl (systemd), rc-service (openrc), /etc/init.d + start-stop-daemon (sysvinit); found: ${found[*]:-none of them}"
  fi
  log "supervisor: $INIT_SYSTEM"
}
detect_init_system

# The squat check — before the account, directories, helper, units or
# rules are touched. An engine already on the capture ports would make
# the services fail to bind while netfilter redirects at a dead listener.
port_preflight

[[ -x "$HELPER_SRC" ]] || die "helper binary missing: $HELPER_SRC — run packages/https-filter/helper/linux/build.sh first"
[[ -x "$SUPERVISE_SRC" ]] || die "bm-supervise.sh missing: $SUPERVISE_SRC — it ships beside bm-anchor.sh in helper/linux"

# --- dedicated service user (idempotent) ---
if ! getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
  NOLOGIN=/usr/sbin/nologin
  [[ -x "$NOLOGIN" ]] || NOLOGIN=/sbin/nologin
  [[ -x "$NOLOGIN" ]] || NOLOGIN=/bin/false
  log "creating system user $SERVICE_USER (shell $NOLOGIN)"
  useradd -r -s "$NOLOGIN" -d "$STORE_ROOT" "$SERVICE_USER" || die "useradd -r $SERVICE_USER failed"
else
  log "user $SERVICE_USER already exists — leaving as-is"
fi
SERVICE_UID="$(id -u "$SERVICE_USER")" || die "cannot resolve uid for $SERVICE_USER"

# --- directories ---
install -d -o root -g root -m 0755 "$STORE_ROOT"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$STORE_DIR"
install -d -o root -g root -m 0755 "$LIBEXEC_DIR"

# --- helper binary + the shared rules-arm script + the respawn wrapper ---
install -o root -g root -m 0755 "$HELPER_SRC" "$HELPER_DST"
install -o root -g root -m 0755 "$ANCHOR_SRC" "$ANCHOR_DST"
install -o root -g root -m 0755 "$SUPERVISE_SRC" "$SUPERVISE_DST"
log "installed $HELPER_DST, $ANCHOR_DST, $SUPERVISE_DST"

# --- service trio + enable/start, per the detected supervisor ---
case "$INIT_SYSTEM" in
  systemd)
    render_proxy_unit > "$PROXY_UNIT"
    render_helper_unit > "$HELPER_UNIT"
    render_rules_unit > "$RULES_UNIT"
    chown root:root "$PROXY_UNIT" "$HELPER_UNIT" "$RULES_UNIT"
    chmod 0644 "$PROXY_UNIT" "$HELPER_UNIT" "$RULES_UNIT"
    log "wrote $PROXY_UNIT, $HELPER_UNIT, $RULES_UNIT"

    # services before rules: a redirect must never meet a dead listener
    systemctl daemon-reload
    systemctl enable blockingmachine-proxy.service blockingmachine-helper.service blockingmachine-capture-rules.service || die "systemctl enable failed — the boot re-arm contract requires all three units enabled"
    systemctl restart blockingmachine-proxy.service || die "proxy service failed to start"
    systemctl restart blockingmachine-helper.service || die "helper service failed to start"
    # The capture-rules oneshot ExecStart's bm-anchor.sh load — the single
    # implementation of the arm sequence (same call the helper's startup
    # re-arm and every boot make). Restart replays flush+load cleanly.
    systemctl restart blockingmachine-capture-rules.service || die "capture-rules unit failed (bm-anchor.sh load)"
    log "started blockingmachine-{proxy,helper,capture-rules} (systemd)"
    ;;

  openrc)
    render_openrc_proxy > "$PROXY_INITD"
    render_openrc_helper > "$HELPER_INITD"
    render_openrc_rules > "$RULES_INITD"
    chown root:root "$PROXY_INITD" "$HELPER_INITD" "$RULES_INITD"
    chmod 0755 "$PROXY_INITD" "$HELPER_INITD" "$RULES_INITD"
    log "wrote $PROXY_INITD, $HELPER_INITD, $RULES_INITD (openrc-run)"

    for svc in blockingmachine-proxy blockingmachine-helper blockingmachine-capture-rules; do
      rc-update add "$svc" default >/dev/null 2>&1 || die "rc-update add $svc default failed — the boot re-arm contract requires all three services enabled"
    done
    rc-service blockingmachine-proxy restart || die "proxy service failed to start"
    rc-service blockingmachine-helper restart || die "helper service failed to start"
    rc-service blockingmachine-capture-rules restart || die "capture-rules service failed (bm-anchor.sh load)"
    log "started blockingmachine-{proxy,helper,capture-rules} (openrc)"
    ;;

  sysvinit)
    render_sysvinit_proxy > "$PROXY_INITD"
    render_sysvinit_helper > "$HELPER_INITD"
    render_sysvinit_rules > "$RULES_INITD"
    chown root:root "$PROXY_INITD" "$HELPER_INITD" "$RULES_INITD"
    chmod 0755 "$PROXY_INITD" "$HELPER_INITD" "$RULES_INITD"
    log "wrote $PROXY_INITD, $HELPER_INITD, $RULES_INITD (LSB init)"

    # Boot enable: update-rc.d wires the LSB headers into the runlevels.
    # Absent (busybox-ish sysvinit), the services still run + respawn now —
    # say so honestly: the inittab/rc.local line is then the operator's.
    if command -v update-rc.d >/dev/null 2>&1; then
      for svc in blockingmachine-proxy blockingmachine-helper blockingmachine-capture-rules; do
        update-rc.d "$svc" defaults >/dev/null 2>&1 || die "update-rc.d $svc defaults failed — the boot re-arm contract requires all three services enabled"
      done
    else
      log "warning: update-rc.d absent — services started now but boot-enable was not wired; add ${RULES_INITD} (after proxy+helper) to your init's boot sequence"
    fi
    "$PROXY_INITD" start || die "proxy service failed to start"
    "$HELPER_INITD" start || die "helper service failed to start"
    "$RULES_INITD" start || die "capture-rules service failed (bm-anchor.sh load)"
    log "started blockingmachine-{proxy,helper,capture-rules} (sysvinit)"
    ;;

  *)
    die "internal: unknown INIT_SYSTEM '$INIT_SYSTEM'"
    ;;
esac

# Record the supervisor beside the state the anchor wrote — observability
# for support + the uninstaller's report line.
printf 'SUPERVISOR=%s\n' "$INIT_SYSTEM" >> "$STATE_FILE"

# --- verify ---
if ! "$ANCHOR_DST" status; then
  die "rules service ran but capture rules are absent — netfilter state inconsistent; run scripts/uninstall-linux-capture.sh"
fi
case "$INIT_SYSTEM" in
  systemd)  systemctl is-active --quiet blockingmachine-helper.service || die "helper service not active after start" ;;
  openrc)   rc-service blockingmachine-helper status >/dev/null 2>&1 || die "helper service not running after start" ;;
  sysvinit) "$HELPER_INITD" status >/dev/null 2>&1 || die "helper service not running after start" ;;
esac
# Unit start proves REGISTRATION, not health — a crash-looping engine
# is 'active' while it dies. The real check is the engine's own control
# answer, polled with bounded patience (the engine mints its CA on first
# boot — RSA keygen can take several seconds).
engine_up=0
for _ in $(seq 1 30); do
  if curl -sf --max-time 2 "http://127.0.0.1:${CONTROL_PORT}/v1/proxy/status" >/dev/null 2>&1; then
    engine_up=1
    break
  fi
  sleep 1
done
case "$INIT_SYSTEM" in
  systemd)  PROXY_LOG_HINT="journalctl -u blockingmachine-proxy" ;;
  openrc)   PROXY_LOG_HINT="rc-service blockingmachine-proxy status + /var/log/messages (supervise-daemon logs there)" ;;
  sysvinit) PROXY_LOG_HINT="${PROXY_INITD} status + the daemon's own log — supervise child output went to the init console" ;;
esac
[[ "$engine_up" -eq 1 ]] || die "blockingmachine-proxy never answered /v1/proxy/status on :${CONTROL_PORT} — the service is active but the engine is not healthy; check ${PROXY_LOG_HINT}"

log "capture installed: tcp:{80,443} → 127.0.0.1:${HELPER_PORT} (helper) → 127.0.0.1:${ENGINE_PORT} (engine)"
log "verify: curl --cacert <ca.pem from http://127.0.0.1:${CONTROL_PORT}/v1/proxy/ca> https://example.com/"
log "remove: sudo scripts/uninstall-linux-capture.sh"
