"""M4 threshold tuning — Blockingmachine AI training pipeline.

Finds operating thresholds from labeled scores, and later from the
M3 shadow log (learned-shadow.jsonl) once the Electron app has been
running it. Usage:

    # from the held-out test set (no shadow log yet)
    .venv/bin/python tune_thresholds.py --artifacts model_artifacts \\
        --observations observations.db

    # from real shadow-mode traffic (preferred once it exists)
    .venv/bin/python tune_thresholds.py --shadow ~/path/learned-shadow.jsonl \\
        --reviews reviewed.csv

Shadow sample records carry the production verdict and the learned score,
so we can measure what the learned model WOULD have done: for each candidate
threshold, precision/recall vs reference-as-proxy, with human-reviewed
disagreements weighted as gold labels. The disagreement rate feeds the
promotion gate (DESIGN.md M5).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np

from train import load_featurizer


def precision_recall_at(y: np.ndarray, s: np.ndarray, t: float, w: np.ndarray | None = None):
    pred = s >= t
    w = np.ones_like(y, dtype=float) if w is None else w
    tp = float(w[(pred == 1) & (y == 1)].sum())
    fp = float(w[(pred == 1) & (y == 0)].sum())
    fn = float(w[(pred == 0) & (y == 1)].sum())
    prec = tp / (tp + fp) if tp + fp else 1.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    return prec, rec


def tune(y: np.ndarray, s: np.ndarray, target_recall: float, w: np.ndarray | None = None) -> dict:
    """Highest threshold achieving >= target_recall, maximizing precision."""
    best = None
    for t in np.linspace(0.01, 0.99, 99):
        prec, rec = precision_recall_at(y, s, t, w)
        if rec >= target_recall and (best is None or prec > best["precision"]):
            best = {"threshold": round(float(t), 3), "precision": prec, "recall": rec}
    return best or {"threshold": 0.99, "precision": 0.0, "recall": 0.0}


def from_test_set(adir: Path, observations: str):
    raw = json.loads((adir / "test_set.json").read_text())
    fversion = raw.get("feature_version", 1) if isinstance(raw, dict) else 1
    test = raw["test"] if isinstance(raw, dict) else raw
    _, _, featurize, _ = load_featurizer(fversion, observations)
    booster = lgb.Booster(model_file=str(adir / "model.txt"))
    y = np.array([t["label"] for t in test])
    s = booster.predict(np.array([featurize(t["domain"]) for t in test]))
    return y, s, f"test set (feature v{fversion})"


def from_shadow(path: Path, reviews: Path | None):
    """Threshold tuning from real traffic.

    Two evidence tiers, honestly labeled:
      * sample records (~1% of all scored domains): reference decision as
        a WEAK proxy label (the reference is the lists — circular, but
        plentiful and unbiased).
      * reviewed disagreements (human labels): gold labels on the hard
        boundary cases, where the threshold actually matters.
    """
    y, s, weights = [], [], []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not row.get("sample"):
            continue
        ref = row.get("referenceDecision")
        if ref not in ("block", "allow"):
            continue
        if row.get("learnedScore") is None:
            continue
        y.append(1 if ref == "block" else 0)
        s.append(row["learnedScore"])
        weights.append(1.0)
    n_proxy = len(y)
    n_gold = 0
    if reviews:
        import csv
        with open(reviews, newline="") as f:
            for rec in csv.DictReader(f):
                lab = (rec.get("reviewer_label") or "").strip()
                sc = (rec.get("learned_score") or "").strip()
                if lab not in ("0", "1") or not sc:
                    continue
                y.append(int(lab))
                s.append(float(sc))
                weights.append(10.0)  # gold labels outweigh proxy labels
                n_gold += 1
    src = (f"shadow log ({n_proxy} sample rows, reference-as-proxy + "
           f"{n_gold} reviewed disagreements as gold labels)")
    return np.array(y), np.array(s), np.array(weights), src


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--artifacts", default="model_artifacts")
    ap.add_argument("--observations", default="observations.db")
    ap.add_argument("--shadow", default=None,
                    help="learned-shadow.jsonl from the Electron app")
    ap.add_argument("--reviews", default=None,
                    help="reviewed.csv with reviewer_label filled (gold labels)")
    ap.add_argument("--target-recall", type=float, default=0.90)
    ap.add_argument("--out", default="thresholds.json")
    args = ap.parse_args()

    w = None
    if args.shadow:
        y, s, w, src = from_shadow(Path(args.shadow),
                                   Path(args.reviews) if args.reviews else None)
    else:
        y, s, src = from_test_set(Path(args.artifacts), args.observations)
    if len(y) == 0:
        raise SystemExit("no scored rows found")

    rec_target = args.target_recall
    block = tune(y, s, rec_target, w)
    review = tune(y, s, min(0.99, rec_target + 0.05), w)
    result = {
        "source": src,
        "n": len(y),
        "target_recall": rec_target,
        "block": block,
        "review": review,
        "note": "block threshold maximizes precision at target recall; "
                "review is a higher-recall triage band. Production gates "
                "still apply (allowlist first, shadow disagreement review). "
                "Advisory only: proxy labels are reference verdicts (the lists), "
                "so this tuner cannot discover anything the lists don't already "
                "say — it checks the operating point hasn't drifted, it does not "
                "set production thresholds. Threshold changes go through the "
                "promotion gate with human review.",
    }
    Path(args.out).write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
