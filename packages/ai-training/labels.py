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
import re
import sqlite3
import sys
import time
from pathlib import Path

from public_names import is_public_name

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


# Modifiers that scope a rule to a site, a cookie, or the page layer —
# their presence means the list does NOT assert the domain itself is
# blockable: `||google.com/*/ads.html$…,domain=napisy24.pl` does not make
# google.com a tracker. Delivery-scope modifiers (third-party, script,
# image, redirect=, …) still assert the domain's content is unwanted, so
# `||adnxs.com^$redirect=nooptext` remains a valid positive.
_SCOPE_MODS = (
    "domain=", "cookie=", "generichide", "elemhide", "document", "popup",
    "removeparam", "csp", "badfilter", "app=",
)


def parse_adblock_domains(text: str) -> list[str]:
    """Extract domains from ||domain rules asserting the domain is unwanted.

    Rejects scope-qualified rules: a `/` in the tail means the rule targets
    a path, not the domain (`||youtube.com/embed/…` does not label
    youtube.com), and _SCOPE_MODS mark site/cookie/page-level scope
    (`||bing.com^$cookie=ABDEF` does not label bing.com). Whatever survives
    is validated against the serving boundary (is_public_name): IPs,
    SRV/service names, malformed labels and non-public suffixes are not
    learnable signal.
    """
    domains = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("||"):
            continue
        body = line[2:]
        m = re.match(r"([^/$^]+)(.*)$", body)
        if not m:
            continue
        host, tail = m.group(1).strip().lower().rstrip("."), m.group(2)
        if "/" in tail:
            continue
        if "$" in tail:
            mods = tail.split("$", 1)[1]
            if any(s in mods for s in _SCOPE_MODS):
                continue
        if host and "*" not in host and is_public_name(host):
            domains.append(host)
    return sorted(set(domains))


def parse_majestic_domains(text: str, limit: int) -> list[str]:
    """Majestic Million CSV: GlobalRank,TldRank,Domain,... (skip header)."""
    domains = []
    for i, line in enumerate(text.splitlines()):
        if i == 0:
            continue
        parts = line.split(",")
        if len(parts) >= 3 and parts[2]:
            d = parts[2].strip().lower().rstrip(".")
            if is_public_name(d):
                domains.append(d)
        if len(domains) >= limit:
            break
    return domains


def ingest_rows(db_path: Path, rows: list[tuple[str, int, str, float]]) -> None:
    """rows: (domain, label, source, weight). Positive label wins conflicts.

    The corpus invariant lives here, not in each parser: a row whose
    domain fails `is_public_name` is dropped for every writer — list
    ingests, review merges, feedback — because the serving side can never
    score such a name, so a label for it is noise (15 junk rows reached
    the store before this existed: ABP `$`-modifier strings, SRV names,
    IP literals, malformed labels).
    """
    # Store the normalized form, not the raw casing (consolidated-review
    # L10): `FOO.com.` and `foo.com` must collapse to one label row, and the
    # serving side lowercases before lookup.
    normalized = [
        (r[0].strip().lower().rstrip("."), r[1], r[2], r[3])
        for r in rows if r[0]
    ]
    kept = [r for r in normalized if is_public_name(r[0])]
    dropped = len(rows) - len(kept)
    if dropped:
        print(f"ingest_rows: dropped {dropped} non-public domain rows", file=sys.stderr)
    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    # Insert negatives first so a later positive insert wins the conflict.
    ordered = sorted(kept, key=lambda r: r[1])
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
