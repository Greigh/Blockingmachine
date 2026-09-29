"""M5 active-learning queue — Blockingmachine AI training pipeline.

DESIGN.md §8: predictions landing in the review band and shadow
disagreements get queued for human review; resolved items become gold
labels (weight 3.0) in the next training run.

Two steps:

  1. build the queue from the shadow log (disagreements, breakage
     risk first, boundary-closest first):
     .venv/bin/python active_learn.py --build-queue --shadow learned-shadow.jsonl \\
         --out review_queue.csv

  2. after a human fills reviewer_label (1 = tracker, 0 = benign),
     merge them as gold labels:
     .venv/bin/python active_learn.py --merge --queue reviewed.csv --db labels.db

The queue CSV is the same format shadow.py --review-sample writes, so
either tool can produce it.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from labels import ingest_rows
from shadow import load_log, review_sample

REVIEW_WEIGHT = 3.0


def build_queue(shadow_path: Path, out: Path, n: int, seed: int) -> None:
    records = load_log(shadow_path)
    rows = review_sample(records, n, seed)
    if not rows:
        print("no disagreements in shadow log — queue is empty")
        return
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["domain", "learned_score", "learned_decision", "reference_decision",
                    "allowlisted", "at", "reviewer_label", "reviewer_notes"])
        for r in rows:
            w.writerow([r["domain"], round(r["learnedScore"], 4), r["learnedDecision"],
                        r["referenceDecision"], r.get("allowlisted", False), r["at"], "", ""])
    print(f"active-learning queue: {len(rows)} domains -> {out}")


def merge(queue_path: Path, db_path: Path, dry_run: bool = False) -> None:
    rows: list[tuple[str, int, str, float]] = []
    skipped = 0
    with open(queue_path, newline="") as f:
        for i, rec in enumerate(csv.DictReader(f), 2):
            lab = (rec.get("reviewer_label") or "").strip()
            if lab not in ("0", "1"):
                skipped += 1
                continue
            domain = (rec.get("domain") or "").strip().lower()
            if not domain:
                print(f"warning: line {i} no domain, skipping", file=sys.stderr)
                skipped += 1
                continue
            rows.append((domain, int(lab), "review", REVIEW_WEIGHT))
    if dry_run:
        print(f"dry run: {len(rows)} gold labels would merge, {skipped} unlabeled rows skipped")
        return
    if rows:
        ingest_rows(db_path, rows)
    print(f"merged {len(rows)} reviewed gold labels (weight {REVIEW_WEIGHT}); "
          f"{skipped} unlabeled rows skipped")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build-queue", action="store_true")
    ap.add_argument("--merge", action="store_true")
    ap.add_argument("--shadow", default=None)
    ap.add_argument("--queue", default=None)
    ap.add_argument("--db", default="labels.db")
    ap.add_argument("--out", default="review_queue.csv")
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.build_queue:
        if not args.shadow:
            raise SystemExit("--build-queue needs --shadow learned-shadow.jsonl")
        build_queue(Path(args.shadow), Path(args.out), args.n, args.seed)
    elif args.merge:
        if not args.queue:
            raise SystemExit("--merge needs --queue reviewed.csv")
        merge(Path(args.queue), Path(args.db), args.dry_run)
    else:
        raise SystemExit("pass --build-queue or --merge")


if __name__ == "__main__":
    main()
