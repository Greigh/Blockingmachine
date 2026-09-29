"""M5 feedback ingestion — Blockingmachine AI training pipeline.

Ingests user Confirm-Threat / Mark-Safe feedback into the label store
(DESIGN.md §2: gold labels, weight 3.0) with anti-poisoning:

  * Canary domains — known-benign domains that appear in NO list. If a
    reporter's batch flags a canary as a threat, the whole batch is
    quarantined: the reporter is unreliable, not the domain.
  * Flip rule — feedback that disagrees with the current effective
    label is NOT applied on one report alone. It needs agreement from
    another source (a second independent reporter, or a crawler/review
    label already in the store). Unagreed flips wait in
    feedback_pending instead of silently moving the label.

Input: feedback.jsonl, one record per line:
    {"domain": "evil.example", "verdict": "threat", "at": "...",
     "reporter": "user-123"}

Usage:
    .venv/bin/python feedback.py --db labels.db --feedback feedback.jsonl
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

from golden import GOLDEN_BENIGN
from labels import SCHEMA, ingest_rows

PENDING_SCHEMA = """
CREATE TABLE IF NOT EXISTS feedback_pending (
  domain    TEXT NOT NULL,
  label     INTEGER NOT NULL,
  reporter  TEXT NOT NULL,
  at        TEXT NOT NULL,
  PRIMARY KEY (domain, reporter)
);
"""

FEEDBACK_WEIGHT = 3.0


def canaries(db_path: Path) -> set[str]:
    """Known-benign domains that appear in no positive list."""
    con = sqlite3.connect(db_path)
    listed = {r[0] for r in con.execute("SELECT domain FROM labels WHERE label=1")}
    con.close()
    return {d for d in GOLDEN_BENIGN if d not in listed}


def effective_labels(db_path: Path) -> dict[str, int]:
    """domain -> label, positive wins across sources."""
    con = sqlite3.connect(db_path)
    eff: dict[str, int] = {}
    for domain, label in con.execute("SELECT domain, label FROM labels"):
        eff[domain] = eff.get(domain, 0) or label
    con.close()
    return eff


def agreeing_source(db_path: Path, domain: str, label: int) -> str | None:
    """A non-feedback source already asserting this label, if any."""
    con = sqlite3.connect(db_path)
    row = con.execute(
        "SELECT source FROM labels WHERE domain=? AND label=? AND source NOT IN ('feedback') LIMIT 1",
        (domain, label),
    ).fetchone()
    con.close()
    return row[0] if row else None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default="labels.db")
    ap.add_argument("--feedback", required=True, help="feedback.jsonl")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    db_path = Path(args.db)
    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA + PENDING_SCHEMA)

    canary = canaries(db_path)
    eff = effective_labels(db_path)

    records = []
    with open(args.feedback) as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                print(f"warning: line {i} not JSON, skipping", file=sys.stderr)
                continue
            if r.get("verdict") not in ("threat", "safe") or not r.get("domain"):
                print(f"warning: line {i} bad verdict/domain, skipping", file=sys.stderr)
                continue
            records.append(r)

    # Canary trip: any reporter flagging a canary as a threat poisons
    # their whole batch.
    tripped = {r.get("reporter", "?") for r in records
               if r["verdict"] == "threat" and r["domain"] in canary}
    if tripped:
        print(f"QUARANTINE: canary trip by reporter(s) {sorted(tripped)} — "
              f"their {sum(1 for r in records if r.get('reporter') in tripped)} records rejected")
    records = [r for r in records if r.get("reporter") not in tripped]

    applied, pending, agreed = 0, 0, 0
    to_apply: list[tuple[str, int, str, float]] = []
    for r in records:
        domain = r["domain"].lower()
        label = 1 if r["verdict"] == "threat" else 0
        current = eff.get(domain)
        if current is None or current == label:
            # New domain or agreement: gold label, straight in.
            to_apply.append((domain, label, "feedback", FEEDBACK_WEIGHT))
            eff[domain] = label
            applied += 1
            continue
        # Flip attempt: needs agreement from another source.
        src = agreeing_source(db_path, domain, label)
        prior = con.execute(
            "SELECT reporter FROM feedback_pending WHERE domain=? AND label=? AND reporter != ?",
            (domain, label, r.get("reporter", "")),
        ).fetchone()
        if src or prior:
            to_apply.append((domain, label, "feedback", FEEDBACK_WEIGHT))
            con.execute("DELETE FROM feedback_pending WHERE domain=?", (domain,))
            eff[domain] = label
            agreed += 1
        else:
            if not args.dry_run:
                con.execute(
                    "INSERT OR REPLACE INTO feedback_pending (domain, label, reporter, at) VALUES (?, ?, ?, ?)",
                    (domain, label, r.get("reporter", ""), r.get("at", "")),
                )
            pending += 1

    if args.dry_run:
        con.rollback()
        print(f"dry run: {applied} would apply, {agreed} flips agreed, "
              f"{pending} pending agreement, {len(tripped)} reporters quarantined")
    else:
        # Commit this connection's pending-table writes BEFORE ingest_rows
        # opens its own connection — otherwise the second writer blocks
        # on this connection's uncommitted transaction (database is locked).
        con.commit()
        if to_apply:
            ingest_rows(db_path, to_apply)
        print(f"feedback: {applied} applied, {agreed} flips applied on agreement, "
              f"{pending} held in feedback_pending, {len(tripped)} reporters quarantined")
    con.close()


if __name__ == "__main__":
    main()
