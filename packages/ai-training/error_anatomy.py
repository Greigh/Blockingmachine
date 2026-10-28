"""Error anatomy + size/quality sweep for flag 43 (analysis only, no artifacts).

Part A: reproduce the gate's P@R=0.90 operating point on the current v3 test set,
enumerate the false positives there, and find the model's 0.99-precision ceiling.
Part B: retrain with smaller num_leaves to measure the artifact-size/quality
tradeoff — evidence for whether the 500 KB budget needs revising or a smaller
tree count is quality-free.
"""

import json
import sqlite3
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from train import PARAMS, load_featurizer, time_split, parse_ts  # noqa: E402
from golden import GOLDEN_BENIGN  # noqa: E402
from gate import precision_at_recall, average_precision  # noqa: E402
from export import convert_node  # noqa: E402

OBS = "observations-2026-09-29.db"
LIVE = "live_observations.db"
ART = Path("model_artifacts_v3")


def featurize_domains(featurize, domains):
    out = []
    for d in domains:
        try:
            out.append(featurize(d))
        except ValueError:
            out.append(None)
    return out


def op_point(y, s, target=0.90):
    """Return (best_prec, threshold) matching the gate's max-precision scan."""
    best, best_t = 0.0, None
    for t in np.unique(s):
        pred = s >= t
        tp = int(((pred == 1) & (y == 1)).sum())
        fp = int(((pred == 1) & (y == 0)).sum())
        fn = int(((pred == 0) & (y == 1)).sum())
        rec = tp / (tp + fn) if tp + fn else 0.0
        prec = tp / (tp + fp) if tp + fp else 1.0
        if rec >= target and prec > best:
            best, best_t = prec, t
    return best, best_t


def ceiling(y, s, pmin=0.99):
    """Highest recall reachable at precision >= pmin, and its threshold."""
    best, best_t = 0.0, None
    for t in np.unique(s):
        pred = s >= t
        tp = int(((pred == 1) & (y == 1)).sum())
        fp = int(((pred == 1) & (y == 0)).sum())
        fn = int(((pred == 0) & (y == 1)).sum())
        rec = tp / (tp + fn) if tp + fn else 0.0
        prec = tp / (tp + fp) if tp + fp else 1.0
        if prec >= pmin and rec > best:
            best, best_t = rec, t
    return best, best_t


def depth(d):
    return d.count(".") + 1


