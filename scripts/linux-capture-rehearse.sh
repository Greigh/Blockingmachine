#!/bin/sh
# linux-capture-rehearse.sh — end-to-end LIVE rehearsal of the Linux
# transparent HTTPS capture leg inside a docker container (P3 plan
# Task 2). The one P3 capture leg this Mac can actually rehearse.
#
#   scripts/linux-capture-rehearse.sh
#
# NEVER AUTO-RUN — operator-invoked like openwrt-live.sh. It boots a
# LOCAL image (docker image inspect gate — never pulls), gives the
# container NET_ADMIN, and rehearses the real install inside the
# container's own netns: the repo is mounted read-only at /bm.
#
# Honest caveats (same posture as openwrt-live.sh):
#   - No systemd in a plain container: PID 1 is sleep, so the units
#     can't be exercised here. The rehearsal performs the installer's
#     steps by hand (useradd, file layout, engine+helper under the real
#     accounts, bm-anchor.sh load/flush) — the same binaries and the
#     same rules, minus the unit supervisor. The units themselves are
#     rendered+diff-asserted by the captureScripts suite.
#   - The container netns is disposable: rules we add exist only inside
#     it. The host is never touched.
#   - debian bookworm's iptables is the nft-backend CLI — the iptables
#     leg still exercises our -A/-C/-D sequencing (the mechanism-detection
#     contract), even though the kernel table is nf_tables under the hood.
#
# Sequence per mechanism pass (nft first — the preferred leg — then
# iptables after removing the nftables package):
#   1. compile redirect-helper.c + common/splice.c with the image's cc
#   2. --selftest (splice + PROXY-v2 legs on the real kernel)
#   3. install layout: useradd blockingmachine, /var/lib store,
#      /usr/local/libexec/blockingmachine/{redirect-helper,bm-anchor.sh}
#   4. engine up as the service user (runuser, real skuid exemption) —
#      wait /v1/proxy/status, fetch the CA, write a block rule, reload
#   5. helper up as root; arm via bm-anchor.sh load; status must pass
#   6. transparent allow: curl --cacert https://example.com → 200
#      (a minted leaf proves the flow crossed redirect→helper→engine)
#   7. block proofs: http:// → real 403 through the engine; https://
#      → connection close + flowsBlocked tick (raw TLS has no response
#      channel — the close IS the verdict)
#   8. engine death → watchdog flushes the rules → curl direct works
#      WITHOUT the engine CA (fail-open proof)
#   9. flush-only + status → rules gone
#
# Env knobs: BM_LINUX_IMAGE (default node:20-bookworm — a LOCAL image),
#            BM_LINUX_CONTAINER, BM_REHEARSE_MECHANISMS ("nft iptables"),
#            BM_REHEARSE_KEEP=1 leaves the container for inspection.
# Exits 0 on PASS, 1 on the first failed assertion, 2 on gate failure.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE="${BM_LINUX_IMAGE:-node:20-bookworm}"
CONTAINER="${BM_LINUX_CONTAINER:-bm-linux-capture-live}"
MECHANISMS="${BM_REHEARSE_MECHANISMS:-nft iptables}"

say()  { printf '\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || {
  echo "docker not found — the Linux capture rehearsal needs docker (colima/docker-desktop)" >&2
  exit 2
}
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "image $IMAGE not present — pull it first:" >&2
  echo "  docker pull $IMAGE" >&2
  echo "(the gate never pulls so CI/contrib hosts stay clean)" >&2
  exit 2
}
[ -f "$REPO_ROOT/packages/https-filter/dist/main.js" ] || {
  echo "engine bundle missing: packages/https-filter/dist/main.js — run npm run build -w @blockingmachine/https-filter first" >&2
  exit 2
}
[ -f "$REPO_ROOT/packages/core/dist/index.js" ] || {
  echo "core dist missing — run npm run build first" >&2
  exit 2
}

cleanup() {
  if [ "${BM_REHEARSE_KEEP:-0}" != "1" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -f "${INNER:-}"
  else
    echo "kept container $CONTAINER (docker exec -it $CONTAINER bash)"
  fi
}
trap cleanup EXIT INT TERM

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

say "boot $IMAGE (--cap-add NET_ADMIN, repo ro at /bm)"
docker run -d --name "$CONTAINER" --cap-add NET_ADMIN \
  -v "$REPO_ROOT:/bm:ro" "$IMAGE" sleep infinity >/dev/null

# The in-container rehearsal — written to a file rather than inlined
# through docker exec quoting (the same reason openwrt-live sideloads
# its harness).
INNER="$(mktemp "${TMPDIR:-/tmp}/bm-linux-inner.XXXXXX.sh")"
cat > "$INNER" <<'INNER_EOF'
#!/bin/sh
# Runs INSIDE the NET_ADMIN'd container. argv: $1 = mechanism list.
set -eu

say()  { printf '\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

REPO=/bm
LIBEXEC=/usr/local/libexec/blockingmachine
STORE=/var/lib/blockingmachine/https-filter
CONTROL=http://127.0.0.1:9293
BLOCKED_HOST=rehearsal-block.example.com
RULES=/tmp/bm-rules.txt
ENGINE_PID=""
HELPER_PID=""

json_field() { # stdin json → field value (node is guaranteed by the image)
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stdout.write(String(JSON.parse(d)[process.argv[1]]??""))})' "$1"
}

