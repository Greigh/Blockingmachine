"""M5 drift monitoring — Blockingmachine AI training pipeline.

Weekly PSI (population stability index) per feature over production
traffic, per DESIGN.md §8: "PSI > 0.2 on any top-10-importance feature
→ alert + propose an off-cycle retrain. This is the early-warning radar
for advertisers changing tactics."

Two steps:

  1. export a baseline from the training split ONCE per trained model:
     .venv/bin/python drift.py --export-baseline --artifacts model_artifacts \\
         --baseline drift_baseline.json

  2. compare production traffic (the *sample* records in
     learned-shadow.jsonl — the unbiased slice, not disagreements)
     against it:
     .venv/bin/python drift.py --psi --baseline drift_baseline.json \\
         --shadow learned-shadow.jsonl --out drift_report.json

PSI < 0.1: no significant change. 0.1–0.25: moderate, watch.
> 0.25: significant shift. The gate uses 0.2 on top-10 features.
"""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
from pathlib import Path

import numpy as np

from golden import GOLDEN_BENIGN
from train import load_featurizer, stratified_split
from shadow import load_log

N_BINS = 10
EPS = 1e-6


def train_matrix(db: str, fversion: int, observations: str | None):
    """Feature matrix of the TRAIN split — what the model learned."""
    _, fnames, featurize, _ = load_featurizer(fversion, observations)
    con = sqlite3.connect(db)
    rows = con.execute("SELECT domain, label, weight FROM labels").fetchall()
    con.close()
    golden = set(GOLDEN_BENIGN)
    rows = [r for r in rows if r[0] not in golden]
    X, domains = [], []
    for domain, _label, _weight in rows:
        try:
            X.append(featurize(domain))
        except ValueError:
            continue
        domains.append(domain)
    items = list(zip(domains, [0] * len(domains), [1.0] * len(domains)))
    train, _, _ = stratified_split(items)
    train_domains = {t[0] for t in train}
    Xtr = np.array([v for d, v in zip(domains, X) if d in train_domains])
    return fnames, Xtr


def export_baseline(artifacts: Path, db: str, fversion: int,
                    observations: str | None, out: Path) -> None:
    fnames, X = train_matrix(db, fversion, observations)
    imp_path = artifacts / "importance.json"
    top = []
    if imp_path.exists():
        imp = json.loads(imp_path.read_text())
        # importance.json is a list of {"feature", "gain"} sorted desc
        pairs = [(e["feature"], e["gain"]) for e in imp] if isinstance(imp, list) \
            else list(imp.items())
        top = [f for f, _ in sorted(pairs, key=lambda kv: kv[1], reverse=True)[:10]]
    feats = {}
    for j, name in enumerate(fnames):
        col = X[:, j]
        mask = ~np.isnan(col)
        missing_frac = float(1 - mask.mean())
        vals = col[mask]
        if len(vals) == 0:
            edges = [0.0, 1.0]
        else:
            qs = np.quantile(vals, np.linspace(0, 1, N_BINS + 1))
            # dedupe flat edges (spiky integer features like token_hits)
            edges = sorted(set(float(q) for q in qs))
            if len(edges) < 2:
                edges = [edges[0] - 0.5, edges[0] + 0.5]
        # actual baseline mass per bin — NOT uniform after dedup
        bins = [-math.inf] + edges[1:-1] + [math.inf]
        hist, _ = np.histogram(vals, bins=bins)
        base_props = (hist / hist.sum()).tolist() if hist.sum() else [1.0 / len(hist)] * len(hist)
        feats[name] = {"edges": edges, "base_props": base_props,
                       "missing_frac": missing_frac}
    baseline = {
        "feature_version": fversion,
        "feature_names": fnames,
        "n_train": len(X),
        "n_bins": N_BINS,
        "top_features": top,
        "features": feats,
    }
    out.write_text(json.dumps(baseline, indent=2))
    print(f"baseline from {len(X)} train rows -> {out}")