def main():
    _, fnames, featurize, _ = load_featurizer(3, OBS, LIVE)
    ts = json.load(open(ART / "test_set.json"))
    test = [(r["domain"], r["label"]) for r in ts["test"]]
    booster = lgb.Booster(model_file=str(ART / "model.txt"))

    print("== Part A: test-set error anatomy ==")
    X = np.array(featurize_domains(featurize, [d for d, _ in test]), dtype=float)
    y = np.array([l for _, l in test])
    s = booster.predict(X)
    n_pos, n_neg = int(y.sum()), int((1 - y).sum())
    print(f"test n={len(y)} pos={n_pos} neg={n_neg}  AP={average_precision(y, s):.4f}")

    p90, t90 = op_point(y, s)
    pred = s >= t90
    fp_idx = [i for i in range(len(y)) if pred[i] and y[i] == 0]
    fn_idx = [i for i in range(len(y)) if not pred[i] and y[i] == 1]
    tp = int(((pred) & (y == 1)).sum())
    print(f"op point (P@R>=0.90): threshold={t90:.4f} P={p90:.4f} "
          f"TP={tp} FP={len(fp_idx)} FN={len(fn_idx)}")
    need = tp / 0.99 - tp  # FP budget for P>=0.99 at this recall
    print(f"to reach P>=0.99 at this recall: FP <= {int(tp/0.99 - tp)} "
          f"(currently {len(fp_idx)} — must cut ~{len(fp_idx) - int(tp/0.99 - tp)})")

    c_rec, c_t = ceiling(y, s)
    print(f"0.99-precision ceiling: max recall {c_rec:.4f} at t={c_t} "
          f"(target is recall>=0.90)")
    for pmin in (0.95, 0.97, 0.98, 0.99):
        r, _ = ceiling(y, s, pmin)
        print(f"  recall ceiling at P>={pmin}: {r:.4f}")

    fp_doms = [test[i][0] for i in fp_idx]
    neg_doms = [d for d, l in test if l == 0]
    fp_depth = [depth(d) for d in fp_doms]
    neg_depth = [depth(d) for d in neg_doms]
    print(f"\nFP depth: mean={np.mean(fp_depth):.2f} median={np.median(fp_depth):.0f} "
          f"depth>=3: {np.mean([d >= 3 for d in fp_depth]):.0%} "
          f"(all test negs: mean={np.mean(neg_depth):.2f} "
          f"depth>=3 {np.mean([d >= 3 for d in neg_depth]):.0%})")
    fp_len = [len(d) for d in fp_doms]
    neg_len = [len(d) for d in neg_doms]
    print(f"FP len: mean={np.mean(fp_len):.1f} (all negs {np.mean(neg_len):.1f})")
    print(f"FP domains ({len(fp_doms)}):")
    for d, sc in sorted(zip(fp_doms, s[fp_idx]), key=lambda x: -x[1]):
        print(f"  {sc:.3f} depth={depth(d):2d} {d}")
    Path("test_fps.json").write_text(json.dumps([
        {"domain": d, "score": round(float(sc), 6),
         "label_depth": depth(d), "len": len(d)}
        for d, sc in sorted(zip(fp_doms, s[fp_idx]), key=lambda x: -x[1])
    ], indent=1))
    print("-> test_fps.json (corpus negatives the model over-ranks; review evidence)")

    print("\n== Part B: num_leaves size/quality sweep ==")
    con = sqlite3.connect("labels.db")
    rows = con.execute("SELECT domain, label, weight, observed_at FROM labels").fetchall()
    con.close()
    golden = set(GOLDEN_BENIGN)
    rows = [r for r in rows if r[0] not in golden]

    domains_all = [r[0] for r in rows]
    print(f"featurizing {len(domains_all)} pool domains once…", flush=True)
    X_all = featurize_domains(featurize, domains_all)
    items = [(d, l, w, parse_ts(ts_)) for (d, l, w, ts_), v in
             zip(rows, X_all) if v is not None]
    feats = {d: v for d, v in zip(domains_all, X_all) if v is not None}
    train, val, test_s, meta = time_split(items)
    print(f"split [{meta['method']}]: train={len(train)} val={len(val)} test={len(test_s)}")

    def ds(split):
        return lgb.Dataset(np.array([feats[x[0]] for x in split]),
                           label=np.array([x[1] for x in split]),
                           weight=np.array([x[2] for x in split]))

    n_neg = sum(1 for _, l, _ in train if l == 0)
    n_pos = sum(1 for _, l, _ in train if l == 1)

    test_y = np.array([x[1] for x in test_s])
    test_X = np.array([feats[x[0]] for x in test_s])

    print(f"{'leaves':>6} {'trees':>6} {'AP':>7} {'P@R0.9':>7} {'treesKB':>8}")
    for leaves in (15, 31, 63, 95):
        params = dict(PARAMS, num_leaves=leaves,
                      scale_pos_weight=n_neg / max(n_pos, 1))
        b = lgb.train(params, ds(train), num_boost_round=1000,
                      valid_sets=[ds(val)], valid_names=["val"],
                      callbacks=[lgb.early_stopping(50, verbose=False)])
        s_b = b.predict(test_X)
        dump = b.dump_model()
        trees = [convert_node(t["tree_structure"]) for t in dump["tree_info"]]
        kb = len(json.dumps(trees).encode()) / 1024
        ap = average_precision(test_y, s_b)
        p90_b, _ = op_point(test_y, s_b)
        print(f"{leaves:>6} {b.num_trees():>6} {ap:>7.4f} {p90_b:>7.4f} {kb:>8.1f}")


if __name__ == "__main__":
    main()