stop_all() {
  [ -n "$HELPER_PID" ] && kill "$HELPER_PID" 2>/dev/null || true
  [ -n "$ENGINE_PID" ] && kill "$ENGINE_PID" 2>/dev/null || true
  HELPER_PID=""; ENGINE_PID=""
  sleep 1
}

start_engine() {
  # The engine runs as the dedicated service user — its own upstream
  # dials ride the skuid/--uid-owner exemption, which is the whole point
  # of the account.
  runuser -u blockingmachine -- env \
    BM_STORE_DIR=$STORE BM_DATA_PORT=9294 BM_CONTROL_PORT=9293 \
    BM_KEYWRAP=off BM_RULES_PATH=$RULES \
    node "$REPO/packages/https-filter/dist/main.js" >/tmp/engine.log 2>&1 &
  ENGINE_PID=$!
  i=0
  until curl -sf --max-time 2 "$CONTROL/v1/proxy/status" >/dev/null 2>&1; do
    i=$((i+1)); [ $i -le 60 ] || { tail -20 /tmp/engine.log; fail "engine never answered /v1/proxy/status"; }
    sleep 1
  done
}

start_helper() {
  "$LIBEXEC/redirect-helper" 9295 9294 >/tmp/helper.log 2>&1 &
  HELPER_PID=$!
  sleep 1
  kill -0 "$HELPER_PID" 2>/dev/null || { cat /tmp/helper.log; fail "helper died at start"; }
}

rehearse() {
  mech="$1"
  say "mechanism pass: $mech"

  rm -f /etc/blockingmachine-capture-linux.state
  stop_all

  # -- 1. engine first (a redirect must never meet a dead engine) ------
  start_engine
  curl -sf "$CONTROL/v1/proxy/ca" > /tmp/ca.json || fail "GET /v1/proxy/ca"
  json_field certPem < /tmp/ca.json > /tmp/ca.pem
  grep -q 'BEGIN CERTIFICATE' /tmp/ca.pem || fail "no PEM in /v1/proxy/ca"
  # The prior pass chowns $RULES to the service user; this container's
  # cap set lacks DAC_OVERRIDE, so a root-owned truncation of the
  # now-999-owned file EACCES's. Re-creating the entry is honest (the
  # dir is ours) — same as an admin rewriting the rules file.
  rm -f "$RULES"
  printf '||%s^\n' "$BLOCKED_HOST" > "$RULES"
  chown blockingmachine:blockingmachine "$RULES" 2>/dev/null || chown blockingmachine "$RULES"
  # control.ts gates every POST on Content-Type: application/json (415
  # otherwise) — the body itself is ignored, {} suffices.
  curl -sf -X POST -H 'Content-Type: application/json' -d '{}' \
    "$CONTROL/v1/proxy/reload" >/dev/null || fail "reload failed"
  ok "engine up as blockingmachine, CA fetched, block rule loaded"

  # -- 2. helper, then the arm -----------------------------------------
  start_helper
  "$LIBEXEC/bm-anchor.sh" load --uid blockingmachine --helper-port 9295 \
    || { cat /tmp/helper.log; fail "bm-anchor.sh load"; }
  "$LIBEXEC/bm-anchor.sh" status >/dev/null 2>&1 || fail "status after load"
  grep -q "MECHANISM=$mech" /etc/blockingmachine-capture-linux.state \
    || fail "state file did not record MECHANISM=$mech: $(cat /etc/blockingmachine-capture-linux.state)"
  ok "rules armed via $mech (state file recorded)"

  # -- 3. transparent allow ---------------------------------------------
  code="$(curl -s --cacert /tmp/ca.pem --max-time 15 -o /tmp/allowed.body -w '%{http_code}' https://example.com/ || true)"
  [ "$code" = "200" ] || fail "transparent allow failed (http_code=$code)"
  ok "https://example.com → 200 through engine MITM (redirect→helper→splice→forge)"

  # -- 4. block proofs ---------------------------------------------------
  # :80 → a real HTTP 403 (plain-HTTP block answers with a response);
  # :443 → connection close + flowsBlocked tick (raw TLS has no response
  # channel — the close itself is the verdict).
  ip="93.184.216.34"
  code="$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' --resolve "$BLOCKED_HOST:80:$ip" "http://$BLOCKED_HOST/" || true)"
  [ "$code" = "403" ] || fail "http:// blocked fetch returned $code, want 403"
  curl -sf "$CONTROL/v1/proxy/stats" > /tmp/stats-b.json || fail "stats(before)"
  before="$(json_field flowsBlocked < /tmp/stats-b.json)"
  if curl -s --cacert /tmp/ca.pem --max-time 15 --resolve "$BLOCKED_HOST:443:$ip" "https://$BLOCKED_HOST/" >/dev/null 2>&1; then
    fail "https:// blocked fetch was NOT refused — rule never reached the engine"
  fi
  curl -sf "$CONTROL/v1/proxy/stats" > /tmp/stats-a.json || fail "stats(after)"
  after="$(json_field flowsBlocked < /tmp/stats-a.json)"
  [ "${after:-0}" -gt "${before:-0}" ] || fail "flowsBlocked did not tick ($before→$after)"
  ok "http:// → 403 (response verdict); https:// → close + flowsBlocked $before→$after (raw-TLS verdict)"

  # -- 5. engine death → watchdog flush → fail-open ----------------------
  kill "$ENGINE_PID" 2>/dev/null || true
  ENGINE_PID=""
  i=0
  until ! "$LIBEXEC/bm-anchor.sh" status >/dev/null 2>&1; do
    i=$((i+1)); [ $i -le 45 ] || fail "rules still loaded 45s after engine death — watchdog did not flush"
    sleep 1
  done
  ok "watchdog flushed the rules after engine death (fail-open armed)"
  code="$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' https://example.com/ || true)"
  [ "$code" = "200" ] || fail "fail-open curl failed (http_code=$code) — traffic did NOT flow direct"
  ok "https://example.com → 200 WITHOUT the engine CA — direct upstream"

  # -- 6. flush-only idempotent + status honest --------------------------
  "$LIBEXEC/bm-anchor.sh" flush-only || fail "flush-only failed"
  "$LIBEXEC/bm-anchor.sh" status >/dev/null 2>&1 \
    && fail "status claims rules loaded after flush-only"
  case "$mech" in
    nft)
      nft list table ip blockingmachine_nat >/dev/null 2>&1 && fail "nft table survived flush" || true ;;
    iptables)
      iptables -t nat -C OUTPUT -p tcp -m multiport --dports 80,443 -j REDIRECT --to-ports 9295 >/dev/null 2>&1 \
        && fail "iptables REDIRECT survived flush" || true ;;
  esac
  ok "flush-only left no capture rules ($mech verified clean)"
}

