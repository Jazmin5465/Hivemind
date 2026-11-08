"""Write a readable report of how the trained LightGBM detector decides.

    python ml/eval/model_report.py                       # writes docs/MODEL_REPORT.md
    python ml/eval/model_report.py --depth 5 --out report.md

Sections:
  1. What the model is (trees, classes, inputs)
  2. What it relies on: gain importance per class
  3. Real trees from the model, printed as if/then rules (exact, but only the top levels)
  4. A short rule set that imitates the whole model (a shallow decision tree trained on the
     model's own predictions), with how often it agrees with the model

The rule set in section 4 is an APPROXIMATION of the model, not the model. Section 3 shows
real splits. The full model is ml/model/lgbm.txt.

Data: the surrogate is trained on the synthetic training table (never the real folders) and
its agreement is measured on held-out synthetic weeks and on the real full_week. The real
week's answer key is read only to report accuracy.
"""
import argparse
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml"))
from features import CLASSES, build_features, build_labels  # noqa: E402
from loader import load  # noqa: E402

NICE_CLASS = {"normal": "normal", "pipeline_leak": "LEAK", "pump_degradation": "WORN PUMP", "pump_failure": "PUMP FAILURE"}
WIN = {"30m": "30 min", "2h": "2 h", "6h": "6 h", "24h": "24 h"}


# ------------------------------------------------------------------ readable names and values
def nice(name):
    """Plain-English name of a model input."""
    fixed = {
        "pump_status": "pump status (0 stopped, 1 running, 2 fault)",
        "pump_fault": "pump reports a fault (1 yes, 0 no)",
        "pump_running": "pump running (1 yes, 0 no)",
        "status_hours": "hours in the current pump status",
        "level_pct": "tank level (%)",
        "level_to_limit": "points below the shutdown limit",
        "level_to_warning": "points below the warning limit",
        "level_noise": "tank level reading jitter",
        "well_frac_now": "well water now (fraction of baseline)",
        "wells_on_frac": "share of wells producing",
        "wells_on_frac_6h": "lowest share of wells producing over 6 h",
        "ratio_std_2h": "variation of received/pumped flow over 2 h",
        "off_press_dev_2h": "pipeline pressure vs disposal pressure while the pump is off (psi)",
        "loss_pipe_vs_pump": "pump flow minus received flow (fraction)",
    }
    if name in fixed:
        return fixed[name]
    parts = name.split("_")
    fam = {"flow": "pump flow (fraction of rated)", "ratio": "received/pumped flow",
           "pipe": "pipeline pressure vs normal (psi)", "dis": "discharge pressure vs normal (psi)",
           "level": "tank level"}.get(parts[0], parts[0])
    if name.endswith("_age_h"):
        return f"hours since the pump last ran ({fam.split(' (')[0]} reading age)"
    if parts[0] == "level" and parts[1] == "slope":
        return f"tank level change per hour over {WIN[parts[2]]}"
    if "_mean_" in name:
        return f"{fam}, {WIN[parts[-1]]} average"
    if "_chg_" in name:
        return f"{fam}, change vs previous {WIN[parts[-1]]}"
    if name.endswith("_carried"):
        return f"{fam}, last 2 h of running"
    if name.endswith("_min_6h"):
        return f"{fam}, lowest 6 h average"
    return name


def fmt(name, v):
    """Threshold in the feature's own units."""
    if name in ("pump_status",):
        return f"{v:g}"
    if name.endswith("_age_h") or name == "status_hours":
        return f"{v:.2f} h"
    if name.startswith(("pipe", "dis", "off_press")):
        return f"{v:+.1f} psi"
    if name.startswith(("flow", "ratio", "well", "loss_")) and not name.startswith("ratio_std"):
        return f"{v:.1%}"
    if name.startswith("level_slope"):
        return f"{v:+.2f} pts/h"
    return f"{v:.3g}"


# ------------------------------------------------------------------ section 2: importance
def importance(booster, features):
    df = booster.trees_to_dataframe()
    df["cls"] = df["tree_index"] % len(CLASSES)
    out = {}
    for c, cname in enumerate(CLASSES):
        g = df[df.cls == c].groupby("split_feature").agg(gain=("split_gain", "sum"), splits=("split_gain", "size"))
        g["share"] = g["gain"] / g["gain"].sum()
        out[cname] = g.sort_values("gain", ascending=False)
    return df, out


