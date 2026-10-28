#!/usr/bin/env bash
#
# Resolves App Store Connect API-key auth from an inline key, a path to the
# AuthKey_XXXXXXXXXX.p8 file, or Apple's conventional location — and normalises
# all three to $ASC_KEY_PATH so callers do not care which one they got.
#
# Why this file exists
# --------------------
# The key is three things: a key id, an issuer id, and a private key file. Two of
# those are identifiers. The third is a *path*, and a path is the one credential
# shape that cannot cross a machine boundary. APP_STORE_CONNECT_API_KEY_PATH
# points into ~/.appstoreconnect/private_keys on this Mac; a GitHub runner has no
# such directory and no signed-in Xcode account either. So the upload path fell
# back to "signed-in Xcode account", which cannot exist on a runner, and then
# failed at export time with a provisioning error that says nothing about
# credentials. The credential was fine. The transport was not.
#
# So the key can also be given as a value — APP_STORE_CONNECT_API_KEY — which
# CI can hand over without a filesystem. It is the same shape
# GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is documented to be (and, before this
# change, was not: both readers read it as a path, so the documented CI route
# for Play had never worked).
#
# Two spellings of the inline form, because there are two ways it arrives:
#
#   * Real newlines  — a GitHub secret, an `export` in CI, anything that does
#     not flatten the value.
#   * Literal \n      — a line in .env. Every .env loader in this repository
#     reads line by line, so a real multi-line value in .env does not become a
#     multi-line value; it becomes several broken assignments. Accept the
#     escaped spelling so one pasted value works in either place.
#
# Neither the key id, the issuer id, nor the key material is ever printed. The
# scripts report which *source* was used and nothing more.
#
# Usage:
#   source "$(dirname "$0")/lib/asc-auth.sh"
#   trap asc_cleanup EXIT
#   asc_resolve_auth
#   asc_auth_configured || asc_require_auth "notarization"
#
# Exports: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, ASC_KEY_SOURCE
#          ("" | "inline" | "path" | "conventional")

ASC_KEY_ID=""
ASC_ISSUER_ID=""
ASC_KEY_PATH=""
ASC_KEY_SOURCE=""
# The xcodebuild spelling of the resolved auth — set by asc_resolve_auth when
# all three halves are usable, so callers share one flag list instead of
# re-spelling -authenticationKeyPath/-ID/-IssuerID at every site.
ASC_AUTH_ARGS=()
_ASC_TMPDIR=""

# Removes the private copy of an inline key. Registered with `trap ... EXIT` by
# the caller. Writing a key to a predictable path and forgetting to delete it
# would leave a private key in the temp directory of every CI run that
# uploaded.
asc_cleanup() {
  if [[ -n "${_ASC_TMPDIR:-}" && -d "$_ASC_TMPDIR" ]]; then
    rm -rf "$_ASC_TMPDIR"
  fi
  _ASC_TMPDIR=""
}

# Rejects a value that is not a PEM, naming the problem rather than letting
# notarytool report "Invalid signature" twenty minutes later.
#
# Both markers are required, and that is not redundancy. A value pasted into
# .env as a real multi-line block is read by a line-based loader as ONE line --
# the BEGIN line -- followed by garbage that the loader then tries to export.
# Testing only for "-----BEGIN" and "PRIVATE KEY-----" passes that first line
# (it contains both), so the resolver happily wrote a one-line key file and
# reported success. The most likely way to get this wrong was the one way that
# got through. Requiring the END marker rejects it.
_asc_assert_pem() {
  local content="$1" origin="$2"
  if [[ "$content" != *"-----BEGIN"* || "$content" != *"-----END"* \
        || "$content" != *"PRIVATE KEY-----"* ]]; then
    echo "❌ APP_STORE_CONNECT_API_KEY from $origin is not a complete PEM private key." >&2
    echo "   Expected a block starting '-----BEGIN ... PRIVATE KEY-----' and ending" >&2
    echo "   '-----END ... PRIVATE KEY-----'. Check that nothing re-wrapped or" >&2
    echo "   truncated it. A .p8 pasted into .env must be a single line with its" >&2
    echo "   newlines written as \\n — a GitHub secret can keep the real ones." >&2
    return 1
  fi
}

