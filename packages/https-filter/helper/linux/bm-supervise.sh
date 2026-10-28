#!/usr/bin/env bash
#
# bm-supervise.sh — restart-on-death wrapper for the non-systemd capture
# legs (flag 118). systemd gives the proxy + helper `Restart=always`; on
# sysvinit nothing supervises, so the init.d scripts start THIS under
# start-stop-daemon --make-pidfile --background instead of the daemon
# itself — the pidfile then names the supervisor, whose only job is to
# keep the child alive.
#
#   bm-supervise.sh <name> -- <command> [args...]
#
# Semantics, deliberately the systemd-unit shape:
#   * child exits (any code) → log → sleep BM_RESPAWN_DELAY (default 2,
#     the units' RestartSec) → exec again. Forever — the same posture
#     Restart=always encodes; there is no backoff ceiling, matching the
#     helper-death-is-fail-closed contract (the dead-listener window must
#     be as short as the init system can make it).
#   * SIGTERM/SIGINT → forwarded to the child, then the supervisor exits —
#     so `start-stop-daemon --stop --pidfile` brings the whole pair down
#     (without the forward, stop would orphan a live engine/helper while
#     the pidfile died).
#
# Logs to stderr — under an init.d start that lands on the boot console /
# service log the invoking script captures.
set -u

NAME="${1:?usage: bm-supervise.sh <name> -- <command> [args...]}"
[[ "${2:-}" == "--" ]] || { printf '[bm-supervise] usage: bm-supervise.sh <name> -- <command> [args...]\n' >&2; exit 2; }
shift 2
[[ $# -gt 0 ]] || { printf '[bm-supervise] no command given\n' >&2; exit 2; }

RESPAWN_DELAY="${BM_RESPAWN_DELAY:-2}"
# L7: an unsanitized env value rode straight into `sleep` — `sleep "abc"`
# fails instantly and the respawn loop spins at fork-rate forever.
# Nonnegative decimal integer/fraction only; anything else is the default.
[[ "$RESPAWN_DELAY" =~ ^[0-9]+([.][0-9]+)?$ ]] || RESPAWN_DELAY=2
CHILD=""
TERMED=""

# TERM/INT only FLAG — never act inside the trap: a TERM landing inside the
# `"$@" &` → `CHILD=$!` window would otherwise see CHILD still unset and
# orphan the just-forked child. The loop checks the flag after every wait
# point, where the pid to kill is already recorded.
on_term() { TERMED=1; }
trap on_term TERM INT

while :; do
  "$@" &
  CHILD=$!
  wait "$CHILD" 2>/dev/null
  rc=$?
  if [[ -n "$TERMED" ]]; then
    kill "$CHILD" 2>/dev/null || true
    wait "$CHILD" 2>/dev/null || true
    exit 0
  fi
  printf '[bm-supervise] %s child pid=%s exited rc=%s — respawning in %ss\n' "$NAME" "$CHILD" "$rc" "$RESPAWN_DELAY" >&2
  CHILD=""
  # The respawn delay runs as a waited child too — a TERM landing during it
  # is honored at the wait point, not after the sleep elapses.
  sleep "$RESPAWN_DELAY" &
  SLEEPER=$!
  wait "$SLEEPER" 2>/dev/null
  if [[ -n "$TERMED" ]]; then
    kill "$SLEEPER" 2>/dev/null || true
    exit 0
  fi
done
