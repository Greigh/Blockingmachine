#!/usr/bin/env bash
#
# Re-derive everything the shipped blocklist cut depends on, from the accumulated browser ledger.
#
# Run weekly by `.github/workflows/weekly-tier-compile.yml`, and by hand by anyone who wants to
# see what the current ledger produces. It is deliberately one script rather than a workflow: the
# thing CI runs every week and the thing you run when a derivation looks wrong should be the same
# code, or the weekly run tells you about a failure you cannot reproduce.
#
# ## What this is and is not for
#
# A CI job cannot collect browsing data. It can only re-derive from evidence someone gathered, so
# the ledger in `ledger/ledger-hits.txt` is the input and the owner topping it up is the only part
# that is genuinely manual. What the weekly run adds is the other half: it proves, every week,
# that the shipped artifacts still match the evidence and that the cut still fits Chrome's rule
# budget. A tier budget that quietly overflowed, or a hot list edited by hand, fails here rather
# than in a user's browser.
#
# ## Why the tier files are compiled and then put back
#
# The repository ships the curated baseline and compiles the real cut at package time — 30,000
# rules a week in a diff would be a repository that cannot be read and a check that cannot see a
# real change. So the compile runs to prove it works and to report what it would produce, and then
# the tier files are restored. It refuses to start if they are already modified, because a
# `git restore` cannot tell a tier file it just wrote from a tier file someone was working on.
#
# Usage:
#   scripts/weekly-tier-compile.sh              # derive and verify
#   scripts/weekly-tier-compile.sh --ledger <f> # use another ledger, for a what-if

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER="ledger/ledger-hits.txt"
TIER_PATHS=(packages/browser-extension/rules packages/browser-extension/src/shared/tierCounts.generated.ts)

while [ $# -gt 0 ]; do
  case "$1" in
    --ledger) LEDGER="${2:?--ledger needs a path}"; shift 2 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
done
cd "$REPO_ROOT"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ------------------------------------------------------------------------------------------------
step "Checking the ledger"

# The ledger gates the *tier cut*, not the whole run: the hot-set rebuild below replays whatever
# derivation the shipped file names, which today is a request trace and not this ledger at all,
# so an absent or empty dropbox is a skip of one step rather than an early exit.
HAVE_LEDGER=1
if [ ! -f "$LEDGER" ]; then
  HAVE_LEDGER=0
  echo "  no ledger at $LEDGER — nothing has been exported from a browser yet."
  echo "  See ledger/README.md. This is the expected state, not a failure."
else
  # A `<count> <rule>` line is what every downstream reader looks for, so this is the same
  # question `package-extension.mjs` asks before it passes `--hits`. Counting it here rather
  # than running the derive and reading its exit code keeps an empty dropbox a quiet no-op
  # instead of a failure that looks like a broken pipeline.
  HITS="$(grep -cE '^[[:space:]]*[0-9]+[[:space:]]+[^[:space:]]' "$LEDGER" || true)"
  if [ "${HITS:-0}" -eq 0 ]; then
    HAVE_LEDGER=0
    echo "  $LEDGER holds no rule hits yet (header only)."
    echo "  The cut stays in input order — only the ledger-derived steps are skipped."
  else
    echo "  $LEDGER: $HITS rules with measured hits"
    sed -n '1,12p' "$LEDGER" | sed 's/^/  | /'
  fi
fi

# ------------------------------------------------------------------------------------------------
step "Refusing to discard tier changes already in the working tree"

if [ "$HAVE_LEDGER" -eq 1 ] && ! git diff --quiet -- "${TIER_PATHS[@]}" 2>/dev/null; then
  echo "  These are modified, and this script restores them after compiling:"
  git status --short -- "${TIER_PATHS[@]}" | sed 's/^/  /'
  echo
  echo "  Commit or stash them first — otherwise a `git restore` here would throw away work."
  exit 1
fi

# ------------------------------------------------------------------------------------------------
step "Building core (the merge, the hot set and the classifier all read its output)"
npm run build --workspace=@blockingmachine/core >/dev/null

