"""M5 shadow-log analysis — Blockingmachine AI training pipeline.

Reads the learned-shadow.jsonl the Electron app appends (see
packages/electron-app/src/learnedShadow.ts and
packages/core/src/ai/learned/shadowMode.ts) and answers the questions
the promotion gate needs:

  * how much shadow coverage do we have (days, scored domains)?
  * where do the model and the production reference disagree, and in
    which direction?  model=block/ref=allow is potential site breakage;
    model=allow/ref=block is a missed tracker.
  * which disagreements should a human review first?

Record kinds (all JSON, one per line):
  disagreement  {domain, learnedScore, learnedDecision,
                 referenceDecision, allowlisted, at}
  sample        same fields + {"sample": true} — a random slice of ALL
                scored domains (opt-in via sampleRate), used for drift.
  summary       {"type": "summary", at, evaluated, disagreements,
                 modelVersion} — per-sweep counters. `modelVersion` is
                 the promotion version of the weights that scored the
                 sweep, or null when they have no manifest. Written by
                 the app's shadow scorer once per sweep that scored at
                 least one domain; `coverage()` splits its totals by
                 whether that version is known.

Unknown kinds are ignored so the format can grow without breaking
this parser.

Usage:
    .venv/bin/python shadow.py --log learned-shadow.jsonl --stats
    .venv/bin/python shadow.py --log learned-shadow.jsonl \\
        --review-sample 120 --out review_queue.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

DECISIONS = {"allow", "review", "block"}

# Review priority: breakage risk first, then misses, then the fuzzy band.
DIRECTION_RANK = {
    ("block", "allow"): 0,    # model would break the site
    ("block", "review"): 1,
    ("review", "allow"): 2,
    ("allow", "block"): 3,    # model misses a tracker
    ("review", "block"): 4,
    ("allow", "review"): 5,
}


def parse_line(line: str, lineno: int) -> dict | None:
    try:
        rec = json.loads(line)
    except json.JSONDecodeError:
        print(f"warning: line {lineno} is not JSON, skipping", file=sys.stderr)
        return None
    if not isinstance(rec, dict):
        return None
    if rec.get("type") == "summary":
        return {"kind": "summary", **rec}
    if rec.get("sample") is True:
        kind = "sample"
    elif "learnedDecision" in rec and "referenceDecision" in rec:
        kind = "disagreement"
    else:
        return None  # unknown kind: ignore, don't crash
    if rec.get("learnedDecision") not in DECISIONS or rec.get("referenceDecision") not in DECISIONS:
        print(f"warning: line {lineno} has bad decisions, skipping", file=sys.stderr)
        return None
    if not rec.get("domain") or not rec.get("at"):
        print(f"warning: line {lineno} missing domain/at, skipping", file=sys.stderr)
        return None
    return {"kind": kind, **rec}


def load_log(path: Path) -> list[dict]:
    records = []
    with open(path) as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            rec = parse_line(line, i)
            if rec is not None:
                records.append(rec)
    return records


def coverage(records: list[dict]) -> dict:
    """Shadow coverage: days spanned, domains scored, from summaries+samples.

    `scored_domains` counts what the app actually scored, which only
    summary records can say: a domain the model and the reference agreed
    about is never written down, so a log of disagreements alone cannot
    measure how much traffic passed through the model. Summaries are
    split by `modelVersion` because "30,000 domains scored" means
    something different when the weights that scored them were never
    versioned — the count is reported either way, and the unversioned
    part is reported beside it so a gate report cannot present
    unversioned evidence as if it identified a model.

    A summary with `evaluated: 0` does not count as a day of shadow: the
    sweep ran, nothing was scored, and that is not coverage.
    """
    summaries = [r for r in records if r["kind"] == "summary"]
    scored = [r for r in summaries if r.get("evaluated", 0) > 0]
    ats = sorted(r["at"] for r in records if r.get("at"))
    days = sorted({a[:10] for a, r in
                   ((r["at"], r) for r in records if r.get("at"))
                   if not (r["kind"] == "summary" and r.get("evaluated", 0) <= 0)})
    evaluated = sum(r.get("evaluated", 0) for r in summaries)
    unversioned = sum(r.get("evaluated", 0) for r in scored if r.get("modelVersion") is None)
    versions = sorted({str(r["modelVersion"]) for r in scored if r.get("modelVersion") is not None})
    return {
        "first_at": ats[0] if ats else None,
        "last_at": ats[-1] if ats else None,
        "days": len(days),
        "scored_domains": evaluated,
        "summaries": len(summaries),
        "unversioned_scored_domains": unversioned,
        "model_versions": versions,
        "disagreement_records": sum(1 for r in records if r["kind"] == "disagreement"),
        "sample_records": sum(1 for r in records if r["kind"] == "sample"),
    }


def disagreement_stats(records: list[dict]) -> dict:
    disag = [r for r in records if r["kind"] == "disagreement"]
    by_dir = Counter((r["learnedDecision"], r["referenceDecision"]) for r in disag)
    return {
        "n": len(disag),
        "by_direction": {f"model={a}/ref={b}": c for (a, b), c in sorted(by_dir.items())},
        "breakage_candidates": by_dir.get(("block", "allow"), 0) + by_dir.get(("block", "review"), 0),
        "miss_candidates": by_dir.get(("allow", "block"), 0) + by_dir.get(("review", "block"), 0),
        "allowlisted": sum(1 for r in disag if r.get("allowlisted")),
    }


def review_sample(records: list[dict], n: int, seed: int = 42) -> list[dict]:
    """Stratified review sample: breakage risk first, then misses.

    Within a direction, domains closest to the block threshold sort
    first — the boundary is where labels are most informative.
    """
    import random
    rng = random.Random(seed)
    disag = [r for r in records if r["kind"] == "disagreement"]
    buckets: dict[tuple[str, str], list[dict]] = {}
    for r in disag:
        buckets.setdefault((r["learnedDecision"], r["referenceDecision"]), []).append(r)
    ordered: list[dict] = []
    for direction in sorted(buckets, key=lambda d: DIRECTION_RANK.get(d, 9)):
        bucket = buckets[direction]
        # boundary-first, then shuffle the rest for diversity
        bucket.sort(key=lambda r: abs(r["learnedScore"] - 0.92))
        ordered.extend(bucket)
    return ordered[:n]


def write_review_csv(rows: list[dict], path: Path) -> None:
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["domain", "learned_score", "learned_decision", "reference_decision",
                    "allowlisted", "at", "reviewer_label", "reviewer_notes"])
        for r in rows:
            w.writerow([r["domain"], round(r["learnedScore"], 4), r["learnedDecision"],
                        r["referenceDecision"], r.get("allowlisted", False), r["at"],
                        "", ""])
    print(f"wrote {len(rows)} review rows to {path}")
    print("reviewer_label: 1 = tracker (model was right to flag), 0 = benign (model was wrong)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log", required=True, help="learned-shadow.jsonl from the app")
    ap.add_argument("--stats", action="store_true", help="print coverage + disagreement stats")
    ap.add_argument("--review-sample", type=int, default=0, metavar="N",
                    help="write N prioritized disagreements for human review")
    ap.add_argument("--out", default="review_queue.csv")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    records = load_log(Path(args.log))
    print(f"{len(records)} records from {args.log}")
    if args.stats or args.review_sample == 0:
        cov = coverage(records)
        print(json.dumps({"coverage": cov, "disagreements": disagreement_stats(records)}, indent=2))
    if args.review_sample:
        write_review_csv(review_sample(records, args.review_sample, args.seed), Path(args.out))


if __name__ == "__main__":
    main()