def psi_for_feature(edges: list[float], base_props: list[float],
                    base_missing: float, prod: np.ndarray) -> float:
    """PSI of production values vs the baseline binning (+missing bin)."""
    prod = np.asarray(prod, dtype=float)
    n = len(prod)
    if n == 0:
        return 0.0
    psi = 0.0
    # extend to ±inf so out-of-range production values land in the
    # edge bins instead of vanishing from the histogram
    bins = [-math.inf] + list(edges[1:-1]) + [math.inf]
    hist_p, _ = np.histogram(prod[~np.isnan(prod)], bins=bins)
    n_val = max((~np.isnan(prod)).sum(), 1)
    for b, c in zip(base_props, hist_p):
        p = max(c / n_val, EPS)
        b = max(b * (1 - base_missing), EPS)
        psi += (p - b) * math.log(p / b)
    # missing bin
    p_miss = max(float(np.isnan(prod).mean()), EPS)
    b_miss = max(base_missing, EPS)
    psi += (p_miss - b_miss) * math.log(p_miss / b_miss)
    return float(psi)


def psi_report(baseline_path: Path, shadow_path: Path) -> dict:
    baseline = json.loads(baseline_path.read_text())
    fnames = baseline["feature_names"]
    fversion = baseline["feature_version"]
    records = load_log(shadow_path)
    samples = [r for r in records if r["kind"] == "sample"]
    if not samples:
        raise SystemExit(
            "no sample records in the shadow log — drift needs the unbiased "
            "production slice. The Electron hook passes LEARNED_SHADOW_SAMPLE_RATE "
            "(1%) explicitly, so reaching this means no watchdog sweep has written "
            "yet: the AI watchdog is off, the app has not run, or the shadow log is "
            "empty. Disagreement records alone cannot substitute — they are the "
            "biased population. See docs/learned-shadow-privacy.md."
        )
    _, _, featurize, _ = load_featurizer(fversion, None)
    domains = [r["domain"] for r in samples]
    Xp, kept = [], []
    for d in domains:
        try:
            Xp.append(featurize(d))
            kept.append(d)
        except ValueError:
            continue
    Xp = np.array(Xp)
    per_feature = {}
    for j, name in enumerate(fnames):
        spec = baseline["features"][name]
        per_feature[name] = psi_for_feature(spec["edges"], spec["base_props"],
                                            spec["missing_frac"], Xp[:, j])
    ranked = sorted(per_feature.items(), key=lambda kv: kv[1], reverse=True)
    top = baseline.get("top_features", [])
    alerts = [name for name in top if per_feature.get(name, 0) > 0.2]
    return {
        "n_production": len(kept),
        "n_train_baseline": baseline["n_train"],
        "psi_by_feature": {k: round(v, 4) for k, v in ranked},
        "top_feature_alerts": alerts,
        "verdict": "DRIFT" if alerts else ("WATCH" if any(v > 0.1 for _, v in ranked[:3]) else "STABLE"),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--export-baseline", action="store_true")
    ap.add_argument("--psi", action="store_true")
    ap.add_argument("--artifacts", default="model_artifacts")
    ap.add_argument("--db", default="labels.db")
    ap.add_argument("--features", type=int, default=1, choices=(1, 2))
    ap.add_argument("--observations", default=None)
    ap.add_argument("--baseline", default="drift_baseline.json")
    ap.add_argument("--shadow", default=None)
    ap.add_argument("--out", default="drift_report.json")
    args = ap.parse_args()

    if args.export_baseline:
        export_baseline(Path(args.artifacts), args.db, args.features,
                        args.observations, Path(args.baseline))
    elif args.psi:
        if not args.shadow:
            raise SystemExit("--psi needs --shadow learned-shadow.jsonl")
        report = psi_report(Path(args.baseline), Path(args.shadow))
        Path(args.out).write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
    else:
        raise SystemExit("pass --export-baseline or --psi")


if __name__ == "__main__":
    main()