# ---- setup shared by every mechanism pass --------------------------
say "install tooling + build helper"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends nftables iptables curl ca-certificates >/dev/null

cc -std=c11 -O2 -Wall -Wextra -Werror -o /tmp/redirect-helper \
  "$REPO/packages/https-filter/helper/linux/redirect-helper.c" \
  "$REPO/packages/https-filter/helper/common/splice.c" \
  || fail "helper compile failed"
ok "redirect-helper compiled -Werror clean on $(uname -sm)"

/tmp/redirect-helper --selftest 19295 19294 | tail -5 | tee /tmp/selftest.out
grep -q 'selftest: PASS' /tmp/selftest.out || fail "helper --selftest failed"
ok "helper --selftest PASS (v4+v6 v2 headers + splice, real kernel)"

say "install layout (installer's steps, minus systemd)"
grep -q '^blockingmachine:' /etc/passwd || useradd -r -s /usr/sbin/nologin -d /var/lib/blockingmachine blockingmachine
mkdir -p "$STORE" "$LIBEXEC"
chown -R blockingmachine:blockingmachine "$STORE" 2>/dev/null || chown -R blockingmachine "$STORE"
chmod 0700 "$STORE"
install -m 0755 /tmp/redirect-helper "$LIBEXEC/redirect-helper"
install -m 0755 "$REPO/packages/https-filter/helper/linux/bm-anchor.sh" "$LIBEXEC/bm-anchor.sh"
ok "user + store + libexec layout installed"

for mech in $1; do
  case "$mech" in
    nft)
      command -v nft >/dev/null 2>&1 || { echo "  skip nft — nft binary absent"; continue; }
      rehearse nft ;;
    iptables)
      # iptables leg requires the nft CLI ABSENT (detection prefers it) —
      # removing the package is the honest simulate.
      apt-get remove -y -qq nftables >/dev/null 2>&1 || true
      command -v iptables >/dev/null 2>&1 || { echo "  skip iptables — absent"; continue; }
      rehearse iptables ;;
  esac
done

stop_all
"$LIBEXEC/bm-anchor.sh" flush-only 2>/dev/null || true
say "all Linux capture rehearsal assertions passed"
INNER_EOF

docker cp "$INNER" "$CONTAINER:/tmp/bm-inner.sh"
docker exec "$CONTAINER" sh /tmp/bm-inner.sh "$MECHANISMS"

say "rehearsal PASS — compile → selftest → install → MITM'd allow → 403/close blocks → watchdog flush → fail-open → flush-only clean"
