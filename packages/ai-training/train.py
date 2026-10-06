"""M2 training — LightGBM binary classifier on the label store.

    python train.py --db labels.db --out model_artifacts

Writes model.txt, test_set.json, and prints train/val/test
average precision. Run inside the venv: `.venv/bin/python train.py`.

Split policy (DESIGN.md §4): split BY TIME, not randomly — train on
time buckets 1–10, validate on 11, test on 12 (of 12 equal-duration
buckets over the label store's observed_at span), stratified per class
so a class that arrived in one import batch can't collapse a split.
Random splits leak in adversarial domains (same actor, new domains).

Fallback: if the label store's time span is < 30 days (e.g. all rows
from one list import), a time split is degenerate, so training falls
back to a stratified random split (seed 42) with a loud warning and
records the fallback in test_set.json. The time split activates
automatically once feedback/crawler labels give observed_at real span.
"""
from __future__ import annotations

import argparse
import json
import random
import sqlite3
from datetime import datetime
from pathlib import Path

import lightgbm as lgb
import numpy as np

from features import FEATURE_NAMES, featurize_vector
from golden import GOLDEN_BENIGN


def load_featurizer(version: int, observations_path: str | None):
    """Return (version, names, featurize_fn). v2 appends behavioral features."""
    if version == 1:
        return 1, FEATURE_NAMES, featurize_vector, len(FEATURE_NAMES)
    if version == 2:
        from features2 import FEATURE_NAMES as N2, FEATURE_VERSION as V2, N_V1
        from features2 import featurize_vector_v2, load_observations
        obs = load_observations(observations_path or "observations.db")
        print(f"v2: {len(obs)} observed domains loaded")
        return V2, N2, lambda d: featurize_vector_v2(d, obs), N_V1
    raise ValueError(f"unknown feature version {version}")

PARAMS = {
    "objective": "binary",
    "metric": "average_precision",
    "num_leaves": 63,
    "min_data_in_leaf": 500,   # precision bias: fewer, high-confidence leaves
    "feature_fraction": 0.8,
    "seed": 42,
    "deterministic": True,
    "verbosity": -1,
}


def stratified_split(items: list, ratios=(0.8, 0.1, 0.1), seed=42):
    """items: (domain, label, weight). Returns (train, val, test)."""
    rng = random.Random(seed)
    by_label: dict[int, list] = {0: [], 1: []}
    for it in items:
        by_label[it[1]].append(it)
    splits: dict[str, list] = {"train": [], "val": [], "test": []}
    names = ("train", "val", "test")
    for label, group in by_label.items():
        rng.shuffle(group)
        n = len(group)
        i0, i1 = int(n * ratios[0]), int(n * (ratios[0] + ratios[1]))
        for name, chunk in zip(names, (group[:i0], group[i0:i1], group[i1:])):
            splits[name].extend(chunk)
    for s in splits.values():
        rng.shuffle(s)
    return splits["train"], splits["val"], splits["test"]


