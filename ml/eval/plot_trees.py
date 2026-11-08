"""Draw the detector's trees as PNG images.

    python ml/eval/plot_trees.py                 # writes docs/model_trees/*.png
    python ml/eval/plot_trees.py --depth 5

One image per model output (normal, leak, worn pump, failure): the first tree the model
built for that class, which is usually its most influential one, drawn to --depth levels.
Plus decision_rules.png: a single shallow tree that imitates the whole model and ends in
the four outputs (an approximation; see docs/MODEL_REPORT.md for how often it agrees).

Each split box reads "<input> <= <threshold>": follow "yes" when true, "no" when false.
The full model is 444 trees; these are the readable top of it.
"""
import argparse
import json
import sys
import textwrap
from pathlib import Path

import lightgbm as lgb
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import to_rgba  # noqa: E402
import numpy as np  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from features import CLASSES  # noqa: E402
from model_report import fmt, nice, surrogate  # noqa: E402

TITLE = {"normal": "Normal", "pipeline_leak": "Pipeline leak", "pump_degradation": "Worn pump",
         "pump_failure": "Pump failure"}
COLOR = {"normal": "#2e7d32", "pipeline_leak": "#1565c0", "pump_degradation": "#ef6c00",
         "pump_failure": "#c62828"}
SPLIT_BG = "#f4f6f8"
CUT_BG = "#e0e0e0"


# ------------------------------------------------------------------ generic layout + drawing
class Node:
    def __init__(self, label, kind, color=None, edge=None):
        self.label, self.kind, self.color, self.edge = label, kind, color, edge
        self.children = []
        self.x = self.y = 0.0


def layout(root):
    """Leaves get consecutive x positions; parents sit above the middle of their children."""
    counter = [0]

    def walk(n, depth):
        n.y = -depth
        if not n.children:
            n.x = counter[0]
            counter[0] += 1
            return
        for c in n.children:
            walk(c, depth + 1)
        n.x = sum(c.x for c in n.children) / len(n.children)

    walk(root, 0)
    return counter[0]


def depth_of(n):
    return 1 + max((depth_of(c) for c in n.children), default=0)


