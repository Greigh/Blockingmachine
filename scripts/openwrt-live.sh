#!/bin/sh
# Live rehearsal of the OpenWrt Deploy Hub recipes (flag 42).
#
# Boots a real OpenWrt rootfs (openwrt/rootfs:x86_64-v24.10.8 — under qemu-x86_64 on
# arm64 hosts), lets procd generate the real UCI configs, then drives the actual
# /usr/sbin/dnsmasq and /usr/sbin/unbound binaries against them:
#
#   dnsmasq (recipe claims in dnsmasqDeploy.ts):
#     - generated config carries `addn-hosts=/tmp/hosts` — a dropped hosts line
#       answers 0.0.0.0, and SIGHUP re-reads it (the fetch+reload mechanism)
#     - generated confdir is per-instance /tmp/dnsmasq.<cfg>.d — a drop-in there
#       is live (proves the dir exists and is read)
#     - /etc/dnsmasq.d/*.conf is NOT in the generated config — a drop-in there
#       stays dead (proves the retired recipe was wrong)
#
#   unbound (recipe claims in unboundDeploy.ts):
#     - UCI generates /var/lib/unbound/unbound.conf with
#       `include: /var/lib/unbound/unbound_ext.conf` at the end (outside server:)
#     - /etc/unbound/*.conf is blind-copied into the chroot at generation time, so
#       the recipe's drop-in /etc/unbound/blockingmachine.conf plus an include:
#       line in unbound_ext.conf reaches the running config
#     - observable effect: a local-zone name answers NXDOMAIN while a real name
#       recurses normally
#
# Caveats that keep this honest:
#   - procd cannot run the daemons under docker's cgroup limits (jail/cgroup
#     "Operation not permitted" → crash-loop). The init scripts DO run — that is
#     where the generated configs come from — but the daemons are then started
#     directly with the generated config, which is the same binary+config pair
#     procd would have used.
#   - netifd cannot talk to the container's netns, so interface setup is manual:
#     loopback up, docker's eth0 address re-added, default route fixed to eth0.
#   - unbound is sideloaded from the real OpenWrt 24.10.8 x86_64 package feed
#     (opkg hangs on HTTPS fetches under qemu; the ipks are extracted by hand —
#     same bits, same /etc/init.d and /usr/lib/unbound generator scripts).
#
# Usage:  sh scripts/openwrt-live.sh          # full rehearsal
#         BM_OWRT_KEEP=1 sh scripts/openwrt-live.sh   # leave the container for inspection
# Exits nonzero on the first failed assertion. Requires docker and curl.

set -eu

IMAGE="${BM_OWRT_IMAGE:-openwrt/rootfs:x86_64-v24.10.8}"
CONTAINER="${BM_OWRT_CONTAINER:-bm-owrt-live}"
FEED_BASE="https://downloads.openwrt.org/releases/24.10.8/packages/x86_64"
UNBOUND_IPKS="libopenssl3_3.0.22-r1 libevent2-7_2.1.12-r2 libevent2-core7_2.1.12-r2"
PKG_IPKS="libunbound_1.26.1-r1 unbound-daemon_1.26.1-r1 unbound-checkconf_1.26.1-r1"

