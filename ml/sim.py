"""Step 2: simulator written from SPEC.md.

simulate(network, ops, incidents, ...) -> (telemetry long DataFrame, labels list)

Physics (SPEC.md): level change per hour = (inflow - pump flow) / 24 / capacity * 100.
Pump starts at start_level_pct, stops at stop_level_pct, keeps state in between.
At the shutdown limit the facility's wells shut in until the repair ends.
Pressures: pipeline = disposal + 50 and discharge = disposal + 150 while the pump runs,
otherwise both read the disposal pressure.

SPEC leaves some things open (noise, how fast a leak or a worn pump develops).
Those live in PARAMS and are fitted from the real week by calibrate.py.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

STEP = 300
PARAMS_FILE = Path(__file__).with_name("sim_params.json")

DEFAULT_PARAMS = {
    "noise": {"well_frac": 0.006, "pump_flow_frac": 0.0055, "recv_flow_frac": 0.0055,
              "psi": 3.0, "level": 0.083},
    "deg": {"rate_per_h": 0.00395, "rate_sd": 0.00015, "psi_per_flow": 392.0},
    "leak": {"step": 0.015, "rate_per_h": 0.0037, "rate_sd": 0.0007, "psi_per_loss": 800.0},
    "pipeline_offset_psi": 50.0,
    "discharge_offset_psi": 150.0,
}


def load_params():
    if PARAMS_FILE.exists():
        return json.loads(PARAMS_FILE.read_text())
    return DEFAULT_PARAMS


def _iso(t):
    return pd.Timestamp(int(t), unit="s", tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def simulate(network, ops, incidents, t0, n_steps, seed=0, params=None,
             init=None, noise_scale=1.0):
    """Simulate telemetry.

    incidents: list of dicts with category (pipeline_leak | pump_degradation | pump_failure),
      facility, onset_unix, end_unix (None = runs past the window). Optional per-incident
      overrides: rate_per_h (leak/degradation), step (leak).
    init: optional {tank_id: (level_pct, pump_on)}; otherwise random.
    """
    P = params or load_params()
    rng = np.random.default_rng(seed)
    lim = network["defaults"]["tank_limits_pct"]["shutdown"]
    repair_h = ops["expected_repair_hours"]["pump_failure"]
    ts = t0 + STEP * np.arange(n_steps)
    hours = ts / 3600.0
    rows = []     # list of (asset, metric, array)
    labels = []

    by_fac = {}
    for inc in sorted(incidents, key=lambda i: i["onset_unix"]):
        by_fac.setdefault(inc["facility"], []).append(inc)

    for system in network["systems"]:
        disp = system["disposal_site"]["pressure_psi"]
        for fac in system["facilities"]:
            fid = fac["id"]
            tank, pump, pipe = fac["tank"], fac["pump"], fac["pipeline"]
            cap, mx = tank["capacity_bbl"], pump["max_flow_bpd"]
            start, stop = pump["start_level_pct"], pump["stop_level_pct"]
            wells = fac["wells"]
            incs = by_fac.get(fid, [])

            # per-step incident state arrays
            failed = np.zeros(n_steps, bool)
            deg_mult = np.ones(n_steps)          # pump flow multiplier
            leak_loss = np.zeros(n_steps)        # fraction of pump flow lost in pipeline
            repair_end = None
            for inc in incs:
                a = inc["onset_unix"]
                b = inc.get("end_unix")
                cat = inc["category"]
                if cat == "pump_failure":
                    b = a + int(repair_h * 3600)
                    failed |= (ts >= a) & (ts < b)
                elif cat == "pump_degradation":
                    r = inc.get("rate_per_h") or max(1e-4, rng.normal(P["deg"]["rate_per_h"], P["deg"]["rate_sd"]))
                    m = (ts >= a) & ((ts < b) if b else True)
                    deg_mult[m] = np.clip(1 - r * (ts[m] - a) / 3600.0, 0.3, 1)
                elif cat == "pipeline_leak":
                    r = inc.get("rate_per_h") or max(1e-4, rng.normal(P["leak"]["rate_per_h"], P["leak"]["rate_sd"]))
                    st = inc.get("step", P["leak"]["step"])
                    m = (ts >= a) & ((ts < b) if b else True)
                    leak_loss[m] = np.clip(st + r * (ts[m] - a) / 3600.0, 0, 0.9)
                lab = {"system": system["id"], "facility": fid,
                       "asset": {"pump_failure": pump["id"], "pump_degradation": pump["id"],
                                 "pipeline_leak": pipe["id"]}[cat],
                       "category": cat, "onset": _iso(a), "onset_unix": int(a),
                       "end": _iso(b) if b else None, "end_unix": int(b) if b else None}
                labels.append(lab)

            # true well rates (flat baselines; noise added at the sensor)
            base = np.array([w["baseline_water_bpd"] for w in wells], float)
            base_in = base.sum()

            level = np.zeros(n_steps)
            pump_on = np.zeros(n_steps, bool)
            shut = np.zeros(n_steps, bool)
            if init and tank["id"] in init:
                lv, on = init[tank["id"]]
            else:
                lv = rng.uniform(stop, start)
                on = bool(rng.random() < 0.5)
            fail_start_state = None
            for i in range(n_steps):
                # automatic shut-in latch: wells off while tank is at the limit
                # and the pump is still failed
                if failed[i]:
                    on = False
                elif i > 0 and failed[i - 1]:
                    # repair done: pump resumes running if the tank is above the start level
                    on = lv >= start or (fail_start_state if lv > stop else False)
                else:
                    if on and lv <= stop:
                        on = False
                    elif (not on) and lv >= start:
                        on = True
                if failed[i] and (i == 0 or not failed[i - 1]):
                    fail_start_state = pump_on[i - 1] if i > 0 else on
                level[i] = lv
                pump_on[i] = on
                is_shut = lv >= lim and failed[i]
                shut[i] = is_shut
                inflow = 0.0 if is_shut else base_in
                flow = mx * deg_mult[i] if on else 0.0
                lv = lv + (inflow - flow) / 24.0 / cap * 100.0 * (STEP / 3600.0)
                if lv >= lim and failed[i]:
                    lv = lim
                lv = max(lv, 0.0)

            ns = P["noise"]
            sc = noise_scale
            # wells
            water = np.zeros(n_steps)
            for w in wells:
                true = np.where(shut, 0.0, w["baseline_water_bpd"])
                val = np.round(true * (1 + rng.normal(0, ns["well_frac"] * sc, n_steps)), 1)
                val = np.where(shut, 0.0, val)
                water += val
                rows.append((w["id"], "water_bpd", val))
                rows.append((w["id"], "status", (~shut).astype(float)))
            rows.append((fid, "inflow_bpd", np.round(water, 1)))

            lv_read = level + rng.normal(0, ns["level"] * sc, n_steps)
            lv_read = np.where(shut, lim, np.minimum(lv_read, lim))
            rows.append((tank["id"], "level_pct", np.round(lv_read, 2)))

            true_flow = np.where(pump_on, mx * deg_mult, 0.0)
            status = np.where(failed, 2.0, np.where(pump_on, 1.0, 0.0))
            pflow = np.where(pump_on, true_flow * (1 + rng.normal(0, ns["pump_flow_frac"] * sc, n_steps)), 0.0)
            rows.append((pump["id"], "status", status))
            rows.append((pump["id"], "flow_bpd", np.round(pflow, 1)))

            run = pump_on & ~failed
            dis_true = disp + np.where(run, P["discharge_offset_psi"]
                                       + P["deg"]["psi_per_flow"] * (deg_mult - 1), 0.0)
            rows.append((pump["id"], "discharge_psi",
                         np.round(dis_true + rng.normal(0, ns["psi"] * sc, n_steps), 1)))

            recv_true = np.where(pump_on, true_flow * (1 - leak_loss), 0.0)
            recv = np.where(pump_on, recv_true * (1 + rng.normal(0, ns["recv_flow_frac"] * sc, n_steps)), 0.0)
            rows.append((pipe["id"], "receive_flow_bpd", np.round(recv, 1)))
            pl_true = disp + np.where(run, P["pipeline_offset_psi"]
                                      - P["leak"]["psi_per_loss"] * leak_loss, 0.0)
            rows.append((pipe["id"], "pressure_psi",
                         np.round(pl_true + rng.normal(0, ns["psi"] * sc, n_steps), 1)))

    # trip times for pump failures
    out = []
    for lab in labels:
        if lab["category"] == "pump_failure":
            f = next(f for s in network["systems"] for f in s["facilities"] if f["id"] == lab["facility"])
            lv = next(r[2] for r in rows if r[0] == f["tank"]["id"] and r[1] == "level_pct")
            m = (ts >= lab["onset_unix"]) & (ts < lab["end_unix"]) & (lv >= lim)
            lab["trips_at_unix"] = int(ts[m][0]) if m.any() else None
            lab["trips_at"] = _iso(ts[m][0]) if m.any() else None
        out.append(lab)
    out.sort(key=lambda l: l["onset_unix"])
    for i, lab in enumerate(out, 1):
        lab["id"] = f"EVENT_{i}"
        lab["status"] = "resolved" if (lab["end_unix"] and lab["end_unix"] <= ts[-1]) else "ongoing"

    tele = pd.DataFrame({
        "timestamp": np.concatenate([[ _iso(t) for t in ts] for _ in rows]),
        "ts_unix": np.concatenate([ts for _ in rows]),
        "asset_id": np.concatenate([[r[0]] * n_steps for r in rows]),
        "metric": np.concatenate([[r[1]] * n_steps for r in rows]),
        "value": np.concatenate([r[2] for r in rows]),
    })
    return tele, out
