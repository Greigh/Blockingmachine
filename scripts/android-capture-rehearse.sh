#!/usr/bin/env bash
#
# android-capture-rehearse.sh — end-to-end LIVE rehearsal of the P4 hub
# capture leg: an Android device (emulator or physical) whose VpnService
# splices TCP :80/:443 onto this machine's https-filter data listener.
#
#   scripts/android-capture-rehearse.sh
#
# NEVER AUTO-RUN — operator-invoked, like macos-capture-rehearse.sh /
# linux-capture-rehearse.sh. It expects a human at the keyboard for the
# legs Android refuses to script (VPN consent, the in-app Start tap).
#
# Honest leg map — what adb CAN and CANNOT drive:
#   SCRIPTABLE   detect adb/emulator, pick a device, install a built APK,
#                launch the app, query the hub control API, drive an
#                `am start VIEW` fetch, diff the engine's flow counters,
#                force-stop the app.
#   BEST-EFFORT  VPN consent — `appops set <pkg> ACTIVATE_VPN allow`
#                works on some builds (older API levels / some emulator
#                images); where it does not take, the platform REQUIRES
#                the consent dialog — a real tap. There is no settings.db
#                key, no pm grant, no intent flag: VpnService.prepare()
#                exists precisely so the OS can demand the tap.
#   MANUAL       starting capture — VpnFilterService is exported=false +
#                BIND_VPN_SERVICE, so `am startservice` is refused outright;
#                only the app itself can arm it (Settings → HTTPS capture →
#                hub IP → Start → consent OK). The script prints the exact
#                taps and POLLS for the service coming up while the
#                operator performs them.
#
# Sequence:
#   1. prereqs — adb on PATH; `emulator -list-avds` for bootable images
#   2. device  — `adb devices` pick; optionally boot an AVD (BM_AVD)
#   3. APK     — install the debug build IF one exists (never builds)
#   4. hub     — local control API answers; resolve the hub address the
#                phone should use (emulator: 10.0.2.2 → host loopback;
#                physical: the engine's LAN bind — BM_BIND_HOST required)
#   5. consent — best-effort appops grant + manual fallback instructions
#   6. capture — MANUAL leg: script prints taps, polls for VpnFilterService
#   7. fetch   — baseline engine flowsTotal, `am start VIEW` a URL, diff
#   8. verdict — optional block leg (BM_BLOCK_URL a rules-blocked host)
#   9. cleanup — force-stop the app (closes the tun), verdict summary
#
# Env knobs (operator overrides; not secrets):
#   BM_SERIAL       adb -s serial to use (default: first device listed)
#   BM_AVD          AVD name to cold-boot when no device is connected
#   BM_APK          APK path (default: packages/mobile debug build output)
#   BM_SKIP_INSTALL set to skip the install leg entirely
#   BM_FETCH_URL    URL driven through the tunnel (default http://example.com/)
#   BM_BLOCK_URL    a URL the hub's loaded ruleset blocks (block-verdict leg)
#   BM_WAIT_S       per-leg timeout budget in seconds (default 90)
#
# Exit: 0 when every scriptable leg passed (manual legs are instructions —
# the script verifies their OUTCOME, so a skipped manual leg fails the run
# at the poll, honestly), 1 on the first failed assertion, 2 on prereqs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PKG="com.blockingmachine.mobile"
APK="${BM_APK:-$REPO_ROOT/packages/mobile/android/app/build/outputs/apk/debug/app-debug.apk}"
CONTROL="http://127.0.0.1:9293"
FETCH_URL="${BM_FETCH_URL:-http://example.com/}"
BLOCK_URL="${BM_BLOCK_URL:-}"
WAIT_S="${BM_WAIT_S:-90}"

step=0
log()  { printf '[rehearse %02d] %s\n' "$step" "$*"; }
ok()   { printf '[rehearse %02d]   PASS %s\n' "$step" "$*"; }
skip() { printf '[rehearse %02d]   SKIP %s\n' "$step" "$*"; }
man()  { printf '[rehearse %02d]   MANUAL %s\n' "$step" "$*"; }
fail() { printf '[rehearse %02d] FAIL %s\n' "$step" "$*" >&2; exit 1; }
begin() { step=$((step + 1)); log "$*"; }

ADB=""
SERIAL="${BM_SERIAL:-}"

