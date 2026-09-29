"""M2 export — LightGBM model -> bm-gbdt/1 JSON for the TypeScript core.

    .venv/bin/python export.py --artifacts model_artifacts --out model.json

Writes the versioned weights artifact per DESIGN.md and verifies it:
re-implements GBDT evaluation over the exported JSON and checks
predictions match the LightGBM booster within 1e-9 on sample domains.

Thresholds are initial values per the design; shadow-mode data (M3)
tunes them. The TS loader must treat them as config, not gospel.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np

from train import load_featurizer

FORMAT = "bm-gbdt/1"
BLOCK_THRESHOLD = 0.92
REVIEW_THRESHOLD = 0.65


def convert_node(node: dict) -> dict:
    if "leaf_value" in node:
        return {"leaf_value": float(node["leaf_value"])}
    return {
        "split_feature": int(node["split_feature"]),
        "threshold": float(node["threshold"]),
        # LightGBM routes NaN (missing) to default_left. v1 trees predate
        # this field; they never see NaN, so the fallback is unreachable.
        "default_left": bool(node.get("default_left", False)),
        # NOTE: LightGBM decision_type "<=" is the common case for our
        # numerical features; categorical splits are not used.
        "left": convert_node(node["left_child"]),
        "right": convert_node(node["right_child"]),
    }


def predict_one(trees: list[dict], vector: list[float]) -> float:
    total = 0.0
    for tree in trees:
        node = tree
        while "leaf_value" not in node:
            x = vector[node["split_feature"]]
            if x != x:  # NaN: follow LightGBM's missing direction
                node = node["left"] if node.get("default_left", False) else node["right"]
            else:
                node = node["left"] if x <= node["threshold"] else node["right"]
        total += node["leaf_value"]
    return 1.0 / (1.0 + math.exp(-total))  # binary logloss -> probability


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--artifacts", default="model_artifacts")
    ap.add_argument("--out", default="model.json")
    ap.add_argument("--verify-n", type=int, default=500)
    ap.add_argument("--features", type=int, default=None,
                    help="feature schema version (default: read from test_set.json)")
    ap.add_argument("--observations", default="observations.db")
    args = ap.parse_args()
    adir = Path(args.artifacts)

    raw_test = json.loads((adir / "test_set.json").read_text())
    fversion = args.features or (raw_test.get("feature_version", 1)
                                 if isinstance(raw_test, dict) else 1)
    fver, fnames, featurize, _ = load_featurizer(fversion, args.observations)

    booster = lgb.Booster(model_file=str(adir / "model.txt"))
    dump = booster.dump_model()
    trees = [convert_node(t["tree_structure"]) for t in dump["tree_info"]]
    print(f"exported {len(trees)} trees, "
          f"{sum(t['num_leaves'] for t in dump['tree_info'])} leaves")

    # Provenance: hash of the booster this export was derived from, so the
    # promotion gate can audit the model.txt -> model.json chain.
    import hashlib
    h = hashlib.sha256()
    with open(adir / "model.txt", "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)

    doc = {
        "format": FORMAT,
        "feature_version": fver,
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "trained_from_sha256": h.hexdigest(),
        "feature_names": fnames,
        "trees": trees,
        "thresholds": {"block": BLOCK_THRESHOLD, "review": REVIEW_THRESHOLD},
    }
    out = Path(args.out)
    out.write_text(json.dumps(doc))
    print(f"wrote {out} ({out.stat().st_size / 1024:.1f} KB)")

    # Verify: exported JSON must agree with the booster (NaN-aware).
    test = raw_test["test"] if isinstance(raw_test, dict) else raw_test
    rng = random.Random(7)
    sample = rng.sample(test, min(args.verify_n, len(test)))
    vecs = [featurize(t["domain"]) for t in sample]
    ref = booster.predict(np.array(vecs))
    got = [predict_one(trees, v) for v in vecs]
    worst = max(abs(a - b) for a, b in zip(ref, got))
    print(f"verification: max |booster - exported| = {worst:.2e} over {len(sample)} domains")
    if worst > 1e-9:
        print("EXPORT VERIFICATION: FAIL")
        return 1
    print("EXPORT VERIFICATION: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
