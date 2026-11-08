"""Generate N synthetic weeks and write one training table of features + labels.

    python src/build_dataset.py --n 200 --seed 1000 --out data/train_features.pkl

Columns: ts_unix, facility, system (metadata), the model features, then
label (0 normal, 1 pipeline_leak, 2 pump_degradation, 3 pump_failure),
event_id, hours_since_onset, week (the group for week-based train/validation splits).
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from features import CLASSES, build_features, build_labels
from gen_data import make_week


def week_table(seed):
    net, ops, tele, labels = make_week(seed)
    W = tele.pivot_table(index="ts_unix", columns=["asset_id", "metric"], values="value", aggfunc="last")
    W.columns = [f"{a}|{m}" for a, m in W.columns]
    F = build_features(W.sort_index(), net)
    cls, eid, since = build_labels(F, labels)
    F["label"], F["event_id"], F["hours_since_onset"] = cls, eid, since
    F["week"] = seed
    f64 = F.select_dtypes("float64").columns.difference(["ts_unix"])
    F[f64] = F[f64].astype("float32")      # halves memory; plenty of precision for the model
    return F


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--seed", type=int, default=1000)
    ap.add_argument("--out", default="data/train_features.pkl")
    a = ap.parse_args()
    parts = []
    for i in range(a.n):
        parts.append(week_table(a.seed + i))
        if (i + 1) % 10 == 0 or i + 1 == a.n:
            print(f"{i + 1}/{a.n} weeks", flush=True)
    T = pd.concat(parts, ignore_index=True)
    T.to_pickle(a.out)
    print(T.shape, "rows x cols;", "class counts:",
          {CLASSES[k]: int(v) for k, v in T["label"].value_counts().sort_index().items()})