say_run() { printf '      $ %s\n' "$*"; }

adb_shell() { "$ADB" -s "$SERIAL" shell "$@"; }

# json_int <key> — first-level integer field out of the flat status JSON.
json_int() {
  curl -fsS "$CONTROL/v1/proxy/status" 2>/dev/null |
    sed -n "s/.*\"$1\":\(-\?[0-9][0-9]*\).*/\1/p" | head -1
}

# json_str <key> — first-level string field.
json_str() {
  curl -fsS "$CONTROL/v1/proxy/status" 2>/dev/null |
    sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1
}

# ---------------------------------------------------------------- 1. prereqs
begin "prereqs — adb (and emulator images, for the boot leg)"
command -v adb >/dev/null 2>&1 || {
  printf '  adb not on PATH. Install platform-tools or export ANDROID_HOME.\n' >&2
  exit 2
}
ADB="$(command -v adb)"
ok "adb: $ADB ($("$ADB" version 2>/dev/null | head -1))"
AVDS=""
if command -v emulator >/dev/null 2>&1; then
  AVDS="$(emulator -list-avds 2>/dev/null | tr '\n' ' ')"
  [ -n "${AVDS// /}" ] && ok "AVDs available: $AVDS" || skip "no AVDs created — emulator boot leg unavailable"
else
  skip "no emulator binary — physical device or pre-booted emulator only"
fi
command -v curl >/dev/null 2>&1 || { printf '  curl required for the hub control API.\n' >&2; exit 2; }

# ---------------------------------------------------------------- 2. device
begin "device — pick an attached target (or boot an AVD when BM_AVD names one)"
"$ADB" start-server >/dev/null 2>&1 || true
DEVICES="$("$ADB" devices | sed -n 's/^\([A-Za-z0-9._-]*\)\s*device$/\1/p')"
if [ -z "$DEVICES" ]; then
  if [ -n "${BM_AVD:-}" ]; then
    log "no device attached — cold-booting AVD '$BM_AVD' (operator named it)"
    say_run "emulator -avd '$BM_AVD' -no-snapshot-boot"
    emulator -avd "$BM_AVD" -no-snapshot-boot >/dev/null 2>&1 &
    "$ADB" wait-for-device
    # Boot is not 'device online' — sys.boot_completed is the real signal.
    deadline=$((SECONDS + 300))
    until [ "$(adb_shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] || [ $SECONDS -ge $deadline ]; do
      sleep 3
    done
    [ "$(adb_shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] \
      || fail "AVD '$BM_AVD' never finished booting"
    DEVICES="$("$ADB" devices | sed -n 's/^\([A-Za-z0-9._-]*\)\s*device$/\1/p')"
  else
    printf '  No device attached and no BM_AVD named.\n' >&2
    printf '  Boot one yourself:  emulator -avd <name>   (AVDs: %s)\n' "${AVDS:-none}" >&2
    printf '  …or attach a USB device with USB debugging enabled.\n' >&2
    exit 2
  fi
fi
SERIAL="${SERIAL:-$(printf '%s\n' "$DEVICES" | head -1)}"
[ -n "$SERIAL" ] || { printf '  adb sees no usable device.\n' >&2; exit 2; }
ok "device: $SERIAL ($(adb_shell getprop ro.product.model 2>/dev/null | tr -d '\r'))"
IS_EMU=0
[ "$(adb_shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r')" = "1" ] && IS_EMU=1
[ "$IS_EMU" = "1" ] && ok "emulator detected — hub alias 10.0.2.2 reaches this host's loopback" \
                   || log "physical device — the hub must be LAN-reachable"

# ---------------------------------------------------------------- 3. APK
begin "APK — install a built package if one exists (this script never builds)"
if [ "${BM_SKIP_INSTALL:-0}" = "1" ]; then
  skip "BM_SKIP_INSTALL set"
elif [ -f "$APK" ]; then
  "$ADB" -s "$SERIAL" install -r -d "$APK" >/dev/null \
    || fail "adb install failed for $APK"
  ok "installed $(basename "$APK")"
else
  if adb_shell pm list packages 2>/dev/null | grep -q "package:$PKG"; then
    skip "no APK at $APK — the installed package stands"
  else
    printf '  No APK at %s and %s is not installed.\n' "$APK" "$PKG" >&2
    printf '  Build one:  cd packages/mobile/android && ./gradlew assembleDebug\n' >&2
    printf '  …then re-run (or pass BM_APK=/path/to/app-debug.apk).\n' >&2
    exit 2
  fi
fi
adb_shell pm list packages 2>/dev/null | grep -q "package:$PKG" \
  || fail "$PKG still not installed after the install leg"

# ---------------------------------------------------------------- 4. hub
begin "hub — control API on this machine + the address the phone should use"
curl -fsS --max-time 5 "$CONTROL/v1/proxy/status" >/dev/null 2>&1 \
  || fail "no engine answering $CONTROL — start the HTTPS filter proxy (app card or BM_STORE_DIR=… node packages/https-filter/dist/main.js)"
ok "engine answers /v1/proxy/status locally"

BIND="$(json_str bindHost)"
if [ "$IS_EMU" = "1" ]; then
  # The emulator's NAT maps 10.0.2.2 onto the HOST's loopback — a
  # loopback-bound engine is reachable from the guest through it, so the
  # default BM_BIND_HOST works here even though it cannot on physical Wi-Fi.
  HUB_HOST="10.0.2.2"
  ok "emulator hub address: $HUB_HOST (host loopback; engine bind '${BIND:-unknown}' is fine)"
else
  case "${BIND:-}" in
    ''|127.*|localhost|::1|0:0:0:0:0:0:0:1)
      printf '  The engine data listener is bound to loopback%s — a physical\n' "${BIND:+ ($BIND)}" >&2
      printf '  phone cannot reach :9294. Restart the engine with its LAN address:\n' >&2
      printf '    BM_BIND_HOST=<this machine LAN ip> …engine entry…\n' >&2
      printf '  then re-run. (The control API stays loopback-pinned by design.)\n' >&2
      exit 1
      ;;
    0.0.0.0|::)
      # Wildcard bind answers every interface — pick a concrete LAN address
      # for the phone to dial.
      HUB_HOST="$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
      [ -n "$HUB_HOST" ] || fail "engine is wildcard-bound but no LAN address resolved for the phone to dial"
      ;;
    *)
      HUB_HOST="$BIND"
      ;;
  esac
  # Reachability proof: the LAN-bound listener must answer a local TCP
  # connect on that same address — the exact path the phone will take.
  (exec 3<>"/dev/tcp/$HUB_HOST/9294" && exec 3>&- && exec 3<&-) 2>/dev/null \
    || fail "data listener did not answer on $HUB_HOST:9294 — the hub bind is not actually LAN-reachable"
  ok "physical-device hub address: $HUB_HOST (data listener verified on it)"
