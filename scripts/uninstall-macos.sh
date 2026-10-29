#!/usr/bin/env bash
#
# uninstall-macos.sh — remove every trace of the Blockingmachine desktop app
# so a fresh .dmg install starts clean.
#
#   sudo scripts/uninstall-macos.sh [--keep-documents] [--dry-run]
#
# What it does, in order (every step tolerant of "already gone" — partial
# installs and re-runs must both unwind cleanly):
#   1. refuses unless EUID=0 — nothing is touched before the check
#   2. quits any running Blockingmachine process
#   3. restores DHCP DNS on every network service pointed at 127.0.0.1 —
#      FIRST user-visible repair, because removing the app with DNS still
#      loopback-bound would leave the Mac unable to resolve anything
#   4. delegates the transparent-capture leg to
#      uninstall-macos-capture.sh (pf anchor flush, enable-token release,
#      LaunchDaemon bootout, helper/plist/state removal), then removes the
#      state that script deliberately keeps: the _blockingmachine service
#      account + group, /Users/Shared/Blockingmachine (service CA + policy
#      ledger), and /Library/Logs/Blockingmachine
#   5. removes every "Blockingmachine HTTPS Filter CA" copy from the
#      console user's login keychain plus its trust settings, so the fresh
#      install's new CA is the only one the system has ever seen
#   6. removes the login keychain's "login item" entry, the app bundles
#      (every copy mdfind can see outside this repo), and the user's
#      ~/Library residue: Application Support, Caches, Preferences,
#      Saved Application State, HTTPStorages, WebKit, Logs
#   7. removes ~/Documents/Blockingmachine (compiled feed output) unless
#      --keep-documents — the fresh install regenerates it on first compile
#
# Deliberately NOT touched:
#   - the repository's own build output (packages/electron-app/out/) —
#     --include-builds opts in, since a clean repo rebuild covers it
#   - iOS/mobile state — that's on the phone, not this Mac
#
# Flags:
#   --keep-documents   preserve ~/Documents/Blockingmachine output files
#   --include-builds   also remove app bundles inside this checkout
#   --dry-run          print what would be removed without removing it
#
set -euo pipefail

APP_BUNDLE_IDS=(com.blockingmachine.app com.electron.blockingmachine)
CA_COMMON_NAME="Blockingmachine HTTPS Filter CA"
CAPTURE_UNINSTALLER="$(cd "$(dirname "$0")" && pwd)/uninstall-macos-capture.sh"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

KEEP_DOCUMENTS=false
INCLUDE_BUILDS=false
DRY_RUN=false

log()  { printf '[uninstall] %s\n' "$*"; }
warn() { printf '[uninstall] warning: %s\n' "$*" >&2; }
die()  { printf '[uninstall] error: %s\n' "$*" >&2; exit 1; }
run()  { $DRY_RUN && { printf '[dry-run] %s\n' "$*"; return 0; } || "$@"; }

for arg in "$@"; do
  case "$arg" in
    --keep-documents) KEEP_DOCUMENTS=true ;;
    --include-builds) INCLUDE_BUILDS=true ;;
    --dry-run)        DRY_RUN=true ;;
    -h|--help)        sed -n '2,42p' "$0"; exit 0 ;;
    *) die "unknown flag: $arg (try --help)" ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "macOS only"
[[ $EUID -eq 0 ]] || die "must run as root (sudo scripts/uninstall-macos.sh)"

CONSOLE_USER="${SUDO_USER:-$(stat -f %Su /dev/console 2>/dev/null || true)}"
[[ -n "$CONSOLE_USER" && "$CONSOLE_USER" != "root" ]] || \
  die "cannot identify the console user — run via sudo from a normal account"
USER_HOME="$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
[[ -n "$USER_HOME" && -d "$USER_HOME" ]] || die "no home directory for $CONSOLE_USER"
log "cleaning for $CONSOLE_USER ($USER_HOME)"

