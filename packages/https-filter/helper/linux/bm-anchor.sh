#!/usr/bin/env bash
#
# bm-anchor.sh — the single implementation of the Linux capture-rules
# arm/flush sequence (docs/https-filtering-p3-plan.md, P3 Task 2). The
# pf-anchor.sh twin: three callers, one code path for the rule mechanics:
#
#   * install-linux-capture.sh runs it once at install time (the arm,
#     after the systemd units are up).
#   * blockingmachine-capture-rules.service ExecStart's it at every boot
#     — nft/iptables state is per-boot while the units and the state file
#     persist, so a rebooted capture would otherwise be administratively
#     on but silently inert.
#   * redirect-helper runs the INSTALLED copy
#     (/usr/local/libexec/blockingmachine/bm-anchor.sh) from its watchdog:
#     sustained engine death → `flush-only` (fail-open), and startup with
#     state file present + rules absent → `load` (the ≤1-per-process
#     re-arm, gated on a live engine probe).
#
# Verbs:
#   bm-anchor.sh render <dir> [--uid N|name] [--helper-port P] [--ports L]
#       Write the rendered rules for BOTH mechanisms into <dir>
#       (blockingmachine.nft, iptables.rules, ip6tables.rules) — touches
#       no system state, needs no root. The captureScripts suite
#       diff-asserts these bytes; `load` renders through the same
#       functions so the tested bytes are the deployed bytes.
#   bm-anchor.sh load [--uid N|name] [--helper-port P] [--ports L]
#       Detect the mechanism (native nft preferred — `command -v nft`
#       plus a real `nft list ruleset` kernel probe — else iptables),
#       apply the rules, and write the state file recording what was
#       armed. Root + flock.
#   bm-anchor.sh flush-only
#       Remove exactly our rules, replaying the mechanism recorded in
#       the state file (falling back to detection on a partial install).
#       Keeps the state file — it is the administrative-enable marker the
#       helper's re-arm gate reads. Root + flock.
#   bm-anchor.sh status
#       Exit 0 when our capture rules are loaded, 1 otherwise. Prints a
#       one-line mechanism summary to stderr. The helper's re-arm gate
#       and the installer's verify call this.
#
# The rules themselves (both mechanisms, both families):
#   * an OUTPUT-chain capture — OUTPUT only ever sees locally-originated
#     packets (forwarded traffic traverses FORWARD/POSTROUTING, never
#     OUTPUT), so capture is scoped to local flows by construction; the
#     helper binds loopback, which is where REDIRECT lands.
#   * `skuid <service-uid> return` FIRST — the engine's own upstream
#     dials must never be re-captured (the dedicated `blockingmachine`
#     system user is the egress loop-break; macOS solved the same
#     requirement with `user !=` on the route-to rules).
#   * `tcp dport {80,443} redirect to :<helperPort>` — conntrack keeps
#     the original destination for the helper's SO_ORIGINAL_DST /
#     IP6T_SO_ORIGINAL_DST getsockopt.
#   * `udp dport 443 drop` — QUIC suppression: UDP/443 is invisible to
#     TCP capture, so it is dropped to force the TCP fallback the
#     redirect sees (same posture as macOS's `block drop` line). The
#     skuid return above exempts the engine's own QUIC dials. nft keeps
#     it in the same table so the flush is atomic; iptables puts it in
#     the filter table — see below.
#
# nftables note: `drop` is a legal terminal verdict in a nat-type chain —
# the rules deliberately share one `blockingmachine_nat` table per family
# so `nft delete table` removes the whole capture leg atomically.
#
# xtables note: the nat table is for NAT verdicts ONLY — iptables ≥1.8.7
# (nf_tables backend) answers a nat-table DROP with "The 'nat' table is
# not intended for filtering, the use of DROP is therefore inhibited".
# The UDP/443 drop therefore lives in `-t filter OUTPUT` — the filtering
# table's own output hook — while the RETURN/REDIRECT pair stays in nat.
# The render emits both so flush removes both (verified live: bookworm's
# nft-backend iptables rejects -t nat … -j DROP outright).
#
# ip6tables note: REDIRECT needs the v6 nat table — some distros ship
# ip6tables without nat (older minimal images). `load` probes
# `ip6tables -t nat -L` and, when it fails, arms v4 only with a warning
# and records V6_ARMED=0 — an honest degrade, never a silent half-claim.
#
# Exits nonzero loudly on the first real failure — the caller decides
# what that means (installer dies, helper logs and runs on fail-open).

set -euo pipefail

