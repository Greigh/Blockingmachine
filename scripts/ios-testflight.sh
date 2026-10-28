#!/usr/bin/env bash
#
# Archive the Blockingmachine iOS app (packages/mobile, Expo prebuilt project)
# for TestFlight / App Store Connect and upload.
#
# Prerequisites:
#   App Store Connect API Key (headless / recommended):
#     export APP_STORE_CONNECT_API_KEY_ID=...
#     export APP_STORE_CONNECT_API_ISSUER_ID=...
#     export APP_STORE_CONNECT_API_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_XXXX.p8
#   …or the repo .env's APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER
#   (the same creds forge notarization uses) — this script maps them.
#   Falls back to a signed-in Xcode account (Xcode → Settings → Accounts) if unset.
#
# Uploads go through `xcodebuild -exportArchive` with a `destination: upload`
# ExportOptions.plist, authenticated via the App Store Connect API key above
# (-authenticationKeyPath/-ID/-IssuerID). This replaces the deprecated
# `xcrun altool --upload-app`.
#
# Usage:
#   ./scripts/ios-testflight.sh                    # archive + upload to TestFlight
#   ./scripts/ios-testflight.sh --archive-only     # build/export without uploading
#   ./scripts/ios-testflight.sh --build 3          # set build number first
#   ./scripts/ios-testflight.sh --build +1         # bump build number, then archive
#   ./scripts/ios-testflight.sh --prebuild         # re-run expo prebuild first
#
# The dns-proxy NE extension (targets/BlockingmachineDNSProxy) is stripped from
# TestFlight builds: the `dns-proxy` capability needs Apple's grant on the
# provisioning profile (docs/known-issues.md flag 89). --prebuild runs with
# BM_IOS_DNSPROXY=0 so the .appex and its entitlements never enter the archive.
# When Apple grants it, regenerate ios/ without the gate.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE="$ROOT/packages/mobile"
IOS_DIR="$MOBILE/ios"
WORKSPACE="$IOS_DIR/Blockingmachine.xcworkspace"
SCHEME="Blockingmachine"
TEAM_ID="365KR8NF53"
ARCHIVE="$MOBILE/build/ios/Blockingmachine.xcarchive"
EXPORT_DIR="$MOBILE/build/ios/upload"
UPLOAD_PLIST="$MOBILE/ExportOptionsUpload.plist"

cd "$ROOT"

# Soft-load the repo-root .env — parsed line-by-line rather than `source`d
# (a pasted .p8's loose lines must not become broken exports).
if [[ -f "$ROOT/.env" ]]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${line#*=}"
    value="${value%$'\r'}"
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$ROOT/.env"
fi

# Map the repo's APPLE_API_* spellings onto the APP_STORE_CONNECT_API_* names
# asc-auth.sh expects. APPLE_API_KEY holds a path on this machine; if it ever
# holds PEM material it maps to the inline form instead.
export APP_STORE_CONNECT_API_KEY_ID="${APP_STORE_CONNECT_API_KEY_ID:-${APPLE_API_KEY_ID:-}}"
export APP_STORE_CONNECT_API_ISSUER_ID="${APP_STORE_CONNECT_API_ISSUER_ID:-${APPLE_API_ISSUER:-}}"
if [[ -z "${APP_STORE_CONNECT_API_KEY_PATH:-}" && -z "${APP_STORE_CONNECT_API_KEY:-}" && -n "${APPLE_API_KEY:-}" ]]; then
  if [[ "$APPLE_API_KEY" == *"-----BEGIN"* ]]; then
    export APP_STORE_CONNECT_API_KEY="$APPLE_API_KEY"
  else
    export APP_STORE_CONNECT_API_KEY_PATH="$APPLE_API_KEY"
  fi
fi

source "$ROOT/scripts/lib/asc-auth.sh"
trap asc_cleanup EXIT

archive_only=false
do_prebuild=false
build_arg=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive-only) archive_only=true; shift ;;
    --prebuild) do_prebuild=true; shift ;;
    --build)
      shift
      if [[ $# -eq 0 ]]; then
        echo "❌ --build requires a value (e.g. --build 3 or --build +1)" >&2
        exit 1
      fi
      build_arg="$1"
      shift
      ;;
    --build=*) build_arg="${1#--build=}"; shift ;;
    -h|--help)
      sed -n '2,36p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "❌ Full Xcode required (xcodebuild not found)." >&2
  exit 1
