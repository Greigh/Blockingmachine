"""M6 v3 features — the live-instrumentation tail (flag 43).

v1 lexical (positions 0–14) + v2 crawl (15–22), byte-identical, plus the signals
only the running system can see:

  dns_*     — from the daemon's observation stream (`obs_ingest.py` →
              live_observations.db). `cname_depth` over real answers and
              `cname_foreign` (chain crosses registrable domain = cloaking) are
              the fields `requests` structurally could not measure; `verdict`
              records whether production already blocks the name; timestamps are
              real observation times, closing the label-store's dead
              `observed_at` span.
  fanout_*  — from the browser extension's first-party ledger: how many distinct
              registrable sites embed the host. The classic tracker-vs-CDN
              discriminator the v2 crawl lacked entirely.

Missing stays NaN — LightGBM learns the missing direction per split, and the
export's `default_left` carries the routing into the TS port. `dns_seen` and the
`fanout_*` counts are honest zeros when absent (no coverage = never observed),
not missing — the distinction matters for what a zero means.

FEATURE_VERSION = 3.
"""
from __future__ import annotations

import math
import sqlite3
from pathlib import Path

from features import FEATURE_NAMES as V1_NAMES
from features2 import FEATURE_NAMES as V2_NAMES

FEATURE_VERSION = 3

# (feature name, aggregate expression over dns_events). Derived entries get None.
V3_DNS_FEATURES: list[tuple[str, str | None]] = [
    ("dns_seen", None),               # any dns_events row exists (0/1, never NaN)
    ("dns_query_count", "n"),         # log1p of event count
    ("dns_blocked", "blocked"),       # production ever answered BLOCKED
    ("dns_cname_depth", "cdepth"),    # deepest chain seen
    ("dns_cname_foreign", "cforeign"),# any chain crossing registrable origin
    ("dns_nxdomain_rate", "nxrate"),  # share of answered events that NXDOMAIN'd
    ("dns_ttl_min", "ttl"),           # smallest TTL upstream gave
    ("dns_latency_ms", "lat"),        # mean DoH round-trip
]

V3_FANOUT_FEATURES: list[tuple[str, str | None]] = [
    ("fanout_sites", "first_parties"),   # distinct first-party sites (0 = unobserved)
    ("fanout_hits", "hits"),             # matched-request count under them
]

FEATURE_NAMES = (
    V2_NAMES
    + [n for n, _ in V3_DNS_FEATURES]
    + [n for n, _ in V3_FANOUT_FEATURES]
)
N_V1 = len(V1_NAMES)
N_V2 = len(V2_NAMES)

_DNS_AGG_SQL = """
SELECT COUNT(*) AS n,
       MAX(CASE WHEN verdict='BLOCKED' THEN 1 ELSE 0 END) AS blocked,
       MAX(cname_depth) AS cdepth,
       MAX(cname_foreign) AS cforeign,
       AVG(CASE WHEN rcode IS NOT NULL THEN CASE WHEN rcode=3 THEN 1.0 ELSE 0.0 END END) AS nxrate,
       MIN(ttl_min) AS ttl,
       AVG(latency_ms) AS lat
FROM dns_events WHERE domain = ?
"""


class LiveObservations:
    """Lazy per-domain joins over live_observations.db — a row absent means the
    running system never observed the name, which is exactly NaN semantics."""

    def __init__(self, db_path: str | Path):
        self.con = sqlite3.connect(db_path)
        self.con.row_factory = sqlite3.Row
        self._dns: dict[str, sqlite3.Row | None] = {}
        self._fanout: dict[str, sqlite3.Row | None] = {}

    def dns(self, domain: str) -> sqlite3.Row | None:
        if domain not in self._dns:
            self._dns[domain] = self.con.execute(_DNS_AGG_SQL, (domain,)).fetchone()
            if self._dns[domain] is not None and self._dns[domain]["n"] == 0:
                self._dns[domain] = None
        return self._dns[domain]

    def fanout(self, domain: str) -> sqlite3.Row | None:
        if domain not in self._fanout:
            self._fanout[domain] = self.con.execute(
                "SELECT first_parties, first_parties_capped, hits FROM fanout WHERE domain = ?",
                (domain,),
            ).fetchone()
        return self._fanout[domain]

    def close(self) -> None:
        self.con.close()


def featurize_vector_v3(
    domain: str,
    crawl_obs: dict[str, dict] | None,
    live: LiveObservations | None,
) -> list[float]:
    """v2 vector + live-instrumentation tail; NaN where unobserved."""
    from features2 import featurize_vector_v2

    vec = featurize_vector_v2(domain, crawl_obs)
    key = domain.strip().lower().rstrip(".")

    dns_row = live.dns(key) if live else None
    tail: list[float] = []
    tail.append(0.0 if dns_row is None else 1.0)  # dns_seen — a real zero
    for _name, col in V3_DNS_FEATURES[1:]:
        if dns_row is None:
            tail.append(math.nan)
            continue
        v = dns_row[col] if col else None
        if _name == "dns_query_count" and v is not None:
            tail.append(math.log1p(float(v)))
        else:
            tail.append(float(v) if v is not None else math.nan)

    fan_row = live.fanout(key) if live else None
    for _name, col in V3_FANOUT_FEATURES:
        # Absent = never observed under any site = honest 0, not NaN.
        v = fan_row[col] if fan_row is not None else None
        tail.append(float(v) if v is not None else 0.0)

    return vec + tail


def load_live_observations(db_path: str | Path | None) -> LiveObservations | None:
    """None when the DB is absent — v3 without live data degrades to all-NaN/0."""
    if not db_path or not Path(db_path).exists():
        return None
    return LiveObservations(db_path)
