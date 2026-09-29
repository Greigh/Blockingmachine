"""SYNTHETIC shadow-log generator — for testing the M5 gate machinery ONLY.

Produces a learned-shadow.jsonl with the EXACT schema the Electron app
writes (see shadowMode.ts), but every value is simulated:

  * learned scores come from the real trained booster (model.txt) —
    faithful, because the TS classifier is proven score-identical (M3).
  * the "production reference" is the true label with 2% noise —
    standing in for the lists/rules verdicts.
  * reviewer labels in the verification step are the true labels —
    a perfect simulated reviewer.

Nothing here is real traffic. The real gate run happens once the
Electron app has logged 7 days of actual shadow data.
"""
from __future__ import annotations

import argparse
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np

from train import load_featurizer

BLOCK_T, REVIEW_T = 0.92, 0.65


def decide(score: float) -> str:
    return "block" if score >= BLOCK_T else "review" if score >= REVIEW_T else "allow"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--artifacts", default="model_artifacts")
    ap.add_argument("--out", default="synth-shadow.jsonl")
    ap.add_argument("--days", type=int, default=8)
    ap.add_argument("--per-day", type=int, default=300)
    ap.add_argument("--sample-rate", type=float, default=0.01)
    ap.add_argument("--noise", type=float, default=0.02)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    adir = Path(args.artifacts)
    raw = json.loads((adir / "test_set.json").read_text())
    test = raw["test"] if isinstance(raw, dict) else raw
    _, _, featurize, _ = load_featurizer(1, None)
    booster = lgb.Booster(model_file=str(adir / "model.txt"))

    domains = [t["domain"] for t in test]
    labels = {t["domain"]: t["label"] for t in test}
    scores = dict(zip(domains, booster.predict(np.array([featurize(d) for d in domains]))))

    start = datetime.now(timezone.utc) - timedelta(days=args.days)
    n_dis, n_samp = 0, 0
    with open(args.out, "w") as f:
        for day in range(args.days):
            at = (start + timedelta(days=day)).isoformat()
            batch = rng.sample(domains, min(args.per_day, len(domains)))
            evaluated, disagreements = 0, 0
            for d in batch:
                truth = labels[d]
                ref = "block" if truth == 1 else "allow"
                if rng.random() < args.noise:
                    ref = "allow" if ref == "block" else "block"
                learned = decide(float(scores[d]))
                evaluated += 1
                rec = {"domain": d, "learnedScore": round(float(scores[d]), 6),
                       "learnedDecision": learned, "referenceDecision": ref,
                       "allowlisted": False, "at": at}
                if learned != ref:
                    f.write(json.dumps(rec) + "\n")
                    disagreements += 1
                    n_dis += 1
                if rng.random() < args.sample_rate:
                    f.write(json.dumps({**rec, "sample": True}) + "\n")
                    n_samp += 1
            f.write(json.dumps({"type": "summary", "at": at, "evaluated": evaluated,
                                "disagreements": disagreements, "modelVersion": "synth-v1"}) + "\n")
    print(f"SYNTHETIC log -> {args.out}: {n_dis} disagreements, {n_samp} samples, "
          f"{args.days} days x {args.per_day} scored")


if __name__ == "__main__":
    main()
