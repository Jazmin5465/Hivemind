"""Step 5: normalized rolling-window features, one row per facility per 5-minute step.

Everything is relative to the facility's own description in network.json, so the same
code works on any network (including the unseen test/ one):
  pump flow            as a fraction of pump.max_flow_bpd          (healthy = 1.0)
  received/pump flow   ratio                                       (healthy = 1.0)
  pipeline pressure    deviation from disposal pressure + offset   (healthy = 0 psi)
  discharge pressure   deviation from disposal pressure + offset   (healthy = 0 psi)
  well water           as a fraction of the well baselines
  tank level           percent, and distance to the shutdown limit
Windows are trailing (only past data), so a feature at time t never sees the future and
a dataset cut at any "now" gives the same rows as the full one up to that point.
Values measured while the pump runs are carried forward through off periods, so a leak
or worn pump is still visible while the pump is stopped.

Not features (never fed to a model): asset ids, absolute time, answer keys.
"""
import numpy as np
import pandas as pd

STEP_H = 5 / 60.0
WINDOWS = {"30m": 6, "2h": 24, "6h": 72, "24h": 288}
CLASSES = ["normal", "pipeline_leak", "pump_degradation", "pump_failure"]
OFFSETS = {"pipeline": 50.0, "discharge": 150.0}   # SPEC.md pressure formulas


def _roll(x, w, how="mean"):
    r = x.rolling(w, min_periods=max(2, w // 6))
    return r.mean() if how == "mean" else r.min() if how == "min" else r.std()


def _age(valid):
    """Steps since the last True in `valid` (0 where True)."""
    idx = np.arange(len(valid))
    last = np.where(valid, idx, -1)
    last = np.maximum.accumulate(last)
    return np.where(last >= 0, idx - last, np.nan)


def _run_length(status):
    """Steps spent in the current status value."""
    s = pd.Series(status)
    grp = (s != s.shift()).cumsum()
    return s.groupby(grp).cumcount().values + 1


def facility_features(W, system, fac, limits):
    """Feature DataFrame (index = W.index) for one facility."""
    disp = system["disposal_site"]["pressure_psi"]
    p, pl, t = fac["pump"], fac["pipeline"], fac["tank"]
    idx = W.index
    st = W[f"{p['id']}|status"]
    run = st == 1
    flow = W[f"{p['id']}|flow_bpd"]
    recv = W[f"{pl['id']}|receive_flow_bpd"]
    level = W[f"{t['id']}|level_pct"]
    base_in = sum(w["baseline_water_bpd"] for w in fac["wells"])

    # raw normalized signals; NaN when the pump is not running so windows only use valid data
    flow_frac = (flow / p["max_flow_bpd"]).where(run)
    recv_ratio = (recv / flow.where(flow > 0)).where(run)
    pipe_dev = (W[f"{pl['id']}|pressure_psi"] - (disp + OFFSETS["pipeline"])).where(run)
    dis_dev = (W[f"{p['id']}|discharge_psi"] - (disp + OFFSETS["discharge"])).where(run)
    # pressure while the pump is off/failed should read the disposal pressure
    off_dev = (W[f"{pl['id']}|pressure_psi"] - disp).where(~run)

    F = pd.DataFrame(index=idx)
    F["pump_status"] = st.values
    F["pump_fault"] = (st == 2).astype(float).values
    F["pump_running"] = run.astype(float).values
    F["status_hours"] = _run_length(st.values) * STEP_H
    F["level_pct"] = level.values
    F["level_to_limit"] = limits["shutdown"] - level.values
    F["level_to_warning"] = limits["warning"] - level.values
    F["level_noise"] = level.diff().abs().rolling(12, min_periods=3).mean().values
    for name, w in WINDOWS.items():
        F[f"level_slope_{name}"] = ((level - level.shift(w)) / (w * STEP_H)).values   # pct per hour
    F["well_frac_now"] = (W[f"{fac['id']}|inflow_bpd"] / base_in).values
    well_cols = [f"{w['id']}|status" for w in fac["wells"]]
    F["wells_on_frac"] = W[well_cols].mean(axis=1).values
    F["wells_on_frac_6h"] = pd.Series(F["wells_on_frac"].values, index=idx).rolling(72, min_periods=6).min().values

    sig = {"flow": flow_frac, "ratio": recv_ratio, "pipe": pipe_dev, "dis": dis_dev}
    for sname, x in sig.items():
        valid = x.notna().values
        F[f"{sname}_age_h"] = _age(valid) * STEP_H            # how stale the last running reading is
        for wname, w in WINDOWS.items():
            m = _roll(x, w)
            F[f"{sname}_mean_{wname}"] = m.values
            if wname in ("2h", "6h", "24h"):
                F[f"{sname}_chg_{wname}"] = (m - m.shift(w)).values   # change vs the previous window
        # slow ramps: carry the last smoothed values across off periods
        carried = _roll(x, WINDOWS["2h"]).ffill()
        F[f"{sname}_carried"] = carried.values
        F[f"{sname}_min_6h"] = _roll(x, WINDOWS["6h"], "min").ffill().values
    F["ratio_std_2h"] = _roll(recv_ratio, WINDOWS["2h"], "std").ffill().values
    F["off_press_dev_2h"] = _roll(off_dev, WINDOWS["2h"]).values
    # leak and wear separate by where the loss shows: pump flow vs pipeline
    F["loss_pipe_vs_pump"] = F["flow_carried"].values - F["ratio_carried"].values
    return F


def build_features(W, network):
    """All facilities of a dataset. Returns a long DataFrame with metadata columns:
    ts_unix, facility, system (metadata only, not for the model)."""
    limits = network["defaults"]["tank_limits_pct"]
    parts = []
    for s in network["systems"]:
        for f in s["facilities"]:
            F = facility_features(W, s, f, limits)
            F.insert(0, "facility", f["id"])
            F.insert(0, "system", s["id"])
            F.insert(0, "ts_unix", W.index.values)
            parts.append(F)
    return pd.concat(parts, ignore_index=True)


def build_labels(features, labels):
    """Class per row from an event list (synthetic labels or an answer key; check use only).
    Returns (class index array, event id array, hours since onset array)."""
    cls = np.zeros(len(features), int)
    eid = np.full(len(features), "", dtype=object)
    since = np.full(len(features), np.nan)
    cmap = {c: i for i, c in enumerate(CLASSES)}
    for l in labels:
        end = l["end_unix"] if l["end_unix"] else np.inf
        m = ((features["facility"].values == l["facility"])
             & (features["ts_unix"].values >= l["onset_unix"]) & (features["ts_unix"].values < end))
        cls[m] = cmap[l["category"]]
        eid[m] = l["id"]
        since[m] = (features["ts_unix"].values[m] - l["onset_unix"]) / 3600.0
    return cls, eid, since


FEATURE_META = ["ts_unix", "facility", "system"]


def feature_columns(F):
    return [c for c in F.columns if c not in FEATURE_META]
