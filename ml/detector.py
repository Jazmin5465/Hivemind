"""Inference core shared by the HTTP service and the tests.

detect(dataset_dir, as_of)  -> per-asset per-step class probabilities
explain(dataset_dir, asset_id, category, onset_unix, as_of) -> top-3 drivers

Causality: the loader drops rows after `as_of` first, features use trailing windows only,
and the model scores each row independently, so every output at time t depends only on
telemetry with ts_unix <= t. Nothing here reads answer_key.json.
"""
import json
from functools import lru_cache
from pathlib import Path

import lightgbm as lgb
import numpy as np

from features import CLASSES, build_features
from loader import load

MODEL_DIR = Path(__file__).parent / "model"
STEP = 300
CAT_TO_CLASS = {"pipeline_leak": 1, "pump_degradation": 2, "pump_failure": 3}
WIN = {"30m": "30 minutes", "2h": "2 hours", "6h": "6 hours", "24h": "24 hours"}


class ModelStore:
    def __init__(self, model_dir=MODEL_DIR):
        self.meta = json.loads((Path(model_dir) / "meta.json").read_text())
        self.booster = lgb.Booster(model_file=str(Path(model_dir) / "lgbm.txt"))
        self.features = self.meta["features"]
        assert self.meta["classes"] == CLASSES, "model classes do not match features.CLASSES"

    @property
    def version(self):
        return self.meta["modelVersion"]


_store = None


def store():
    global _store
    if _store is None:
        _store = ModelStore()
    return _store


class DatasetError(ValueError):
    pass


def _check_dir(dataset_dir):
    d = Path(dataset_dir)
    if not d.is_dir():
        raise DatasetError(f"datasetDir not found: {dataset_dir}")
    missing = [f for f in ("network.json", "ops.json", "telemetry.csv") if not (d / f).exists()]
    if missing:
        raise DatasetError(f"datasetDir is missing {', '.join(missing)}")
    return d


def _prepare(dataset_dir, as_of, use_cache=True):
    d = _check_dir(dataset_dir)
    key = (str(d.resolve()), (d / "telemetry.csv").stat().st_mtime_ns, None if as_of is None else int(as_of))
    if use_cache:
        return _prepare_cached(key)
    return _prepare_uncached(key)


def _prepare_uncached(key):
    path, _, as_of = key
    try:
        ds = load(path, as_of=as_of)
    except ValueError as e:              # e.g. asOfUnix before the first reading
        raise DatasetError(str(e)) from e
    F = build_features(ds.wide, ds.network)
    X = F[store().features]
    P = store().booster.predict(X, num_iteration=store().meta["bestIteration"])
    return ds, F, P


@lru_cache(maxsize=4)
def _prepare_cached(key):
    return _prepare_uncached(key)


def detect(dataset_dir, as_of=None, use_cache=True):
    ds, F, P = _prepare(dataset_dir, as_of, use_cache)
    n = len(ds.wide)
    ts = ds.wide.index.values.astype(np.int64)
    fac_rows = {}
    fids = F["facility"].values
    for s, f in ds.facilities():
        fac_rows[f["id"]] = np.where(fids == f["id"])[0]
    assets = []
    for s, f in ds.facilities():
        p = P[fac_rows[f["id"]]]            # n x 4: normal, leak, degradation, failure
        r = lambda x: np.round(x, 5).tolist()
        # Pump: normal / degradation / failure (a leak is not a pump problem)
        assets.append({"assetId": f["pump"]["id"], "assetType": "pump", "tsUnix": ts.tolist(),
                       "probs": {"normal": r(p[:, 0] + p[:, 1]), "degradation": r(p[:, 2]),
                                 "failure": r(p[:, 3])}})
        # Pipeline: normal / leak
        assets.append({"assetId": f["pipeline"]["id"], "assetType": "pipeline", "tsUnix": ts.tolist(),
                       "probs": {"normal": r(1 - p[:, 1]), "leak": r(p[:, 1])}})
    return {"modelVersion": store().version, "asOfUnix": int(ts[-1]), "stepSec": STEP, "assets": assets}


# ------------------------------------------------------------------ explain
def _w(name):
    return WIN.get(name, name)