say()  { printf '\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; exit 1; }

cleanup() {
  if [ "${BM_OWRT_KEEP:-0}" != "1" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$IPKDIR"
  else
    echo "kept container $CONTAINER (docker exec -it $CONTAINER sh)"
  fi
}
trap cleanup EXIT

# --- preflight ---------------------------------------------------------------
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "image $IMAGE not present — pull it first:" >&2
  echo "  docker pull --platform linux/amd64 $IMAGE" >&2
  exit 1
}

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
IPKDIR="$(mktemp -d /tmp/bm-owrt-ipk.XXXXXX)"

say "boot $IMAGE"
# NET_ADMIN is required: netifd scrambles docker's netns at boot and the
# rehearsal has to repair lo/eth0/default-route by hand.
docker run -d --name "$CONTAINER" --platform linux/amd64 --cap-add NET_ADMIN "$IMAGE" /sbin/init >/dev/null

# Wait for procd's boot run of /etc/init.d/dnsmasq to write the generated conf.
say "wait for UCI-generated dnsmasq conf"
i=0
until docker exec "$CONTAINER" sh -c 'ls /var/etc/dnsmasq.conf.* 2>/dev/null | head -1 | grep -q .' 2>/dev/null; do
  i=$((i+1)); [ "$i" -le 90 ] || fail "no /var/etc/dnsmasq.conf.* after ~6min (procd still generating?)"
  sleep 4
done
CONF="$(docker exec "$CONTAINER" sh -c 'ls /var/etc/dnsmasq.conf.* | head -1')"
CFG="$(basename "$CONF" | sed 's/.*dnsmasq.conf\.//')"
ok "generated config: $CONF (instance $CFG)"

# Repair the netns OpenWrt's own network init scrambles.
say "container networking"
GW="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
IP="$(docker inspect -f '{{.NetworkSettings.IPAddress}}' "$CONTAINER" 2>/dev/null || true)"
GW="${GW:-172.17.0.1}"
IP="${IP:-172.17.0.2}"
docker exec "$CONTAINER" sh -c "
  set -x
  ip link set lo up
  # netifd may have enslaved eth0 into br-lan; give the address to whichever
  # device owns it.
  DEV=eth0
  MASTER=\$(ip link show eth0 | sed -n 's/.*master \([^ ]*\).*/\1/p')
  [ -n \"\$MASTER\" ] && DEV=\$MASTER
  ip link set \$DEV up
  ip addr replace $IP/16 dev \$DEV 2>/dev/null || ip addr add $IP/16 dev \$DEV
  ip route replace default via $GW dev \$DEV
"
ok "lo up, eth0=$IP/16, gw=$GW"

# Assert the generated-config claims before touching a daemon.
say "dnsmasq generated-config claims"
docker exec "$CONTAINER" sh -c "grep -q 'addn-hosts=/tmp/hosts' $CONF" \
  && ok "addn-hosts=/tmp/hosts present in generated config" \
  || fail "addn-hosts missing from generated config"
docker exec "$CONTAINER" sh -c "grep -q 'conf-dir=/tmp/dnsmasq.$CFG.d' $CONF" \
  && ok "conf-dir=/tmp/dnsmasq.$CFG.d present (per-instance, not /etc/dnsmasq.d)" \
  || fail "generated confdir is not the per-instance /tmp/dnsmasq.<cfg>.d"
docker exec "$CONTAINER" sh -c "grep -q '/etc/dnsmasq.d' $CONF" \
  && fail "/etc/dnsmasq.d unexpectedly present in generated config" \
  || ok "/etc/dnsmasq.d absent from generated config"

start_dnsmasq() {
  docker exec "$CONTAINER" sh -c 'killall -9 dnsmasq 2>/dev/null; true'
  docker exec -d "$CONTAINER" /usr/sbin/dnsmasq -C "$CONF" -k
  i=0
  until docker exec "$CONTAINER" sh -c 'netstat -ln 2>/dev/null | grep -q ":53 "'; do
    i=$((i+1)); [ "$i" -le 30 ] || fail "dnsmasq did not bind :53"
    sleep 2
  done
}

q() { docker exec "$CONTAINER" nslookup "$1" 127.0.0.1 2>&1 || true; }

say "dnsmasq live rehearsal"
start_dnsmasq
docker exec -e CFG="$CFG" "$CONTAINER" sh -c 'mkdir -p /etc/dnsmasq.d
printf "address=/bm-inert.test/9.9.9.9\n" > /etc/dnsmasq.d/bm.conf
printf "address=/bm-confdir.test/9.9.9.9\n" > "/tmp/dnsmasq.$CFG.d/bm.conf"
printf "0.0.0.0 bm-blocked.test\n" >> "/tmp/hosts/dhcp.$CFG"'
start_dnsmasq

q bm-blocked.test | grep -q "Address: 0.0.0.0" \
  && ok "addn-hosts sinkhole: bm-blocked.test -> 0.0.0.0" \
  || fail "bm-blocked.test did not sinkhole"
q bm-confdir.test | grep -q "Address: 9.9.9.9" \
  && ok "per-instance confdir live: bm-confdir.test -> 9.9.9.9" \
  || fail "conf-dir drop-in not honored"
q bm-inert.test | grep -q "Address: 9.9.9.9" \
  && fail "/etc/dnsmasq.d drop-in unexpectedly took effect" \
  || ok "/etc/dnsmasq.d drop-in inert (retired recipe confirmed dead)"

docker exec -e CFG="$CFG" "$CONTAINER" sh -c 'printf "0.0.0.0 bm-sighup.test\n" >> "/tmp/hosts/dhcp.$CFG"; killall -HUP dnsmasq'
sleep 3
q bm-sighup.test | grep -q "Address: 0.0.0.0" \
  && ok "SIGHUP re-reads hosts: bm-sighup.test -> 0.0.0.0" \
  || fail "SIGHUP did not pick up the hosts entry"
# clean control through real forwarding (dnsmasq's generated resolv-file)
docker exec "$CONTAINER" sh -c 'mkdir -p /tmp/resolv.conf.d && echo "nameserver 8.8.8.8" > /tmp/resolv.conf.d/resolv.conf.auto; killall -HUP dnsmasq'
sleep 3
q openwrt.org | grep -qE "Address: [0-9a-f:.]+" \
  && ok "clean control resolves through upstream forwarding" \
  || fail "clean control (openwrt.org) did not resolve"

# --- unbound -------------------------------------------------------------------
say "sideload unbound 1.26.1-r1 from the OpenWrt feed"
for p in $UNBOUND_IPKS; do
  curl -fsSL "$FEED_BASE/base/${p}_x86_64.ipk" -o "$IPKDIR/$p.ipk"
done
for p in $PKG_IPKS; do
  curl -fsSL "$FEED_BASE/packages/${p}_x86_64.ipk" -o "$IPKDIR/$p.ipk"
done
docker exec "$CONTAINER" mkdir -p /tmp/bm-ipk
docker cp "$IPKDIR/." "$CONTAINER":/tmp/bm-ipk/
docker exec "$CONTAINER" sh -c 'cd /tmp/bm-ipk && for f in *.ipk; do d=$(mktemp -d); tar xzf "$f" -C "$d" && tar xzf "$d/data.tar.gz" -C / && rm -rf "$d"; done'
# The tarball sideload skips postinst, so the package`s `Require-User: unbound`
# field is replicated by hand — this is exactly what opkg`s default_postinst
# would have appended (32768 is the OpenWrt service-UID allocation base).
docker exec "$CONTAINER" sh -c 'grep -q "^unbound:" /etc/passwd || {
  echo "unbound:x:32768:unbound" >> /etc/group
  echo "unbound:x:32768:32768:unbound:/var/run/unbound:/bin/false" >> /etc/passwd
  mkdir -p /var/run/unbound /var/lib/unbound
  chown unbound:unbound /var/lib/unbound /var/run/unbound
}'
docker exec "$CONTAINER" /usr/sbin/unbound -V | grep -q "Version 1.26.1" \
  && ok "unbound 1.26.1-r1 runs on OpenWrt" \
  || fail "unbound did not install"

# Recipe artifacts BEFORE generation so the real generator copies them itself.
docker exec "$CONTAINER" sh -c 'printf "server:\n  local-zone: \"bm-ublock.test\" always_nxdomain\n" > /etc/unbound/blockingmachine.conf
printf "\ninclude: \"/etc/unbound/blockingmachine.conf\"\n" >> /etc/unbound/unbound_ext.conf'

say "UCI generation of /var/lib/unbound/unbound.conf"
docker exec -d "$CONTAINER" sh -c '/etc/init.d/unbound start'
i=0
until docker exec "$CONTAINER" sh -c 'grep -q "include: /var/lib/unbound/unbound_ext.conf" /var/lib/unbound/unbound.conf 2>/dev/null'; do
  i=$((i+1)); [ "$i" -le 120 ] || fail "generated unbound.conf never appeared (~8min)"
  sleep 4
done
ok "generated conf ends with include: /var/lib/unbound/unbound_ext.conf"
docker exec "$CONTAINER" sh -c 'grep -q blockingmachine.conf /var/lib/unbound/unbound_ext.conf' \
  && ok "generator mirrored /etc/unbound/unbound_ext.conf into the chroot" \
  || fail "ext.conf edit never reached /var/lib/unbound"

docker exec "$CONTAINER" /usr/sbin/unbound-checkconf /var/lib/unbound/unbound.conf \
  && ok "unbound-checkconf accepts the recipe chain" \
  || fail "checkconf rejects the recipe chain"

say "unbound live rehearsal"
# The [i] keeps pgrep`s own containing shell from matching itself.
docker exec "$CONTAINER" sh -c 'killall dnsmasq 2>/dev/null; killall -9 unbound 2>/dev/null; for p in $(pgrep -f "[i]nit.d/unbound"); do kill -9 $p; done 2>/dev/null; true'
docker exec -d "$CONTAINER" /usr/sbin/unbound -d -c /var/lib/unbound/unbound.conf
i=0
until docker exec "$CONTAINER" sh -c 'netstat -ln 2>/dev/null | grep -q ":53 "'; do
  i=$((i+1)); [ "$i" -le 30 ] || fail "unbound did not bind :53"
  sleep 2
done

q bm-ublock.test | grep -q "NXDOMAIN" \
  && ok "local-zone live: bm-ublock.test -> NXDOMAIN" \
  || fail "bm-ublock.test was not sinkholed"
q openwrt.org | grep -qE "Address: [0-9a-f:.]+" \
  && ok "clean control: openwrt.org recursed to a real answer" \
  || fail "clean control (openwrt.org) did not resolve"

say "all OpenWrt rehearsal assertions passed"