def draw(root, title, subtitle, legend, out):
    n_leaves = layout(root)
    levels = depth_of(root)
    w = max(10, n_leaves * 2.3)
    h = max(5, levels * 1.9 + 1.4)
    fig, ax = plt.subplots(figsize=(w, h))
    ax.set_axis_off()

    def edges(n):
        for c in n.children:
            ax.plot([n.x, c.x], [n.y - 0.18, c.y + 0.22], color="#90a4ae", lw=1.3, zorder=1)
            ax.text((n.x + c.x) / 2, (n.y + c.y) / 2 + 0.02, c.edge, ha="center", va="center", fontsize=9,
                    color="#455a64", style="italic",
                    bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none"), zorder=2)
            edges(c)

    def boxes(n):
        if n.kind == "split":
            fc, ec, tc = SPLIT_BG, "#607d8b", "#212121"
        elif n.kind == "cut":
            fc, ec, tc = CUT_BG, "#9e9e9e", "#424242"
        else:
            fc, ec, tc = n.color, "#37474f", "white"
        ax.text(n.x, n.y, n.label, ha="center", va="center", fontsize=8.5, color=tc, zorder=3,
                linespacing=1.25, bbox=dict(boxstyle="round,pad=0.45", fc=fc, ec=ec, lw=1.1))
        for c in n.children:
            boxes(c)

    edges(root)
    boxes(root)
    ax.set_xlim(-0.8, n_leaves - 0.2)
    ax.set_ylim(-(levels - 1) - 0.7, 0.75)
    fig.suptitle(title, fontsize=15, fontweight="bold", y=0.995)
    ax.set_title(subtitle, fontsize=9.5, color="#455a64", pad=14)
    if legend:
        handles = [plt.Rectangle((0, 0), 1, 1, fc=c, ec="#37474f") for c, _ in legend]
        ax.legend(handles, [t for _, t in legend], loc="lower center", bbox_to_anchor=(0.5, -0.08),
                  ncol=len(legend), fontsize=8.5, frameon=False)
    fig.tight_layout()
    fig.savefig(out, dpi=140, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def wrap(s, width=24):
    return "\n".join(textwrap.wrap(s, width))


# ------------------------------------------------------------------ LightGBM trees
def lgb_tree(df, tree_index, cname, max_depth):
    t = df[df.tree_index == tree_index].set_index("node_index")
    root_id = t[t["node_depth"] == 1].index[0]
    leaves = t[t["split_feature"].isna()]["value"]
    lo, hi = float(leaves.min()), float(leaves.max())
    base = np.array(to_rgba(COLOR[cname]))

    def shade(v):
        # higher score = more likely this class = darker class colour
        a = 0.35 + 0.65 * ((v - lo) / (hi - lo) if hi > lo else 1.0)
        return tuple(base[:3] * a + (1 - a) * np.array([0.62, 0.66, 0.70])) + (1.0,)

    def build(node_id, depth, edge):
        r = t.loc[node_id]
        rows = int(r["count"]) if r["count"] == r["count"] else 0
        if not isinstance(r["split_feature"], str):
            n = Node(f"score {r['value']:+.3f}\n{rows:,} rows", "leaf", shade(r["value"]), edge)
            return n
        if depth > max_depth:
            return Node(f"deeper splits\n{rows:,} rows", "cut", None, edge)
        f, thr = r["split_feature"], r["threshold"]
        n = Node(wrap(f"{nice(f)} <= {fmt(f, thr)}") + f"\n[{f}]\n{rows:,} rows", "split", None, edge)
        n.children = [build(r["left_child"], depth + 1, "yes"), build(r["right_child"], depth + 1, "no")]
        return n

    return build(root_id, 1, None), lo, hi


# ------------------------------------------------------------------ imitation tree
def surrogate_tree(clf, feats, fill):
    tr = clf.tree_

    def build(i, edge):
        if tr.children_left[i] == -1:
            counts = tr.value[i][0]
            c = int(np.argmax(counts))
            share = counts[c] / counts.sum()
            cname = CLASSES[c]
            return Node(f"{TITLE[cname].upper()}\n{share:.0%} of the model's\ncalls here", "leaf", COLOR[cname], edge)
        f, thr = feats[tr.feature[i]], tr.threshold[i]
        text = f"{nice(f)} has no recent reading" if thr < fill / 2 else f"{nice(f)} <= {fmt(f, thr)}"
        n = Node(wrap(text) + f"\n[{f}]", "split", None, edge)
        n.children = [build(tr.children_left[i], "yes"), build(tr.children_right[i], "no")]
        return n

    return build(0, None)


# ------------------------------------------------------------------ three trees in a row
def short(f):
    """Compact input name for the side-by-side image."""
    fixed = {"pump_status": "Pump status", "pump_fault": "Pump fault", "pump_running": "Pump running",
             "ratio_std_2h": "Flow ratio wobble (2 h)", "loss_pipe_vs_pump": "Pump minus arriving flow",
             "level_to_limit": "Below shutdown limit", "level_to_warning": "Below warning limit"}
    if f in fixed:
        return fixed[f]
    p = f.split("_")
    fam = {"flow": "Pump flow", "ratio": "Water arriving / pumped", "pipe": "Pipeline pressure",
           "dis": "Discharge pressure", "level": "Tank level"}.get(p[0], p[0])
    if p[0] == "level" and p[1] == "slope":
        return f"Tank level change ({p[2]})"
    if f.endswith("_carried"):
        return f"{fam} (last 2 h running)"
    if f.endswith("_min_6h"):
        return f"{fam} (6 h low)"
    if "_mean_" in f:
        return f"{fam} ({p[-1]} avg)"
    if "_chg_" in f:
        return f"{fam} change ({p[-1]})"
    if f.endswith("_age_h"):
        return "Hours since pump ran"
    return f


def compact_tree(df, tree_index, cname, max_depth):
    t = df[df.tree_index == tree_index].set_index("node_index")
    root_id = t[t["node_depth"] == 1].index[0]
    leaves = t[t["split_feature"].isna()]["value"]
    lo, hi = float(leaves.min()), float(leaves.max())
    base = np.array(to_rgba(COLOR[cname]))

    def shade(v):
        a = 0.3 + 0.7 * ((v - lo) / (hi - lo) if hi > lo else 1.0)
        return tuple(base[:3] * a + (1 - a) * np.array([0.62, 0.66, 0.70])) + (1.0,)

    def build(node_id, depth, edge):
        r = t.loc[node_id]
        if not isinstance(r["split_feature"], str):
            return Node(f"{r['value']:+.2f}", "leaf", shade(r["value"]), edge)
        if depth > max_depth:
            return Node("more\nsplits", "cut", None, edge)
        f, thr = r["split_feature"], r["threshold"]
        val = "fault?" if f == "pump_status" and 1 < thr < 2 else f"<= {fmt(f, thr)}?"
        if f == "pump_status" and 1 < thr < 2:
            n = Node("Pump status\nnot a fault?", "split", None, edge)
        else:
            n = Node(wrap(short(f), 14) + "\n" + val, "split", None, edge)
        n.children = [build(r["left_child"], depth + 1, "yes"), build(r["right_child"], depth + 1, "no")]
        return n

    return build(root_id, 1, None)


def draw_row(df, depth, out, model_version):
    # the worn-pump tree gets one more level: its strongest leaf sits one level deeper
    panels = [(1, "pipeline_leak", depth), (2, "pump_degradation", depth + 1), (3, "pump_failure", depth)]
    roots = [(compact_tree(df, i, c, d), c) for i, c, d in panels]
    widths = [max(2, layout(r)) for r, _ in roots]
    levels = max(depth_of(r) for r, _ in roots)
    fig, axes = plt.subplots(1, 3, figsize=(sum(widths) * 1.05 + 1, levels * 1.35 + 1.4),
                             gridspec_kw={"width_ratios": widths})
    for ax, (root, cname), w in zip(axes, roots, widths):
        ax.set_axis_off()

        def edges(n):
            for c in n.children:
                ax.plot([n.x, c.x], [n.y - 0.2, c.y + 0.24], color="#90a4ae", lw=1.2, zorder=1)
                ax.text((n.x + c.x) / 2, (n.y + c.y) / 2, c.edge, ha="center", va="center", fontsize=8,
                        color="#455a64", style="italic", bbox=dict(boxstyle="round,pad=0.12", fc="white", ec="none"),
                        zorder=2)
                edges(c)

        def boxes(n):
            if n.kind == "split":
                fc, ec, tc = SPLIT_BG, "#607d8b", "#212121"
            elif n.kind == "cut":
                fc, ec, tc = CUT_BG, "#9e9e9e", "#424242"
            else:
                fc, ec, tc = n.color, "#37474f", "white"
            ax.text(n.x, n.y, n.label, ha="center", va="center", fontsize=9.5, color=tc, zorder=3, linespacing=1.15,
                    bbox=dict(boxstyle="round,pad=0.4", fc=fc, ec=ec, lw=1))
            for c in n.children:
                boxes(c)

        edges(root)
        boxes(root)
        ax.set_xlim(-0.75, w - 0.25)
        ax.set_ylim(-(levels - 1) - 0.6, 0.65)
        ax.set_title(TITLE[cname], fontsize=15, fontweight="bold", color=COLOR[cname], pad=8)
    fig.suptitle("How the detector starts deciding: its first tree for each problem", fontsize=16, fontweight="bold")
    fig.text(0.5, 0.005, f"Real splits from model {model_version}, top {depth} levels (worn pump {depth + 1}). Follow 'yes' when the "
             "condition is true. Coloured numbers are leaf scores: darker = more likely that problem. "
             "Each problem has 110 more trees adding smaller corrections.", ha="center", fontsize=10, color="#455a64")
    fig.tight_layout(rect=(0, 0.03, 1, 0.97))
    fig.savefig(out, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(ROOT / "ml" / "model"))
    ap.add_argument("--features", default=str(ROOT.parent / "data" / "train_features.pkl"))
    ap.add_argument("--real", default=str(ROOT / "data" / "eog" / "full_week"))
    ap.add_argument("--out-dir", default=str(ROOT / "docs" / "model_trees"))
    ap.add_argument("--depth", type=int, default=4, help="levels drawn for each model tree")
    ap.add_argument("--rules-depth", type=int, default=4, help="depth of the imitation tree")
    ap.add_argument("--no-rules", action="store_true", help="skip decision_rules.png (needs the training table)")
    ap.add_argument("--row-only", action="store_true", help="only write three_trees.png")
    ap.add_argument("--row-depth", type=int, default=3, help="levels per tree in three_trees.png")
    a = ap.parse_args()

    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    meta = json.loads((Path(a.model) / "meta.json").read_text())
    booster = lgb.Booster(model_file=str(Path(a.model) / "lgbm.txt"))
    df = booster.trees_to_dataframe()
    n_rounds = df["tree_index"].nunique() // len(CLASSES)

    written = []
    row = out / "three_trees.png"
    draw_row(df, a.row_depth, row, meta["modelVersion"])
    written.append(row)
    if a.row_only:
        print(f"wrote {row}")
        return
    for c, cname in enumerate(CLASSES):
        root, lo, hi = lgb_tree(df, c, cname, a.depth)
        path = out / f"tree_{cname}.png"
        draw(root,
             f"{TITLE[cname]}: first tree of {n_rounds} (model {meta['modelVersion']})",
             f"Real splits from the model, top {a.depth} levels. Follow 'yes' when the condition is true. "
             f"Leaf scores add to the '{cname}' total: darker = more likely {TITLE[cname].lower()} "
             f"(range {lo:+.2f} to {hi:+.2f}). Grey boxes have more splits below.",
             None, path)
        written.append(path)

    if not a.no_rules:
        print("training the imitation tree ...", flush=True)
        clf, feats, fill, ag_ho, ag_real, n_tr = surrogate(booster, meta, a.features, a.real, a.rules_depth, 300_000, 0)
        path = out / "decision_rules.png"
        draw(surrogate_tree(clf, feats, fill),
             "How the model picks an output: a short imitation of all 444 trees",
             f"A {a.rules_depth}-level tree trained to copy the model's calls. Same call as the model: "
             f"{ag_ho['agree']:.1%} on held-out synthetic weeks, {ag_real['agree']:.1%} on the real week. "
             "An approximation, not the model itself.",
             [(COLOR[c], TITLE[c]) for c in CLASSES], path)
        written.append(path)

    for p in written:
        print(f"wrote {p}")


if __name__ == "__main__":
    main()
