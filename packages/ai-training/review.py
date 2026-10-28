"""Interactive review assistant for the flag-43 disagreement queue.

Builds the reviewable set — every distinct domain in the shadow log
(disagreements + samples) plus, optionally, the candidate's test-set false
positives (test_fps.json — the same "model over-blocks benign" population
from the corpus side) — then walks it family-by-family for human verdicts.

Each row written to reviewed.csv is re-scored against the *candidate*
booster, not the frozen shipped-weights log: learned_score/learned_decision
describe the model under evaluation, so zero_confirmed_breakage tracks the
candidate and a fixed model sheds inherited vetoes honestly.

Keys: 1 = tracker (model right to flag), 0 = benign, s = skip, q = save+quit.
Family prompts batch the verdict across the family's member domains; 'd'
drops into per-domain review.

--emit-labels merges verdicts into labels.db at gold weight 3.0 — the
reviewed infra names are exactly the deep-benign class the corpus lacks.
"""

import argparse
import csv
import json
import sqlite3
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from shadow import load_log  # noqa: E402
from train import load_featurizer  # noqa: E402
from labels import ingest_rows  # noqa: E402
from public_names import is_public_name  # noqa: E402

FIELDS = ["domain", "learned_score", "learned_decision", "reference_decision",
          "allowlisted", "at", "reviewer_label", "reviewer_notes"]

CSV_FIELDS = FIELDS  # gate.py reads this exact schema

FAMILY_OWNERS = {
    "apple.com": "Apple first-party services",
    "aaplimg.com": "Apple first-party services",
    "apple-dns.net": "Apple DNS/CDN",
    "akadns.net": "Akamai CDN edge",
    "akamai.net": "Akamai CDN edge",
    "googleapis.com": "Google APIs",
    "googleusercontent.com": "Google user content",
    "google.com": "Google first-party",
    "netflix.com": "Netflix streaming infra",
    "amazonaws.com": "AWS regional infra",
    "azure.com": "Azure infra",
    "codeium.com": "Codeium IDE telemetry",
    "brave.com": "Brave browser services",
    "roku.com": "Roku device services",
    "tiktokv.us": "TikTok CDN",
    "tiktokcdn.com": "TikTok CDN",
    "tiktokcdn-us.com": "TikTok CDN",
    "ttcdn-us.com": "TikTok CDN",
    "quad9.net": "Quad9 public DNS",
    "conviva.com": "Conviva video analytics",
    "appsflyersdk.com": "AppsFlyer attribution SDK",
    "app-analytics-services.com": "Amazon app analytics",
    "gitkraken.dev": "GitKraken IDE services",
    "minerva.devices.a2z.com": "Amazon devices",
}


def family(domain: str) -> str:
    """Registrable-domain approximation (last two labels) for grouping."""
    parts = domain.rstrip(".").split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else domain


def decision(score: float, block_t: float, review_t: float) -> str:
    if score >= block_t:
        return "block"
    if score >= review_t:
        return "review"
    return "allow"


def build_population(args, featurize, booster, block_t, review_t) -> list[dict]:
    """Rows: domain + candidate score/decision + reference verdict + context."""
    rows: dict[str, dict] = {}

    # Population 1: every distinct domain the shadow log recorded.
    if args.log:
        for r in load_log(Path(args.log)):
            # L10: store/compare the normalized lowercase spelling — raw log
            # casing must not create duplicate review rows or label writes.
            d = (r.get("domain") or "").strip().lower().rstrip(".")
            if not d or d in rows:
                continue
            rows[d] = {
                "domain": d,
                "reference_decision": r.get("referenceDecision", "allow"),
                "allowlisted": bool(r.get("allowlisted", False)),
                "at": r.get("at", ""),
                "kind": r["kind"],
                "logged_learned": r.get("learnedDecision"),
                "logged_score": r.get("learnedScore"),
            }

    # Population 2: candidate's test-set FPs — corpus negatives it blocks.
    if args.fps:
        fps = json.loads(Path(args.fps).read_text())
        for rec in fps[: args.fps_limit]:
            d = (rec["domain"] or "").strip().lower().rstrip(".")
            if not d or d in rows:
                continue
            rows[d] = {
                "domain": d,
                "reference_decision": "allow",  # corpus negative
                "allowlisted": False,
                "at": "",
                "kind": "test_fp",
                "logged_learned": None,
                "logged_score": None,
            }

    # Population 3: held-out negatives in the candidate's suspicion zone —
    # "is the model about to over-flag this benign domain?" is exactly the
    # question the review exists to answer, and the gate's review floor
    # needs more rows than the log alone holds.
    if args.suspect_min:
        import sqlite3 as _s3
        from train import time_split, parse_ts
        from golden import GOLDEN_BENIGN
        con = _s3.connect(args.db)
        lbl_rows = con.execute("SELECT domain, label, weight, observed_at FROM labels").fetchall()
        con.close()
        golden = set(GOLDEN_BENIGN)
        items, feats = [], {}
        for d, l, w, t in lbl_rows:
            if d in golden:
                continue
            try:
                v = featurize(d)
            except ValueError:
                continue
            items.append((d, l, w, parse_ts(t)))
            feats[d] = v
        _, val, test, _ = time_split(items)
        held_neg = [x[0] for x in val + test if x[1] == 0]
        s_held = booster.predict(np.array([feats[d] for d in held_neg]))
        for d, sc in zip(held_neg, s_held):
            if sc >= args.suspect_min and d not in rows:
                rows[d] = {
                    "domain": d,
                    "reference_decision": "allow",
                    "allowlisted": False,
                    "at": "",
                    "kind": "suspect_neg",
                    "logged_learned": None,
                    "logged_score": None,
                }

    # Re-score every domain against the candidate — the row describes the
    # model under evaluation, not the frozen weights that wrote the log.
    for d, row in rows.items():
        try:
            s = float(booster.predict(np.array([featurize(d)]))[0])
        except ValueError:
            s = float("nan")
        row["learned_score"] = round(s, 4)
        row["learned_decision"] = decision(s, block_t, review_t)
    return list(rows.values())


