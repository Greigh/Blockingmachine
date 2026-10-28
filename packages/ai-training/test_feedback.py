"""Feedback-merge test: user Confirm-Threat/Mark-Safe labels into labels.db.

Exercises the real feedback.py path (canary quarantine, flip rule, reset
tombstones) against a temp labels.db. Run from the package directory:

    python test_feedback.py
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

from labels import ingest_rows

PKG = Path(__file__).resolve().parent


def run_merge(db: Path, feedback: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(PKG / "feedback.py"), "--db", str(db), "--feedback", str(feedback)],
        capture_output=True, text=True, cwd=PKG,
    )


def labels(db: Path) -> dict[tuple[str, str], int]:
    con = sqlite3.connect(db)
    rows = {r[:2]: r[2] for r in con.execute(
        "SELECT domain, source, label FROM labels")}
    con.close()
    return rows


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.write_text("".join(json.dumps(r) + "\n" for r in records))


def main() -> int:
    bad = 0
    total = 0

    def check(name: str, cond: bool) -> None:
        nonlocal bad, total
        total += 1
        if cond:
            print(f"  ok  {name}")
        else:
            print(f" FAIL {name}")
            bad += 1

    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "labels.db"
        fb = Path(td) / "user-labels.jsonl"

        # Seed one non-feedback positive so the flip rule has something to say.
        ingest_rows(db, [("list-tracker.example.com", 1, "adguard", 1.0)])

        # 1) New-domain user labels apply straight in as gold feedback.
        write_jsonl(fb, [
            {"domain": "evil-tracker.example.com", "verdict": "threat",
             "reporter": "local-user", "correctedVerdict": "clean",
             "correctedCategory": "Clean", "at": "2026-10-15T00:00:00Z"},
            {"domain": "good-api.example.com", "verdict": "safe",
             "reporter": "local-user", "at": "2026-10-15T00:00:00Z"},
        ])
        r = run_merge(db, fb)
        check("merge exits clean", r.returncode == 0)
        got = labels(db)
        check("threat label applied at gold weight source",
              got.get(("evil-tracker.example.com", "feedback")) == 1)
        check("safe label applied",
              got.get(("good-api.example.com", "feedback")) == 0)

        # 2) reset tombstone deletes only the feedback row.
        write_jsonl(fb, [
            {"domain": "evil-tracker.example.com", "verdict": "reset",
             "reporter": "local-user", "at": "2026-10-15T00:01:00Z"},
        ])
        r = run_merge(db, fb)
        check("reset merge exits clean", r.returncode == 0)
        got = labels(db)
        check("feedback label deleted by reset",
              ("evil-tracker.example.com", "feedback") not in got)
        check("other-source label survives reset",
              got.get(("list-tracker.example.com", "adguard")) == 1)
        check("safe label survives reset", got.get(("good-api.example.com", "feedback")) == 0)

        # 3) reset on a domain that had NO feedback row is a harmless no-op.
        write_jsonl(fb, [
            {"domain": "list-tracker.example.com", "verdict": "reset",
             "reporter": "local-user", "at": "2026-10-15T00:02:00Z"},
        ])
        r = run_merge(db, fb)
        check("no-op reset merge exits clean", r.returncode == 0)
        got = labels(db)
        check("reset leaves list-sourced rows alone",
              got.get(("list-tracker.example.com", "adguard")) == 1)

        # 4) malformed lines are skipped, not fatal.
        with open(fb, "w") as f:
            f.write('{"domain":"ok.example.com","verdict":"threat","reporter":"local-user","at":"t"}\n')
            f.write("not-json\n")
            f.write('{"domain":"x.com","verdict":"maybe","reporter":"r"}\n')
        r = run_merge(db, fb)
        check("malformed lines skipped", r.returncode == 0
              and ("ok.example.com", "feedback") in labels(db))

    print(f"\n{total - bad}/{total} checks passed" if bad else "\nAll checks passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
