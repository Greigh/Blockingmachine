"""Parity test: recompute every fixture vector and compare.

This is the contract the TypeScript port must satisfy: same domain
-> same vector within 1e-9. Run from the package directory:

    python test_fixtures.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from features import FEATURE_NAMES, FEATURE_VERSION, featurize_vector


def main() -> int:
    doc = json.loads(Path("fixtures.json").read_text())
    assert doc["feature_version"] == FEATURE_VERSION, "fixtures are stale: regenerate"
    assert doc["feature_names"] == FEATURE_NAMES, "feature order changed: regenerate"

    bad = 0
    for item in doc["fixtures"]:
        got = featurize_vector(item["domain"])
        for name, g, e in zip(FEATURE_NAMES, got, item["vector"]):
            if not math.isclose(g, e, rel_tol=1e-9, abs_tol=1e-12):
                print(f"MISMATCH {item['domain']} {name}: got {g}, want {e}")
                bad += 1

    # Sanity: the features should discriminate obvious cases.
    i_ent = FEATURE_NAMES.index("entropy")
    i_tok = FEATURE_NAMES.index("token_hits")
    dga = featurize_vector("xkqzjw92mfn4.biz")
    benign = featurize_vector("github.com")
    tracker = featurize_vector("pixel.track-analytics.xyz")
    assert dga[i_ent] > benign[i_ent], "entropy should flag DGA-ish domains"
    assert tracker[i_tok] > benign[i_tok], "token_hits should flag trackers"

    n = len(doc["fixtures"])
    print(f"{n} fixtures OK, sanity checks OK" if not bad else f"{bad} mismatches")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