def load_existing(path: Path) -> dict[str, dict]:
    """Resume support: any prior reviewed.csv rows with a verdict survive."""
    done: dict[str, dict] = {}
    if path.exists():
        for rec in csv.DictReader(open(path, newline="")):
            if (rec.get("reviewer_label") or "").strip() in ("0", "1"):
                done[rec["domain"].strip().lower()] = rec
    return done


def apply_verdict(row: dict, label: str, notes: str = "") -> dict:
    return {
        "domain": row["domain"],
        "learned_score": row["learned_score"],
        "learned_decision": row["learned_decision"],
        "reference_decision": row["reference_decision"],
        "allowlisted": row["allowlisted"],
        "at": row["at"],
        "reviewer_label": label,
        "reviewer_notes": notes,
    }


def hint_str(domain: str, hints: dict) -> str:
    """Ghostery consult hint — informs the human, never the verdict. A tilde
    marks a broad parent-domain listing (org attribution only); '—' means
    TrackerDB has no entry, which is unknown, NOT benign."""
    rec = hints.get(domain.lower())
    if not rec or not rec.get("category"):
        return "  g:—"
    s = f"  g:{rec['category']}/{rec.get('org') or rec.get('pattern') or '?'}"
    if rec.get("match_kind") == "domain_list":
        s += "~"
    return s


def interactive(rows: list[dict], done: dict[str, dict], out_path: Path, hints: dict) -> dict[str, dict]:
    # Group pending domains by family — the triage pass showed infra
    # families dominate, and a family verdict is one considered decision
    # applied to each member (each still gets its own CSV row).
    pending = [r for r in rows if r["domain"].lower() not in done]
    fams: dict[str, list[dict]] = {}
    for r in pending:
        fams.setdefault(family(r["domain"]), []).append(r)
    fams = dict(sorted(fams.items(), key=lambda kv: -len(kv[1])))

    print(f"{len(done)} already reviewed, {len(pending)} pending in {len(fams)} families")
    print("keys: 1 tracker · 0 benign · d detail/per-domain · s skip · q save+quit")
    if hints:
        print("g:<cat>/<org> = Ghostery TrackerDB consult hint (~ broad parent match, — unlisted ≠ benign)\n")
    else:
        print()
    quit_now = False
    for fam, members in fams.items():
        if quit_now:
            break
        hint = FAMILY_OWNERS.get(fam, "")
        members.sort(key=lambda r: -r["learned_score"])
        print(f"── {fam} ({len(members)}) {hint}")
        for m in members:
            logged = f" log:{m['logged_learned']}@{m['logged_score']}" if m["logged_learned"] else ""
            print(f"    {m['learned_score']:>6} {m['learned_decision']:>6} vs ref:{m['reference_decision']:<5} {m['domain']}{logged}{hint_str(m['domain'], hints)}")
        while True:
            k = input(f"{fam} > ").strip().lower()
            if k in ("1", "0"):
                for m in members:
                    done[m["domain"].lower()] = apply_verdict(m, k, f"family={fam}")
                print(f"    {len(members)} domains labeled {k}")
                break
            if k == "d":
                for m in members:
                    while True:
                        kd = input(f"    {m['domain']} [{m['learned_score']}] > ").strip().lower()
                        if kd in ("1", "0"):
                            done[m["domain"].lower()] = apply_verdict(m, kd)
                            break
                        if kd in ("s", "skip", ""):
                            break
                        if kd == "q":
                            quit_now = True
                            break
                        print("    1/0/s/q")
                    if quit_now:
                        break
                break
            if k in ("s", "skip", ""):
                break
            if k == "q":
                quit_now = True
                break
            print("    1/0/d/s/q")
    return done


