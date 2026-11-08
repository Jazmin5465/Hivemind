"""Train the LightGBM detector on SYNTHETIC weeks only.

    python ml/train.py --features data/train_features.pkl --out ml/model

The real folders (full_week, snapshots, mock test, test/) are never read here. The
validation set is held-out synthetic WEEKS (split by week, not by row, because
neighbouring 5-minute rows are almost identical).

Writes <out>/lgbm.txt and <out>/meta.json (feature order, classes, version).
"""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from features import CLASSES, feature_columns

DROP = ["label", "event_id", "hours_since_onset", "week"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", default="data/train_features.pkl")
    ap.add_argument("--out", default="ml/model")
    ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument("--rounds", type=int, default=600)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()

    T = pd.read_pickle(a.features)
    cols = [c for c in feature_columns(T) if c not in DROP]
    weeks = np.array(sorted(T["week"].unique()))
    rng = np.random.default_rng(a.seed)
    val_weeks = set(rng.choice(weeks, max(1, int(len(weeks) * a.val_frac)), replace=False))
    is_val = T["week"].isin(val_weeks).values
    Xtr, ytr = T.loc[~is_val, cols], T.loc[~is_val, "label"].values
    Xva, yva = T.loc[is_val, cols], T.loc[is_val, "label"].values
    print(f"{len(cols)} features | train {len(Xtr):,} rows ({len(weeks) - len(val_weeks)} weeks) | "
          f"val {len(Xva):,} rows ({len(val_weeks)} weeks)")

    # mild class balancing (sqrt of inverse frequency): rare classes matter more than their row count
    freq = np.bincount(ytr, minlength=len(CLASSES)) / len(ytr)
    cw = (1.0 / np.sqrt(freq)); cw = cw / cw[0]
    w = cw[ytr]
    params = dict(objective="multiclass", num_class=len(CLASSES), learning_rate=0.05,
                  num_leaves=31, min_data_in_leaf=200, feature_fraction=0.8,
                  bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0,
                  num_threads=-1, verbose=-1, seed=a.seed)
    t = time.time()
    dtr = lgb.Dataset(Xtr, ytr, weight=w)
    dva = lgb.Dataset(Xva, yva, reference=dtr)
    model = lgb.train(params, dtr, a.rounds, valid_sets=[dva],
                      callbacks=[lgb.early_stopping(40), lgb.log_evaluation(50)])
    print(f"trained in {time.time() - t:.0f}s, best iteration {model.best_iteration}")

    P = model.predict(Xva, num_iteration=model.best_iteration)
    pred = P.argmax(1)
    from sklearn.metrics import confusion_matrix, precision_recall_fscore_support
    pr, rc, f1, _ = precision_recall_fscore_support(yva, pred, labels=range(len(CLASSES)), zero_division=0)
    print("\nValidation (held-out synthetic weeks), per-row, argmax:")
    for i, c in enumerate(CLASSES):
        print(f"  {c:18s} precision {pr[i]:.3f}  recall {rc[i]:.3f}  f1 {f1[i]:.3f}")
    print("confusion (rows=true, cols=pred):\n", confusion_matrix(yva, pred))

    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    model.save_model(str(out / "lgbm.txt"), num_iteration=model.best_iteration)
    h = hashlib.sha1((out / "lgbm.txt").read_bytes()).hexdigest()[:8]
    meta = {"modelVersion": f"lgbm-synth-{h}",
            "trainedOn": f"synthetic: {len(weeks)} simulated weeks ({len(weeks) - len(val_weeks)} train, "
                         f"{len(val_weeks)} validation), simulator calibrated on full_week",
            "classes": CLASSES, "features": cols, "bestIteration": int(model.best_iteration),
            "valPerClass": {c: {"precision": float(pr[i]), "recall": float(rc[i])} for i, c in enumerate(CLASSES)}}
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    print("saved", out, meta["modelVersion"])


if __name__ == "__main__":
    main()