N_TIME_BUCKETS = 12          # DESIGN.md §4: train 1–10, validate 11, test 12
MIN_TIME_SPAN_DAYS = 30      # below this a time split is degenerate


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def time_split(items: list, seed=42):
    """items: (domain, label, weight, observed_at datetime).

    12 equal-duration buckets over the global [min, max] observed_at;
    per class, rows sorted by time go to train (buckets 0–9), val (10),
    test (11). Returns (train, val, test, metadata) where each split
    holds (domain, label, weight) tuples.
    """
    rng = random.Random(seed)
    tmin = min(it[3] for it in items)
    tmax = max(it[3] for it in items)
    span_days = (tmax - tmin).total_seconds() / 86400
    meta: dict = {
        "method": "time",
        "buckets": N_TIME_BUCKETS,
        "span_days": round(span_days, 2),
        "window_start": tmin.isoformat(),
        "window_end": tmax.isoformat(),
    }
    if span_days < MIN_TIME_SPAN_DAYS:
        meta["method"] = "stratified-random-fallback"
        meta["reason"] = (
            f"observed_at span {span_days:.1f}d < {MIN_TIME_SPAN_DAYS}d — "
            "degenerate for a time split (list snapshots share one import "
            "timestamp); the time split activates automatically once "
            "feedback/crawler labels give observed_at real span"
        )
        print(f"WARNING: {meta['reason']}")
        train, val, test = stratified_split([(d, l, w) for d, l, w, _ in items], seed=seed)
        return train, val, test, meta

    def bucket(t: datetime) -> int:
        frac = (t - tmin).total_seconds() / max((tmax - tmin).total_seconds(), 1)
        return min(N_TIME_BUCKETS - 1, int(frac * N_TIME_BUCKETS))

    by_label: dict[int, list] = {0: [], 1: []}
    for it in items:
        by_label[it[1]].append(it)
    splits: dict[str, list] = {"train": [], "val": [], "test": []}
    for label, group in by_label.items():
        group.sort(key=lambda it: it[3])
        for it in group:
            b = bucket(it[3])
            name = "train" if b < 10 else "val" if b == 10 else "test"
            splits[name].append((it[0], it[1], it[2]))
    for s in splits.values():
        rng.shuffle(s)
    if not splits["val"] or not splits["test"]:
        meta["method"] = "stratified-random-fallback"
        meta["reason"] = "time buckets for val/test came out empty (labels clustered in time)"
        print(f"WARNING: {meta['reason']}")
        train, val, test = stratified_split([(d, l, w) for d, l, w, _ in items], seed=seed)
        return train, val, test, meta
    for name, s in splits.items():
        n0 = sum(1 for _, l, _ in s if l == 0)
        meta[f"{name}_n"] = len(s)
        meta[f"{name}_neg"] = n0
        meta[f"{name}_pos"] = len(s) - n0
    return splits["train"], splits["val"], splits["test"], meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="labels.db")
    ap.add_argument("--out", default="model_artifacts")
    ap.add_argument("--rounds", type=int, default=1000)
    ap.add_argument("--early-stopping", type=int, default=50)
    ap.add_argument("--features", type=int, default=1, choices=(1, 2),
                    help="feature schema version (v2 needs --observations)")
    ap.add_argument("--observations", default="observations.db")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    fversion, fnames, featurize, n_v1 = load_featurizer(args.features, args.observations)
    print(f"feature schema v{fversion} ({len(fnames)} features)")

    con = sqlite3.connect(args.db)
    rows = con.execute("SELECT domain, label, weight, observed_at FROM labels").fetchall()
    con.close()

    golden = set(GOLDEN_BENIGN)
    rows = [r for r in rows if r[0] not in golden]
    print(f"{len(rows)} labeled domains ({len(golden)} golden excluded from training)")

    X, y, w, domains, ts_list = [], [], [], [], []
    skipped = 0
    for domain, label, weight, observed_at in rows:
        try:
            X.append(featurize(domain))
        except ValueError:
            skipped += 1
            continue
        y.append(label)
        w.append(weight)
        domains.append(domain)
        ts_list.append(parse_ts(observed_at))
    if skipped:
        print(f"skipped {skipped} unfeaturizable domains")

    items = list(zip(domains, y, w, ts_list))
    train, val, test, split_meta = time_split(items)
    print(f"split [{split_meta['method']}]: "
          f"train={len(train)} val={len(val)} test={len(test)}")

    # Re-featurize avoidance: build the feature cache once.
    feats = {d: v for d, v in zip(domains, X)}

    def ds(split):
        return lgb.Dataset(
            np.array([feats[x[0]] for x in split]),
            label=np.array([x[1] for x in split]),
            weight=np.array([x[2] for x in split]),
        )

    # How many pool domains actually have observations (v2 signal coverage)?
    if fversion == 2:
        import math
        n_obs = sum(1 for v in X if not math.isnan(v[n_v1]))
        print(f"v2 signal coverage: {n_obs}/{len(X)} train-pool domains observed")

    n_neg = sum(1 for _, label, _ in train if label == 0)
    n_pos = sum(1 for _, label, _ in train if label == 1)
    params = dict(PARAMS, scale_pos_weight=n_neg / max(n_pos, 1))

    booster = lgb.train(
        params,
        ds(train),
        num_boost_round=args.rounds,
        valid_sets=[ds(val)],
        valid_names=["val"],
        callbacks=[lgb.early_stopping(args.early_stopping, verbose=False)],
    )
    print(f"best iteration: {booster.best_iteration}")

    booster.save_model(str(out / "model.txt"))
    with open(out / "test_set.json", "w") as f:
        json.dump(
            {
                "feature_version": fversion,
                "split": split_meta,
                "test": [{"domain": d, "label": l} for d, l, _ in test],
            },
            f,
        )

    for name, split in (("train", train), ("val", val), ("test", test)):
        preds = booster.predict(np.array([feats[x[0]] for x in split]))
        ap_score = _average_precision([x[1] for x in split], preds)
        print(f"{name} average_precision: {ap_score:.4f} (n={len(split)})")
    print(f"wrote {out}/model.txt and test_set.json")


def _average_precision(y_true: list[int], scores: list[float]) -> float:
    order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    tp = fp = 0
    total_pos = sum(y_true)
    ap, prev_recall = 0.0, 0.0
    for i in order:
        if y_true[i]:
            tp += 1
        else:
            fp += 1
        precision = tp / (tp + fp)
        recall = tp / total_pos if total_pos else 0.0
        ap += (recall - prev_recall) * precision
        prev_recall = recall
    return ap


if __name__ == "__main__":
    main()
