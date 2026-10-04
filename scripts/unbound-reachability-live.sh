#!/usr/bin/env bash
#
# Run the Unbound reachability check against real resolvers.
#
# The check's central claim is empirical — that a resolver which loaded the compiled drop-in answers
# NXDOMAIN for a domain inside it — and a unit suite cannot establish it, because every answer in
# `unboundReachability.test.ts` is written by hand to agree with the claim. This rig supplies the
# other half: four genuinely configured Unbound instances built from the project's own artifacts,
# then the check run against them over real sockets.
#
#   ub-live       the core drop-in included   → the deployment the recipe describes
#   ub-notloaded  the same image, no include  → fetched but never loaded
#   ub-cli        the CLI's own drop-in       → a working deployment that answers NOERROR/0.0.0.0
#   ub-swallow    refuses the control name    → the one "success" that must not read as a pass
#
# Two things here are less obvious than they look.
#
# **The probe runs in the container network, under plain Node, not under Jest.** The Docker daemon
# runs inside a Colima VM and the daemon cannot see the host's /tmp; the resolver and the harness
# therefore have to reach each other over the container network rather than over the published
# ports. Jest does not survive that: it cannot resolve *any* module through the virtiofs mount
# (it fails to find its own `jest-circus/build/runner.js` before it reads a test), so the rig
# compiles `unboundProbe` / `unboundReachability` / `unboundAddress` straight from the app's
# TypeScript and runs a plain harness. The code under test is identical either way. The Jest suite
# `unboundReachabilityLive.test.ts` covers the same ground and runs on the host against a native
# resolver, which is what `--native` does here.
#
# **The readiness gate is not optional.** A resolver that has not finished loading the drop-in
# answers as though it never will, which reads as `not-loaded` — so an ungated rig cheerfully
# records a defect that is really its own timing. This bit me: the first run reported a working
# deployment as broken because the container had loaded a half-written 5.8 MB file.
#
# Usage:
#   scripts/unbound-reachability-live.sh              # containerised, Linux, Unbound 1.19.2
#   scripts/unbound-reachability-live.sh --native     # same verdicts, native Unbound, on this host
#   scripts/unbound-reachability-live.sh --keep       # leave the containers up afterwards

set -euo pipefail

MODE=container
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --native) MODE=native ;;
    --keep) KEEP=1 ;;
    *) echo "unknown option: $arg"; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="ubcheck/unbound:rig"
NETWORK="ubnet"
VOLUME="ubdropin"
DOCKER=(docker)
# The VM can only mount what it shares, which is the home directory. So the harness lives inside the
# repository for the duration and is removed on exit, rather than in /tmp where the daemon would not
# see it.
HARNESS_DIR="$REPO_ROOT/.unbound-live-harness"
# `deployRefresh` is a leaf import of `unboundReachability` — the stale report it checks for is
# part of the verdict. Keep this list in step with that module's runtime imports, or the harness
# compiles fine and then dies on an unresolved specifier under Node.
MODULES=(unboundProbe unboundReachability unboundAddress deployRefresh)
SCENARIOS=(live notloaded cli swallow)

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

cleanup() {
  [ "$KEEP" = "1" ] && [ "$MODE" = container ] && { echo "--keep: leaving $NETWORK, ub-* and $VOLUME in place"; return; }
  if [ "$MODE" = container ]; then
    step "Tearing down"
    "${DOCKER[@]}" rm -f $(for s in "${SCENARIOS[@]}"; do echo "ub-$s"; done) >/dev/null 2>&1 || true
    "${DOCKER[@]}" network rm "$NETWORK" >/dev/null 2>&1 || true
    "${DOCKER[@]}" volume rm "$VOLUME" >/dev/null 2>&1 || true
  fi
  rm -rf "$HARNESS_DIR"
}
trap cleanup EXIT

# ------------------------------------------------------------------------------------------------
step "Compiling the modules under test, and the harness that drives them"
rm -rf "$HARNESS_DIR"; mkdir -p "$HARNESS_DIR"
# Compiled straight from the app's TypeScript. `moduleResolution: bundler` so the `.js` specifiers
# the sources already use resolve to the `.ts` files, and the emitted output keeps them — so the
# result is ordinary ESM that Node loads with no loader and no transform.
#
# `--strict` is not optional. Passing files on the command line makes tsc ignore tsconfig.json
# entirely, and these modules narrow on a discriminated union — which is a `strictNullChecks`
# behaviour. Without the flag the compile fails on `parsed.message` inside a branch it can no longer
# narrow, and the rig dies before it reaches a resolver.
(cd "$REPO_ROOT/packages/electron-app" && npx tsc \
  src/unboundProbe.ts src/unboundReachability.ts src/unboundAddress.ts src/deployRefresh.ts \
  --outDir "$HARNESS_DIR" --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --strict)