# ------------------------------------------------------------------------------------------------
step "Rebuilding the hot set from the derivation it names"

# `--write`, not `--check`: the point of the weekly run is to find that the shipped hot set no
# longer matches the evidence it was built from, and a check that only fails has no PR to open.
#
# No input flag — deliberately. The file's `Derivation:` header names the measurement it was
# adopted from (a URL-bearing live trace today; `--check` replays the same line), so the weekly
# job re-derives *that* and opens a PR when the fresh build differs — which happens when the
# source list moves, not merely because time passed. Passing `--hits` here would silently revert
# every deliberate adoption decision (flag 15 adopted the URL trace because it is the only input
# that can decide path-scoped rules); switching the shipped default to a different measurement
# is an owner's call — flag 16's question — and is done by running the builder with the new
# input by hand, not by automation outvoting a review.
node scripts/build-hot-list.mjs --write

# ------------------------------------------------------------------------------------------------
if [ "$HAVE_LEDGER" -eq 0 ]; then
  step "Skipping the ledger-derived tier cut (no hits to derive from)"
else
step "Compiling the tier cut from the ledger"

# The compile is the claim under test: that the ledger-derived cut still fits Chrome's guaranteed
# static-rule minimum. `--json` so the numbers land in a file a reader can diff rather than in a
# scrollback nobody keeps. That file is a *run report*, not an artifact — it records absolute input
# paths, so it differs per machine and is gitignored.
node scripts/compile-tier-rulesets.mjs --hits "$LEDGER" --json > "$REPO_ROOT/ledger/last-tier-plan.json"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const plan = JSON.parse(readFileSync("ledger/last-tier-plan.json", "utf8"));
  console.log(`  ${plan.total.toLocaleString()} of ${plan.budget.toLocaleString()} rules, from ${plan.distinctSyncedHosts.toLocaleString()} synced hosts`);
  for (const [tier, count] of Object.entries(plan.counts ?? {})) {
    const omitted = plan.omitted?.[tier] ?? 0;
    console.log(`    ${tier.padEnd(18)} ${String(count).padStart(6).replace(/(\d)(?=(\d{3})+$)/g, "$1,")} shipped${omitted ? `   ${omitted.toLocaleString()} did not fit` : ""}`);
  }
  const evidence = plan.hitEvidence;
  if (evidence) {
    console.log(`  measured evidence: ${evidence.hosts} hosts / ${evidence.hits.toLocaleString()} hits`);
    console.log(`    ${evidence.shippedWithEvidence} of those hosts survived the cut, ${evidence.promoted} promoted over input order`);
  } else {
    console.log("  measured evidence: none — this plan was not ranked by a ledger");
  }
'

step "Putting the tier files back (the cut is a packaging artifact, not a repository one)"
git restore -- "${TIER_PATHS[@]}"
echo "  restored ${TIER_PATHS[*]}"
echo "  the plan this run produced is in ledger/last-tier-plan.json (gitignored, and not committed)"
echo "  for the reasoning, see ledger/README.md"
fi

# ------------------------------------------------------------------------------------------------
step "Verifying what actually ships"

# `check:hotlist` is the one that matters: the hot set was just rebuilt from the derivation its
# header records, and this re-derives it from the same provenance and asks whether they agree.
# It is what catches a hand-edited hot list and a measurement whose artifact was not regenerated.
npm run check:hotlist

# The tier budget is enforced by the compile above — it allocates against the budget by
# construction and exits non-zero if the plan ever lands above it — so this is the packaging-time
# guardian run against the restored baseline, not against the plan. Both are cheap; both are the
# difference between a weekly failure and a release failure.
npm run verify:mv3

step "Done"
if [ "$HAVE_LEDGER" -eq 1 ]; then
  echo "  The hot set matches its recorded derivation, and the ledger-derived cut fit the budget."
else
  echo "  The hot set matches its recorded derivation (no ledger hits, so the tier cut was skipped)."
fi
echo "  Commit any change to packages/cli/filters/output/hotlist.txt that you want kept."