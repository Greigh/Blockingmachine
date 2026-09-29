"""M2 label store — Blockingmachine AI training pipeline.

SQLite table per DESIGN.md. Ingest tracker positives from an
Adblock-style list file and benign negatives from a Majestic-style
CSV. Feedback/crawler sources plug into `ingest_rows` later with
higher trust weights.

    python labels.py --db labels.db \
        --pos-file adguard_tracking.txt --neg-file majestic.csv --neg-limit 10000
"""
from __future__ import annotations

import argparse
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS labels (
  domain      TEXT NOT NULL,
  label       INTEGER NOT NULL,   -- 1 = tracker/ad, 0 = benign
  source      TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (domain, source)
);
CREATE INDEX IF NOT EXISTS idx_labels_domain ON labels(domain);
"""


def parse_adblock_domains(text: str) -> list[str]:
    """Extract domains from ||domain^ style rules."""
    domains = []
    for line in text.splitlines():
        if line.startswith("||"):
            host = line[2:].split("^")[0].split("/")[0]
            if host and "." in host and "*" not in host:
                domains.append(host.lower())
    return sorted(set(domains))


def parse_majestic_domains(text: str, limit: int) -> list[str]:
    """Majestic Million CSV: GlobalRank,TldRank,Domain,... (skip header)."""
    domains = []
    for i, line in enumerate(text.splitlines()):
        if i == 0:
            continue
        parts = line.split(",")
        if len(parts) >= 3 and parts[2]:
            domains.append(parts[2].strip().lower())
        if len(domains) >= limit:
            break
    return domains


def ingest_rows(db_path: Path, rows: list[tuple[str, int, str, float]]) -> None:
    """rows: (domain, label, source, weight). Positive label wins conflicts."""
    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    # Insert negatives first so a later positive insert wins the conflict.
    ordered = sorted(rows, key=lambda r: r[1])
    con.executemany(
        """INSERT INTO labels (domain, label, source, weight, observed_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(domain, source) DO UPDATE SET
             label=excluded.label, weight=excluded.weight,
             observed_at=excluded.observed_at""",
        [(d, l, s, w, now) for d, l, s, w in ordered],
    )
    con.commit()
    con.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="labels.db")
    ap.add_argument("--pos-file", required=True)
    ap.add_argument("--neg-file", required=True)
    ap.add_argument("--neg-limit", type=int, default=10000)
    args = ap.parse_args()

    pos = parse_adblock_domains(Path(args.pos_file).read_text(errors="replace"))
    neg = parse_majestic_domains(
        Path(args.neg_file).read_text(errors="replace"), args.neg_limit
    )
    pos_set = set(pos)
    conflicts = [d for d in neg if d in pos_set]
    neg = [d for d in neg if d not in pos_set]  # positive label wins

    rows = [(d, 1, "adguard", 1.0) for d in pos]
    rows += [(d, 0, "majestic", 1.0) for d in neg]
    ingest_rows(Path(args.db), rows)

    con = sqlite3.connect(args.db)
    n_pos = con.execute("SELECT COUNT(*) FROM labels WHERE label=1").fetchone()[0]
    n_neg = con.execute("SELECT COUNT(*) FROM labels WHERE label=0").fetchone()[0]
    con.close()
    print(f"labels.db: {n_pos} positives, {n_neg} negatives "
          f"({len(conflicts)} conflicts resolved as positive)")


if __name__ == "__main__":
    main()
