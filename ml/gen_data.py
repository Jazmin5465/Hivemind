"""Step 4: generate random labelled weeks with the simulator.

Each generated week is a normal dataset (network.json, ops.json, telemetry.csv) plus
labels.json, so src/loader.py reads it exactly like the real folders.

    python src/gen_data.py --n 5 --out data/synth --seed 0

Training code can also call make_week(seed) and use the result in memory.

Randomized, anchored to the real week:
  networks     2-5 systems, 2-4 facilities, 2-4 wells, tank sizes, pump = 1.3-1.8x inflow,
               disposal pressure 950-1100, fleet 2-3 trucks, repair time 4-8 h
  incidents    leaks 20-28 h, worn pumps 24-36 h, failures = repair time; about 20 episodes
               per 15 facilities, 3/5 of worn pumps end in a failure at the same pump,
               failures cluster 2-3 per system within about an hour
  sensors      noise x0.8-1.4, leak/wear rates jittered
"""
import argparse
import json
import string
from pathlib import Path

import numpy as np

from sim import STEP, load_params, simulate

T0 = 1791158400          # Mon 2026-10-05 00:00 UTC, same as the real week
N_STEPS = 2016


# ---------------------------------------------------------------- networks
def random_network(rng, n_systems=None):
    n_systems = n_systems or int(rng.integers(2, 6))
    systems = []
    for si in range(1, n_systems + 1):
        sid = f"S{si}"
        lat0, lon0 = 31.5 + rng.uniform(0, 1.5), -102.5 + rng.uniform(0, 1.0)
        facs = []
        for fi in range(int(rng.integers(2, 5))):
            L = string.ascii_uppercase[fi]
            nw = int(rng.choice([2, 3, 3, 3, 4]))
            wells = []
            for wi in range(1, nw + 1):
                wells.append({"id": f"{sid}_WELL_{L}{wi}",
                              "baseline_water_bpd": int(rng.choice(np.arange(300, 1100, 50))),
                              "oil_bpd": int(rng.choice(np.arange(100, 700, 10))),
                              "gas_mcfd": int(rng.choice(np.arange(400, 2500, 50)))})
            inflow = sum(w["baseline_water_bpd"] for w in wells)
            cap = int(round(inflow * rng.uniform(0.4, 0.6) / 50) * 50)
            ratio = rng.uniform(1.3, 1.8) if rng.random() < 0.3 else 1.5
            start = 70 if rng.random() < 0.8 else int(rng.choice([65, 70, 75]))
            stop = 30 if rng.random() < 0.8 else int(rng.choice([25, 30, 35]))
            facs.append({"id": f"{sid}_FACILITY_{L}",
                         "lat": round(lat0 + rng.uniform(-0.1, 0.1), 3),
                         "lon": round(lon0 + rng.uniform(-0.1, 0.1), 3),
                         "wells": wells,
                         "tank": {"id": f"{sid}_TANK_{L}", "capacity_bbl": max(cap, 400)},
                         "pump": {"id": f"{sid}_PUMP_{L}",
                                  "max_flow_bpd": int(round(inflow * ratio / 50) * 50),
                                  "start_level_pct": start, "stop_level_pct": stop},
                         "pipeline": {"id": f"{sid}_PIPELINE_{L}",
                                      "max_bpd": int(round(inflow * ratio * 1.15 / 50) * 50),
                                      "max_pressure_psi": int(rng.choice([1550, 1600, 1650, 1700, 1750]))}})
        systems.append({"id": sid, "center": [round(lat0, 3), round(lon0, 3)],
                        "truck_yard": [round(lat0 - 0.2, 3), round(lon0 - 0.3, 3)],
                        "disposal_site": {"id": f"{sid}_DISPOSAL", "lat": round(lat0 + 0.02, 3),
                                          "lon": round(lon0 + 0.005, 3),
                                          "pressure_psi": int(rng.choice(np.arange(950, 1101, 50)))},
                        "facilities": facs})
    return {"meta": {"units": {"volume": "bbl", "rate": "bpd", "gas_rate": "mcfd", "pressure": "psi"},
                     "timezone": "UTC"},
            "defaults": {"tank_limits_pct": {"warning": 85, "shutdown": 92}},
            "systems": systems}


def random_ops(rng, network):
    ops = {"dataset_id": "synthetic",
           "prices": {"oil_per_bbl": 60, "gas_per_mcf": 3.0},
           "expected_repair_hours": {"pump_failure": int(rng.choice([4, 5, 6, 6, 6, 7, 8]))},
           "emergency_trucking": {"truck_capacity_bbl": int(rng.choice([100, 150, 150, 200])),
                                  "cost_per_trip": int(rng.choice([700, 905, 905, 1100]))},
           "systems": {}}
    for s in network["systems"]:
        ops["systems"][s["id"]] = {
            "emergency_fleet_size": int(rng.choice([2, 2, 3])),
            "facilities": {f["id"]: {"response_min": int(rng.choice(np.arange(60, 105, 5))),
                                     "cycle_min": int(rng.choice(np.arange(200, 275, 5)))}
                           for f in s["facilities"]}}
    return ops