# Materialises inline key material to a mode-600 file and points ASC_KEY_PATH
# at it. Everything Apple's tools take (-authenticationKeyPath, notarytool
# --key) wants a path, so a value has to become a file somewhere; the job here
# is to make sure that file is private, temporary, and gone afterwards.
_asc_write_inline_key() {
  local content="$1" origin="$2"

  if [[ "$content" != *$'\n'* && "$content" == *'\n'* ]]; then
    content="$(printf '%b' "$content")"
  fi

  _asc_assert_pem "$content" "$origin" || return 1

  _ASC_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/blockingmachine-asc.XXXXXX")" || return 1
  chmod 700 "$_ASC_TMPDIR"

  # umask first: the redirect below creates the file, and the window between
  # create and chmod is exactly where a world-readable private key lives.
  (
    umask 077
    printf '%s\n' "$content" > "$_ASC_TMPDIR/AuthKey.p8"
  ) || return 1

  ASC_KEY_PATH="$_ASC_TMPDIR/AuthKey.p8"
  ASC_KEY_SOURCE="inline"
}

# Fills ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH / ASC_KEY_SOURCE. Always
# returns 0 — "no credentials" is a state callers handle, not an error, because
# one of them falls back to a signed-in Xcode account and the other does not.
asc_resolve_auth() {
  ASC_KEY_ID="${APP_STORE_CONNECT_API_KEY_ID:-}"
  ASC_ISSUER_ID="${APP_STORE_CONNECT_API_ISSUER_ID:-}"
  ASC_KEY_PATH="${APP_STORE_CONNECT_API_KEY_PATH:-}"
  ASC_KEY_PATH="${ASC_KEY_PATH/#\~/$HOME}"
  ASC_KEY_SOURCE=""
  ASC_AUTH_ARGS=()

  # Inline wins over a path. A path left over in .env is the local developer's
  # machine; an inline value in the environment is this run, on this runner.
  # If both are set, this run is the one that was asked for.
  local inline="${APP_STORE_CONNECT_API_KEY:-}"
  if [[ -n "$inline" ]]; then
    _asc_write_inline_key "$inline" "the environment" || return 1
  elif [[ -n "$ASC_KEY_PATH" ]]; then
    ASC_KEY_SOURCE="path"
  elif [[ -n "$ASC_KEY_ID" ]]; then
    # No path given — Apple's own convention, so a key downloaded through
    # Xcode or the App Store Connect UI works with no configuration at all.
    local conventional="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
    if [[ -f "$conventional" ]]; then
      ASC_KEY_PATH="$conventional"
      ASC_KEY_SOURCE="conventional"
    fi
  fi

  if asc_auth_configured; then
    ASC_AUTH_ARGS=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
  fi
  return 0
}

# 0 when all three halves are present and the key material is actually readable.
asc_auth_configured() {
  [[ -n "$ASC_KEY_ID" && -n "$ASC_ISSUER_ID" && -n "$ASC_KEY_PATH" && -f "$ASC_KEY_PATH" ]]
}

# A one-line "what is missing", because "not fully configured" sends people
# looking for the wrong one of three variables.
_asc_missing() {
  local missing=()
  [[ -n "$ASC_KEY_ID" ]] || missing+=("APP_STORE_CONNECT_API_KEY_ID")
  [[ -n "$ASC_ISSUER_ID" ]] || missing+=("APP_STORE_CONNECT_API_ISSUER_ID")
  if [[ -z "$ASC_KEY_PATH" ]]; then
    missing+=("APP_STORE_CONNECT_API_KEY (inline) or APP_STORE_CONNECT_API_KEY_PATH")
  elif [[ ! -f "$ASC_KEY_PATH" ]]; then
    missing+=("a readable key file at APP_STORE_CONNECT_API_KEY_PATH=$ASC_KEY_PATH")
  fi
  printf '%s' "${missing[*]}"
}

# Hard stop for callers that cannot fall back. $1 names the step, so the error
# says what was being attempted rather than just "unset".
asc_require_auth() {
  local step="${1:-this step}"
  if asc_auth_configured; then
    return 0
  fi
  echo "❌ App Store Connect API key unusable — ${step} needs it." >&2
  echo "   Missing: $(_asc_missing)" >&2
  echo "" >&2
  echo "   For CI, pass the key as a value rather than a path:" >&2
  echo "     APP_STORE_CONNECT_API_KEY_ID=XXXXXXXXXX" >&2
  echo "     APP_STORE_CONNECT_API_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" >&2
  echo "     APP_STORE_CONNECT_API_KEY=<contents of AuthKey_XXXXXXXXXX.p8>" >&2
  echo "" >&2
  echo "   Locally, a path is fine:" >&2
  echo "     APP_STORE_CONNECT_API_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8" >&2
  exit 1
}