TABLE_NAME="blockingmachine_nat"
STATE_FILE="${BM_ANCHOR_STATE_FILE:-/etc/blockingmachine-capture-linux.state}"
PORTS="80,443"
HELPER_PORT=9295
SERVICE_UID=""
V6_ARMED=1

log() { printf '[bm-anchor] %s\n' "$*" >&2; }
die() { printf '[bm-anchor] error: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '17,40p' "$0" >&2
  exit 2
}

# ------------------------------------------------------------------ #
# Lock — serialize against a racing watchdog flush / unit stop /        #
# second install. iptables -A/-D sequences are NOT atomic across the    #
# three rules, so the lock is the honest serialization point (the macOS #
# twin needs none: its single pfctl -f IS atomic). Degrades to a warn-  #
# only path when flock(1) is absent.                                    #
# ------------------------------------------------------------------ #

LOCK_FILE=""
take_lock() {
  command -v flock >/dev/null 2>&1 || { log "flock unavailable — proceeding unlocked"; return 0; }
  local dir=/run
  [[ -d "$dir" ]] || dir=/var/lock
  [[ -d "$dir" ]] || dir=/tmp
  LOCK_FILE="$dir/blockingmachine-capture.lock"
  exec 9>"$LOCK_FILE"
  # -w 5 as TWO argv elements — a bounded wait, not a combined "-w 5"
  # token (flock would not parse that) and not an unbounded wait either:
  # a wedged lock holder must not stall the watchdog's fail-open flush.
  flock -x -w 5 9 || die "another bm-anchor.sh holds the capture lock ($LOCK_FILE) or lock wait timed out"
}

# ------------------------------------------------------------------ #
# Render — single source for the rule bytes, every family + mechanism   #
# ------------------------------------------------------------------ #

render_nft_v4() {
  cat <<EOF
table ip ${TABLE_NAME} {
  chain output {
    type nat hook output priority -100; policy accept;
    meta skuid ${SERVICE_UID} return
    tcp dport { ${PORTS} } redirect to :${HELPER_PORT}
    udp dport 443 drop
  }
}
EOF
}

render_nft_v6() {
  cat <<EOF
table ip6 ${TABLE_NAME} {
  chain output {
    type nat hook output priority -100; policy accept;
    meta skuid ${SERVICE_UID} return
    tcp dport { ${PORTS} } redirect to :${HELPER_PORT}
    udp dport 443 drop
  }
}
EOF
}

# Argument lines — `iptables $line` / `ip6tables $line` (the SAME lines;
# v4/v6 chains are identical). action $1 = -A or -D. The DROP rides the
# filter table — the nat table refuses filtering verdicts on the
# nf_tables backend (see the header note).
render_xtables() {
  local action="$1"
  cat <<EOF
-t nat ${action} OUTPUT -m owner --uid-owner ${SERVICE_UID} -j RETURN
-t nat ${action} OUTPUT -p tcp -m multiport --dports ${PORTS} -j REDIRECT --to-ports ${HELPER_PORT}
-t filter ${action} OUTPUT -m owner --uid-owner ${SERVICE_UID} -j RETURN
-t filter ${action} OUTPUT -p udp --dport 443 -j DROP
EOF
}

# ------------------------------------------------------------------ #
# Mechanism detection — native nft preferred; the iptables leg exists   #
# for nft-less systems (SO_ORIGINAL_DST is table-syntax-agnostic — it  #
# is a conntrack lookup either way). The kernel probes are real:       #
# `nft list ruleset` fails on kernels without nf_tables and inside     #
# containers lacking NET_ADMIN, and `iptables -t nat -L` fails where   #
# the nat table itself is missing.                                    #
# ------------------------------------------------------------------ #

detect_mechanism() {
  if command -v nft >/dev/null 2>&1 && nft list ruleset >/dev/null 2>&1; then
    printf 'nft\n'
    return 0
  fi
  if command -v iptables >/dev/null 2>&1 && iptables -t nat -L >/dev/null 2>&1; then
    printf 'iptables\n'
    return 0
  fi
  printf 'none\n'
  return 1
}

# Can ip6tables own a nat table here? (some minimal distros ship v6
# filter only — REDIRECT then can't exist for v6).
ip6tables_nat_works() {
  command -v ip6tables >/dev/null 2>&1 && ip6tables -t nat -L >/dev/null 2>&1
}

# ------------------------------------------------------------------ #
# State file — what was armed, so flush replays the recorded mechanism  #
# and the helper's re-arm gate sees "administratively enabled"          #
# ------------------------------------------------------------------ #