# --------------------------------------------------------------- incidents
def _free(busy, fid, a, b, margin=2 * 3600):
    return all(b + margin <= x or a - margin >= y for x, y in busy.get(fid, []))


def random_incidents(rng, network, ops, n_steps=N_STEPS, t0=T0, density=1.0, rate_jitter=0.25):
    repair = int(ops["expected_repair_hours"]["pump_failure"] * 3600)
    T1 = t0 + n_steps * STEP
    P = load_params()
    busy, incs = {}, []

    def add(cat, fid, a, b):
        busy.setdefault(fid, []).append((a, b))
        inc = {"category": cat, "facility": fid, "onset_unix": int(a),
               "end_unix": int(b) if cat != "pump_failure" else int(a + repair)}
        j = lambda: float(np.clip(rng.normal(1, rate_jitter), 0.5, 1.8))
        if cat == "pump_degradation":
            inc["rate_per_h"] = P["deg"]["rate_per_h"] * j()
        if cat == "pipeline_leak":
            inc["rate_per_h"] = P["leak"]["rate_per_h"] * j()
        incs.append(inc)

    def grid(x):
        return t0 + int((x - t0) // STEP) * STEP

    def pick_time(lo, hi):
        return grid(rng.uniform(lo, hi))

    facs = [(s["id"], f["id"]) for s in network["systems"] for f in s["facilities"]]
    n_ep = rng.poisson(1.0 * len(facs) * density)
    for _ in range(n_ep):
        kind = rng.choice(["leak", "deg", "chain", "fail", "cluster"], p=[0.25, 0.10, 0.15, 0.30, 0.20])
        sid, fid = facs[rng.integers(len(facs))]
        if kind == "leak":
            d = rng.uniform(20, 28) * 3600
            a = pick_time(t0, T1 - 3600)
            if _free(busy, fid, a, a + d):
                add("pipeline_leak", fid, a, min(a + d, T1 + 1))
        elif kind == "deg":
            d = rng.uniform(24, 36) * 3600
            a = pick_time(t0, T1 - 3600)
            if _free(busy, fid, a, a + d):
                add("pump_degradation", fid, a, a + d)
        elif kind == "chain":
            d = rng.uniform(24, 36) * 3600
            a = pick_time(t0, T1 - d - 3600)
            if _free(busy, fid, a, a + d + repair):
                add("pump_degradation", fid, a, a + d)
                add("pump_failure", fid, a + d, a + d + repair)
        elif kind == "fail":
            a = pick_time(t0, T1 - 3600)
            if _free(busy, fid, a, a + repair):
                add("pump_failure", fid, a, a + repair)
        else:   # cluster: 2-3 pump failures in one system within about an hour
            members = [f for s2, f in facs if s2 == sid]
            rng.shuffle(members)
            k = min(len(members), int(rng.integers(2, 4)))
            a0 = pick_time(t0, T1 - 2 * 3600)
            for j, f in enumerate(members[:k]):
                a = a0 + j * int(rng.choice([1800, 1800, 3600]))
                if _free(busy, f, a, a + repair):
                    add("pump_failure", f, a, a + repair)
    return incs


# ------------------------------------------------------------------- weeks
def make_week(seed, n_steps=N_STEPS, t0=T0, network=None, density=1.0):
    rng = np.random.default_rng(seed)
    net = network or random_network(rng)
    ops = random_ops(rng, net)
    incs = random_incidents(rng, net, ops, n_steps, t0, density)
    tele, labels = simulate(net, ops, incs, t0, n_steps, seed=int(rng.integers(1 << 31)),
                            noise_scale=float(rng.uniform(0.8, 1.4)))
    # synthetic-only convenience: which failure directly follows a worn pump at the same pump
    for l in labels:
        l["follows"] = None
        if l["category"] == "pump_failure":
            for m in labels:
                if (m["category"] == "pump_degradation" and m["asset"] == l["asset"]
                        and m["end_unix"] == l["onset_unix"]):
                    l["follows"] = m["id"]
    return net, ops, tele, labels


def write_week(folder, net, ops, tele, labels):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "network.json").write_text(json.dumps(net, indent=1))
    (folder / "ops.json").write_text(json.dumps(ops, indent=1))
    (folder / "labels.json").write_text(json.dumps(labels, indent=1))
    tele.to_csv(folder / "telemetry.csv", index=False)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3)
    ap.add_argument("--out", default="data/synth")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    for i in range(a.n):
        net, ops, tele, labels = make_week(a.seed + i)
        write_week(Path(a.out) / f"week_{a.seed + i:05d}", net, ops, tele, labels)
        cats = {}
        for l in labels:
            cats[l["category"]] = cats.get(l["category"], 0) + 1
        nf = sum(len(s["facilities"]) for s in net["systems"])
        print(f"week_{a.seed + i:05d}: {nf} facilities, {len(labels)} events {cats}")
