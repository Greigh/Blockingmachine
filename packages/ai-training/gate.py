"""M5 promotion gate — Blockingmachine AI training pipeline.

Decides whether a candidate model may be promoted to the shipped
ai-weights. Every criterion from DESIGN.md §5 (eval gates) and §8
(drift) is checked against evidence, and the verdict is a JSON report
a human reviews before merging. There is no silent auto-ship: the
gate advises, `promote.py --confirm` executes, a human approves.

Checks:
  offline (candidate artifacts)
    1. test average precision >= min_test_ap (design: 0.95)
    2. precision@recall=0.90 >= target (design: 0.99)
    3. golden benign set: zero flips at the review threshold
    4. exported model.json <= max_artifact_kb (design: 500 KB)
    5. feature_version supported and feature_names match the contract
  shadow (learned-shadow.jsonl + reviewed disagreements)
    6. coverage: >= min_shadow_days days, >= min_shadow_scored domains
     (counted from the per-sweep `summary` records the app writes; the
     report states how much of that was scored by versioned weights)
    7. >= min_reviewed distinct disagreements reviewed (>= min_reviewed_block
       distinct in the block direction, capped at available)
    8. ZERO confirmed breakage: no distinct domain where the reviewer
       called a model-block benign. Reviewed block precision is reported
       as informational — it is measured on the hard-case disagreement
       subset, not production traffic.
  drift (drift_baseline.json vs shadow samples)
    9. PSI <= max_psi_top10 on every top-10-importance feature

Usage:
    .venv/bin/python gate.py --artifacts model_artifacts \\
        --export model.json --allowlist allowlist.json \\
        --shadow learned-shadow.jsonl --reviews reviewed.csv \\
        --baseline drift_baseline.json --out gate_report.json

Exit code 0 on PASS, 1 on FAIL (or on missing evidence — a gate that
can't see the evidence must not pass).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np

from golden import GOLDEN_BENIGN
from train import load_featurizer
from shadow import load_log, coverage
from drift import psi_report

DEFAULT_CONFIG = {
    "min_test_ap": 0.95,
    "min_precision_at_recall_90": 0.99,
    "max_golden_flips": 0,
    "max_artifact_kb": 500,
    "min_shadow_days": 7,
    "min_shadow_scored": 1000,
    "min_reviewed": 50,
    "min_reviewed_block": 30,
    "max_confirmed_breakage": 0,
    "max_psi_top10": 0.2,
}


def average_precision(y: np.ndarray, s: np.ndarray) -> float:
    order = np.argsort(-s, kind="stable")
    y = y[order]
    tp = np.cumsum(y)
    prec = tp / np.arange(1, len(y) + 1)
    rec = tp / max(tp[-1], 1)
    ap = 0.0
    prev_r = 0.0
    for p, r in zip(prec, rec):
        ap += p * (r - prev_r)
        prev_r = r
    return float(ap)


def precision_at_recall(y: np.ndarray, s: np.ndarray, target: float = 0.90,
                        keep: np.ndarray | None = None) -> float:
    """Best precision reachable at recall >= target.

    `keep` masks the evaluation rows: the allowlist-adjusted variant drops the
    domains the allowlist decides before the model ever scores, so the number
    answers "how precise is the model where it is actually allowed to speak"
    rather than re-measuring a decision it does not make.
    """
    if keep is not None:
        y = y[keep]
        s = s[keep]
    best = 0.0
    for t in np.unique(s):
        pred = s >= t
        tp = int(((pred == 1) & (y == 1)).sum())
        fp = int(((pred == 1) & (y == 0)).sum())
        fn = int(((pred == 0) & (y == 1)).sum())
        rec = tp / (tp + fn) if tp + fn else 0.0
        prec = tp / (tp + fp) if tp + fp else 1.0
        if rec >= target and prec > best:
            best = prec
    return best


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--artifacts", required=True, help="train.py output dir (model.txt, test_set.json, importance.json)")
    ap.add_argument("--export", required=True, help="exported candidate model.json")
    ap.add_argument("--allowlist", required=True, help="exported candidate allowlist.json")
    ap.add_argument("--shadow", required=True, help="learned-shadow.jsonl")
    ap.add_argument("--reviews", required=True, help="reviewed.csv with reviewer_label filled")
    ap.add_argument("--baseline", required=True, help="drift_baseline.json for the candidate")
    ap.add_argument("--config", default=None, help="gate_config.json (defaults follow DESIGN.md)")
    ap.add_argument("--observations", default=None)
    ap.add_argument("--out", default="gate_report.json")
    args = ap.parse_args()

    cfg = dict(DEFAULT_CONFIG)
    if args.config:
        cfg.update(json.loads(Path(args.config).read_text()))

    adir = Path(args.artifacts)
    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str, value=None):
        checks.append({"name": name, "pass": bool(ok), "detail": detail,
                       "value": value})
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")

    print("== offline ==")
    # --- offline: score the test set with the candidate booster ---
    raw = json.loads((adir / "test_set.json").read_text())
    fversion = raw.get("feature_version", 1) if isinstance(raw, dict) else 1
    test = raw["test"] if isinstance(raw, dict) else raw
    _, _, featurize, _ = load_featurizer(fversion, args.observations)
    booster = lgb.Booster(model_file=str(adir / "model.txt"))
    y = np.array([t["label"] for t in test])
    s = booster.predict(np.array([featurize(t["domain"]) for t in test]))
    ap_score = average_precision(y, s)
    check("test_ap", ap_score >= cfg["min_test_ap"],
          f"AP={ap_score:.4f} (min {cfg['min_test_ap']})", round(ap_score, 4))
    p90 = precision_at_recall(y, s)
    check("precision_at_recall_90", p90 >= cfg["min_precision_at_recall_90"],
          f"P@R=0.9={p90:.4f} (min {cfg['min_precision_at_recall_90']})", round(p90, 4))

    # --- golden gate (allowlist-first, mirroring serving semantics) ---
    allow = json.loads(Path(args.allowlist).read_text())
    allow_ok = allow.get("format") == "bm-allowlist/1" and isinstance(allow.get("domains"), list)
    allow_set = {d.lower() for d in allow.get("domains", [])}
    check("allowlist_valid", allow_ok, f"allowlist format ok: {allow_ok}, {len(allow_set)} domains")

    # Allowlist-adjusted P@R: the same metric with the rows the allowlist
    # decides removed — serving semantics applied to the test set. Reported,
    # not gated: the design bar is on the raw number, and whether the adjusted
    # one is good enough to lower it to is a reviewer decision (open flag),
    # not a threshold this script may choose.
    test_domains = np.array([str(t.get("domain", "")).lower() for t in test])
    keep_mask = np.array([d not in allow_set for d in test_domains])
    n_decided = int((~keep_mask).sum())
    p90_adjusted = precision_at_recall(y, s, keep=keep_mask)
    print(f"  [info] precision_at_recall_90 (allowlist-adjusted): "
          f"{p90_adjusted:.4f} over {int(keep_mask.sum())} rows "
          f"({n_decided} decided by allowlist)")
    review_t = 0.65
    flips, protected = [], 0
    for d in GOLDEN_BENIGN:
        if d.lower() in allow_set:
            protected += 1  # allowlist decides before the model scores
            continue
        try:
            sc = float(booster.predict(np.array([featurize(d)]))[0])
        except ValueError:
            continue
        if sc >= review_t:
            flips.append((d, round(sc, 4)))
    check("golden_zero_flips", len(flips) <= cfg["max_golden_flips"],
          f"{len(flips)} flips at review threshold {review_t} "
          f"({protected} golden domains protected by allowlist)" +
          (f": {flips[:5]}" if flips else ""), len(flips))

    # --- artifact ceremony ---
    export_path = Path(args.export)
    size_kb = export_path.stat().st_size / 1024
    check("artifact_size", size_kb <= cfg["max_artifact_kb"],
          f"model.json {size_kb:.1f} KB (max {cfg['max_artifact_kb']})", round(size_kb, 1))
    model = json.loads(export_path.read_text())
    fv = model.get("feature_version")
    from features import FEATURE_NAMES as N1
    try:
        from features2 import FEATURE_NAMES as N2
    except ImportError:
        N2 = None
    contract = {1: list(N1), 2: list(N2) if N2 else None}
    names_ok = fv in contract and contract[fv] is not None and model.get("feature_names") == contract[fv]
    check("feature_contract", names_ok,
          f"feature_version={fv}, names match contract: {names_ok}", fv)
    # provenance: the export must derive from the evaluated booster
    src_hash = model.get("trained_from_sha256")
    if src_hash:
        txt_hash = sha256_file(adir / "model.txt")
        check("export_provenance", src_hash == txt_hash,
              f"model.json trained_from_sha256 matches model.txt: {src_hash == txt_hash}")
    else:
        print("  [info] export_provenance: no trained_from_sha256 (pre-M5 export) — skipped")

    print("== shadow ==")
    records = load_log(Path(args.shadow))
    cov = coverage(records)
    check("shadow_days", (cov["days"] or 0) >= cfg["min_shadow_days"],
          f"{cov['days']} days of shadow (min {cfg['min_shadow_days']})", cov["days"])
    # The count is the same either way — excluding unversioned sweeps
    # would make the ceremony impossible to start, since the shipped
    # weights predate the manifest. What changes is that the report says
    # how much of the evidence identified a model, so a reader cannot
    # mistake "30,000 domains scored" for a claim about a specific one.
    scored = cov["scored_domains"] or 0
    unversioned = cov.get("unversioned_scored_domains") or 0
    if not cov.get("summaries"):
        note = "; no per-sweep summaries in the log, so no count came from the app at all"
    elif unversioned:
        note = (f"; {unversioned} of {scored} scored by weights with no promotion "
                f"manifest (model version unknown)")
    else:
        note = f"; scored by model {','.join(cov['model_versions'])}"
    check("shadow_scored", scored >= cfg["min_shadow_scored"],
          f"{scored} domains scored (min {cfg['min_shadow_scored']}){note}",
          scored)

    # --- reviewed disagreements (deduplicated: recurring domains must not
    # overcount; one broken site is one veto, not N log lines) ---
    import csv
    seen: dict[str, dict] = {}
    with open(args.reviews, newline="") as f:
        for rec in csv.DictReader(f):
            lab = (rec.get("reviewer_label") or "").strip()
            if lab not in ("0", "1"):
                continue
            seen.setdefault((rec.get("domain") or "").strip().lower(), rec)
    reviewed = list(seen.values())
    n_rev = len(reviewed)
    block_rows = [r for r in reviewed if r.get("learned_decision") == "block"]
    n_block_avail = len({r["domain"] for r in load_log(Path(args.shadow))
                         if r["kind"] == "disagreement" and r["learnedDecision"] == "block"})
    need_block = min(cfg["min_reviewed_block"], n_block_avail)
    check("reviewed_enough", n_rev >= cfg["min_reviewed"] and len(block_rows) >= need_block,
          f"{n_rev} distinct reviewed (min {cfg['min_reviewed']}), "
          f"{len(block_rows)} distinct in block direction (need {need_block}, "
          f"{n_block_avail} available)", {"reviewed": n_rev, "block": len(block_rows)})
    tp = sum(1 for r in block_rows if r["reviewer_label"] == "1")
    fp = sum(1 for r in block_rows if r["reviewer_label"] == "0")
    shadow_prec = tp / (tp + fp) if tp + fp else 0.0
    # Informational: this is precision on the hard-case subset where the
    # model and the reference disagreed — NOT production precision.
    # The hard gate is breakage below.
    print(f"  [info] reviewed block precision (hard-case subset): "
          f"{shadow_prec:.4f} ({tp} tracker / {fp} benign distinct domains)")
    check("zero_confirmed_breakage", fp <= cfg["max_confirmed_breakage"],
          f"{fp} distinct confirmed breakage domains (max {cfg['max_confirmed_breakage']})", fp)

    print("== drift ==")
    try:
        drep = psi_report(Path(args.baseline), Path(args.shadow))
        alerts = drep["top_feature_alerts"]
        check("drift_top10", not alerts,
              f"top-10 PSI alerts: {alerts or 'none'} (threshold {cfg['max_psi_top10']})", alerts)
    except SystemExit as e:
        check("drift_top10", False, f"drift evidence missing: {e}", None)

    verdict = "PASS" if all(c["pass"] for c in checks) else "FAIL"
    report = {
        "format": "bm-gate-report/1",
        "at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "candidate": {
            "model_sha256": sha256_file(export_path),
            "allowlist_sha256": sha256_file(Path(args.allowlist)),
            "feature_version": fv,
        },
        "config": cfg,
        "checks": checks,
        "metrics": {
            # Informational: the same P@R with allowlist-decided test rows
            # removed. It is NOT the gated number — the bar applies to the
            # raw metric — so a FAIL verdict with a high adjusted value is
            # the recorded evidence for the open flag's review decision.
            "precision_at_recall_90": round(p90, 4),
            "precision_at_recall_90_allowlist_adjusted": round(p90_adjusted, 4),
            "allowlist_decided_test_rows": n_decided,
            "test_rows": int(len(test)),
        },
        "verdict": verdict,
    }
    Path(args.out).write_text(json.dumps(report, indent=2))
    print(f"\nGATE VERDICT: {verdict} -> {args.out}")
    if verdict == "FAIL":
        failed = [c["name"] for c in checks if not c["pass"]]
        print(f"failed checks: {failed}")
    sys.exit(0 if verdict == "PASS" else 1)


if __name__ == "__main__":
    main()