write_state() {
  local mechanism="$1"
  umask 077
  {
    printf 'MECHANISM=%s\n' "$mechanism"
    printf 'UID=%s\n' "$SERVICE_UID"
    printf 'PORTS=%s\n' "$PORTS"
    printf 'HELPER_PORT=%s\n' "$HELPER_PORT"
    printf 'V6_ARMED=%s\n' "$V6_ARMED"
  } > "$STATE_FILE"
  chmod 0600 "$STATE_FILE"
}

# Parse one key out of the state file WITHOUT sourcing it (install-owned
# file; the uninstall-macos precedent — sed, not eval).
state_get() {
  [[ -f "$STATE_FILE" ]] || return 1
  sed -n "s/^$1=//p" "$STATE_FILE" | head -1
}

# ------------------------------------------------------------------ #
# Apply / remove / probe — per mechanism                                #
# ------------------------------------------------------------------ #

apply_nft() {
  # Replace, not append: delete-anything-there first, then create. `nft
  # -f` per family so an ip6-capable-but-nat-less kernel loses only the
  # v6 leg (and v4 failure stays the loud die it should be).
  nft delete table ip "$TABLE_NAME" >/dev/null 2>&1 || true
  render_nft_v4 | nft -f - || die "nft v4 ruleset failed (nft list table ip $TABLE_NAME to inspect)"
  if render_nft_v6 | nft -f - 2>/dev/null; then
    V6_ARMED=1
  else
    V6_ARMED=0
    log "warning: ip6 nat table unavailable — capture armed v4-only (v6 traffic flows direct)"
  fi
}

apply_iptables() {
  # Idempotent: each -C || -A pair installs the rule only when absent.
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    # shellcheck disable=SC2086 -- intentional field splitting: the
    # rendered lines are literal iptables argv.
    iptables ${line/ -A / -C } >/dev/null 2>&1 || iptables $line || die "iptables rule failed: $line"
  done < <(render_xtables -A)
  if ip6tables_nat_works; then
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      # shellcheck disable=SC2086
      ip6tables ${line/ -A / -C } >/dev/null 2>&1 || ip6tables $line || die "ip6tables rule failed: $line"
    done < <(render_xtables -A)
    V6_ARMED=1
  else
    V6_ARMED=0
    log "warning: ip6tables nat unavailable — capture armed v4-only"
  fi
}

remove_nft() {
  nft delete table ip "$TABLE_NAME" >/dev/null 2>&1 || true
  nft delete table ip6 "$TABLE_NAME" >/dev/null 2>&1 || true
}

remove_iptables() {
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    # shellcheck disable=SC2086
    iptables $line >/dev/null 2>&1 || true
  done < <(render_xtables -D)
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    # shellcheck disable=SC2086
    ip6tables $line >/dev/null 2>&1 || true
  done < <(render_xtables -D)
}

# Rules currently loaded? Mechanism-aware; prefers the recorded
# mechanism (the state file is authoritative when present).
probe_loaded() {
  local mech
  mech="$(state_get MECHANISM || true)"
  if [[ -z "$mech" ]]; then
    mech="$(detect_mechanism || true)"
  fi
  case "$mech" in
    nft)
      nft list table ip "$TABLE_NAME" >/dev/null 2>&1
      ;;
    iptables)
      local port
      port="$(state_get HELPER_PORT || true)"
      [[ -n "$port" ]] || port="$HELPER_PORT"
      local ports
      ports="$(state_get PORTS || true)"
      [[ -n "$ports" ]] || ports="$PORTS"
      iptables -t nat -C OUTPUT -p tcp -m multiport --dports "$ports" -j REDIRECT --to-ports "$port" >/dev/null 2>&1
      ;;
    *)
      return 1
      ;;
  esac
}

# ------------------------------------------------------------------ #
# Arg parse: verb, then options                                         #
# ------------------------------------------------------------------ #

VERB="${1:-}"
[[ -n "$VERB" ]] || usage
shift

RENDER_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uid)         SERVICE_UID="${2:?--uid needs a value}"; shift 2 ;;
    --helper-port) HELPER_PORT="${2:?--helper-port needs a value}"; shift 2 ;;
    --ports)       PORTS="${2:?--ports needs a value}"; shift 2 ;;
    -h|--help)     usage ;;
    -*)            die "unknown option: $1" ;;
    *)             RENDER_DIR="$1"; shift ;;
  esac
done