cp "$REPO_ROOT/scripts/unbound-reachability-harness.mjs" "$HARNESS_DIR/harness.mjs"
# `argv.mjs` travels with it — the harness imports `./argv.mjs` and runs from $HARNESS_DIR.
cp "$REPO_ROOT/scripts/argv.mjs" "$HARNESS_DIR/argv.mjs"
printf '{ "name": "unbound-live-harness", "private": true, "type": "module" }\n' > "$HARNESS_DIR/package.json"
echo "harness in $HARNESS_DIR"

# ------------------------------------------------------------------------------------------------
step "Generating both drop-ins by calling the project's real formatters"
# Two, because the project has two Unbound formatters and the difference turned out to be the whole
# story. Core's emits `always_nxdomain` — what the desktop Hub compiles and serves, and what the
# check's premise assumes. The CLI's emits `redirect` + `local-data A 0.0.0.0`, which blocks just as
# effectively and answers a completely different way.
generate_dropins() { # output directory
  local out="$1"
  (cd "$REPO_ROOT" && node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import { mkdirSync } from "node:fs";
    import { parseFilterList, generateFilterList } from "@blockingmachine/core";
    import { exportFormat } from "./packages/cli/dist/lib/export.js";
    const out = process.argv[1];
    const parsed = parseFilterList(readFileSync("packages/cli/filters/output/imported-rules.txt", "utf8"), "imported-rules");
    const meta = { title: "Blockingmachine Filter List", description: "live reachability rig",
      homepage: "https://github.com/greigh/blockingmachine", version: "1.0.0-rc.6",
      lastUpdated: new Date().toISOString() };
    const core = generateFilterList(parsed, meta, "unbound");
    mkdirSync(out, { recursive: true });
    writeFileSync(out + "/blockingmachine.conf", core);
    const nx = (core.match(/always_nxdomain/g) || []).length;
    console.log(`  core: ${(core.match(/local-zone:/g) || []).length} local-zone, ${nx} always_nxdomain`);
    if (nx === 0) { console.error("core artifact is not an always_nxdomain drop-in"); process.exit(1); }
    await exportFormat("unbound", out + "/cli", parsed, meta);
    const cli = readFileSync(out + "/cli/blocklist.unbound", "utf8");
    writeFileSync(out + "/blockingmachine-cli.conf", cli);
    console.log(`  cli:  ${(cli.match(/local-zone:/g) || []).length} local-zone, ${(cli.match(/local-data:/g) || []).length} local-data`);
  ' "$out")
}
[ -f "$REPO_ROOT/packages/cli/dist/lib/export.js" ] || { echo "packages/cli/dist missing; run npm run build -w @blockingmachine/cli"; exit 1; }

# ------------------------------------------------------------------------------------------------
if [ "$MODE" = native ]; then
  step "Native Unbound on this host"
  command -v unbound >/dev/null 2>&1 || { echo "unbound is not on PATH (brew install unbound)"; exit 1; }
  UNBOUND_BIN="$(command -v unbound)"
  CONF_DIR="$HARNESS_DIR/native"
  DROPIN_DIR="$CONF_DIR/dropin"
  mkdir -p "$CONF_DIR"
  generate_dropins "$DROPIN_DIR"

  # A resolver that refuses the control name too. Indistinguishable from a working drop-in by any
  # single query, which is why the check asks a second question before believing the first.
  printf 'server:\n  local-zone: "example.com" always_nxdomain\n  local-zone: "com" always_nxdomain\n' \
    > "$CONF_DIR/blockingmachine-swallow.conf"

  python3 - "$CONF_DIR" "$DROPIN_DIR" <<'PY'
import pathlib, sys
conf, dropin = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
base = '''server:
  verbosity: 1
  interface: 127.0.0.1
  port: {port}
  do-daemonize: no
  chroot: ""
  username: ""
  directory: "{dir}"
  pidfile: "{dir}/unbound-{port}.pid"
  use-syslog: no
  access-control: 0.0.0.0/0 allow
  auto-trust-anchor-file: ""
  forward-zone:
    name: "."
    forward-first: yes
    forward-addr: 1.1.1.1
    forward-addr: 8.8.8.8
'''
for name, port, include in [
    ('live', 15353, f'  include: "{dropin}/blockingmachine.conf"\n'),
    ('notloaded', 15354, ''),   # deliberately nothing: served and fetched, never loaded
    ('cli', 15355, f'  include: "{dropin}/blockingmachine-cli.conf"\n'),
    ('swallow', 15356, f'  include: "{conf}/blockingmachine-swallow.conf"\n'),
]:
    (conf / f'{name}.conf').write_text(base.format(port=port, dir=conf) + include)
PY

  # `$!` rather than `jobs -p`: that prints one PID per line, and a newline inside the double-quoted
  # trap string turns the second PID into a command to run on exit.
  pids=''
  for s in "${SCENARIOS[@]}"; do
    "$UNBOUND_BIN" -d -c "$CONF_DIR/$s.conf" > "$CONF_DIR/$s.log" 2>&1 &
    pids="$pids $!"
  done
  # shellcheck disable=SC2064
  trap "kill $pids 2>/dev/null; rm -rf '$HARNESS_DIR'" EXIT

  # Readiness gate: never record a verdict from a resolver that has not finished loading.
  ready=0
  for _ in $(seq 1 30); do
    if dig +noall +comments +time=2 @127.0.0.1 -p 15353 0-02.net A 2>&1 | grep -q 'status: NXDOMAIN'; then ready=1; break; fi
    sleep 1
  done
  [ "$ready" = 1 ] || { echo "native resolver never blocked; refusing to record verdicts"; tail -5 "$CONF_DIR/live.log"; exit 1; }

  step "Each resolver, before any application code runs"
  echo "  native unbound: $("$UNBOUND_BIN" -V | head -1)"
  for spec in live:15353 notloaded:15354 cli:15355 swallow:15356; do
    name="${spec%%:*}"; port="${spec##*:}"
    printf '  %-10s canary=%-9s control=%s\n' "$name" \
      "$(dig +noall +comments +time=3 @127.0.0.1 -p "$port" 0-02.net A 2>&1 | grep -oE 'status: [A-Z]+' | cut -d' ' -f2)" \
      "$(dig +noall +comments +time=3 @127.0.0.1 -p "$port" example.com A 2>&1 | grep -oE 'status: [A-Z]+' | cut -d' ' -f2)"
  done

  step "The check, and every verdict it reaches"
  HARNESS_CLI_RESOLVER=127.0.0.1:15355 node "$HARNESS_DIR/harness.mjs" \
    "$DROPIN_DIR/blockingmachine.conf" 127.0.0.1:15353 127.0.0.1:15354 127.0.0.1:15356

  step "And the same ground under Jest, which is the suite that stays in the repository"
  (cd "$REPO_ROOT/packages/electron-app" && \
    UNBOUND_LIVE_DROPIN="$DROPIN_DIR/blockingmachine.conf" \
    UNBOUND_LIVE_DEPLOYED=127.0.0.1:15353 \
    UNBOUND_LIVE_BARE=127.0.0.1:15354 \
    UNBOUND_LIVE_SWALLOW=127.0.0.1:15356 \
    node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --coverage=false \
      src/__tests__/unboundReachabilityLive.test.ts)
  exit 0
fi

# ------------------------------------------------------------------------------------------------
step "Building the resolver image (Unbound on Ubuntu)"
"${DOCKER[@]}" info >/dev/null 2>&1 || { echo "docker is not reachable"; exit 1; }
[ -d "$REPO_ROOT/node_modules/@blockingmachine" ] || { echo "node_modules missing; run npm install"; exit 1; }

BUILD_DIR="$(mktemp -d)"
mkdir -p "$BUILD_DIR/scenarios"
cat > "$BUILD_DIR/Dockerfile" <<'DOCKERFILE'
FROM ubuntu:24.04
RUN apt-get -qq update && apt-get -qq install -y --no-install-recommends unbound dnsutils \
    && rm -rf /var/lib/apt/lists/*
COPY scenarios/ /etc/unbound/
CMD ["unbound", "-d", "-c", "/etc/unbound/live.conf"]
DOCKERFILE

# One base config; each scenario is that base plus at most one include line. Everything else is held
# constant on purpose — a verdict that changes because the resolver was configured differently is
# not a verdict about the check.
cat > "$BUILD_DIR/scenarios/base.conf" <<'CONF'
server:
  verbosity: 1
  interface: 0.0.0.0
  port: 53
  do-daemonize: no
  chroot: ""
  username: ""
  directory: "/etc/unbound"
  pidfile: "/tmp/unbound.pid"
  use-syslog: no
  access-control: 0.0.0.0/0 allow
  auto-trust-anchor-file: ""
  forward-zone:
    name: "."
    forward-first: yes
    forward-addr: 1.1.1.1
    forward-addr: 8.8.8.8
CONF
cat > "$BUILD_DIR/scenarios/blockingmachine-swallow.conf" <<'CONF'
server:
  local-zone: "example.com" always_nxdomain
  local-zone: "com" always_nxdomain
CONF
python3 - "$BUILD_DIR/scenarios" <<'PY'
import pathlib, sys
d = pathlib.Path(sys.argv[1])
base = (d / "base.conf").read_text()
for name, extra in {
    "live.conf": '  include: "/dropin/blockingmachine.conf"\n',
    "cli.conf": '  include: "/dropin/blockingmachine-cli.conf"\n',
    "notloaded.conf": "",   # deliberately nothing: served and fetched, never loaded
    "swallow.conf": '  include: "/etc/unbound/blockingmachine-swallow.conf"\n',
}.items():
    (d / name).write_text(base + extra)
PY
"${DOCKER[@]}" build -q -t "$IMAGE" "$BUILD_DIR" >/dev/null
rm -rf "$BUILD_DIR"
echo "built $IMAGE"

# ------------------------------------------------------------------------------------------------
step "Resetting containers, network and volume"
"${DOCKER[@]}" rm -f $(for s in "${SCENARIOS[@]}"; do echo "ub-$s"; done) >/dev/null 2>&1 || true
"${DOCKER[@]}" network rm "$NETWORK" >/dev/null 2>&1 || true
"${DOCKER[@]}" volume rm "$VOLUME" >/dev/null 2>&1 || true
"${DOCKER[@]}" network create "$NETWORK" >/dev/null
"${DOCKER[@]}" volume create "$VOLUME" >/dev/null
# The drop-ins are written into the volume *before* any resolver starts, and the readiness gate below
# waits for one to prove it loaded them. Between those two, no resolver can be caught mid-load.
# The host directory is bind-mounted rather than read by path: the daemon lives in a VM and sees the
# host only at the mounts it was given, so a container handed a host path finds nothing there.
generate_dropins "$HARNESS_DIR/dropin"
"${DOCKER[@]}" run --rm --network "$NETWORK" \
  -v "$HARNESS_DIR/dropin:/src:ro" -v "$VOLUME:/dropin" node:24 \
  node --input-type=module -e '
    import { copyFileSync } from "node:fs";
    copyFileSync("/src/blockingmachine.conf", "/dropin/blockingmachine.conf");
    copyFileSync("/src/blockingmachine-cli.conf", "/dropin/blockingmachine-cli.conf");
  '
echo "drop-ins staged into $VOLUME"

# ------------------------------------------------------------------------------------------------
step "Starting the four resolvers"
for s in "${SCENARIOS[@]}"; do
  "${DOCKER[@]}" run -d --name "ub-$s" --network "$NETWORK" -v "$VOLUME:/dropin:ro" \
    "$IMAGE" unbound -d -c "/etc/unbound/$s.conf" >/dev/null
done
sleep 3
for s in "${SCENARIOS[@]}"; do
  "${DOCKER[@]}" ps --format '{{.Names}}' | grep -qx "ub-$s" || {
    echo "ub-$s is not running:"; "${DOCKER[@]}" logs --tail 20 "ub-$s"; exit 1; }
done
"${DOCKER[@]}" ps --format '  {{.Names}}\t{{.Status}}' | grep ub- | sort

ready=0
for _ in $(seq 1 30); do
  if "${DOCKER[@]}" exec ub-live dig +noall +comments +time=2 @127.0.0.1 0-02.net A 2>&1 | grep -q 'status: NXDOMAIN'; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "ub-live never blocked; refusing to record verdicts"; "${DOCKER[@]}" logs --tail 20 ub-live; exit 1; }

ip() { "${DOCKER[@]}" inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }
LIVE_IP="$(ip ub-live)"; BARE_IP="$(ip ub-notloaded)"; CLI_IP="$(ip ub-cli)"; SWALLOW_IP="$(ip ub-swallow)"

step "Each resolver, before any application code runs"
echo "  container unbound: $("${DOCKER[@]}" exec ub-live unbound -V | head -1)"
for spec in "ub-live:$LIVE_IP" "ub-notloaded:$BARE_IP" "ub-cli:$CLI_IP" "ub-swallow:$SWALLOW_IP"; do
  name="${spec%%:*}"; addr="${spec##*:}"
  printf '  %-14s canary=%-9s control=%s\n' "$name" \
    "$("${DOCKER[@]}" exec "$name" dig +noall +comments +time=3 @127.0.0.1 0-02.net A 2>&1 | grep -oE 'status: [A-Z]+' | cut -d' ' -f2)" \
    "$("${DOCKER[@]}" exec "$name" dig +noall +comments +time=3 @127.0.0.1 example.com A 2>&1 | grep -oE 'status: [A-Z]+' | cut -d' ' -f2)"
done

step "The check, and every verdict it reaches"
"${DOCKER[@]}" run --rm --network "$NETWORK" \
  -v "$HARNESS_DIR:/h:ro" -v "$VOLUME:/dropin:ro" -w /h \
  -e HARNESS_CLI_RESOLVER="$CLI_IP" \
  node:24 node harness.mjs /dropin/blockingmachine.conf "$LIVE_IP:53" "$BARE_IP:53" "$SWALLOW_IP:53"