def write_csv(done: dict[str, dict], out_path: Path) -> None:
    rows = sorted(done.values(), key=lambda r: (r["learned_decision"] != "block", -(r["learned_score"] or 0)))
    with open(out_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in CSV_FIELDS})
    n1 = sum(1 for r in rows if r["reviewer_label"] == "1")
    nblock = sum(1 for r in rows if r["learned_decision"] == "block")
    print(f"wrote {len(rows)} reviewed rows -> {out_path} "
          f"({n1} tracker / {len(rows) - n1} benign, {nblock} block-direction)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log", default=str(Path.home() / "Library/Application Support/Blockingmachine/learned-shadow.jsonl"))
    ap.add_argument("--fps", default="test_fps.json", help="candidate test-set FPs (error_anatomy.py)")
    ap.add_argument("--fps-limit", type=int, default=102)
    ap.add_argument("--suspect-min", type=float, default=0.3,
                    help="add held-out negatives the candidate scores >= this (0 disables)")
    ap.add_argument("--artifacts", default="model_artifacts_v3")
    ap.add_argument("--model", default="model_v3_experimental.json", help="for decision thresholds")
    ap.add_argument("--observations", default="observations-2026-09-29.db")
    ap.add_argument("--live-observations", default="live_observations.db")
    ap.add_argument("--out", default="reviewed.csv")
    ap.add_argument("--db", default="labels.db")
    ap.add_argument("--hints", default="ghostery_hints.json",
                    help="Ghostery TrackerDB consult cache (ghostery_hints.py) — display only, never labels")
    ap.add_argument("--emit-labels", action="store_true",
                    help="merge verdicts into labels.db at gold weight 3.0 (source=review)")
    ap.add_argument("--stats", action="store_true", help="print population summary and exit")
    ap.add_argument("--auto", default="",
                    help="pre-fill verdicts: 'family=0,other=1 domain.com=0' — user-asserted, still human review")
    args = ap.parse_args()

    model = json.loads(Path(args.model).read_text())
    block_t = model.get("thresholds", {}).get("block", 0.92)
    review_t = model.get("thresholds", {}).get("review", 0.65)
    _, _, featurize, _ = load_featurizer(3, args.observations, args.live_observations)
    booster = lgb.Booster(model_file=str(Path(args.artifacts) / "model.txt"))

    rows = build_population(args, featurize, booster, block_t, review_t)
    print(f"reviewable population: {len(rows)} distinct domains "
          f"({sum(1 for r in rows if r['kind'] in ('disagreement', 'sample'))} shadow log, "
          f"{sum(1 for r in rows if r['kind'] == 'test_fp')} test FPs, "
          f"{sum(1 for r in rows if r['kind'] == 'suspect_neg')} suspicion-zone negs)")

    if args.stats:
        from collections import Counter
        print(Counter((r["learned_decision"], r["reference_decision"], r["kind"]) for r in rows))
        return

    done = load_existing(Path(args.out))
    # Refresh candidate-side fields on prior verdicts — the reviewer_label is
    # about the domain (reusable), but learned_score/learned_decision must
    # describe the candidate under evaluation, or a fixed model inherits
    # stale block rows it no longer commits.
    by_domain = {r["domain"].lower(): r for r in rows}
    for key, rec in done.items():
        fresh = by_domain.get(key)
        if fresh:
            rec["learned_score"] = fresh["learned_score"]
            rec["learned_decision"] = fresh["learned_decision"]
            rec["reference_decision"] = fresh["reference_decision"]
        else:
            # Verdict fell out of the rebuilt population — it is still
            # evidence, so re-score the domain against this candidate
            # directly rather than carry the previous model's stale
            # learned_* into the gate's reviewed.csv.
            try:
                s = float(booster.predict(np.array([featurize(rec["domain"])]))[0])
            except ValueError:
                s = float("nan")
            rec["learned_score"] = round(s, 4)
            rec["learned_decision"] = decision(s, block_t, review_t)

    # --auto: pre-asserted family/domain verdicts (the human typed them).
    for spec in args.auto.split():
        if "=" not in spec:
            continue
        key, _, val = spec.partition("=")
        key, val = key.strip().lower(), val.strip()
        if val not in ("0", "1"):
            continue
        for r in rows:
            if r["domain"].lower() == key or family(r["domain"]) == key:
                done[r["domain"].lower()] = apply_verdict(r, val, f"auto:{spec}")

    hint_path = Path(args.hints)
    hints = json.loads(hint_path.read_text()) if hint_path.exists() else {}
    done = interactive(rows, done, Path(args.out), hints)
    write_csv(done, Path(args.out))

    if args.emit_labels:
        labelled = [(r["domain"], int(r["reviewer_label"]))
                    for r in done.values() if is_public_name(r["domain"])]
        ingest_rows(Path(args.db), [(d, l, "review", 3.0) for d, l in labelled])
        print(f"merged {len(labelled)} verdicts into {args.db} (source=review, weight=3.0)")


if __name__ == "__main__":
    main()
