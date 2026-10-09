"""Ingest live observation streams — flag 43's data foundation.

Reads the daemon's DNS observation JSONL (`<userData>/dns-observations.jsonl`
plus its rotated `.1` sibling) and the browser fan-out aggregate
(`<userData>/browser-fanout.json`) into `live_observations.db`, the store
`features3.py` joins against the label store at train time.

Both inputs are append/merge-shaped so re-running is idempotent: dns events
dedup on (domain, observed_at), fanout rows merge by max.

Usage:
    .venv/bin/python obs_ingest.py --db live_observations.db \
        --dns ~/Library/Application\\ Support/Blockingmachine/dns-observations.jsonl \
        --fanout ~/Library/Application\\ Support/Blockingmachine/browser-fanout.json
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS dns_events (
  domain TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  qtype TEXT,
  verdict TEXT,
  rcode INTEGER,
  upstream_ok INTEGER,
  cname_depth INTEGER,
  cname_hosts TEXT,
  cname_foreign INTEGER,
  ttl_min INTEGER,
  answer_count INTEGER,
  latency_ms INTEGER,
  PRIMARY KEY (domain, observed_at)
);
CREATE INDEX IF NOT EXISTS dns_events_domain ON dns_events(domain);

CREATE TABLE IF NOT EXISTS fanout (
  domain TEXT PRIMARY KEY,
  first_parties INTEGER,
  first_parties_capped INTEGER,
  hits INTEGER,
  updated_at TEXT
);
"""


def _dns_paths(path: Path) -> list[Path]:
    """The stream plus its single rotated sibling, oldest first."""
    rotated = Path(str(path) + ".1")
    return [p for p in (rotated, path) if p.exists()]


def ingest_dns(con: sqlite3.Connection, path: Path) -> tuple[int, int]:
    """(rows_seen, rows_new) — INSERT OR IGNORE keeps reruns idempotent."""
    seen = 0
    new = 0
    for p in _dns_paths(path):
        with open(p, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                seen += 1
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue  # torn tail from a mid-write read
                domain = r.get("domain")
                observed_at = r.get("observed_at")
                if not isinstance(domain, str) or not isinstance(observed_at, str):
                    continue
                cur = con.execute(
                    """INSERT OR IGNORE INTO dns_events
                       (domain, observed_at, qtype, verdict, rcode, upstream_ok,
                        cname_depth, cname_hosts, cname_foreign, ttl_min,
                        answer_count, latency_ms)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        domain.lower().rstrip("."),
                        observed_at,
                        r.get("qtype"),
                        r.get("verdict"),
                        r.get("rcode"),
                        _int01(r.get("upstream_ok")),
                        r.get("cname_depth"),
                        json.dumps(r["cname_hosts"]) if isinstance(r.get("cname_hosts"), list) else None,
                        _int01(r.get("cname_foreign")),
                        r.get("ttl_min"),
                        r.get("answer_count"),
                        r.get("latency_ms"),
                    ),
                )
                new += cur.rowcount
    return seen, new


def _int01(v: object) -> int | None:
    if v is None:
        return None
    return 1 if v else 0


def ingest_fanout(con: sqlite3.Connection, path: Path) -> tuple[int, int]:
    """Merge the hub's aggregate — the union semantics the extension relies on."""
    seen = 0
    new = 0
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0, 0
    entries = raw.get("entries")
    if not isinstance(entries, dict):
        return 0, 0
    for domain, e in entries.items():
        if not isinstance(domain, str) or not isinstance(e, dict):
            continue
        seen += 1
        fps = e.get("firstParties")
        fp_count = len(fps) if isinstance(fps, list) else 0
        capped = 1 if e.get("firstPartiesCapped") else 0
        hits = e.get("hits") if isinstance(e.get("hits"), (int, float)) else 0
        cur = con.execute(
            """INSERT INTO fanout (domain, first_parties, first_parties_capped, hits, updated_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(domain) DO UPDATE SET
                 first_parties=MAX(first_parties, excluded.first_parties),
                 first_parties_capped=MAX(first_parties_capped, excluded.first_parties_capped),
                 hits=MAX(hits, excluded.hits),
                 updated_at=excluded.updated_at""",
            (domain.lower().rstrip("."), fp_count, capped, int(hits),
             time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        )
        new += cur.rowcount
    return seen, new


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="live_observations.db")
    ap.add_argument("--dns", help="path to dns-observations.jsonl")
    ap.add_argument("--fanout", help="path to browser-fanout.json")
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    con.executescript(SCHEMA)
    try:
        if args.dns:
            seen, new = ingest_dns(con, Path(args.dns))
            print(f"dns: {seen} records read, {new} new events -> {args.db}")
        if args.fanout:
            seen, new = ingest_fanout(con, Path(args.fanout))
            print(f"fanout: {seen} entries read, {new} rows upserted -> {args.db}")
        con.commit()
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