# ------------------------------------------------------------------ section 3: real trees
def tree_rules(df, tree_index, max_depth):
    t = df[df.tree_index == tree_index].set_index("node_index")
    root = t[t["node_depth"] == 1].index[0]
    lines = []

    def walk(node, depth, indent):
        r = t.loc[node]
        if not isinstance(r["split_feature"], str):
            lines.append(f"{indent}-> score {r['value']:+.3f}")
            return
        if depth > max_depth:
            lines.append(f"{indent}-> ... ({int(r['count']):,} training rows reach here; deeper splits omitted)")
            return
        f, thr = r["split_feature"], r["threshold"]
        miss = "left" if r["missing_direction"] == "left" else "right"
        lines.append(f"{indent}if {nice(f)} <= {fmt(f, thr)}:   [{f}; missing values go {'here' if miss == 'left' else 'to else'}]")
        walk(r["left_child"], depth + 1, indent + "    ")
        lines.append(f"{indent}else:")
        walk(r["right_child"], depth + 1, indent + "    ")

    walk(root, 1, "")
    return lines


# ------------------------------------------------------------------ section 4: surrogate rules
def surrogate(booster, meta, train_path, real_dir, depth, sample, seed):
    from sklearn.tree import DecisionTreeClassifier

    feats = meta["features"]
    T = pd.read_pickle(train_path)
    weeks = np.array(sorted(T["week"].unique()))
    rng = np.random.default_rng(seed)
    hold = set(rng.choice(weeks, max(1, len(weeks) // 5), replace=False))
    tr, ho = T[~T["week"].isin(hold)], T[T["week"].isin(hold)]
    if len(tr) > sample:
        tr = tr.sample(sample, random_state=seed)

    def teacher(X):
        return booster.predict(X[feats], num_iteration=meta["bestIteration"]).argmax(1)

    Xtr = tr[feats].astype("float32")
    ytr = teacher(Xtr)
    # NaN means "no recent running reading": encode as a value no real feature takes
    fill = -999.0
    clf = DecisionTreeClassifier(max_depth=depth, class_weight="balanced", min_samples_leaf=200, random_state=seed)
    clf.fit(Xtr.fillna(fill), ytr)

    def agreement(X, y_true=None):
        X = X[feats].astype("float32")
        t = teacher(X)
        s = clf.predict(X.fillna(fill))
        res = {"rows": len(X), "agree": float((s == t).mean()),
               "per_class": {CLASSES[c]: float((s[t == c] == c).mean()) if (t == c).any() else None for c in range(4)}}
        if y_true is not None:
            res["rules_acc"] = float((s == y_true).mean())
            res["model_acc"] = float((t == y_true).mean())
        return res

    ag_ho = agreement(ho)
    ds = load(real_dir)
    R = build_features(ds.wide, ds.network)
    key_path = Path(real_dir) / "answer_key.json"
    y = None
    if key_path.exists():
        y, _, _ = build_labels(R, json.loads(key_path.read_text()))
    ag_real = agreement(R, y)
    return clf, feats, fill, ag_ho, ag_real, len(tr)


def surrogate_rules(clf, feats, fill):
    tr = clf.tree_
    lines = []

    def walk(n, indent):
        if tr.children_left[n] == -1:
            counts = tr.value[n][0]
            c = int(np.argmax(counts))
            share = counts[c] / counts.sum()
            lines.append(f"{indent}-> {NICE_CLASS[CLASSES[c]]}  ({share:.0%} of the model's calls here)")
            return
        f = feats[tr.feature[n]]
        thr = tr.threshold[n]
        if thr < fill / 2:          # split separates "no reading" from real values
            lines.append(f"{indent}if {nice(f)} has no recent reading (pump has not run):")
        else:
            lines.append(f"{indent}if {nice(f)} <= {fmt(f, thr)}:")
        walk(tr.children_left[n], indent + "    ")
        lines.append(f"{indent}else:")
        walk(tr.children_right[n], indent + "    ")

    walk(0, "")
    return lines


# ------------------------------------------------------------------ report
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(ROOT / "ml" / "model"))
    ap.add_argument("--features", default=str(ROOT.parent / "data" / "train_features.pkl"),
                    help="synthetic training table from ml/build_dataset.py")
    ap.add_argument("--real", default=str(ROOT / "data" / "eog" / "full_week"))
    ap.add_argument("--out", default=str(ROOT / "docs" / "MODEL_REPORT.md"))
    ap.add_argument("--depth", type=int, default=4, help="depth of the imitation rule set")
    ap.add_argument("--tree-depth", type=int, default=3, help="levels shown for each real tree")
    ap.add_argument("--sample", type=int, default=300_000)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()

    meta = json.loads((Path(a.model) / "meta.json").read_text())
    booster = lgb.Booster(model_file=str(Path(a.model) / "lgbm.txt"))
    df, imp = importance(booster, meta["features"])
    n_trees = df["tree_index"].nunique()
    n_splits = int(df["split_feature"].notna().sum())
    L = []
    w = L.append

    w("# How the detector decides\n")
    w(f"Generated by `ml/eval/model_report.py` for model `{meta['modelVersion']}`.\n")
    w("## 1. What the model is\n")
    w(f"- **LightGBM**, a gradient-boosted tree model: **{n_trees} decision trees** "
      f"({n_trees // len(CLASSES)} rounds x {len(CLASSES)} classes) with **{n_splits:,} split rules** in total.")
    w(f"- **Classes:** {', '.join(CLASSES)}.")
    w(f"- **Inputs:** {len(meta['features'])} numbers per facility per 5-minute step (see `ml/features.py`).")
    w("- **How a prediction is made:** for each class, every tree for that class asks a few yes/no questions about "
      "the inputs and lands on a leaf with a score. The scores of all trees for a class are added up, and the four "
      "totals are turned into probabilities (softmax). There are no per-input weights as in a linear model: the "
      "trees and their thresholds are the model.")
    w(f"- **Trained on:** {meta['trainedOn']}.")
    w("- **The exact model** is the plain-text file `ml/model/lgbm.txt`: every tree, threshold and leaf score.\n")

    w("## 2. What it relies on\n")
    w("Share of each class's total *gain* (how much the splits on an input improved the model while training). "
      "Higher means the model leans on that input more for that class.\n")
    for cname, g in imp.items():
        w(f"### {NICE_CLASS[cname].capitalize() if cname == 'normal' else NICE_CLASS[cname]} (`{cname}`)\n")
        w("| Input | Meaning | Share of gain | Splits |")
        w("|---|---|---|---|")
        for f, r in g.head(8).iterrows():
            w(f"| `{f}` | {nice(f)} | {r['share']:.1%} | {int(r['splits'])} |")
        w("")

    w("## 3. Real trees from the model\n")
    w(f"The first tree of each class (round 1, usually the most influential), top {a.tree_depth} levels. "
      "These are the model's actual splits. A leaf's score is added to that class's total; every later tree "
      "adds a smaller correction. Compare a tree's leaves with each other: the first tree also carries the "
      "class's starting value (how common the class is), so all its leaves can be negative and the higher one "
      "still means *more likely*. For example, in the failure tree a fault (`pump_status` > 1.5) scores higher "
      "than no fault.\n")
    for c, cname in enumerate(CLASSES):
        w(f"### {cname} (tree {c})\n")
        w("```")
        L.extend(tree_rules(df, c, a.tree_depth))
        w("```\n")

    print("training the imitation rule set ...", flush=True)
    clf, feats, fill, ag_ho, ag_real, n_tr = surrogate(booster, meta, a.features, a.real, a.depth, a.sample, a.seed)
    w(f"## 4. A short rule set that imitates the model\n")
    w(f"A single decision tree, **{a.depth} levels deep**, trained to copy the model's own calls on {n_tr:,} rows of "
      "the synthetic training data (real data never used). It is much easier to read than 444 trees, but it is an "
      "**approximation**: the table shows how often it makes the same call as the real model.\n")
    w("| Data | Rows | Same call as the model | normal | leak | worn pump | failure |")
    w("|---|---|---|---|---|---|---|")
    for label, ag in [("Held-out synthetic weeks", ag_ho), ("Real full_week", ag_real)]:
        pc = ag["per_class"]
        cells = " | ".join("n/a" if pc[c] is None else f"{pc[c]:.1%}" for c in CLASSES)
        w(f"| {label} | {ag['rows']:,} | **{ag['agree']:.1%}** | {cells} |")
    w("\nThe per-class columns read: of the steps where the model called that class, the share where the rules "
      "called it too.\n")
    if "rules_acc" in ag_real:
        w(f"Against the real week's answer key (one row per facility per step): the full model is right "
          f"**{ag_real['model_acc']:.1%}** of the time, these rules **{ag_real['rules_acc']:.1%}**.\n")
    w("```")
    L.extend(surrogate_rules(clf, feats, fill))
    w("```\n")
    w("How to read it: start at the top, follow `if` when the condition is true and `else` when it is false, and "
      "stop at an arrow. The percentage is how often the model itself made that call for the training rows that "
      "end there.\n")

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(L), encoding="utf-8")
    print(f"wrote {out}")
    print(f"imitation rules agree with the model: {ag_ho['agree']:.1%} (held-out synthetic), {ag_real['agree']:.1%} (real full_week)")


if __name__ == "__main__":
    main()