as_user() { $DRY_RUN && { printf '[dry-run] as %s: %s\n' "$CONSOLE_USER" "$*"; return 0; } || sudo -u "$CONSOLE_USER" "$@"; }

# --- 1. quit the app --------------------------------------------------------
# The managed DNS daemon and capture helpers exec inside the bundle, so
# matching the bundle path — not just the main binary — quits them too.
run pkill -f "Blockingmachine.app/Contents" 2>/dev/null \
  && log "quit running Blockingmachine processes" \
  || log "no running Blockingmachine processes"

# --- 2. restore DNS before the daemon that answered it disappears -----------
restored=0
while IFS= read -r service; do
  [[ -n "$service" ]] || continue
  if networksetup -getdnsservers "$service" 2>/dev/null | grep -qx "127.0.0.1"; then
    run networksetup -setdnsservers "$service" Empty \
      && { log "restored DHCP DNS on \"$service\""; restored=$((restored + 1)); } \
      || warn "could not restore DNS on \"$service\" — set it in System Settings > Network"
  fi
done < <(networksetup -listallnetworkservices 2>/dev/null | tail -n +2 | sed 's/^[*] *//')
[[ $restored -eq 0 ]] && log "no network service was bound to loopback DNS"

# --- 3. capture leg: delegate, then sweep what it keeps ---------------------
if [[ -x "$CAPTURE_UNINSTALLER" || -f "$CAPTURE_UNINSTALLER" ]]; then
  $DRY_RUN || bash "$CAPTURE_UNINSTALLER" || warn "capture uninstaller reported a problem — continuing"
else
  warn "uninstall-macos-capture.sh not found beside this script — skipping pf/daemon leg"
fi

for label in com.blockingmachine.natlook com.blockingmachine.proxy; do
  launchctl print "system/$label" &>/dev/null \
    && warn "$label still registered after capture uninstall" \
    || true
done

# The capture uninstaller deliberately keeps these; a full uninstall does not.
if dscl . -read "/Users/_blockingmachine" &>/dev/null; then
  run dscl . -delete "/Users/_blockingmachine" && log "removed _blockingmachine user"
fi
if dscl . -read "/Groups/_blockingmachine" &>/dev/null; then
  run dscl . -delete "/Groups/_blockingmachine" && log "removed _blockingmachine group"
fi
for f in /Library/LaunchDaemons/com.blockingmachine.*.plist; do
  [[ -e "$f" ]] && run rm -f "$f" && log "removed $f"
done
for d in "/Library/Application Support/Blockingmachine" \
         "/Users/Shared/Blockingmachine" \
         "/Library/Logs/Blockingmachine"; do
  [[ -d "$d" ]] && run rm -rf "$d" && log "removed $d"
done

# --- 4. HTTPS-filter CA out of the login keychain ---------------------------
# Order matters: trust settings must be unwound while the cert PEM still
# exists — remove-trusted-cert takes the PEM file, not a hash. -t on
# delete-certificate clears the user-domain entry; remove-trusted-cert -d
# clears the admin-domain entry `add-trusted-cert -d` created. All keychain
# reads run as the console user on THEIR keychain — under sudo `security`
# would otherwise see root's empty login keychain.
LOGIN_KC="$USER_HOME/Library/Keychains/login.keychain-db"
if [[ -f "$LOGIN_KC" ]]; then
  pem_dir="$(mktemp -d)"; trap 'rm -rf "$pem_dir"' EXIT
  n=0
  # -a -p prints every matching cert as PEM blocks; split them per file so
  # each can feed remove-trusted-cert before its cert object is deleted.
  as_user security find-certificate -a -p -c "$CA_COMMON_NAME" "$LOGIN_KC" 2>/dev/null \
    | awk -v dir="$pem_dir" '
        /-----BEGIN CERTIFICATE-----/ { n++; incert = 1 }
        incert { print > (dir "/ca-" n ".pem") }
        /-----END CERTIFICATE-----/ { incert = 0 }'
  for pem in "$pem_dir"/ca-*.pem; do
    [[ -s "$pem" ]] || continue
    run security remove-trusted-cert -d "$pem" &>/dev/null || true
    as_user security remove-trusted-cert "$pem" &>/dev/null || true
    as_user security delete-certificate -t -c "$CA_COMMON_NAME" "$LOGIN_KC" &>/dev/null \
      && n=$((n + 1))
  done
  [[ $n -gt 0 ]] && log "removed $n CA certificate(s) + trust from $CONSOLE_USER's keychain" \
    || log "no Blockingmachine CA in $CONSOLE_USER's keychain"
