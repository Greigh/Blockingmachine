"""M4 v2 features — Blockingmachine AI training pipeline.

Appends behavioral + graph features (from observations.db) to the v1
lexical vector. Append-only: positions 0-14 are byte-identical to v1,
so v1 fixtures still validate the prefix.

Missing observations are NOT imputed — they are NaN, which LightGBM
handles natively (it learns the optimal missing direction per split).
The TypeScript port must pass NaN through and honor `default_left`
in the exported trees (see export.py / gbdt.ts).

FEATURE_VERSION = 2. Changing any definition below bumps it again.
"""
from __future__ import annotations

import math
import sqlite3
from pathlib import Path

from features import FEATURE_NAMES as V1_NAMES, featurize_vector

FEATURE_VERSION = 2

# (feature name, observation column). None column -> derived/constant.
V2_FEATURES: list[tuple[str, str | None]] = [
    ("redirect_count", "redirect_count"),       # redirects followed
    ("fetch_error", None),                      # 1.0 if both fetches failed
    ("has_set_cookie", "set_cookie"),           # server sets cookies
    ("cookie_count", "cookie_count"),           # raw Set-Cookie count
    ("body_kw_hits", "body_kw_hits"),           # tracker keywords in body
    ("https_ok", "https_ok"),                   # clean https fetch
    ("cert_free_ca", "cert_free_ca"),           # free-CA TLS cert
    ("cname_depth", "cname_depth"),             # CNAME chain length (graph)
]

FEATURE_NAMES = V1_NAMES + [name for name, _ in V2_FEATURES]
N_V1 = len(V1_NAMES)

_obs_cache: dict[str, dict] | None = None


def load_observations(db_path: str | Path) -> dict[str, dict]:
    """{domain: row-dict} from observations.db. Cached per process."""
    global _obs_cache
    if _obs_cache is None:
        con = sqlite3.connect(db_path)
        con.row_factory = sqlite3.Row
        _obs_cache = {
            r["domain"]: dict(r)
            for r in con.execute("SELECT * FROM observations")
        }
        con.close()
    return _obs_cache


def featurize_vector_v2(domain: str, observations: dict[str, dict] | None) -> list[float]:
    """v1 lexical vector + behavioral features; NaN where unobserved."""
    vec = featurize_vector(domain)
    key = domain.strip().lower().rstrip(".")
    obs = (observations or {}).get(key)
    if obs is None:
        return vec + [math.nan] * len(V2_FEATURES)
    tail: list[float] = []
    for name, col in V2_FEATURES:
        if name == "fetch_error":
            tail.append(1.0 if obs.get("fetch_error") else 0.0)
            continue
        v = obs.get(col) if col else None
        tail.append(float(v) if v is not None else math.nan)
    return vec + tail