def describe(name, v, disp_note=""):
    """Plain-English sentence for one feature value. Numbers come straight from the data."""
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return f"No recent running readings for {name.replace('_', ' ')}"
    parts = name.split("_")
    fam = parts[0]
    win = parts[-1] if parts[-1] in WIN else None
    if name == "pump_fault":
        return "The pump is reporting a fault (status 2)" if v >= 0.5 else "The pump is not reporting a fault"
    if name == "pump_running":
        return "The pump is running" if v >= 0.5 else "The pump is stopped"
    if name == "pump_status":
        return {0: "The pump is stopped", 1: "The pump is running", 2: "The pump is in fault"}.get(int(round(v)), f"Pump status is {v:g}")
    if name == "status_hours":
        return f"The pump has been in its current state for {v:.1f} hours"
    if name == "level_pct":
        return f"The tank is {v:.1f}% full"
    if name == "level_to_limit":
        return f"The tank is {v:.1f} percentage points below its shutdown limit"
    if name == "level_to_warning":
        return f"The tank is {v:.1f} percentage points {'below' if v >= 0 else 'above'} its warning level"
    if name == "level_noise":
        return f"Tank level readings are moving {v:.2f} points per step on average"
    if fam == "level" and parts[1] == "slope":
        return f"Tank level changed {v:+.2f} points per hour over the last {_w(win)}"
    if name == "well_frac_now":
        return f"The wells are sending {v:.0%} of their baseline water to the tank"
    if name == "wells_on_frac":
        return f"{v:.0%} of the wells are producing"
    if name == "wells_on_frac_6h":
        return f"At the lowest, {v:.0%} of the wells were producing over the last 6 hours"
    if name.endswith("_age_h"):
        what = {"flow": "pump flow", "ratio": "received-to-pumped flow", "pipe": "pipeline pressure",
                "dis": "discharge pressure"}.get(fam, fam)
        return f"The pump last ran {v:.1f} hours ago, so the latest {what} reading is that old"
    if name == "ratio_std_2h":
        return f"Received-to-pumped flow ratio varied by {v:.3f} (standard deviation) over the last 2 hours"
    if name == "off_press_dev_2h":
        return f"With the pump off, pipeline pressure was {abs(v):.1f} psi {'below' if v < 0 else 'above'} the disposal pressure over the last 2 hours"
    if name == "loss_pipe_vs_pump":
        return f"Pump flow is {v * 100:.1f} percentage points above the flow arriving at the disposal site"
    kind = "mean"
    if "_chg_" in name:
        kind = "chg"
    elif name.endswith("_carried"):
        kind, win = "carried", "2h"
    elif name.endswith("_min_6h"):
        kind, win = "min", "6h"
    W = _w(win) if win else "the last window"
    if fam == "flow":
        return {"mean": f"Pump flow averaged {v:.1%} of its rated flow over the last {W}",
                "carried": f"Pump flow averaged {v:.1%} of its rated flow over its last 2 hours of running",
                "min": f"Pump flow dipped to an average of {v:.1%} of rated over a 6-hour window",
                "chg": f"Pump flow moved {v * 100:+.1f} points of rated flow versus the previous {W}"}[kind]
    if fam == "ratio":
        return {"mean": f"Water reaching the disposal site averaged {v:.1%} of what the pump sent over the last {W}",
                "carried": f"Water reaching the disposal site was {v:.1%} of what the pump sent (last 2 hours of running)",
                "min": f"Received-to-pumped flow dipped to {v:.1%} over a 6-hour window",
                "chg": f"Received-to-pumped flow moved {v * 100:+.1f} points versus the previous {W}"}[kind]
    if fam in ("pipe", "dis"):
        what = "Pipeline pressure at the disposal end" if fam == "pipe" else "Pump discharge pressure"
        side = "below" if v < 0 else "above"
        return {"mean": f"{what} was {abs(v):.0f} psi {side} normal over the last {W}",
                "carried": f"{what} was {abs(v):.0f} psi {side} normal (last 2 hours of running)",
                "min": f"{what} bottomed at {abs(v):.0f} psi {side} normal over 6 hours",
                "chg": f"{what} moved {v:+.0f} psi versus the previous {W}"}[kind]
    return f"{name.replace('_', ' ')} is {v:.3g}"


def _family(name):
    """Group near-duplicate features so the top drivers each tell a different story."""
    if name.startswith(("pump_", "status_")):
        return "pump state"
    if name.startswith(("well", )):
        return "wells"
    if name.startswith("level"):
        return "tank level"
    if name.startswith(("ratio", "loss_")):
        return "received flow"
    if name.startswith(("pipe", "off_press")):
        return "pipeline pressure"
    if name.startswith("dis"):
        return "discharge pressure"
    if name.startswith("flow"):
        return "pump flow"
    return name


def explain(dataset_dir, asset_id, category, onset_unix, as_of=None, top=3):
    if category not in CAT_TO_CLASS:
        raise DatasetError(f"unknown category {category!r}; use one of {sorted(CAT_TO_CLASS)}")
    ds, F, P = _prepare(dataset_dir, as_of)
    fid = None
    for s, f in ds.facilities():
        if asset_id in (f["id"], f["pump"]["id"], f["pipeline"]["id"], f["tank"]["id"]):
            fid = f["id"]
    if fid is None:
        raise DatasetError(f"assetId {asset_id!r} not found in network.json")
    rows = np.where(F["facility"].values == fid)[0]
    row = rows[-1]                      # the latest step at or before asOf
    x = F.iloc[[row]][store().features]
    contrib = store().booster.predict(x, num_iteration=store().meta["bestIteration"], pred_contrib=True)[0]
    nf, k = len(store().features), CAT_TO_CLASS[category]
    c = contrib[k * (nf + 1): k * (nf + 1) + nf]          # SHAP values toward this class (log-odds)
    order, seen = [], set()
    for i in np.argsort(-c):                       # strongest push toward this class first
        fam = _family(store().features[i])
        if fam in seen:
            continue                               # one driver per signal family
        seen.add(fam)
        order.append(i)
        if len(order) == top:
            break
    drivers = []
    for i in order:
        name = store().features[i]
        v = x.iloc[0, i]
        drivers.append({"feature": name, "text": describe(name, None if np.isnan(v) else float(v)),
                        "contribution": round(float(c[i]), 4)})
    return {"drivers": drivers, "assetId": asset_id, "category": category,
            "evaluatedAtUnix": int(F["ts_unix"].values[row]),
            "probability": round(float(P[row][k]), 4)}