fi

# --- 5. login item ----------------------------------------------------------
as_user osascript -e 'tell application "System Events" to delete every login item whose name is "Blockingmachine"' &>/dev/null \
  && log "removed login item" || true

# --- 6. app bundles ---------------------------------------------------------
# Spotlight indexes per-user, so query it as the console user — root's
# mdfind sees an empty index on privacy-hardened systems.
app_paths=$(as_user mdfind "kMDItemCFBundleIdentifier == 'com.blockingmachine.app' || kMDItemCFBundleIdentifier == 'com.electron.blockingmachine'" 2>/dev/null || true)
for fixed in /Applications/Blockingmachine.app "$USER_HOME/Applications/Blockingmachine.app"; do
  [[ -d "$fixed" && "$app_paths" != *"$fixed"* ]] && app_paths="$app_paths"$'\n'"$fixed"
done
while IFS= read -r p; do
  [[ -d "$p" ]] || continue
  if ! $INCLUDE_BUILDS && [[ "$p" == "$REPO_ROOT"/* ]]; then
    log "kept build artifact $p (--include-builds to remove)"
    continue
  fi
  run /System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister -u "$p" &>/dev/null || true
  run rm -rf "$p" && log "removed $p"
done <<< "$app_paths"

# --- 7. ~/Library residue ----------------------------------------------------
for bid in "${APP_BUNDLE_IDS[@]}" Blockingmachine; do
  for d in "$USER_HOME/Library/Application Support/$bid" \
           "$USER_HOME/Library/Caches/$bid" \
           "$USER_HOME/Library/Caches/$bid-updater" \
           "$USER_HOME/Library/Saved Application State/$bid.savedState" \
           "$USER_HOME/Library/WebKit/$bid" \
           "$USER_HOME/Library/Logs/$bid"; do
    [[ -e "$d" ]] && run rm -rf "$d" && log "removed $d"
  done
done
for p in "$USER_HOME"/Library/Preferences/com.blockingmachine.app.plist \
         "$USER_HOME"/Library/Preferences/com.electron.blockingmachine.plist \
         "$USER_HOME"/Library/Preferences/Blockingmachine.plist \
         "$USER_HOME"/Library/HTTPStorages/Blockingmachine \
         "$USER_HOME"/Library/HTTPStorages/com.blockingmachine.app* \
         "$USER_HOME"/Library/HTTPStorages/com.electron.blockingmachine*; do
  [[ -e "$p" ]] && run rm -rf "$p" && log "removed $p"
done
for bid in "${APP_BUNDLE_IDS[@]}"; do
  as_user defaults delete "$bid" &>/dev/null || true
done
# Flush the console user's prefs cache so the deleted plists stay deleted —
# root's cfprefsd is none of our business.
as_user killall cfprefsd &>/dev/null || true

# --- 8. Documents output -----------------------------------------------------
DOC_DIR="$USER_HOME/Documents/Blockingmachine"
if [[ -d "$DOC_DIR" ]]; then
  if $KEEP_DOCUMENTS; then
    log "kept $DOC_DIR (--keep-documents)"
  else
    run rm -rf "$DOC_DIR" && log "removed $DOC_DIR"
  fi
fi

$DRY_RUN && log "dry run — nothing was removed" || log "done — the machine is clean for a fresh install"