# UID resolution — numeric passes through; a name resolves to the
# account's numeric uid (the rules and the state file carry the NUMBER —
# a renamed/renumbered account must not leave stale rules). Default is
# the dedicated service account.
resolve_uid() {
  local v="$1"
  if [[ "$v" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$v"
    return 0
  fi
  id -u "$v" 2>/dev/null
}

[[ "$PORTS" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "invalid --ports '$PORTS' — comma-separated numbers only"
[[ "$HELPER_PORT" =~ ^[0-9]+$ ]] || die "invalid --helper-port '$HELPER_PORT'"

# UID handling per verb:
#   load        — resolve to the NUMBER (rules + state file carry it;
#                 nft skuid and --uid-owner both accept names, but a
#                 renumbered account must not leave stale rules behind).
#   render      — the account may not exist on the host rendering (the
#                 test seam); names are valid in both grammars, so a
#                 name-shape token passes through unresolved.
#   flush-only/status — read what was recorded; no resolution needed.
[[ "$VERB" == "flush-only" || "$VERB" == "status" ]] || {
  if [[ -z "$SERVICE_UID" ]]; then
    if [[ "$VERB" == "render" ]]; then
      SERVICE_UID="blockingmachine"
    else
      SERVICE_UID="$(resolve_uid blockingmachine)" || die "no --uid given and the 'blockingmachine' user does not exist (pass --uid explicitly)"
    fi
  else
    if [[ "$VERB" == "render" ]]; then
      [[ "$SERVICE_UID" =~ ^[0-9]+$ || "$SERVICE_UID" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid --uid '$SERVICE_UID' — numeric uid or login-name shape"
    else
      SERVICE_UID="$(resolve_uid "$SERVICE_UID")" || die "--uid '$SERVICE_UID' does not resolve to a user"
    fi
  fi
}

case "$VERB" in

  render)
    [[ -n "$RENDER_DIR" ]] || die "render needs a target dir: bm-anchor.sh render <dir> [--uid N] [--helper-port P]"
    mkdir -p "$RENDER_DIR"
    { render_nft_v4; render_nft_v6; } > "$RENDER_DIR/blockingmachine.nft"
    render_xtables -A > "$RENDER_DIR/iptables.rules"
    render_xtables -A > "$RENDER_DIR/ip6tables.rules"
    log "rendered nft + iptables rules into $RENDER_DIR (uid=$SERVICE_UID helper=$HELPER_PORT ports=$PORTS)"
    ;;

  load)
    [[ "$(uname -s)" == "Linux" ]] || die "Linux only — this script is the netfilter capture leg"
    [[ $EUID -eq 0 ]] || die "must run as root (netfilter rules)"
    take_lock
    mech="$(detect_mechanism)" || die "no usable firewall mechanism — need native nft or iptables with a nat table"
    log "mechanism: $mech (uid=$SERVICE_UID helper=$HELPER_PORT ports=$PORTS)"
    case "$mech" in
      nft)      apply_nft ;;
      iptables) apply_iptables ;;
      *)        die "unknown mechanism '$mech'" ;;
    esac
    write_state "$mech"
    log "capture rules armed via $mech — state recorded in $STATE_FILE"
    ;;

  flush-only)
    [[ "$(uname -s)" == "Linux" ]] || die "Linux only"
    [[ $EUID -eq 0 ]] || die "must run as root"
    take_lock
    mech="$(state_get MECHANISM || true)"
    if [[ -z "$mech" ]]; then
      mech="$(detect_mechanism || true)"
      log "no state file — flushing via detected mechanism '${mech:-none}'"
    fi
    # Re-render the -D twins from the RECORDED values — a reinstall that
    # changed the helper port must not leave the old redirect behind.
    SERVICE_UID="$(state_get UID || true)"
    [[ -n "$SERVICE_UID" ]] || SERVICE_UID="$(resolve_uid blockingmachine || printf '0')"
    PORTS="$(state_get PORTS || true)"
    [[ -n "$PORTS" ]] || PORTS="80,443"
    HELPER_PORT="$(state_get HELPER_PORT || true)"
    [[ -n "$HELPER_PORT" ]] || HELPER_PORT=9295
    case "$mech" in
      nft)
        remove_nft
        log "flushed nft tables (ip + ip6 $TABLE_NAME)"
        ;;
      iptables)
        remove_iptables
        log "flushed iptables/ip6tables nat OUTPUT rules"
        ;;
      *)
        log "nothing recorded or detectable to flush — continuing"
        ;;
    esac
    ;;

  status)
    if probe_loaded; then
      log "capture rules loaded (mechanism=$(state_get MECHANISM || detect_mechanism || printf '?'))"
      exit 0
    fi
    log "capture rules absent"
    exit 1
    ;;

  *)
    die "unknown verb '$VERB' — render|load|flush-only|status"
    ;;
esac