fi
if [[ "$(xcode-select -p)" == *CommandLineTools* ]]; then
  echo "❌ Point xcode-select at Xcode.app:" >&2
  echo "   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
  exit 1
fi

# Build number bookkeeping — app.json is the source of truth a future prebuild
# regenerates from; the generated pbxproj must match it for THIS archive.
if [[ -n "$build_arg" ]]; then
  if [[ "$build_arg" == +* ]]; then
    cur="$(cd "$MOBILE" && node -e "console.log(require('./app.json').expo.ios.buildNumber || '1')")"
    next="$(( ${cur:-0} + ${build_arg#+} ))"
  else
    next="$build_arg"
  fi
  (cd "$MOBILE" && node -e "
    const fs = require('fs');
    const a = JSON.parse(fs.readFileSync('app.json', 'utf8'));
    a.expo.ios.buildNumber = '$next';
    fs.writeFileSync('app.json', JSON.stringify(a, null, 2) + '\n');
  ")
  echo "→ iOS build number → $next"
  (cd "$IOS_DIR" && xcrun agvtool new-version -all "$next" >/dev/null)
fi

if $do_prebuild; then
  echo "→ expo prebuild --platform ios --clean (dns-proxy extension stripped: entitlement not granted — flag 89)"
  (cd "$MOBILE" && CI=1 BM_IOS_DNSPROXY=0 env -u ELECTRON_RUN_AS_NODE npx expo prebuild --platform ios --clean)
fi

if [[ ! -d "$WORKSPACE" ]]; then
  echo "❌ $WORKSPACE not found." >&2
  echo "   Generate it first:" >&2
  echo "     cd packages/mobile && CI=1 BM_IOS_DNSPROXY=0 npx expo prebuild --platform ios" >&2
  echo "     cd ios && pod install   # needs LC_ALL=en_US.UTF-8 on this box (Ruby 4 + CocoaPods 1.17 bug)" >&2
  exit 1
fi

echo "→ Archiving ($SCHEME, Release, generic iOS device)…"
asc_resolve_auth
rm -rf "$ARCHIVE"
mkdir -p "$(dirname "$ARCHIVE")"

xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  "${ASC_AUTH_ARGS[@]+"${ASC_AUTH_ARGS[@]}"}" \
  archive

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' "$ARCHIVE/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleVersion' "$ARCHIVE/Info.plist")"
echo "✓ Archive: $ARCHIVE ($VERSION build $BUILD)"

if $archive_only; then
  echo "✓ Archive mode: skipping upload."
  echo "  Upload manually: Xcode → Window → Organizer → Distribute App"
  exit 0
fi

upload_to_app_store_connect() {
  rm -rf "$EXPORT_DIR"
  mkdir -p "$EXPORT_DIR"

  if asc_auth_configured; then
    echo "→ Uploading to App Store Connect via API key $ASC_KEY_ID (source: $ASC_KEY_SOURCE)…"
  else
    echo "⚠️  App Store Connect API key not fully set — falling back to signed-in Xcode account." >&2
  fi

  if xcodebuild -exportArchive \
      -archivePath "$ARCHIVE" \
      -exportOptionsPlist "$UPLOAD_PLIST" \
      -exportPath "$EXPORT_DIR" \
      -allowProvisioningUpdates \
      "${ASC_AUTH_ARGS[@]+"${ASC_AUTH_ARGS[@]}"}"; then
    echo "🎉 SUCCESS: iOS IPA uploaded to App Store Connect / TestFlight."
    echo "   Build: $VERSION ($BUILD)"
    echo "   https://appstoreconnect.apple.com/apps"
    return 0
  fi

  echo "" >&2
  echo "❌ Upload failed — archive kept at:" >&2
  echo "   $ARCHIVE" >&2
  echo "   Manual routes: Xcode Organizer → Distribute App, or Transporter.app." >&2
  return 1
}

upload_to_app_store_connect