fi

# ---------------------------------------------------------------- 5. consent
begin "VPN consent — best-effort appops grant; the platform may still demand a tap"
CONSENT_NOTE=""
if adb_shell appops set "$PKG" ACTIVATE_VPN allow 2>/dev/null; then
  MODE="$(adb_shell appops get "$PKG" ACTIVATE_VPN 2>/dev/null | tr -d '\r')"
  case "$MODE" in
    *allow*|*Mode:\ allow*|*allow\;*)
      ok "ACTIVATE_VPN pre-granted via appops ($MODE) — consent dialog should be skipped"
      ;;
    *)
      CONSENT_NOTE="appops accepted the write but reports '$MODE' — this build ignores it"
      ;;
  esac
else
  CONSENT_NOTE="this build refuses the appops grant (normal on newer API levels)"
fi
if [ -n "$CONSENT_NOTE" ]; then
  man "$CONSENT_NOTE — the consent dialog is genuinely UI. When the app asks, tap OK on the system dialog."
fi
say_run "adb -s $SERIAL shell monkey -p $PKG -c android.intent.category.LAUNCHER 1"
adb_shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true

# ---------------------------------------------------------------- 6. capture
begin "capture — MANUAL leg: arm hub capture in the app (adb cannot drive it)"
cat <<EOF

  ┌─ operator taps ──────────────────────────────────────────────────────┐
  │  1. In the app: open the Settings tab.                                │
  │  2. HTTPS capture card → enter hub address:  $HUB_HOST                │
  │  3. Tap "Start capture".                                              │
  │  4. If the system VPN-consent dialog appears, tap OK — it must be a   │
  │     real tap; nothing else can grant it (that's the platform contract).│
  │                                                                       │
  │  Polling up to ${WAIT_S}s for VpnFilterService to come up…             │
  └───────────────────────────────────────────────────────────────────────┘
EOF
deadline=$((SECONDS + WAIT_S))
VPN_UP=0
while [ $SECONDS -lt $deadline ]; do
  # dumpsys sees the service while it's started; tun0 appears once establish()ed.
  if adb_shell dumpsys activity services "$PKG" 2>/dev/null | grep -q 'VpnFilterService'; then
    VPN_UP=1
    break
  fi
  if adb_shell ip addr show tun0 2>/dev/null | grep -q 'tun0'; then
    VPN_UP=1
    break
  fi
  sleep 3
done
[ "$VPN_UP" = "1" ] || fail "VpnFilterService never came up — complete the manual leg above (consent + Start capture) and re-run"
ok "VpnFilterService is up — capture armed toward $HUB_HOST:9294"

# ---------------------------------------------------------------- 7. fetch
begin "fetch — drive a URL through the tunnel, diff the engine's flow counter"
FLOWS_BEFORE="$(json_int flowsTotal)"
FLOWS_BEFORE="${FLOWS_BEFORE:-0}"
say_run "adb -s $SERIAL shell am start -a android.intent.action.VIEW -d '$FETCH_URL'"
adb_shell am start -a android.intent.action.VIEW -d "$FETCH_URL" >/dev/null 2>&1 \
  || fail "am start VIEW failed — cannot drive a fetch at all"
# The tun→TCP→splice→PROXY-v2→verdict chain takes a beat; poll the counter.
deadline=$((SECONDS + 45))
FLOWED=0
while [ $SECONDS -lt $deadline ]; do
  NOW="$(json_int flowsTotal)"; NOW="${NOW:-0}"
  if [ "$NOW" -gt "$FLOWS_BEFORE" ]; then FLOWED=1; break; fi
  sleep 2
done
[ "$FLOWED" = "1" ] \
  || fail "engine flowsTotal stayed at $FLOWS_BEFORE after the fetch — the flow never reached the hub (capture not really armed? hub IP wrong?)"
ok "engine counted new flows ($FLOWS_BEFORE → $NOW) — device traffic crossed tun → splice → PROXY-v2 → engine"

# ---------------------------------------------------------------- 8. verdict
begin "verdict — optional block leg (needs BM_BLOCK_URL naming a host the hub ruleset blocks)"
if [ -n "$BLOCK_URL" ]; then
  BLOCKED_BEFORE="$(json_int flowsBlocked)"; BLOCKED_BEFORE="${BLOCKED_BEFORE:-0}"
  say_run "adb -s $SERIAL shell am start -a android.intent.action.VIEW -d '$BLOCK_URL'"
  adb_shell am start -a android.intent.action.VIEW -d "$BLOCK_URL" >/dev/null 2>&1 || true
  deadline=$((SECONDS + 45))
  TICKED=0
  while [ $SECONDS -lt $deadline ]; do
    NOWB="$(json_int flowsBlocked)"; NOWB="${NOWB:-0}"
    if [ "$NOWB" -gt "$BLOCKED_BEFORE" ]; then TICKED=1; break; fi
    sleep 2
  done
  [ "$TICKED" = "1" ] \
    || fail "flowsBlocked stayed at $BLOCKED_BEFORE — $BLOCK_URL did not produce a hub verdict (is it really in the loaded ruleset?)"
  ok "flowsBlocked ticked ($BLOCKED_BEFORE → $NOWB) — the hub's verdict reached device traffic"
else
  skip "BM_BLOCK_URL unset — the block-verdict leg needs a URL the hub's ruleset blocks"
fi

# ---------------------------------------------------------------- 9. cleanup
begin "cleanup — force-stop the app (drops the tun + foreground service)"
adb_shell am force-stop "$PKG" >/dev/null 2>&1 || true
ok "app force-stopped; tun closed"

log "REHEARSAL COMPLETE — scriptable legs green. Manual legs performed: VPN consent (if required), the in-app Start tap."
log "NOT rehearsed (documented, not hidden): CA install into the user store (the plain-LAN fetch is flag mobile-hub-ca-over-plain-lan),"
log "  per-app bypass (flag android-per-app-bypass), off-LAN operation (the hub dependency itself is flag android-no-ondevice-engine)."
